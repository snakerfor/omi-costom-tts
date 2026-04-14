import 'dotenv/config';
import { db } from '../src/db';

const OMI_API_KEY = process.env.OMI_DEV_API_KEY;
if (!OMI_API_KEY) {
  console.error('Set OMI_DEV_API_KEY in .env');
  process.exit(1);
}

const BASE = 'https://api.omi.me/v1/dev/user';
const HEADERS = { Authorization: `Bearer ${OMI_API_KEY}` };

async function fetchAll(endpoint: string, pageSize = 100): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  while (true) {
    const url = `${BASE}/${endpoint}?limit=${pageSize}&offset=${offset}`;
    const resp = await fetch(url, { headers: HEADERS });
    if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
    const page = await resp.json() as any[];
    all.push(...page);
    console.log(`  fetched ${endpoint} offset=${offset} got=${page.length} total=${all.length}`);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS omi_cloud_conversations (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      title TEXT,
      overview TEXT,
      emoji TEXT,
      category TEXT,
      language TEXT,
      source TEXT,
      folder_id TEXT,
      folder_name TEXT,
      action_items_json TEXT,
      events_json TEXT,
      transcript_segments_json TEXT,
      geolocation_json TEXT,
      raw_json TEXT,
      pulled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS omi_cloud_memories (
      id TEXT PRIMARY KEY,
      content TEXT,
      category TEXT,
      visibility TEXT,
      tags_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      raw_json TEXT,
      pulled_at TEXT
    );
  `);
}

function upsertConversation(c: any) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO omi_cloud_conversations
      (id, created_at, started_at, finished_at, title, overview, emoji, category,
       language, source, folder_id, folder_name, action_items_json, events_json,
       transcript_segments_json, geolocation_json, raw_json, pulled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    c.id,
    c.created_at,
    c.started_at,
    c.finished_at,
    c.structured?.title || null,
    c.structured?.overview || null,
    c.structured?.emoji || null,
    c.structured?.category || null,
    c.language,
    c.source,
    c.folder_id,
    c.folder_name,
    JSON.stringify(c.structured?.action_items || []),
    JSON.stringify(c.structured?.events || []),
    JSON.stringify(c.transcript_segments || []),
    JSON.stringify(c.geolocation || null),
    JSON.stringify(c),
    now,
  );
}

function upsertMemory(m: any) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO omi_cloud_memories
      (id, content, category, visibility, tags_json, created_at, updated_at, raw_json, pulled_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    m.id,
    m.content,
    m.category,
    m.visibility,
    JSON.stringify(m.tags || []),
    m.created_at,
    m.updated_at,
    JSON.stringify(m),
    now,
  );
}

async function main() {
  ensureTables();

  console.log('[OMI Cloud] Pulling conversations...');
  const conversations = await fetchAll('conversations');
  console.log(`[OMI Cloud] Total conversations: ${conversations.length}`);

  const txConv = db.transaction((items: any[]) => {
    for (const c of items) upsertConversation(c);
  });
  txConv(conversations);
  console.log(`[OMI Cloud] Stored ${conversations.length} conversations`);

  console.log('\n[OMI Cloud] Pulling memories...');
  const memories = await fetchAll('memories');
  console.log(`[OMI Cloud] Total memories: ${memories.length}`);

  const txMem = db.transaction((items: any[]) => {
    for (const m of items) upsertMemory(m);
  });
  txMem(memories);
  console.log(`[OMI Cloud] Stored ${memories.length} memories`);

  console.log('\n[OMI Cloud] Summary:');
  const convCount = db.prepare('SELECT COUNT(*) as c FROM omi_cloud_conversations').get() as any;
  const memCount = db.prepare('SELECT COUNT(*) as c FROM omi_cloud_memories').get() as any;
  console.log(`  omi_cloud_conversations: ${convCount.c}`);
  console.log(`  omi_cloud_memories: ${memCount.c}`);

  const sources: Record<string, number> = {};
  (db.prepare('SELECT source, COUNT(*) as c FROM omi_cloud_conversations GROUP BY source').all() as any[])
    .forEach((r: any) => { sources[r.source] = r.c; });
  console.log('  By source:', sources);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
