import { db } from '../db';

export interface KnowledgeTimelineFilters {
  from: string;
  to: string;
  limit: number;
  type?: string;
}

export interface KnowledgeTimelineRow {
  id: string;
  event_type: string;
  started_at: string;
  ended_at: string | null;
  content_text: string | null;
  title: string | null;
  participants_json: string | null;
  source_table: string;
  source_row_id: string;
}

export interface KnowledgeConversationFilters {
  from: string;
  to: string;
  limit: number;
}

export interface KnowledgeConversationRow {
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
}

export interface KnowledgeConversationDetailEvent {
  item_order: number;
  event_type: string;
  started_at: string;
  content_text: string | null;
  event_title: string | null;
  participants_json: string | null;
}

export interface KnowledgeMemoryFilters {
  category?: string;
  limit: number;
}

export interface KnowledgeMemoryRow {
  id: string;
  canonical_text: string;
  category: string;
  subject_key: string | null;
  confidence: number | null;
  source_refs_json: string;
  first_observed_at: string | null;
  last_observed_at: string | null;
  status: string;
}

export interface KnowledgeMemoryCandidateRow {
  id: string;
  candidate_text: string;
  category: string;
  confidence: number | null;
  status: string;
  conversation_id: string;
  created_at: string;
}

function clampLimit(limit: number, fallback: number, max: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

export function listKnowledgeTimeline(filters: KnowledgeTimelineFilters): KnowledgeTimelineRow[] {
  let sql = `
    SELECT id, event_type, started_at, ended_at,
           content_text, title, participants_json, source_table, source_row_id
    FROM knowledge_events
    WHERE started_at >= ? AND started_at <= ?
  `;
  const params: unknown[] = [filters.from, filters.to];

  if (filters.type) {
    sql += ' AND event_type = ?';
    params.push(filters.type);
  }

  sql += ' ORDER BY started_at ASC LIMIT ?';
  params.push(clampLimit(filters.limit, 100, 500));

  return db.prepare(sql).all(...params) as KnowledgeTimelineRow[];
}

export function listKnowledgeConversations(filters: KnowledgeConversationFilters): KnowledgeConversationRow[] {
  return db.prepare(`
    SELECT
      kc.id,
      kc.started_at,
      kc.ended_at,
      kc.primary_source,
      kc.participants_json,
      kc.title,
      kc.summary,
      kc.topics_json,
      kc.action_items_json,
      kc.review_status,
      (SELECT COUNT(*) FROM knowledge_conversation_items WHERE conversation_id = kc.id) AS event_count
    FROM knowledge_conversations kc
    WHERE kc.started_at >= ? AND kc.started_at <= ?
    ORDER BY kc.started_at ASC
    LIMIT ?
  `).all(filters.from, filters.to, clampLimit(filters.limit, 20, 200)) as KnowledgeConversationRow[];
}

export function getKnowledgeConversation(conversationId: string): any | null {
  const row = db.prepare('SELECT * FROM knowledge_conversations WHERE id = ?').get(conversationId) as any;
  return row ?? null;
}

export function listKnowledgeConversationEvents(conversationId: string): KnowledgeConversationDetailEvent[] {
  return db.prepare(`
    SELECT
      ki.item_order,
      ke.event_type,
      ke.started_at,
      ke.content_text,
      ke.title AS event_title,
      ke.participants_json
    FROM knowledge_conversation_items ki
    JOIN knowledge_events ke ON ke.id = ki.event_id
    WHERE ki.conversation_id = ?
    ORDER BY ki.item_order ASC
  `).all(conversationId) as KnowledgeConversationDetailEvent[];
}

export function listKnowledgeMemories(filters: KnowledgeMemoryFilters): KnowledgeMemoryRow[] {
  let sql = `
    SELECT id, canonical_text, category, subject_key, confidence,
           source_refs_json, first_observed_at, last_observed_at, status
    FROM knowledge_memories
    WHERE status = 'active'
  `;
  const params: unknown[] = [];

  if (filters.category) {
    sql += ' AND category = ?';
    params.push(filters.category);
  }

  sql += ' ORDER BY last_observed_at DESC LIMIT ?';
  params.push(clampLimit(filters.limit, 50, 500));

  return db.prepare(sql).all(...params) as KnowledgeMemoryRow[];
}

export function listKnowledgeMemoryCandidates(filters: KnowledgeMemoryFilters): KnowledgeMemoryCandidateRow[] {
  let sql = `
    SELECT mc.id, mc.candidate_text, mc.category, mc.confidence, mc.status,
           mc.conversation_id, mc.created_at
    FROM knowledge_memory_candidates mc
  `;
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.category) {
    clauses.push('mc.category = ?');
    params.push(filters.category);
  }

  if (clauses.length) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }

  sql += ' ORDER BY mc.created_at DESC LIMIT ?';
  params.push(clampLimit(filters.limit, 50, 500));

  return db.prepare(sql).all(...params) as KnowledgeMemoryCandidateRow[];
}

export function getKnowledgeMemoryCategoryStats(): Array<{ category: string; cnt: number }> {
  return db.prepare(`
    SELECT category, COUNT(*) AS cnt
    FROM knowledge_memories
    WHERE status = 'active'
    GROUP BY category
    ORDER BY cnt DESC
  `).all() as Array<{ category: string; cnt: number }>;
}

export function getKnowledgeEventStats(): {
  total: number;
  byType: Array<{ event_type: string; cnt: number; earliest: string | null; latest: string | null }>;
} {
  const byType = db.prepare(`
    SELECT event_type, COUNT(*) AS cnt,
           MIN(started_at) AS earliest,
           MAX(started_at) AS latest
    FROM knowledge_events
    GROUP BY event_type
    ORDER BY cnt DESC
  `).all() as Array<{ event_type: string; cnt: number; earliest: string | null; latest: string | null }>;

  const total = (db.prepare('SELECT COUNT(*) AS total FROM knowledge_events').get() as { total: number }).total;
  return { total, byType };
}
