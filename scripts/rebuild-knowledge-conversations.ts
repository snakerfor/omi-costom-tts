import 'dotenv/config';
import { db, initDb } from '../src/db';
import { isAIAvailable, chatCompletion, parseJSON } from '../src/services/minimax-client';

const DESKTOP_GAP_MS = 5 * 60 * 1000; // 5 min gap → split into separate blocks
const CROSS_SOURCE_OVERLAP_MS = 3 * 60 * 1000; // merge desktop block if overlaps audio by >= 3 min

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface KnowledgeEvent {
  id: string;
  event_type: string;
  started_at: string;
  ended_at: string | null;
  content_text: string | null;
  title: string | null;
  participants_json: string | null;
  conversation_ref: string | null;
  source_table: string;
}

interface ConversationDraft {
  id: string;
  primary_source: string;
  events: KnowledgeEvent[];
  started_at: string;
  ended_at: string;
  participants: Set<string>;
  conversation_refs: Set<string>;
}

// ─── Step 1: Audio conversation drafts ───

function buildAudioDrafts(): ConversationDraft[] {
  const rows = db.prepare(`
    SELECT id, event_type, started_at, ended_at, content_text, title,
           participants_json, conversation_ref, source_table
    FROM knowledge_events
    WHERE conversation_ref IS NOT NULL AND event_type = 'speech_segment'
    ORDER BY started_at ASC
  `).all() as KnowledgeEvent[];

  const byConvRef = new Map<string, KnowledgeEvent[]>();
  for (const row of rows) {
    const ref = row.conversation_ref!;
    if (!byConvRef.has(ref)) byConvRef.set(ref, []);
    byConvRef.get(ref)!.push(row);
  }

  const drafts: ConversationDraft[] = [];
  for (const [ref, events] of byConvRef) {
    events.sort((a, b) => a.started_at.localeCompare(b.started_at));
    const participants = new Set<string>();
    for (const e of events) {
      const speaker = extractSpeakerLabel(e.participants_json);
      if (speaker) participants.add(speaker);
    }

    drafts.push({
      id: genId('kc'),
      primary_source: 'audio_realtime',
      events,
      started_at: events[0].started_at,
      ended_at: events[events.length - 1].ended_at || events[events.length - 1].started_at,
      participants,
      conversation_refs: new Set([ref]),
    });
  }

  return drafts;
}

// ─── Step 2: Desktop time-block drafts ───

function buildDesktopDrafts(): ConversationDraft[] {
  const rows = db.prepare(`
    SELECT id, event_type, started_at, ended_at, content_text, title,
           participants_json, conversation_ref, source_table
    FROM knowledge_events
    WHERE conversation_ref IS NULL
    ORDER BY started_at ASC
  `).all() as KnowledgeEvent[];

  if (!rows.length) return [];

  const drafts: ConversationDraft[] = [];
  let currentBlock: KnowledgeEvent[] = [rows[0]];

  for (let i = 1; i < rows.length; i++) {
    const prevEnd = currentBlock[currentBlock.length - 1].ended_at
      || currentBlock[currentBlock.length - 1].started_at;
    const gap = new Date(rows[i].started_at).getTime() - new Date(prevEnd).getTime();

    if (gap > DESKTOP_GAP_MS) {
      drafts.push(blockToDraft(currentBlock));
      currentBlock = [rows[i]];
    } else {
      currentBlock.push(rows[i]);
    }
  }
  if (currentBlock.length) {
    drafts.push(blockToDraft(currentBlock));
  }

  return drafts;
}

function blockToDraft(events: KnowledgeEvent[]): ConversationDraft {
  return {
    id: genId('kc'),
    primary_source: 'desktop_sync',
    events,
    started_at: events[0].started_at,
    ended_at: events[events.length - 1].ended_at || events[events.length - 1].started_at,
    participants: new Set(),
    conversation_refs: new Set(),
  };
}

// ─── Step 3: Cross-source merge ───

function mergeOverlapping(audioDrafts: ConversationDraft[], desktopDrafts: ConversationDraft[]): ConversationDraft[] {
  const merged: ConversationDraft[] = [...audioDrafts];
  const usedDesktop = new Set<number>();

  for (const audio of audioDrafts) {
    const audioStart = new Date(audio.started_at).getTime();
    const audioEnd = new Date(audio.ended_at).getTime();

    for (let i = 0; i < desktopDrafts.length; i++) {
      if (usedDesktop.has(i)) continue;
      const desktop = desktopDrafts[i];
      const dStart = new Date(desktop.started_at).getTime();
      const dEnd = new Date(desktop.ended_at).getTime();

      const overlapStart = Math.max(audioStart, dStart);
      const overlapEnd = Math.min(audioEnd, dEnd);
      const overlap = overlapEnd - overlapStart;

      if (overlap >= CROSS_SOURCE_OVERLAP_MS) {
        audio.events.push(...desktop.events);
        audio.events.sort((a, b) => a.started_at.localeCompare(b.started_at));
        if (dStart < audioStart) audio.started_at = desktop.started_at;
        if (dEnd > audioEnd) audio.ended_at = desktop.ended_at;
        usedDesktop.add(i);
      }
    }
  }

  for (let i = 0; i < desktopDrafts.length; i++) {
    if (!usedDesktop.has(i)) {
      merged.push(desktopDrafts[i]);
    }
  }

  merged.sort((a, b) => a.started_at.localeCompare(b.started_at));
  return merged;
}

// ─── Step 4: Programmatic title / summary (no AI) ───

function generateProgrammaticTitle(draft: ConversationDraft): string {
  if (draft.primary_source === 'audio_realtime') {
    const speakerList = [...draft.participants].slice(0, 3).join(', ');
    const date = draft.started_at.slice(0, 10);
    const time = draft.started_at.slice(11, 16);
    return speakerList
      ? `${date} ${time} conversation with ${speakerList}`
      : `${date} ${time} audio conversation`;
  }

  const eventTypes = new Set(draft.events.map(e => e.event_type));
  const date = draft.started_at.slice(0, 10);
  const startTime = draft.started_at.slice(11, 16);
  const endTime = draft.ended_at.slice(11, 16);

  const appTitles = draft.events
    .filter(e => e.title)
    .map(e => e.title!)
    .slice(0, 3);

  if (appTitles.length) {
    return `${date} ${startTime}-${endTime} desktop: ${appTitles[0]}`;
  }
  return `${date} ${startTime}-${endTime} desktop activity (${[...eventTypes].join('+')})`;
}

function generateProgrammaticSummary(draft: ConversationDraft): string {
  const textSegments = draft.events
    .filter(e => e.content_text)
    .map(e => {
      const speaker = extractSpeakerLabel(e.participants_json);
      const prefix = speaker ? `[${speaker}] ` : '';
      return prefix + e.content_text!;
    });

  if (!textSegments.length) return '(no text content)';

  const joined = textSegments.join('\n');
  if (joined.length <= 500) return joined;
  return joined.slice(0, 497) + '...';
}

// ─── Step 5: AI enhancement (MiniMax) ───

async function enhanceWithAI(draft: ConversationDraft): Promise<{
  title: string;
  summary: string;
  topics: string[];
  actionItems: string[];
} | null> {
  if (!isAIAvailable()) return null;

  const textSegments = draft.events
    .filter(e => e.content_text)
    .slice(0, 100)
    .map(e => {
      const speaker = extractSpeakerLabel(e.participants_json);
      const time = e.started_at.slice(11, 19);
      const prefix = speaker ? `[${time} ${speaker}]` : `[${time}]`;
      return `${prefix} ${e.content_text}`;
    });

  if (textSegments.length < 2) return null;

  const transcript = textSegments.join('\n');

  const prompt = `Analyze this conversation/activity transcript and return JSON only.

<transcript>
${transcript}
</transcript>

Return exactly this JSON structure:
{
  "title": "concise title in the language of the content (max 15 words)",
  "summary": "2-3 sentence summary in the language of the content",
  "topics": ["topic1", "topic2"],
  "action_items": ["action1", "action2"]
}

Rules:
- Use the same language as the transcript content
- title should capture the main subject
- topics: max 5 items
- action_items: only include if explicitly mentioned, otherwise empty array
- Return raw JSON only, no markdown fences`;

  try {
    const text = await chatCompletion(prompt, { temperature: 0.3, maxTokens: 4096 });
    const parsed = parseJSON(text);
    return {
      title: parsed.title || '',
      summary: parsed.summary || '',
      topics: parsed.topics || [],
      actionItems: parsed.action_items || [],
    };
  } catch (err) {
    console.warn(`[AI] enhancement failed: ${err}`);
    return null;
  }
}

// ─── Step 6: Persist ───

function persistDraft(draft: ConversationDraft, ai: {
  title: string; summary: string; topics: string[]; actionItems: string[];
} | null): void {
  const now = new Date().toISOString();
  const title = ai?.title || generateProgrammaticTitle(draft);
  const summary = ai?.summary || generateProgrammaticSummary(draft);
  const topics = ai?.topics || [];
  const actionItems = ai?.actionItems || [];
  const participantsArr = [...draft.participants];

  db.prepare(`
    INSERT OR REPLACE INTO knowledge_conversations (
      id, started_at, ended_at, primary_source, source_refs_json,
      participants_json, title, summary, topics_json, action_items_json,
      quality_score, review_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    draft.id,
    draft.started_at,
    draft.ended_at,
    draft.primary_source,
    JSON.stringify([...draft.conversation_refs]),
    participantsArr.length ? JSON.stringify(participantsArr) : null,
    title,
    summary,
    JSON.stringify(topics),
    JSON.stringify(actionItems),
    null,
    ai ? 'ai_enhanced' : 'draft',
    now,
    now,
  );

  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO knowledge_conversation_items (
      id, conversation_id, event_id, item_order, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < draft.events.length; i++) {
    insertItem.run(genId('ki'), draft.id, draft.events[i].id, i, now);
  }
}

// ─── helpers ───

function extractSpeakerLabel(json: string | null): string | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    return p.speaker_name || p.speaker_identity || p.speaker_label || null;
  } catch {
    return null;
  }
}

// ─── CLI ───

function parseArgs(): { mode: 'full' | 'date'; date?: string; ai: boolean } {
  const dateArg = process.argv.find(a => a.startsWith('--date='));
  const noAi = process.argv.includes('--no-ai');
  if (dateArg) {
    return { mode: 'date', date: dateArg.split('=')[1], ai: !noAi };
  }
  return { mode: 'full', ai: !noAi };
}

async function main(): Promise<void> {
  initDb();
  const args = parseArgs();

  if (args.mode === 'date' && args.date) {
    console.log(`[conversations] date-scoped rebuild for ${args.date}`);
    const startOfDay = `${args.date}T00:00:00.000Z`;
    const endOfDay = `${args.date}T23:59:59.999Z`;
    const convIds = db.prepare(`
      SELECT id FROM knowledge_conversations WHERE started_at >= ? AND started_at <= ?
    `).all(startOfDay, endOfDay) as Array<{ id: string }>;
    for (const c of convIds) {
      db.prepare('DELETE FROM knowledge_conversation_items WHERE conversation_id = ?').run(c.id);
    }
    db.prepare(`
      DELETE FROM knowledge_conversations WHERE started_at >= ? AND started_at <= ?
    `).run(startOfDay, endOfDay);
  } else {
    console.log('[conversations] full rebuild');
    db.exec('DELETE FROM knowledge_conversation_items');
    db.exec('DELETE FROM knowledge_conversations');
  }

  const audioDrafts = buildAudioDrafts();
  console.log(`[conversations] audio drafts: ${audioDrafts.length}`);

  const desktopDrafts = buildDesktopDrafts();
  console.log(`[conversations] desktop drafts: ${desktopDrafts.length}`);

  const merged = mergeOverlapping(audioDrafts, desktopDrafts);
  console.log(`[conversations] merged drafts: ${merged.length}`);

  let aiCount = 0;
  for (let idx = 0; idx < merged.length; idx++) {
    const draft = merged[idx];
    let aiResult = null;
    if (args.ai) {
      const tag = `[${idx + 1}/${merged.length}]`;
      const evtCount = draft.events.filter(e => e.content_text).length;
      if (evtCount >= 2) {
        console.log(`${tag} enhancing "${draft.started_at.slice(0, 16)}" (${evtCount} text events)...`);
        aiResult = await enhanceWithAI(draft);
        if (aiResult) {
          aiCount++;
          console.log(`${tag} ✓ AI: "${aiResult.title}"`);
        } else {
          console.log(`${tag} ✗ AI skipped/failed, using programmatic`);
        }
      } else {
        console.log(`${tag} skip AI (only ${evtCount} text events)`);
      }
    }

    db.transaction(() => persistDraft(draft, aiResult))();
  }

  console.log(`\n[conversations] persisted: ${merged.length} conversations (${aiCount} AI-enhanced)`);

  const stats = db.prepare(`
    SELECT review_status, COUNT(*) AS cnt FROM knowledge_conversations GROUP BY review_status
  `).all() as Array<{ review_status: string; cnt: number }>;
  console.log('\n[conversations] final stats:');
  for (const s of stats) {
    console.log(`  ${s.review_status}: ${s.cnt}`);
  }
}

main().catch(err => {
  console.error('[conversations] failed:', err);
  process.exit(1);
});
