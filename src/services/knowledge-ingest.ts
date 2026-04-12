/**
 * Incremental knowledge layer sync.
 *
 * Two tiers:
 *   1. syncNewEvents()         — lightweight, call after every data ingestion
 *   2. aggregateAndEnhance()   — heavier, call on a timer (involves AI)
 */
import { db } from '../db';
import { isAIAvailable, chatCompletion, parseJSON } from './minimax-client';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ═══════════════════════════════════════════════════════════════════
// Tier 1: Incremental event sync (fast, no AI)
// ═══════════════════════════════════════════════════════════════════

const insertEvent = () => db.prepare(`
  INSERT OR IGNORE INTO knowledge_events (
    id, source_type, source_table, source_row_id, source_key,
    session_ref, conversation_ref, event_type,
    started_at, ended_at, content_text, title,
    participants_json, metadata_json, quality_score, dedupe_key,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function syncConversationSegments(conversationId: string): number {
  const rows = db.prepare(`
    SELECT cs.id, cs.absolute_start_time, cs.absolute_end_time, cs.text,
           cs.speaker_label, cs.speaker_id, cs.speaker_name, cs.speaker_identity,
           cs.confidence, c.session_id
    FROM conversation_segments cs
    LEFT JOIN conversations c ON c.id = cs.conversation_id
    WHERE cs.conversation_id = ?
      AND cs.absolute_start_time IS NOT NULL
      AND cs.text IS NOT NULL AND cs.text != ''
  `).all(conversationId) as any[];

  const stmt = insertEvent();
  const now = nowIso();
  let count = 0;

  for (const row of rows) {
    const participants = JSON.stringify({
      speaker_label: row.speaker_label,
      speaker_id: row.speaker_id,
      speaker_name: row.speaker_name,
      speaker_identity: row.speaker_identity,
    });

    const result = stmt.run(
      genId('ke'), 'audio_realtime', 'conversation_segments', row.id, null,
      row.session_id, conversationId, 'speech_segment',
      row.absolute_start_time, row.absolute_end_time, row.text, null,
      participants, null, row.confidence, `speech_segment:${row.id}`,
      now, now,
    ) as { changes: number };
    count += result.changes;
  }
  return count;
}

export function syncOmiMetadataBatch(sourceKey: string, entities: string[]): number {
  const now = nowIso();
  const stmt = insertEvent();
  let total = 0;

  if (entities.includes('transcription_segments')) {
    const rows = db.prepare(`
      SELECT seg.id, seg.source_key, seg.source_session_id, seg.speaker, seg.speaker_label,
             seg.text, seg.start_time, seg.end_time,
             sess.started_at AS session_started_at
      FROM omi_transcription_segments seg
      LEFT JOIN omi_transcription_sessions sess
        ON seg.source_key = sess.source_key AND seg.source_session_id = sess.source_session_id
      WHERE seg.source_key = ? AND seg.text IS NOT NULL AND seg.text != ''
        AND NOT EXISTS (SELECT 1 FROM knowledge_events WHERE dedupe_key = 'desktop_transcript:' || seg.id)
    `).all(sourceKey) as any[];

    for (const row of rows) {
      const baseTime = row.session_started_at ? new Date(row.session_started_at).getTime() : 0;
      let startedAt = row.session_started_at || now;
      let endedAt: string | null = null;
      if (baseTime && row.start_time != null) {
        startedAt = new Date(baseTime + row.start_time * 1000).toISOString();
        if (row.end_time != null) endedAt = new Date(baseTime + row.end_time * 1000).toISOString();
      }
      const participants = row.speaker_label ? JSON.stringify({ speaker_label: row.speaker_label, speaker_index: row.speaker }) : null;

      const r = stmt.run(
        genId('ke'), 'desktop_sync', 'omi_transcription_segments', row.id, row.source_key,
        `transcription_session:${row.source_session_id}`, null, 'desktop_transcript',
        startedAt, endedAt, row.text, null,
        participants, null, null, `desktop_transcript:${row.id}`,
        now, now,
      ) as { changes: number };
      total += r.changes;
    }
  }

  if (entities.includes('screenshots')) {
    const rows = db.prepare(`
      SELECT id, source_key, ts, app_name, window_title, ocr_text, image_path, video_chunk_path, frame_offset
      FROM omi_screenshots
      WHERE source_key = ? AND ts IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM knowledge_events WHERE dedupe_key = 'screenshot:' || id)
    `).all(sourceKey) as any[];

    for (const row of rows) {
      const titleStr = [row.app_name, row.window_title].filter(Boolean).join(' - ');
      const metadata = JSON.stringify({ image_path: row.image_path, video_chunk_path: row.video_chunk_path, frame_offset: row.frame_offset });

      const r = stmt.run(
        genId('ke'), 'desktop_sync', 'omi_screenshots', row.id, row.source_key,
        null, null, 'screenshot',
        row.ts, null, row.ocr_text, titleStr || null,
        null, metadata, null, `screenshot:${row.id}`,
        now, now,
      ) as { changes: number };
      total += r.changes;
    }
  }

  if (entities.includes('observations')) {
    const screenshotTsLookup = new Map<number, string>();
    const ssRows = db.prepare('SELECT source_screenshot_id, ts FROM omi_screenshots WHERE source_key = ?').all(sourceKey) as any[];
    for (const ss of ssRows) screenshotTsLookup.set(ss.source_screenshot_id, ss.ts);

    const rows = db.prepare(`
      SELECT id, source_key, source_screenshot_id, app_name, context_summary,
             current_activity, has_task, task_title, created_at AS obs_created_at
      FROM omi_observations
      WHERE source_key = ?
        AND NOT EXISTS (SELECT 1 FROM knowledge_events WHERE dedupe_key = 'observation:' || id)
    `).all(sourceKey) as any[];

    for (const row of rows) {
      const startedAt = (row.source_screenshot_id != null ? screenshotTsLookup.get(row.source_screenshot_id) : null) || row.obs_created_at;
      const contentParts = [row.context_summary, row.current_activity, row.task_title ? `[task] ${row.task_title}` : null].filter(Boolean);
      const metadata = JSON.stringify({ app_name: row.app_name, has_task: row.has_task === 1, source_screenshot_id: row.source_screenshot_id });

      const r = stmt.run(
        genId('ke'), 'desktop_sync', 'omi_observations', row.id, row.source_key,
        null, null, 'observation',
        startedAt, null, contentParts.join('\n') || null, row.app_name,
        null, metadata, null, `observation:${row.id}`,
        now, now,
      ) as { changes: number };
      total += r.changes;
    }
  }

  return total;
}

// ═══════════════════════════════════════════════════════════════════
// Tier 2: Conversation aggregation + Memory extraction (with AI)
// ═══════════════════════════════════════════════════════════════════

const DESKTOP_GAP_MS = 5 * 60 * 1000;

interface PendingConvRef {
  conversation_ref: string;
  event_count: number;
}

export async function aggregateNewConversations(): Promise<number> {
  const existingRefs = new Set(
    (db.prepare(`SELECT json_each.value AS ref FROM knowledge_conversations, json_each(source_refs_json)`).all() as any[])
      .map((r: any) => r.ref)
  );

  const audioRefs = db.prepare(`
    SELECT conversation_ref, COUNT(*) AS event_count
    FROM knowledge_events
    WHERE conversation_ref IS NOT NULL AND event_type = 'speech_segment'
    GROUP BY conversation_ref
  `).all() as PendingConvRef[];

  const newRefs = audioRefs.filter(r => !existingRefs.has(r.conversation_ref));
  let created = 0;

  for (const ref of newRefs) {
    const events = db.prepare(`
      SELECT id, event_type, started_at, ended_at, content_text, title, participants_json
      FROM knowledge_events
      WHERE conversation_ref = ?
      ORDER BY started_at ASC
    `).all(ref.conversation_ref) as any[];

    if (!events.length) continue;

    const convId = genId('kc');
    const now = nowIso();
    const participants = new Set<string>();

    for (const e of events) {
      const speaker = extractSpeaker(e.participants_json);
      if (speaker) participants.add(speaker);
    }

    const startedAt = events[0].started_at;
    const endedAt = events[events.length - 1].ended_at || events[events.length - 1].started_at;

    let title = generateTitle(startedAt, [...participants]);
    let summary = generateSummary(events);
    let topics: string[] = [];
    let actionItems: string[] = [];
    let reviewStatus = 'draft';

    if (isAIAvailable() && events.length >= 2) {
      try {
        const aiResult = await enhanceConversation(events);
        if (aiResult) {
          title = aiResult.title || title;
          summary = aiResult.summary || summary;
          topics = aiResult.topics;
          actionItems = aiResult.actionItems;
          reviewStatus = 'ai_enhanced';
        }
      } catch (err) {
        console.warn(`[knowledge] AI enhance failed for ${ref.conversation_ref}: ${err}`);
      }
    }

    db.transaction(() => {
      db.prepare(`
        INSERT INTO knowledge_conversations (
          id, started_at, ended_at, primary_source, source_refs_json,
          participants_json, title, summary, topics_json, action_items_json,
          quality_score, review_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        convId, startedAt, endedAt, 'audio_realtime',
        JSON.stringify([ref.conversation_ref]),
        [...participants].length ? JSON.stringify([...participants]) : null,
        title, summary, JSON.stringify(topics), JSON.stringify(actionItems),
        null, reviewStatus, now, now,
      );

      const insertItem = db.prepare(`
        INSERT OR IGNORE INTO knowledge_conversation_items (id, conversation_id, event_id, item_order, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < events.length; i++) {
        insertItem.run(genId('ki'), convId, events[i].id, i, now);
      }
    })();

    created++;
  }

  return created;
}

export async function extractNewMemories(): Promise<number> {
  const unprocessedConvs = db.prepare(`
    SELECT id, started_at, title, summary, participants_json, topics_json, primary_source
    FROM knowledge_conversations
    WHERE id NOT IN (SELECT DISTINCT conversation_id FROM knowledge_memory_candidates)
    ORDER BY started_at ASC
  `).all() as any[];

  if (!unprocessedConvs.length) return 0;

  let totalPromoted = 0;

  for (const conv of unprocessedConvs) {
    const events = db.prepare(`
      SELECT ke.content_text, ke.participants_json, ke.started_at, ke.event_type
      FROM knowledge_conversation_items ki
      JOIN knowledge_events ke ON ke.id = ki.event_id
      WHERE ki.conversation_id = ?
      ORDER BY ki.item_order ASC
    `).all(conv.id) as any[];

    const textParts = events
      .filter((e: any) => e.content_text)
      .slice(0, 80)
      .map((e: any) => {
        const speaker = extractSpeaker(e.participants_json);
        const time = e.started_at.slice(11, 19);
        return speaker ? `[${time} ${speaker}] ${e.content_text}` : `[${time}] ${e.content_text}`;
      });

    if (textParts.length < 2) continue;

    let candidates: any[] = [];

    if (isAIAvailable()) {
      try {
        candidates = await extractMemoryCandidatesAI(conv, textParts.join('\n'));
      } catch (err) {
        console.warn(`[knowledge] memory extraction failed for ${conv.id}: ${err}`);
      }
    }

    if (!candidates.length) {
      candidates = extractMemoryCandidatesRules(conv);
    }

    if (!candidates.length) continue;

    const now = nowIso();
    const CATEGORIES = ['person', 'relationship', 'project', 'preference', 'habit', 'work_context', 'recurring_task', 'fact'];
    const insertCandidate = db.prepare(`
      INSERT OR IGNORE INTO knowledge_memory_candidates (
        id, conversation_id, candidate_text, category, confidence,
        evidence_json, dedupe_key, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMemory = db.prepare(`
      INSERT OR IGNORE INTO knowledge_memories (
        id, canonical_text, category, subject_key, confidence,
        source_refs_json, first_observed_at, last_observed_at,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const minConfidence = isAIAvailable() ? 0.6 : 0.35;

    db.transaction(() => {
      for (const c of candidates) {
        const category = CATEGORIES.includes(c.category) ? c.category : 'fact';
        const normalized = c.candidate_text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, ' ').trim();
        const dedupeKey = `mc:${category}:${normalized.slice(0, 120)}`;

        insertCandidate.run(
          genId('mc'), conv.id, c.candidate_text, category, c.confidence,
          JSON.stringify({ evidence: c.evidence, why_long_term: c.why_long_term }),
          dedupeKey, 'pending', now, now,
        );

        if (c.confidence >= minConfidence) {
          const subjectKey = (category === 'person' || category === 'relationship')
            ? (c.candidate_text.match(/^(\S+)/) || [])[1] || null
            : null;

          insertMemory.run(
            genId('km'), c.candidate_text, category, subjectKey, c.confidence,
            JSON.stringify([conv.id]), conv.started_at, conv.started_at,
            'active', now, now,
          );

          db.prepare('UPDATE knowledge_memory_candidates SET status = ?, updated_at = ? WHERE dedupe_key = ?')
            .run('accepted', now, dedupeKey);
          totalPromoted++;
        }
      }
    })();
  }

  return totalPromoted;
}

// ═══════════════════════════════════════════════════════════════════
// Background scheduler
// ═══════════════════════════════════════════════════════════════════

let schedulerTimer: NodeJS.Timeout | null = null;
const AGGREGATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function startKnowledgeScheduler(): void {
  if (schedulerTimer) return;

  console.log(`[knowledge] scheduler started (interval: ${AGGREGATE_INTERVAL_MS / 1000}s)`);

  schedulerTimer = setInterval(async () => {
    try {
      const convs = await aggregateNewConversations();
      const mems = await extractNewMemories();
      if (convs || mems) {
        console.log(`[knowledge] scheduled run: ${convs} new conversations, ${mems} new memories`);
      }
    } catch (err) {
      console.error('[knowledge] scheduled aggregation failed:', err);
    }
  }, AGGREGATE_INTERVAL_MS);
}

export function stopKnowledgeScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function extractSpeaker(json: string | null): string | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    return p.speaker_name || p.speaker_identity || p.speaker_label || null;
  } catch { return null; }
}

function generateTitle(startedAt: string, speakers: string[]): string {
  const date = startedAt.slice(0, 10);
  const time = startedAt.slice(11, 16);
  if (speakers.length) return `${date} ${time} conversation with ${speakers.slice(0, 3).join(', ')}`;
  return `${date} ${time} audio conversation`;
}

function generateSummary(events: any[]): string {
  const parts = events
    .filter((e: any) => e.content_text)
    .map((e: any) => {
      const speaker = extractSpeaker(e.participants_json);
      return speaker ? `[${speaker}] ${e.content_text}` : e.content_text;
    });
  const joined = parts.join('\n');
  return joined.length <= 500 ? joined : joined.slice(0, 497) + '...';
}

async function enhanceConversation(events: any[]): Promise<{
  title: string; summary: string; topics: string[]; actionItems: string[];
} | null> {
  const textSegments = events
    .filter((e: any) => e.content_text)
    .slice(0, 100)
    .map((e: any) => {
      const speaker = extractSpeaker(e.participants_json);
      const time = e.started_at.slice(11, 19);
      return speaker ? `[${time} ${speaker}] ${e.content_text}` : `[${time}] ${e.content_text}`;
    });

  if (textSegments.length < 2) return null;

  const prompt = `Analyze this conversation transcript and return JSON only.

<transcript>
${textSegments.join('\n')}
</transcript>

Return exactly this JSON:
{"title":"concise title in content language (max 15 words)","summary":"2-3 sentence summary in content language","topics":["topic1","topic2"],"action_items":["item1"]}

Rules: same language as content, topics max 5, action_items only if explicit, raw JSON only.`;

  const text = await chatCompletion(prompt, { temperature: 0.3, maxTokens: 1024 });
  const parsed = parseJSON(text);
  return { title: parsed.title || '', summary: parsed.summary || '', topics: parsed.topics || [], actionItems: parsed.action_items || [] };
}

async function extractMemoryCandidatesAI(conv: any, transcript: string): Promise<any[]> {
  const prompt = `Extract long-term memory facts from this conversation.

<context>Conversation: ${conv.title || conv.id}, Time: ${conv.started_at}</context>
<transcript>${transcript.slice(0, 6000)}</transcript>

Extract facts valid beyond today: people, relationships, projects, preferences, habits, recurring tasks.
Do NOT extract: temporary states, one-time todos, greetings, timestamps.

Return JSON array: [{"candidate_text":"...","category":"person|relationship|project|preference|habit|work_context|recurring_task|fact","confidence":0.0-1.0,"evidence":"...","why_long_term":"..."}]
If nothing qualifies, return []. Raw JSON only.`;

  const text = await chatCompletion(prompt, { temperature: 0.2, maxTokens: 2048 });
  const arr = parseJSON<any[]>(text);
  if (!Array.isArray(arr)) return [];
  return arr.filter((c: any) => c.candidate_text && c.category && typeof c.confidence === 'number');
}

function extractMemoryCandidatesRules(conv: any): any[] {
  const candidates: any[] = [];
  if (conv.participants_json) {
    try {
      const speakers = JSON.parse(conv.participants_json);
      if (Array.isArray(speakers)) {
        for (const s of speakers) {
          if (s && s !== '?' && !/^\d+$/.test(s)) {
            candidates.push({
              candidate_text: `${s} appeared in a conversation on ${conv.started_at.slice(0, 10)}`,
              category: 'person', confidence: 0.5,
              evidence: `conversation ${conv.id}`, why_long_term: 'person identification',
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
              category: 'work_context', confidence: 0.4,
              evidence: `conversation ${conv.id}`, why_long_term: 'recurring topic',
            });
          }
        }
      }
    } catch {}
  }
  return candidates;
}
