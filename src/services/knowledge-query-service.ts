import { db } from '../db';

export interface KnowledgeTimelineFilters {
  from?: string;
  to?: string;
  type?: string;
  speaker?: string;
  speakerId?: string;
  identity?: string;
  resolutionMethod?: string;
  minConfidence?: number;
  limit?: number;
}

export interface KnowledgeConversationFilters {
  from?: string;
  to?: string;
  speaker?: string;
  speakerId?: string;
  identity?: string;
  hasLowConfidence?: boolean;
  hasUnresolved?: boolean;
  limit?: number;
}

export interface SpeakerReviewFilters {
  from?: string;
  to?: string;
  speaker?: string;
  identity?: string;
  limit?: number;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

function addSpeakerFilters(where: string[], params: unknown[], filters: {
  speaker?: string;
  speakerId?: string;
  identity?: string;
  resolutionMethod?: string;
  minConfidence?: number;
}): void {
  if (filters.speakerId) {
    where.push('cs.speaker_id = ?');
    params.push(filters.speakerId);
  }

  if (filters.speaker) {
    const q = `%${filters.speaker.trim()}%`;
    where.push(`(
      COALESCE(s.name, '') LIKE ?
      OR COALESCE(s.display_label, '') LIKE ?
      OR COALESCE(cs.speaker_name, '') LIKE ?
      OR COALESCE(cs.speaker_label, '') LIKE ?
      OR COALESCE(cs.original_speaker_label, '') LIKE ?
    )`);
    params.push(q, q, q, q, q);
  }

  if (filters.identity) {
    const q = `%${filters.identity.trim()}%`;
    where.push(`(
      COALESCE(s.identity_label, '') LIKE ?
      OR COALESCE(cs.speaker_identity, '') LIKE ?
    )`);
    params.push(q, q);
  }

  if (filters.resolutionMethod) {
    where.push('cs.resolution_method = ?');
    params.push(filters.resolutionMethod);
  }

  if (filters.minConfidence != null && Number.isFinite(filters.minConfidence)) {
    where.push('COALESCE(cs.confidence, svm.top_score, 0) >= ?');
    params.push(filters.minConfidence);
  }
}

const LATEST_MATCH_JOIN = `
  LEFT JOIN segment_voiceprint_matches svm ON svm.id = (
    SELECT svm2.id
    FROM segment_voiceprint_matches svm2
    WHERE svm2.segment_id = cs.id
    ORDER BY svm2.created_at DESC
    LIMIT 1
  )
`;

export function listKnowledgeTimeline(filters: KnowledgeTimelineFilters): any[] {
  const where = ['ke.started_at >= ?', 'ke.started_at <= ?'];
  const params: unknown[] = [
    filters.from || new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z',
    filters.to || new Date().toISOString().slice(0, 10) + 'T23:59:59.999Z',
  ];

  if (filters.type) {
    where.push('ke.event_type = ?');
    params.push(filters.type);
  }

  addSpeakerFilters(where, params, filters);

  const limit = clampLimit(filters.limit, 100, 500);
  params.push(limit);

  return db.prepare(`
    SELECT
      ke.id,
      ke.event_type,
      ke.started_at,
      ke.ended_at,
      ke.content_text,
      ke.title,
      ke.source_table,
      ke.source_row_id,
      ke.participants_json,
      ke.metadata_json,
      ke.quality_score,
      cs.speaker_id,
      COALESCE(s.name, s.display_label, cs.speaker_name) AS speaker_name,
      COALESCE(s.identity_label, cs.speaker_identity) AS speaker_identity,
      cs.speaker_label,
      cs.original_speaker_label,
      cs.confidence AS speaker_confidence,
      cs.resolution_method,
      svm.decision AS voiceprint_decision,
      svm.top_speaker_id,
      svm.top_score,
      svm.second_speaker_id,
      svm.second_score
    FROM knowledge_events ke
    LEFT JOIN conversation_segments cs
      ON ke.source_table = 'conversation_segments'
     AND ke.source_row_id = cs.id
    LEFT JOIN speakers s ON s.id = cs.speaker_id
    ${LATEST_MATCH_JOIN}
    WHERE ${where.join(' AND ')}
    ORDER BY ke.started_at ASC
    LIMIT ?
  `).all(...params);
}

export function listKnowledgeConversations(filters: KnowledgeConversationFilters): any[] {
  const where = ['COALESCE(c.first_audio_frame_at, c.created_at) >= ?', 'COALESCE(c.ended_at, c.updated_at, c.created_at) <= ?'];
  const params: unknown[] = [
    filters.from || new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z',
    filters.to || new Date().toISOString().slice(0, 10) + 'T23:59:59.999Z',
  ];

  if (filters.speakerId || filters.speaker || filters.identity) {
    const subWhere: string[] = ['cs2.conversation_id = c.id'];
    if (filters.speakerId) {
      subWhere.push('cs2.speaker_id = ?');
      params.push(filters.speakerId);
    }
    if (filters.speaker) {
      const q = `%${filters.speaker.trim()}%`;
      subWhere.push(`(
        COALESCE(s2.name, '') LIKE ?
        OR COALESCE(s2.display_label, '') LIKE ?
        OR COALESCE(cs2.speaker_name, '') LIKE ?
        OR COALESCE(cs2.speaker_label, '') LIKE ?
        OR COALESCE(cs2.original_speaker_label, '') LIKE ?
      )`);
      params.push(q, q, q, q, q);
    }
    if (filters.identity) {
      const q = `%${filters.identity.trim()}%`;
      subWhere.push(`(
        COALESCE(s2.identity_label, '') LIKE ?
        OR COALESCE(cs2.speaker_identity, '') LIKE ?
      )`);
      params.push(q, q);
    }
    where.push(`EXISTS (
      SELECT 1
      FROM conversation_segments cs2
      LEFT JOIN speakers s2 ON s2.id = cs2.speaker_id
      WHERE ${subWhere.join(' AND ')}
    )`);
  }

  if (filters.hasLowConfidence) {
    where.push(`EXISTS (
      SELECT 1
      FROM conversation_segments cs3
      WHERE cs3.conversation_id = c.id
        AND COALESCE(cs3.resolution_method, '') IN ('xfyun_low_confidence', 'xfyun_conflict')
    )`);
  }

  if (filters.hasUnresolved) {
    where.push(`EXISTS (
      SELECT 1
      FROM conversation_segments cs4
      WHERE cs4.conversation_id = c.id
        AND (
          cs4.speaker_id IS NULL
          OR COALESCE(cs4.resolution_method, '') IN ('xfyun_low_confidence', 'xfyun_conflict', 'xfyun_no_match', 'xfyun_error')
        )
        AND COALESCE(cs4.resolution_method, '') NOT IN ('human_segment_excluded', 'xfyun_skipped_short')
    )`);
  }

  const limit = clampLimit(filters.limit, 20, 200);
  params.push(limit);

  return db.prepare(`
    SELECT
      c.id,
      c.session_id,
      c.status,
      COALESCE(c.first_audio_frame_at, c.created_at) AS started_at,
      c.ended_at,
      COUNT(cs.id) AS segment_count,
      COUNT(DISTINCT cs.speaker_id) AS confirmed_speaker_count,
      SUM(CASE WHEN COALESCE(cs.resolution_method, '') IN ('xfyun_low_confidence', 'xfyun_conflict') THEN 1 ELSE 0 END) AS low_confidence_count,
      SUM(CASE WHEN cs.speaker_id IS NULL AND COALESCE(cs.resolution_method, '') NOT IN ('human_segment_excluded', 'xfyun_skipped_short') THEN 1 ELSE 0 END) AS unresolved_count,
      COALESCE(GROUP_CONCAT(CASE WHEN cs.text IS NOT NULL AND TRIM(cs.text) != '' THEN cs.text END, ' '), '') AS summary_text
    FROM conversations c
    LEFT JOIN conversation_segments cs ON cs.conversation_id = c.id
    WHERE ${where.join(' AND ')}
    GROUP BY c.id, c.session_id, c.status, c.first_audio_frame_at, c.ended_at, c.created_at
    ORDER BY COALESCE(c.first_audio_frame_at, c.created_at) DESC
    LIMIT ?
  `).all(...params).map((row: any) => ({
    ...row,
    summary_text: String(row.summary_text || '').slice(0, 240),
  }));
}

export function listSpeakerReviewSegments(mode: 'low-confidence' | 'unresolved', filters: SpeakerReviewFilters): any[] {
  const where = ['COALESCE(cs.absolute_start_time, c.first_audio_frame_at, c.created_at) >= ?', 'COALESCE(cs.absolute_start_time, c.ended_at, c.updated_at, c.created_at) <= ?'];
  const params: unknown[] = [
    filters.from || '0000-01-01T00:00:00.000Z',
    filters.to || '9999-12-31T23:59:59.999Z',
  ];

  if (mode === 'low-confidence') {
    where.push(`COALESCE(cs.resolution_method, '') IN ('xfyun_low_confidence', 'xfyun_conflict')`);
  } else {
    where.push(`(
      cs.speaker_id IS NULL
      OR COALESCE(cs.resolution_method, '') IN ('xfyun_low_confidence', 'xfyun_conflict', 'xfyun_no_match', 'xfyun_error')
    )`);
    where.push(`COALESCE(cs.resolution_method, '') NOT IN ('human_segment_excluded', 'xfyun_skipped_short')`);
  }

  addSpeakerFilters(where, params, {
    speaker: filters.speaker,
    identity: filters.identity,
  });

  const limit = clampLimit(filters.limit, 50, 500);
  params.push(limit);

  return db.prepare(`
    SELECT
      cs.id AS segment_id,
      cs.conversation_id,
      c.session_id,
      COALESCE(cs.absolute_start_time, c.first_audio_frame_at, c.created_at) AS started_at,
      cs.absolute_end_time AS ended_at,
      cs.start_ms,
      cs.end_ms,
      cs.text,
      cs.speaker_label,
      cs.original_speaker_label,
      cs.speaker_id,
      COALESCE(s.name, s.display_label, cs.speaker_name) AS speaker_name,
      COALESCE(s.identity_label, cs.speaker_identity) AS speaker_identity,
      cs.confidence,
      cs.resolution_method,
      svm.decision AS voiceprint_decision,
      svm.top_speaker_id,
      top_s.name AS top_speaker_name,
      top_s.identity_label AS top_speaker_identity,
      svm.top_score,
      svm.second_speaker_id,
      second_s.name AS second_speaker_name,
      second_s.identity_label AS second_speaker_identity,
      svm.second_score
    FROM conversation_segments cs
    JOIN conversations c ON c.id = cs.conversation_id
    LEFT JOIN speakers s ON s.id = cs.speaker_id
    ${LATEST_MATCH_JOIN}
    LEFT JOIN speakers top_s ON top_s.id = svm.top_speaker_id
    LEFT JOIN speakers second_s ON second_s.id = svm.second_speaker_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(cs.absolute_start_time, c.first_audio_frame_at, c.created_at) DESC
    LIMIT ?
  `).all(...params);
}
