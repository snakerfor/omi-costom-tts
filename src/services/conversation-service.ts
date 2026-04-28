import { db } from '../db';
import { PaginatedResult } from './speaker-service';

export interface ConversationListFilters {
  speakerName?: string;
  identityLabel?: string;
  keyword?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
  hasSegments?: 'all' | 'true' | 'false' | 'with_failed';
  hasUnconfirmedSpeakers?: 'all' | 'true' | 'false';
  page?: number;
  pageSize?: number;
}

export interface ConversationListRow {
  id: string;
  session_id: string;
  uid: string | null;
  status: string;
  error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  audio_file_path: string | null;
  raw_result_path: string | null;
  created_at: string;
  updated_at: string;
  segment_count: number;
  speaker_count: number;
  confirmed_speaker_count: number;
  unconfirmed_speaker_count: number;
  low_confidence_count: number;
  short_segment_count: number;
  no_match_count: number;
  error_count: number;
  summary_text: string;
}

export interface ConversationSpeakerSummary {
  speaker_label: string | null;
  speaker_id: string | null;
  speaker_name: string | null;
  display_name: string;
  identity_label: string | null;
  segment_count: number;
  total_duration_ms: number;
  is_confirmed: number;
}

export interface ConversationSegmentRow {
  id: string;
  start_ms: number;
  end_ms: number;
  absolute_start_time: string | null;
  absolute_end_time: string | null;
  original_speaker_label: string | null;
  speaker_label: string | null;
  speaker_id: string | null;
  speaker_name: string | null;
  speaker_identity: string | null;
  display_name: string;
  text: string;
  confidence: number | null;
  resolution_method: string | null;
  voiceprint_top_score: number | null;
  voiceprint_second_score: number | null;
  voiceprint_top_speaker_id: string | null;
  voiceprint_top_speaker_name: string | null;
  voiceprint_top_speaker_identity: string | null;
  speaker_confirmed: number;
}

export interface ConversationDetail {
  conversation: ConversationListRow;
  speakers: ConversationSpeakerSummary[];
  segments: ConversationSegmentRow[];
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

const SEGMENT_DURATION_EXPR = `(COALESCE(cs.end_ms, 0) - COALESCE(cs.start_ms, 0))`;
const LOW_CONFIDENCE_EXPR = `COALESCE(cs.resolution_method, '') IN ('xfyun_low_confidence', 'xfyun_conflict')`;
const HAS_RESOLVED_SPEAKER_EXPR = `(cs.speaker_id IS NOT NULL OR COALESCE(cs.speaker_name, '') != '')`;
const PARTICIPANT_KEY_EXPR = `(
  CASE
    WHEN cs.speaker_id IS NOT NULL THEN 'speaker:' || cs.speaker_id
    ELSE 'label:' || COALESCE(cs.speaker_label, 'unknown')
  END
)`;
const SHORT_SEGMENT_EXPR = `(
  cs.id IS NOT NULL
  AND
  NOT (${HAS_RESOLVED_SPEAKER_EXPR})
  AND COALESCE(cs.resolution_method, '') != 'human_segment_excluded'
  AND COALESCE(cs.resolution_method, '') != 'xfyun_error'
  AND NOT (${LOW_CONFIDENCE_EXPR})
  AND (
    COALESCE(cs.resolution_method, '') = 'xfyun_skipped_short'
    OR (${SEGMENT_DURATION_EXPR} >= 0 AND ${SEGMENT_DURATION_EXPR} < 1200)
  )
)`;
const NO_MATCH_EXPR = `(
  cs.id IS NOT NULL
  AND
  NOT (${HAS_RESOLVED_SPEAKER_EXPR})
  AND COALESCE(cs.resolution_method, '') != 'human_segment_excluded'
  AND COALESCE(cs.resolution_method, '') != 'xfyun_error'
  AND NOT (${LOW_CONFIDENCE_EXPR})
  AND NOT (
    COALESCE(cs.resolution_method, '') = 'xfyun_skipped_short'
    OR (${SEGMENT_DURATION_EXPR} >= 0 AND ${SEGMENT_DURATION_EXPR} < 1200)
  )
)`;

function buildConversationFilters(filters: ConversationListFilters): { whereClause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.speakerName) {
    const q = `%${filters.speakerName.trim()}%`;
    where.push(`EXISTS (
      SELECT 1
      FROM conversation_segments cs2
      LEFT JOIN speakers s2 ON s2.id = cs2.speaker_id
      WHERE cs2.conversation_id = c.id
        AND (
          COALESCE(cs2.speaker_name, '') LIKE ?
          OR COALESCE(s2.name, '') LIKE ?
          OR COALESCE(s2.display_label, '') LIKE ?
          OR COALESCE(cs2.speaker_label, '') LIKE ?
        )
    )`);
    params.push(q, q, q, q);
  }

  if (filters.identityLabel) {
    const q = `%${filters.identityLabel.trim()}%`;
    where.push(`EXISTS (
      SELECT 1
      FROM conversation_segments cs2
      LEFT JOIN speakers s2 ON s2.id = cs2.speaker_id
      WHERE cs2.conversation_id = c.id
        AND (
          COALESCE(cs2.speaker_identity, '') LIKE ?
          OR COALESCE(s2.identity_label, '') LIKE ?
        )
    )`);
    params.push(q, q);
  }

  if (filters.keyword) {
    const q = `%${filters.keyword.trim()}%`;
    where.push(`EXISTS (
      SELECT 1 FROM conversation_segments cs2
      WHERE cs2.conversation_id = c.id
        AND COALESCE(cs2.text, '') LIKE ?
    )`);
    params.push(q);
  }

  if (filters.startTime) {
    where.push(`COALESCE(c.first_audio_frame_at, c.created_at) >= ?`);
    params.push(filters.startTime);
  }

  if (filters.endTime) {
    where.push(`COALESCE(c.ended_at, c.updated_at, c.created_at) <= ?`);
    params.push(filters.endTime);
  }

  if (filters.status) {
    where.push(`c.status = ?`);
    params.push(filters.status);
  }

  if (filters.hasSegments === 'true') {
    where.push(`EXISTS (
      SELECT 1
      FROM conversation_segments cs2
      WHERE cs2.conversation_id = c.id
    )`);
  }

  if (filters.hasSegments === 'with_failed') {
    where.push(`(
      c.status = 'failed'
      OR EXISTS (
        SELECT 1
        FROM conversation_segments cs2
        WHERE cs2.conversation_id = c.id
      )
    )`);
  }

  if (filters.hasSegments === 'false') {
    where.push(`NOT EXISTS (
      SELECT 1
      FROM conversation_segments cs2
      WHERE cs2.conversation_id = c.id
    )`);
  }

  if (filters.hasUnconfirmedSpeakers === 'true') {
    where.push(`EXISTS (
      SELECT 1
      FROM conversation_segments cs2
      LEFT JOIN speakers s2 ON s2.id = cs2.speaker_id
      WHERE cs2.conversation_id = c.id
        AND (
          s2.id IS NULL
          OR s2.name IS NULL OR TRIM(s2.name) = ''
          OR s2.identity_label IS NULL OR TRIM(s2.identity_label) = ''
        )
    )`);
  }

  if (filters.hasUnconfirmedSpeakers === 'false') {
    where.push(`NOT EXISTS (
      SELECT 1
      FROM conversation_segments cs2
      LEFT JOIN speakers s2 ON s2.id = cs2.speaker_id
      WHERE cs2.conversation_id = c.id
        AND (
          s2.id IS NULL
          OR s2.name IS NULL OR TRIM(s2.name) = ''
          OR s2.identity_label IS NULL OR TRIM(s2.identity_label) = ''
        )
    )`);
  }

  return {
    whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

function countConversations(filters: ConversationListFilters): number {
  const { whereClause, params } = buildConversationFilters(filters);
  const row = db.prepare(`
    SELECT COUNT(*) AS total
    FROM conversations c
    ${whereClause}
  `).get(...params) as { total?: number };
  return Number(row?.total || 0);
}

export function listConversations(filters: ConversationListFilters): PaginatedResult<ConversationListRow> {
  const { whereClause, params } = buildConversationFilters(filters);
  const pageSize = clampPositiveInt(filters.pageSize, 50, 200);
  const page = clampPositiveInt(filters.page, 1, 100000);
  const offset = (page - 1) * pageSize;
  const total = countConversations(filters);
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;

  return {
    data: db.prepare(`
    SELECT
      c.id,
      c.session_id,
      c.uid,
      c.status,
      c.error_message,
      COALESCE(c.first_audio_frame_at, c.created_at) AS started_at,
      c.ended_at,
      c.audio_file_path,
      c.raw_result_path,
      c.created_at,
      c.updated_at,
      COUNT(cs.id) AS segment_count,
      COUNT(DISTINCT CASE WHEN cs.id IS NOT NULL THEN ${PARTICIPANT_KEY_EXPR} ELSE NULL END) AS speaker_count,
      COUNT(DISTINCT CASE
        WHEN cs.id IS NOT NULL AND ${HAS_RESOLVED_SPEAKER_EXPR}
        THEN ${PARTICIPANT_KEY_EXPR}
        ELSE NULL
      END) AS confirmed_speaker_count,
      COUNT(DISTINCT CASE
        WHEN cs.id IS NOT NULL AND NOT (${HAS_RESOLVED_SPEAKER_EXPR})
        THEN ${PARTICIPANT_KEY_EXPR}
        ELSE NULL
      END) AS unconfirmed_speaker_count,
      SUM(CASE WHEN ${LOW_CONFIDENCE_EXPR} THEN 1 ELSE 0 END) AS low_confidence_count,
      SUM(CASE WHEN ${SHORT_SEGMENT_EXPR} THEN 1 ELSE 0 END) AS short_segment_count,
      SUM(CASE WHEN ${NO_MATCH_EXPR} THEN 1 ELSE 0 END) AS no_match_count,
      SUM(CASE WHEN cs.resolution_method = 'xfyun_error' THEN 1 ELSE 0 END) AS error_count,
      COALESCE(GROUP_CONCAT(CASE WHEN cs.text IS NOT NULL AND TRIM(cs.text) != '' THEN cs.text END, ' '), '') AS summary_text
    FROM conversations c
    LEFT JOIN conversation_segments cs ON cs.conversation_id = c.id
    LEFT JOIN speakers s ON s.id = cs.speaker_id
    ${whereClause}
    GROUP BY c.id, c.session_id, c.uid, c.status, c.error_message, c.first_audio_frame_at, c.ended_at, c.audio_file_path, c.raw_result_path, c.created_at, c.updated_at
    ORDER BY COALESCE(c.first_audio_frame_at, c.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset).map((row: any) => ({
    ...row,
    summary_text: String(row.summary_text || '').slice(0, 240),
  })) as ConversationListRow[],
    page,
    pageSize,
    total,
    totalPages,
  };
}

export function getConversationDetail(conversationId: string): ConversationDetail {
  const conversation = db.prepare(`
    SELECT
      c.id,
      c.session_id,
      c.uid,
      c.status,
      c.error_message,
      COALESCE(c.first_audio_frame_at, c.created_at) AS started_at,
      c.ended_at,
      c.audio_file_path,
      c.raw_result_path,
      c.created_at,
      c.updated_at,
      COUNT(cs.id) AS segment_count,
      COUNT(DISTINCT CASE WHEN cs.id IS NOT NULL THEN ${PARTICIPANT_KEY_EXPR} ELSE NULL END) AS speaker_count,
      COUNT(DISTINCT CASE
        WHEN cs.id IS NOT NULL AND ${HAS_RESOLVED_SPEAKER_EXPR}
        THEN ${PARTICIPANT_KEY_EXPR}
        ELSE NULL
      END) AS confirmed_speaker_count,
      COUNT(DISTINCT CASE
        WHEN cs.id IS NOT NULL AND NOT (${HAS_RESOLVED_SPEAKER_EXPR})
        THEN ${PARTICIPANT_KEY_EXPR}
        ELSE NULL
      END) AS unconfirmed_speaker_count,
      SUM(CASE WHEN ${LOW_CONFIDENCE_EXPR} THEN 1 ELSE 0 END) AS low_confidence_count,
      SUM(CASE WHEN ${SHORT_SEGMENT_EXPR} THEN 1 ELSE 0 END) AS short_segment_count,
      SUM(CASE WHEN ${NO_MATCH_EXPR} THEN 1 ELSE 0 END) AS no_match_count,
      SUM(CASE WHEN cs.resolution_method = 'xfyun_error' THEN 1 ELSE 0 END) AS error_count,
      COALESCE(GROUP_CONCAT(CASE WHEN cs.text IS NOT NULL AND TRIM(cs.text) != '' THEN cs.text END, ' '), '') AS summary_text
    FROM conversations c
    LEFT JOIN conversation_segments cs ON cs.conversation_id = c.id
    LEFT JOIN speakers s ON s.id = cs.speaker_id
    WHERE c.id = ?
    GROUP BY c.id, c.session_id, c.uid, c.status, c.error_message, c.first_audio_frame_at, c.ended_at, c.audio_file_path, c.raw_result_path, c.created_at, c.updated_at
  `).get(conversationId) as ConversationListRow | undefined;

  if (!conversation) {
    throw new Error(`conversation not found: ${conversationId}`);
  }

  conversation.summary_text = String(conversation.summary_text || '').slice(0, 500);

  const speakers = db.prepare(`
    SELECT
      CASE WHEN cs.speaker_id IS NULL THEN cs.speaker_label ELSE NULL END AS speaker_label,
      cs.speaker_id,
      COALESCE(MAX(s.name), MAX(cs.speaker_name)) AS speaker_name,
      COALESCE(
        CASE WHEN cs.speaker_id IS NOT NULL THEN MAX(s.name) END,
        CASE WHEN cs.speaker_id IS NOT NULL THEN MAX(s.display_label) END,
        CASE WHEN cs.speaker_id IS NOT NULL THEN MAX(cs.speaker_name) END,
        CASE WHEN cs.speaker_id IS NULL THEN cs.speaker_label END,
        CASE WHEN cs.speaker_id IS NULL THEN '未知发言人' END,
        '未知发言人'
      ) AS display_name,
      COALESCE(MAX(s.identity_label), MAX(cs.speaker_identity)) AS identity_label,
      COUNT(cs.id) AS segment_count,
      SUM(COALESCE(cs.end_ms, 0) - COALESCE(cs.start_ms, 0)) AS total_duration_ms,
      CASE
        WHEN ${HAS_RESOLVED_SPEAKER_EXPR} THEN 1
        ELSE 0
      END AS is_confirmed
    FROM conversation_segments cs
    LEFT JOIN speakers s ON s.id = cs.speaker_id
    WHERE cs.conversation_id = ?
    GROUP BY ${PARTICIPANT_KEY_EXPR}
    ORDER BY total_duration_ms DESC, segment_count DESC
  `).all(conversationId) as ConversationSpeakerSummary[];

  const segments = db.prepare(`
    SELECT
      cs.id,
      cs.start_ms,
      cs.end_ms,
      cs.absolute_start_time,
      cs.absolute_end_time,
      cs.original_speaker_label,
      cs.speaker_label,
      cs.speaker_id,
      cs.speaker_name,
      COALESCE(s.identity_label, cs.speaker_identity) AS speaker_identity,
      COALESCE(s.name, s.display_label, cs.speaker_name, cs.speaker_label, '未知发言人') AS display_name,
      cs.text,
      cs.confidence,
      cs.resolution_method,
      svm.top_score AS voiceprint_top_score,
      svm.second_score AS voiceprint_second_score,
      svm.top_speaker_id AS voiceprint_top_speaker_id,
      COALESCE(vps.name, vps.display_label) AS voiceprint_top_speaker_name,
      vps.identity_label AS voiceprint_top_speaker_identity,
      CASE
        WHEN s.id IS NOT NULL AND s.name IS NOT NULL AND TRIM(s.name) != '' THEN 1
        ELSE 0
      END AS speaker_confirmed
    FROM conversation_segments cs
    LEFT JOIN speakers s ON s.id = cs.speaker_id
    LEFT JOIN segment_voiceprint_matches svm ON svm.id = (
      SELECT svm2.id
      FROM segment_voiceprint_matches svm2
      WHERE svm2.segment_id = cs.id
      ORDER BY svm2.created_at DESC
      LIMIT 1
    )
    LEFT JOIN speakers vps ON vps.id = svm.top_speaker_id
    WHERE cs.conversation_id = ?
    ORDER BY cs.start_ms ASC, cs.created_at ASC
  `).all(conversationId) as ConversationSegmentRow[];

  return {
    conversation,
    speakers,
    segments,
  };
}
