import 'dotenv/config';
import { db, initDb } from '../src/db';
import { isAIAvailable, chatCompletion, parseJSON } from '../src/services/minimax-client';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const MEMORY_CATEGORIES = [
  'person',
  'relationship',
  'project',
  'preference',
  'habit',
  'work_context',
  'recurring_task',
  'fact',
] as const;
type MemoryCategory = typeof MEMORY_CATEGORIES[number];

interface Conversation {
  id: string;
  started_at: string;
  title: string | null;
  summary: string | null;
  participants_json: string | null;
  topics_json: string | null;
  primary_source: string;
}

interface CandidateFromAI {
  candidate_text: string;
  category: string;
  confidence: number;
  evidence: string;
  why_long_term: string;
}

// ─── Step 1: Candidate nomination ───

async function nominateCandidatesForConversation(conv: Conversation): Promise<CandidateFromAI[]> {

  const events = db.prepare(`
    SELECT ke.content_text, ke.participants_json, ke.started_at, ke.event_type
    FROM knowledge_conversation_items ki
    JOIN knowledge_events ke ON ke.id = ki.event_id
    WHERE ki.conversation_id = ?
    ORDER BY ki.item_order ASC
  `).all(conv.id) as Array<{
    content_text: string | null;
    participants_json: string | null;
    started_at: string;
    event_type: string;
  }>;

  const textParts = events
    .filter(e => e.content_text)
    .slice(0, 80)
    .map(e => {
      const speaker = extractSpeaker(e.participants_json);
      const time = e.started_at.slice(11, 19);
      return speaker ? `[${time} ${speaker}] ${e.content_text}` : `[${time}] ${e.content_text}`;
    });

  if (textParts.length < 2) return [];

  if (!isAIAvailable()) {
    return extractCandidatesByRules(conv, textParts);
  }

  return await extractCandidatesByAI(conv, textParts.join('\n'));
}

// ─── Rule-based extraction (no AI) ───

function extractCandidatesByRules(conv: Conversation, textParts: string[]): CandidateFromAI[] {
  const candidates: CandidateFromAI[] = [];
  const fullText = textParts.join('\n');

  if (conv.participants_json) {
    try {
      const speakers = JSON.parse(conv.participants_json);
      if (Array.isArray(speakers)) {
        for (const s of speakers) {
          if (s && s !== '?' && !/^\d+$/.test(s)) {
            candidates.push({
              candidate_text: `${s} appeared in a conversation on ${conv.started_at.slice(0, 10)}`,
              category: 'person',
              confidence: 0.5,
              evidence: `conversation ${conv.id}`,
              why_long_term: 'person identification from conversation',
            });
          }
        }
      }
    } catch {}
  }

  if (conv.topics_json) {
    try {
      const topics = JSON.parse(conv.topics_json);
      if (Array.isArray(topics)) {
        for (const t of topics) {
          if (typeof t === 'string' && t.length > 3) {
            candidates.push({
              candidate_text: `Topic discussed: ${t}`,
              category: 'work_context',
              confidence: 0.4,
              evidence: `conversation ${conv.id}`,
              why_long_term: 'recurring topic from conversation',
            });
          }
        }
      }
    } catch {}
  }

  const projectPatterns = [
    /项目|project|工程|开发|上线|部署|deploy/i,
  ];
  if (projectPatterns.some(p => p.test(fullText))) {
    const firstLine = textParts.find(t => projectPatterns.some(p => p.test(t)));
    if (firstLine) {
      candidates.push({
        candidate_text: `Project-related discussion: ${firstLine.slice(0, 100)}`,
        category: 'project',
        confidence: 0.4,
        evidence: `conversation ${conv.id}`,
        why_long_term: 'project context',
      });
    }
  }

  return candidates;
}

// ─── AI-based extraction (MiniMax) ───

async function extractCandidatesByAI(conv: Conversation, transcript: string): Promise<CandidateFromAI[]> {
  const prompt = `Extract long-term memory facts from this conversation transcript.

<context>
Conversation: ${conv.title || conv.id}
Time: ${conv.started_at}
</context>

<transcript>
${transcript.slice(0, 6000)}
</transcript>

Extract facts that remain true beyond today: people identities, relationships, projects, preferences, habits, recurring tasks.

Do NOT extract:
- Temporary states or moods
- One-time todo items
- Greetings or small talk
- Timestamps

Return a JSON array:
[
  {
    "candidate_text": "the factual statement",
    "category": "person|relationship|project|preference|habit|work_context|recurring_task|fact",
    "confidence": 0.0-1.0,
    "evidence": "quote or reference from transcript",
    "why_long_term": "reason this is long-term valid"
  }
]

If nothing qualifies, return []. Return raw JSON only, no markdown.`;

  try {
    const text = await chatCompletion(prompt, { temperature: 0.2, maxTokens: 4096 });
    const arr = parseJSON<any[]>(text);
    if (!Array.isArray(arr)) return [];
    return arr.filter((c: any) =>
      c.candidate_text && c.category && typeof c.confidence === 'number'
    );
  } catch (err) {
    console.warn(`[memory-ai] extraction failed for ${conv.id}: ${err}`);
    return [];
  }
}

// ─── Step 2: Dedup + persist candidates ───

function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, ' ').trim();
}

function persistCandidates(convId: string, candidates: CandidateFromAI[]): number {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO knowledge_memory_candidates (
      id, conversation_id, candidate_text, category, confidence,
      evidence_json, dedupe_key, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  let count = 0;

  for (const c of candidates) {
    const category = MEMORY_CATEGORIES.includes(c.category as MemoryCategory)
      ? c.category
      : 'fact';
    const dedupeKey = `mc:${category}:${normalizeForDedup(c.candidate_text).slice(0, 120)}`;
    const evidence = { evidence: c.evidence, why_long_term: c.why_long_term };

    insert.run(
      genId('mc'),
      convId,
      c.candidate_text,
      category,
      c.confidence,
      JSON.stringify(evidence),
      dedupeKey,
      'pending',
      now,
      now,
    );
    count++;
  }
  return count;
}

// ─── Step 3: Promote high-confidence candidates to formal memories ───

function promoteToMemories(): number {
  const minConfidence = isAIAvailable() ? 0.6 : 0.35;

  const candidates = db.prepare(`
    SELECT id, candidate_text, category, confidence, conversation_id, created_at
    FROM knowledge_memory_candidates
    WHERE status = 'pending' AND confidence >= ?
    ORDER BY confidence DESC
  `).all(minConfidence) as Array<{
    id: string;
    candidate_text: string;
    category: string;
    confidence: number;
    conversation_id: string;
    created_at: string;
  }>;

  if (!candidates.length) return 0;

  const insertMemory = db.prepare(`
    INSERT OR IGNORE INTO knowledge_memories (
      id, canonical_text, category, subject_key, confidence,
      source_refs_json, first_observed_at, last_observed_at,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateCandidate = db.prepare(`
    UPDATE knowledge_memory_candidates SET status = 'accepted', updated_at = ? WHERE id = ?
  `);

  const now = new Date().toISOString();
  const existingMemories = db.prepare(`
    SELECT canonical_text, category FROM knowledge_memories WHERE status = 'active'
  `).all() as Array<{ canonical_text: string; category: string }>;

  const existingNormalized = new Set(
    existingMemories.map(m => `${m.category}:${normalizeForDedup(m.canonical_text).slice(0, 120)}`)
  );

  let promoted = 0;

  for (const c of candidates) {
    const normKey = `${c.category}:${normalizeForDedup(c.candidate_text).slice(0, 120)}`;
    if (existingNormalized.has(normKey)) {
      db.prepare(`
        UPDATE knowledge_memory_candidates SET status = 'merged', updated_at = ? WHERE id = ?
      `).run(now, c.id);
      continue;
    }

    const subjectKey = extractSubjectKey(c.candidate_text, c.category);

    insertMemory.run(
      genId('km'),
      c.candidate_text,
      c.category,
      subjectKey,
      c.confidence,
      JSON.stringify([c.conversation_id]),
      c.created_at,
      c.created_at,
      'active',
      now,
      now,
    );

    updateCandidate.run(now, c.id);
    existingNormalized.add(normKey);
    promoted++;
  }

  return promoted;
}

function extractSubjectKey(text: string, category: string): string | null {
  if (category === 'person' || category === 'relationship') {
    const match = text.match(/^(\S+)/);
    return match ? match[1] : null;
  }
  return null;
}

// ─── helpers ───

function extractSpeaker(json: string | null): string | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    return p.speaker_name || p.speaker_identity || p.speaker_label || null;
  } catch {
    return null;
  }
}

// ─── CLI ───

function parseArgs(): { mode: 'full' | 'date'; date?: string; ai: boolean; promote: boolean } {
  const dateArg = process.argv.find(a => a.startsWith('--date='));
  const noAi = process.argv.includes('--no-ai');
  const noPromote = process.argv.includes('--no-promote');
  if (dateArg) {
    return { mode: 'date', date: dateArg.split('=')[1], ai: !noAi, promote: !noPromote };
  }
  return { mode: 'full', ai: !noAi, promote: !noPromote };
}

async function main(): Promise<void> {
  initDb();
  const args = parseArgs();

  if (args.mode === 'full') {
    console.log('[memories] full rebuild — clearing candidates');
    db.exec('DELETE FROM knowledge_memory_candidates');
  }

  const conversations = db.prepare(`
    SELECT id, started_at, title, summary, participants_json, topics_json, primary_source
    FROM knowledge_conversations
    ORDER BY started_at ASC
  `).all() as Conversation[];

  console.log(`[memories] processing ${conversations.length} conversations`);

  let totalCandidates = 0;
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const tag = `[${i + 1}/${conversations.length}]`;
    const candidates = await nominateCandidatesForConversation(conv);
    if (candidates.length) {
      const inserted = db.transaction(() => persistCandidates(conv.id, candidates))();
      console.log(`${tag} ${conv.title || conv.id}: ${candidates.length} candidates → ${inserted} new`);
      totalCandidates += candidates.length;
    } else {
      console.log(`${tag} ${conv.title || conv.id}: no candidates`);
    }
  }

  console.log(`[memories] total candidates: ${totalCandidates}`);

  if (args.promote) {
    const promoted = db.transaction(() => promoteToMemories())();
    console.log(`[memories] promoted to formal memories: ${promoted}`);
  }

  const candidateStats = db.prepare(`
    SELECT status, COUNT(*) AS cnt FROM knowledge_memory_candidates GROUP BY status
  `).all() as Array<{ status: string; cnt: number }>;

  const memoryStats = db.prepare(`
    SELECT category, COUNT(*) AS cnt FROM knowledge_memories WHERE status = 'active' GROUP BY category ORDER BY cnt DESC
  `).all() as Array<{ category: string; cnt: number }>;

  console.log('\n[memories] candidate stats:');
  for (const s of candidateStats) console.log(`  ${s.status}: ${s.cnt}`);

  if (memoryStats.length) {
    console.log('\n[memories] active memories by category:');
    for (const s of memoryStats) console.log(`  ${s.category}: ${s.cnt}`);
  }

  const total = (db.prepare('SELECT COUNT(*) AS total FROM knowledge_memories').get() as { total: number }).total;
  console.log(`\n[memories] total formal memories: ${total}`);
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('[memories] failed:', err);
  process.exit(1);
});
