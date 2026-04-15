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

interface ExistingMemory {
  id: string;
  canonical_text: string;
  category: string;
  confidence: number | null;
  source_refs_json: string;
  first_observed_at: string | null;
  last_observed_at: string | null;
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

function extractCandidatesByRules(_conv: Conversation, _textParts: string[]): CandidateFromAI[] {
  return [];
}

// ─── AI-based extraction (MiniMax) ───

async function extractCandidatesByAI(conv: Conversation, transcript: string): Promise<CandidateFromAI[]> {
  const prompt = `You are a personal knowledge assistant. Extract long-term facts from this conversation that are worth remembering.

<context>
Conversation: ${conv.title || conv.id}
Time: ${conv.started_at}
</context>

<transcript>
${transcript.slice(0, 6000)}
</transcript>

Good examples of what to extract:
- "用户正在开发OMI Custom TTS项目，使用Soniox做语音识别" (project context)
- "用户的同事张三负责前端开发" (person/relationship)
- "用户偏好使用MiniMax而非OpenAI" (preference)
- "每周一团队会做代码review" (recurring_task)

Do NOT extract:
- Generic public knowledge (e.g. "React is a JavaScript framework")
- Repository statistics (stars, forks, license)
- Vague summaries (e.g. "discussed technical topics")
- Garbled OCR text or meaningless fragments
- One-time small talk or greetings

Return 0-3 items per conversation. Most casual conversations should return [].

Return a JSON array:
[
  {
    "candidate_text": "clear factual statement in the language of the content",
    "category": "person|relationship|project|preference|habit|work_context|recurring_task|fact",
    "confidence": 0.6-1.0,
    "evidence": "brief quote from transcript",
    "why_long_term": "one sentence reason"
  }
]

If nothing worth remembering, return []. Return raw JSON only, no markdown.`;

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

function parseSourceRefs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
  } catch {
    return [];
  }
}

function mergeRefs(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming])];
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
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
  const minConfidence = 0.75;

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

  const updateMergedCandidate = db.prepare(`
    UPDATE knowledge_memory_candidates SET status = 'merged', updated_at = ? WHERE id = ?
  `);

  const updateExistingMemory = db.prepare(`
    UPDATE knowledge_memories
    SET confidence = ?, source_refs_json = ?, first_observed_at = ?, last_observed_at = ?, updated_at = ?
    WHERE id = ?
  `);

  const now = new Date().toISOString();
  const existingMemories = db.prepare(`
    SELECT id, canonical_text, category, confidence, source_refs_json, first_observed_at, last_observed_at
    FROM knowledge_memories
    WHERE status = 'active'
  `).all() as ExistingMemory[];

  const existingByCategoryAndText = new Map<string, ExistingMemory>();
  const existingByText = new Map<string, ExistingMemory>();
  for (const memory of existingMemories) {
    const normalizedText = normalizeForDedup(memory.canonical_text).slice(0, 120);
    existingByCategoryAndText.set(`${memory.category}:${normalizedText}`, memory);
    if (!existingByText.has(normalizedText)) {
      existingByText.set(normalizedText, memory);
    }
  }

  let promoted = 0;

  for (const c of candidates) {
    const normalizedText = normalizeForDedup(c.candidate_text).slice(0, 120);
    const byCategoryKey = `${c.category}:${normalizedText}`;
    const existing = existingByCategoryAndText.get(byCategoryKey) || existingByText.get(normalizedText);
    if (existing) {
      const mergedRefs = mergeRefs(parseSourceRefs(existing.source_refs_json), [c.conversation_id]);
      const confidence = existing.confidence == null
        ? c.confidence
        : Math.max(existing.confidence, c.confidence);
      const firstObservedAt = minIso(existing.first_observed_at, c.created_at);
      const latestObservedAt = maxIso(existing.last_observed_at, c.created_at);
      updateExistingMemory.run(
        confidence,
        JSON.stringify(mergedRefs),
        firstObservedAt,
        latestObservedAt,
        now,
        existing.id,
      );
      existing.confidence = confidence;
      existing.source_refs_json = JSON.stringify(mergedRefs);
      existing.first_observed_at = firstObservedAt;
      existing.last_observed_at = latestObservedAt;
      updateMergedCandidate.run(now, c.id);
      continue;
    }

    const subjectKey = extractSubjectKey(c.candidate_text, c.category);
    const memoryId = genId('km');

    insertMemory.run(
      memoryId,
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
    const inserted: ExistingMemory = {
      id: memoryId,
      canonical_text: c.candidate_text,
      category: c.category,
      confidence: c.confidence,
      source_refs_json: JSON.stringify([c.conversation_id]),
      first_observed_at: c.created_at,
      last_observed_at: c.created_at,
    };
    existingByCategoryAndText.set(byCategoryKey, inserted);
    existingByText.set(normalizedText, inserted);
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

function nextDayIso(date: string): string {
  const parts = date.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`invalid --date value: ${date}`);
  }
  const [year, month, day] = parts;
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0));
  return nextDay.toISOString();
}

function parseArgs(): { mode: 'full' | 'date'; date?: string; ai: boolean; promote: boolean; preserveExisting: boolean } {
  const dateArg = process.argv.find(a => a.startsWith('--date='));
  const noAi = process.argv.includes('--no-ai');
  const noPromote = process.argv.includes('--no-promote');
  const preserveExisting = process.argv.includes('--preserve-existing');
  if (dateArg) {
    const date = dateArg.split('=')[1];
    if (!date) {
      throw new Error('--date requires a value, e.g. --date=2026-04-15');
    }
    return { mode: 'date', date, ai: !noAi, promote: !noPromote, preserveExisting };
  }
  return { mode: 'full', ai: !noAi, promote: !noPromote, preserveExisting };
}

async function main(): Promise<void> {
  initDb();
  const args = parseArgs();

  if (args.mode === 'full') {
    console.log(`[memories] full rebuild — clearing candidates${args.preserveExisting ? ' and preserving existing memories' : ' and memories'}`);
    db.exec('DELETE FROM knowledge_memory_candidates');
    if (!args.preserveExisting) {
      db.exec('DELETE FROM knowledge_memories');
    }
  }

  const conversations = db.prepare(`
    SELECT id, started_at, title, summary, participants_json, topics_json, primary_source
    FROM knowledge_conversations
    ${args.mode === 'date' ? 'WHERE started_at >= ? AND started_at < ?' : ''}
    ORDER BY started_at ASC
  `).all(...(
    args.mode === 'date' && args.date
      ? [`${args.date}T00:00:00.000Z`, nextDayIso(args.date)]
      : []
  )) as Conversation[];

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
