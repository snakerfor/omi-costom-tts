import 'dotenv/config';
import { db, initDb } from '../src/db';
import { isAIAvailable, chatCompletion } from '../src/services/minimax-client';

// ─── arg parsing ───

function getCommand(): string {
  return process.argv[2] || 'help';
}

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── timeline ───

function cmdTimeline(): void {
  const from = getFlag('from') || `${todayISO()}T00:00:00.000Z`;
  const to = getFlag('to') || `${todayISO()}T23:59:59.999Z`;
  const limit = parseInt(getFlag('limit') || '100', 10);
  const eventType = getFlag('type');

  let sql = `
    SELECT id, event_type, started_at, ended_at,
           content_text, title, participants_json, source_table, source_row_id
    FROM knowledge_events
    WHERE started_at >= ? AND started_at <= ?
  `;
  const params: any[] = [from, to];

  if (eventType) {
    sql += ' AND event_type = ?';
    params.push(eventType);
  }

  sql += ' ORDER BY started_at ASC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    event_type: string;
    started_at: string;
    ended_at: string | null;
    content_text: string | null;
    title: string | null;
    participants_json: string | null;
    source_table: string;
    source_row_id: string;
  }>;

  if (!rows.length) {
    console.log(`No events found between ${from} and ${to}`);
    return;
  }

  console.log(`Timeline: ${from} → ${to}  (${rows.length} events)\n`);

  for (const row of rows) {
    const time = row.started_at.slice(11, 19);
    const tag = row.event_type.padEnd(20);
    const speaker = parseSpeaker(row.participants_json);
    const text = truncate(row.content_text || row.title || '(no content)', 120);

    if (speaker) {
      console.log(`  ${time}  [${tag}]  ${speaker}: ${text}`);
    } else {
      console.log(`  ${time}  [${tag}]  ${text}`);
    }
  }

  console.log(`\n  Total: ${rows.length} events`);
}

// ─── conversations (from knowledge_conversations table) ───

function cmdConversations(): void {
  const from = getFlag('from') || `${todayISO()}T00:00:00.000Z`;
  const to = getFlag('to') || `${todayISO()}T23:59:59.999Z`;
  const limit = parseInt(getFlag('limit') || '20', 10);
  const convId = getFlag('id');

  if (convId) {
    showConversationDetail(convId);
    return;
  }

  const rows = db.prepare(`
    SELECT
      kc.id, kc.started_at, kc.ended_at, kc.primary_source,
      kc.participants_json, kc.title, kc.summary,
      kc.topics_json, kc.action_items_json, kc.review_status,
      (SELECT COUNT(*) FROM knowledge_conversation_items WHERE conversation_id = kc.id) AS event_count
    FROM knowledge_conversations kc
    WHERE kc.started_at >= ? AND kc.started_at <= ?
    ORDER BY kc.started_at ASC
    LIMIT ?
  `).all(from, to, limit) as Array<{
    id: string;
    started_at: string;
    ended_at: string | null;
    primary_source: string;
    participants_json: string | null;
    title: string | null;
    summary: string | null;
    topics_json: string | null;
    action_items_json: string | null;
    review_status: string;
    event_count: number;
  }>;

  if (!rows.length) {
    console.log(`No conversations found between ${from} and ${to}`);
    console.log('Hint: run "npm run rebuild:conversations" first.');
    return;
  }

  console.log(`Conversations: ${from} → ${to}  (${rows.length} results)\n`);

  for (const row of rows) {
    const startTime = row.started_at.slice(11, 19);
    const endTime = row.ended_at ? row.ended_at.slice(11, 19) : '??:??:??';
    const date = row.started_at.slice(0, 10);
    const source = row.primary_source === 'audio_realtime' ? 'audio' : 'desktop';
    const status = row.review_status;

    console.log(`  ${date} [${startTime} - ${endTime}]  ${source}  ${row.event_count} events  [${status}]`);
    if (row.title) console.log(`    title: ${row.title}`);
    if (row.participants_json) {
      try {
        const arr = JSON.parse(row.participants_json);
        if (Array.isArray(arr) && arr.length) {
          console.log(`    speakers: ${arr.join(', ')}`);
        }
      } catch {}
    }
    if (row.summary) console.log(`    summary: ${truncate(row.summary, 120)}`);
    if (row.topics_json) {
      try {
        const topics = JSON.parse(row.topics_json);
        if (Array.isArray(topics) && topics.length) {
          console.log(`    topics: ${topics.join(', ')}`);
        }
      } catch {}
    }
    if (row.action_items_json) {
      try {
        const items = JSON.parse(row.action_items_json);
        if (Array.isArray(items) && items.length) {
          for (const item of items) console.log(`    ☐ ${item}`);
        }
      } catch {}
    }
    console.log(`    id: ${row.id}`);
    console.log('');
  }
}

function showConversationDetail(convId: string): void {
  const conv = db.prepare(`
    SELECT * FROM knowledge_conversations WHERE id = ?
  `).get(convId) as any;

  if (!conv) {
    console.log(`Conversation ${convId} not found.`);
    return;
  }

  console.log(`Conversation: ${conv.id}\n`);
  console.log(`  Time:    ${conv.started_at} → ${conv.ended_at || '?'}`);
  console.log(`  Source:  ${conv.primary_source}`);
  console.log(`  Status:  ${conv.review_status}`);
  if (conv.title) console.log(`  Title:   ${conv.title}`);
  if (conv.participants_json) console.log(`  Speakers: ${conv.participants_json}`);
  if (conv.summary) console.log(`  Summary: ${conv.summary}`);
  if (conv.topics_json) console.log(`  Topics:  ${conv.topics_json}`);
  if (conv.action_items_json) console.log(`  Actions: ${conv.action_items_json}`);

  const items = db.prepare(`
    SELECT ki.item_order, ke.event_type, ke.started_at, ke.content_text,
           ke.title AS event_title, ke.participants_json
    FROM knowledge_conversation_items ki
    JOIN knowledge_events ke ON ke.id = ki.event_id
    WHERE ki.conversation_id = ?
    ORDER BY ki.item_order ASC
  `).all(convId) as Array<{
    item_order: number;
    event_type: string;
    started_at: string;
    content_text: string | null;
    event_title: string | null;
    participants_json: string | null;
  }>;

  console.log(`\n  Events (${items.length}):\n`);
  for (const item of items) {
    const time = item.started_at.slice(11, 19);
    const speaker = parseSpeaker(item.participants_json);
    const text = truncate(item.content_text || item.event_title || '', 100);
    if (speaker) {
      console.log(`    ${time} [${item.event_type}] ${speaker}: ${text}`);
    } else {
      console.log(`    ${time} [${item.event_type}] ${text}`);
    }
  }
}

// ─── memories ───

function cmdMemories(): void {
  const category = getFlag('category');
  const limit = parseInt(getFlag('limit') || '50', 10);
  const showCandidates = process.argv.includes('--candidates');

  if (showCandidates) {
    showMemoryCandidates(category, limit);
    return;
  }

  let sql = `
    SELECT id, canonical_text, category, subject_key, confidence,
           source_refs_json, first_observed_at, last_observed_at, status
    FROM knowledge_memories
    WHERE status = 'active'
  `;
  const params: any[] = [];

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }

  sql += ' ORDER BY last_observed_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    canonical_text: string;
    category: string;
    subject_key: string | null;
    confidence: number | null;
    source_refs_json: string;
    first_observed_at: string | null;
    last_observed_at: string | null;
    status: string;
  }>;

  if (!rows.length) {
    console.log('No active memories found.');
    console.log('Hint: run "npm run rebuild:memories" first.');
    return;
  }

  console.log(`Active Memories (${rows.length})\n`);

  let currentCategory = '';
  for (const row of rows) {
    if (row.category !== currentCategory) {
      currentCategory = row.category;
      console.log(`── ${currentCategory} ──`);
    }
    const conf = row.confidence != null ? ` (${(row.confidence * 100).toFixed(0)}%)` : '';
    const subject = row.subject_key ? ` [${row.subject_key}]` : '';
    const observed = row.first_observed_at ? row.first_observed_at.slice(0, 10) : '?';
    console.log(`  ${row.canonical_text}${subject}${conf}`);
    console.log(`    first seen: ${observed}  id: ${row.id}`);
  }

  const totalStats = db.prepare(`
    SELECT category, COUNT(*) AS cnt FROM knowledge_memories WHERE status = 'active' GROUP BY category ORDER BY cnt DESC
  `).all() as Array<{ category: string; cnt: number }>;
  console.log('\nSummary:');
  for (const s of totalStats) console.log(`  ${s.category}: ${s.cnt}`);
}

function showMemoryCandidates(category: string | undefined, limit: number): void {
  let sql = `
    SELECT mc.id, mc.candidate_text, mc.category, mc.confidence, mc.status,
           mc.conversation_id, mc.created_at
    FROM knowledge_memory_candidates mc
  `;
  const params: any[] = [];
  const clauses: string[] = [];

  if (category) {
    clauses.push('mc.category = ?');
    params.push(category);
  }

  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY mc.created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    candidate_text: string;
    category: string;
    confidence: number | null;
    status: string;
    conversation_id: string;
    created_at: string;
  }>;

  if (!rows.length) {
    console.log('No memory candidates found.');
    return;
  }

  console.log(`Memory Candidates (${rows.length})\n`);
  for (const row of rows) {
    const conf = row.confidence != null ? `${(row.confidence * 100).toFixed(0)}%` : '?';
    const status = row.status.padEnd(10);
    console.log(`  [${status}] ${row.category.padEnd(16)} ${conf.padStart(4)}  ${truncate(row.candidate_text, 80)}`);
    console.log(`    from: ${row.conversation_id}  date: ${row.created_at.slice(0, 10)}`);
  }
}

// ─── ask ───

async function cmdAsk(): Promise<void> {
  const question = process.argv.slice(3).filter(a => !a.startsWith('--')).join(' ');
  if (!question) {
    console.log('Usage: omimem ask "your question here"');
    return;
  }

  const memories = db.prepare(`
    SELECT canonical_text, category, confidence
    FROM knowledge_memories WHERE status = 'active'
    ORDER BY last_observed_at DESC LIMIT 30
  `).all() as Array<{ canonical_text: string; category: string; confidence: number | null }>;

  const recentConvs = db.prepare(`
    SELECT title, summary, started_at, participants_json
    FROM knowledge_conversations
    ORDER BY started_at DESC LIMIT 10
  `).all() as Array<{
    title: string | null;
    summary: string | null;
    started_at: string;
    participants_json: string | null;
  }>;

  const memoryBlock = memories.length
    ? memories.map(m => `- [${m.category}] ${m.canonical_text}`).join('\n')
    : '(no memories yet)';

  const convBlock = recentConvs.length
    ? recentConvs.map(c => {
        const date = c.started_at.slice(0, 10);
        return `- ${date}: ${c.title || '(untitled)'}\n  ${c.summary || ''}`;
      }).join('\n')
    : '(no conversations yet)';

  if (!isAIAvailable()) {
    console.log('No MiniMax API key found. Showing raw context instead.\n');
    console.log(`Question: ${question}\n`);
    console.log('=== Long-term Memories ===');
    console.log(memoryBlock);
    console.log('\n=== Recent Conversations ===');
    console.log(convBlock);
    console.log('\nSet MINIMAX_API_KEY or install OpenClaw with MiniMax to get AI-powered answers.');
    return;
  }

  const prompt = `You are a personal knowledge assistant. Answer the user's question using ONLY the provided context.

<long_term_memories>
${memoryBlock}
</long_term_memories>

<recent_conversations>
${convBlock}
</recent_conversations>

<question>
${question}
</question>

Rules:
- Answer in the same language as the question
- Only use information from the provided context
- If the context doesn't contain enough information, say so
- Be concise and direct
- Cite which memory or conversation your answer comes from`;

  try {
    const answer = await chatCompletion(prompt, { temperature: 0.3, maxTokens: 1024 });
    console.log(answer);
  } catch (err) {
    console.error(`ask failed: ${err}`);
  }
}

// ─── stats ───

function cmdStats(): void {
  const stats = db.prepare(`
    SELECT event_type, COUNT(*) AS cnt,
           MIN(started_at) AS earliest,
           MAX(started_at) AS latest
    FROM knowledge_events
    GROUP BY event_type
    ORDER BY cnt DESC
  `).all() as Array<{
    event_type: string;
    cnt: number;
    earliest: string;
    latest: string;
  }>;

  const total = db.prepare('SELECT COUNT(*) AS total FROM knowledge_events').get() as { total: number };

  console.log('Knowledge Events Stats\n');
  for (const s of stats) {
    console.log(`  ${s.event_type.padEnd(22)} ${String(s.cnt).padStart(6)}  (${s.earliest.slice(0, 10)} ~ ${s.latest.slice(0, 10)})`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${String(total.total).padStart(6)}`);
}

// ─── export ───

function cmdExport(): void {
  const day = getFlag('day') || todayISO();
  const format = getFlag('format') || 'md';
  const from = `${day}T00:00:00.000Z`;
  const to = `${day}T23:59:59.999Z`;

  const rows = db.prepare(`
    SELECT id, event_type, started_at, ended_at,
           content_text, title, participants_json, source_table
    FROM knowledge_events
    WHERE started_at >= ? AND started_at <= ?
    ORDER BY started_at ASC
  `).all(from, to) as Array<{
    id: string;
    event_type: string;
    started_at: string;
    ended_at: string | null;
    content_text: string | null;
    title: string | null;
    participants_json: string | null;
    source_table: string;
  }>;

  if (format === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`# Knowledge Events — ${day}\n`);
  console.log(`Total: ${rows.length} events\n`);

  let currentHour = '';
  for (const row of rows) {
    const hour = row.started_at.slice(11, 13);
    if (hour !== currentHour) {
      currentHour = hour;
      console.log(`\n## ${hour}:00\n`);
    }

    const time = row.started_at.slice(11, 19);
    const speaker = parseSpeaker(row.participants_json);
    const content = row.content_text || row.title || '';

    if (row.event_type === 'speech_segment') {
      console.log(`- **${time}** ${speaker ? `[${speaker}]` : ''} ${content}`);
    } else if (row.event_type === 'screenshot') {
      console.log(`- **${time}** _screenshot_ ${row.title || ''}${content ? ` — ${truncate(content, 80)}` : ''}`);
    } else if (row.event_type === 'observation') {
      console.log(`- **${time}** _observation_ ${row.title || ''}: ${truncate(content, 100)}`);
    } else {
      console.log(`- **${time}** [${row.event_type}] ${truncate(content, 100)}`);
    }
  }
}

// ─── helpers ───

function parseSpeaker(json: string | null): string | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    return p.speaker_name || p.speaker_identity || p.speaker_label || null;
  } catch {
    return null;
  }
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + '...';
}

// ─── help ───

function printHelp(): void {
  console.log(`
omimem — Personal Knowledge Layer CLI

Commands:
  timeline       Show unified event timeline
  conversations  Show aggregated conversations (from knowledge_conversations)
  memories       Show long-term memories
  ask            Ask a question against your knowledge base
  stats          Show knowledge_events statistics
  export         Export a day's events as markdown or JSON

Options:
  --from <ISO>      Start time (default: today 00:00)
  --to <ISO>        End time   (default: today 23:59)
  --limit <n>       Max results (default varies)
  --type <type>     Filter event_type (timeline only)
  --id <id>         Show conversation detail (conversations only)
  --category <cat>  Filter memory category (memories only)
  --candidates      Show candidates instead of formal memories
  --day <date>      Date for export (default: today)
  --format <fmt>    md or json (export only)

Examples:
  npx ts-node scripts/omimem.ts timeline
  npx ts-node scripts/omimem.ts timeline --from 2026-04-12T00:00:00Z --to 2026-04-12T23:59:59Z
  npx ts-node scripts/omimem.ts conversations --from 2026-04-01 --to 2026-04-12
  npx ts-node scripts/omimem.ts conversations --id kc_abc123
  npx ts-node scripts/omimem.ts memories
  npx ts-node scripts/omimem.ts memories --category person
  npx ts-node scripts/omimem.ts memories --candidates
  npx ts-node scripts/omimem.ts ask "我最近在推进什么事情？"
  npx ts-node scripts/omimem.ts stats
  npx ts-node scripts/omimem.ts export --day 2026-04-12 --format md
`);
}

// ─── main ───

async function main(): Promise<void> {
  initDb();

  const cmd = getCommand();
  switch (cmd) {
    case 'timeline':
      cmdTimeline();
      break;
    case 'conversations':
      cmdConversations();
      break;
    case 'memories':
      cmdMemories();
      break;
    case 'ask':
      await cmdAsk();
      break;
    case 'stats':
      cmdStats();
      break;
    case 'export':
      cmdExport();
      break;
    default:
      printHelp();
      break;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
