import { db } from '../db';
import { IDENTITY_OPTIONS, isValidIdentityLabel } from '../constants/identity-options';

export interface SpeakerRow {
  id: string;
  name: string | null;
  status: string;
  display_label: string | null;
  identity_label: string | null;
  identity_status: string;
  notes: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  sample_text: string | null;
  sample_segment_id: string | null;
  sample_audio_path: string | null;
  created_at: string;
  updated_at: string;
  conversation_count: number;
  segment_count: number;
  name_confirmed: number;
  identity_confirmed: number;
}

export interface SpeakerListFilters {
  q?: string;
  confirmation?: 'all' | 'unconfirmed_name' | 'unconfirmed_identity' | 'unconfirmed_any' | 'confirmed';
  startTime?: string;
  endTime?: string;
  page?: number;
  pageSize?: number;
}

export interface SpeakerStats {
  confirmed: number;
  total: number;
}

export interface PaginatedResult<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SpeakerRecentConversation {
  conversation_id: string;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  segment_count: number;
  latest_segment_time: string | null;
}

export interface SpeakerRepresentativeSegment {
  id: string;
  conversation_id: string;
  absolute_start_time: string | null;
  absolute_end_time: string | null;
  text: string;
}

export interface SpeakerVoiceprintFeature {
  id: string;
  provider: string;
  group_id: string;
  feature_id: string;
  feature_version: number;
  status: string;
  source_enrollment_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpeakerEnrollmentBatch {
  id: string;
  provider: string;
  group_id: string;
  feature_id: string | null;
  action: string;
  status: string;
  audio_path: string | null;
  duration_ms: number | null;
  audio_size_bytes: number | null;
  error_message: string | null;
  segment_count: number;
  created_at: string;
  updated_at: string;
}

export interface SpeakerDetail {
  speaker: SpeakerRow;
  recentConversations: SpeakerRecentConversation[];
  representativeSegments: SpeakerRepresentativeSegment[];
  voiceprintFeatures: SpeakerVoiceprintFeature[];
  enrollmentBatches: SpeakerEnrollmentBatch[];
}

export interface UpdateSpeakerInput {
  name?: string | null;
  identityLabel?: string | null;
  notes?: string | null;
}

const BASE_SPEAKER_SELECT = `
  SELECT
    s.id,
    s.name,
    s.status,
    s.display_label,
    s.identity_label,
    COALESCE(s.identity_status, CASE WHEN s.identity_label IS NOT NULL AND TRIM(s.identity_label) != '' THEN 'confirmed' ELSE 'unconfirmed' END) AS identity_status,
    s.notes,
    s.first_seen_at,
    s.last_seen_at,
    s.sample_text,
    s.sample_segment_id,
    s.sample_audio_path,
    s.created_at,
    s.updated_at,
    COUNT(DISTINCT cs.conversation_id) AS conversation_count,
    COUNT(cs.id) AS segment_count,
    CASE WHEN s.name IS NOT NULL AND TRIM(s.name) != '' THEN 1 ELSE 0 END AS name_confirmed,
    CASE WHEN s.identity_label IS NOT NULL AND TRIM(s.identity_label) != '' THEN 1 ELSE 0 END AS identity_confirmed
  FROM speakers s
  LEFT JOIN conversation_segments cs ON cs.speaker_id = s.id
`;

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildSpeakerFilters(filters: SpeakerListFilters): { whereClause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.q) {
    const q = `%${filters.q.trim()}%`;
    where.push(`(
      COALESCE(s.name, '') LIKE ?
      OR COALESCE(s.display_label, '') LIKE ?
      OR COALESCE(s.identity_label, '') LIKE ?
      OR COALESCE(s.sample_text, '') LIKE ?
    )`);
    params.push(q, q, q, q);
  }

  if (filters.startTime) {
    where.push(`COALESCE(s.last_seen_at, s.created_at) >= ?`);
    params.push(filters.startTime);
  }

  if (filters.endTime) {
    where.push(`COALESCE(s.first_seen_at, s.created_at) <= ?`);
    params.push(filters.endTime);
  }

  switch (filters.confirmation) {
    case 'unconfirmed_name':
      where.push(`(s.name IS NULL OR TRIM(s.name) = '')`);
      break;
    case 'unconfirmed_identity':
      where.push(`(s.identity_label IS NULL OR TRIM(s.identity_label) = '')`);
      break;
    case 'unconfirmed_any':
      where.push(`(
        s.name IS NULL OR TRIM(s.name) = ''
        OR s.identity_label IS NULL OR TRIM(s.identity_label) = ''
      )`);
      break;
    case 'confirmed':
      where.push(`(
        s.name IS NOT NULL AND TRIM(s.name) != ''
        AND s.identity_label IS NOT NULL AND TRIM(s.identity_label) != ''
      )`);
      break;
    default:
      break;
  }

  return {
    whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

function speakerListQuery(filters: SpeakerListFilters): { sql: string; params: unknown[] } {
  const { whereClause, params } = buildSpeakerFilters(filters);
  const pageSize = clampPositiveInt(filters.pageSize, 50, 200);
  const page = clampPositiveInt(filters.page, 1, 100000);
  const offset = (page - 1) * pageSize;

  return {
    sql: `
      ${BASE_SPEAKER_SELECT}
      ${whereClause}
      GROUP BY
        s.id, s.name, s.status, s.display_label, s.identity_label, s.identity_status, s.notes,
        s.first_seen_at, s.last_seen_at, s.sample_text, s.sample_segment_id, s.sample_audio_path,
        s.created_at, s.updated_at
      ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC, s.created_at DESC
      LIMIT ? OFFSET ?
    `,
    params: [...params, pageSize, offset],
  };
}

function countSpeakers(filters: SpeakerListFilters): number {
  const { whereClause, params } = buildSpeakerFilters(filters);
  const row = db.prepare(`
    SELECT COUNT(*) AS total
    FROM speakers s
    ${whereClause}
  `).get(...params) as { total?: number };
  return Number(row?.total || 0);
}

export function listAllSpeakers(): SpeakerRow[] {
  return db.prepare(`
    ${BASE_SPEAKER_SELECT}
    GROUP BY
      s.id, s.name, s.status, s.display_label, s.identity_label, s.identity_status, s.notes,
      s.first_seen_at, s.last_seen_at, s.sample_text, s.sample_segment_id, s.sample_audio_path,
      s.created_at, s.updated_at
    ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC, s.created_at DESC
  `).all() as SpeakerRow[];
}

export function listAnonymousSpeakers(): SpeakerRow[] {
  return db.prepare(`
    ${BASE_SPEAKER_SELECT}
    WHERE s.status = 'anonymous'
    GROUP BY
      s.id, s.name, s.status, s.display_label, s.identity_label, s.identity_status, s.notes,
      s.first_seen_at, s.last_seen_at, s.sample_text, s.sample_segment_id, s.sample_audio_path,
      s.created_at, s.updated_at
    ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC, s.created_at DESC
  `).all() as SpeakerRow[];
}

export function listSpeakers(filters: SpeakerListFilters): PaginatedResult<SpeakerRow> {
  const query = speakerListQuery(filters);
  const pageSize = clampPositiveInt(filters.pageSize, 50, 200);
  const page = clampPositiveInt(filters.page, 1, 100000);
  const total = countSpeakers(filters);
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
  return {
    data: db.prepare(query.sql).all(...query.params) as SpeakerRow[],
    page,
    pageSize,
    total,
    totalPages,
  };
}

export function getSpeakerStats(): SpeakerStats {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE
        WHEN name IS NOT NULL AND TRIM(name) != '' AND identity_label IS NOT NULL AND TRIM(identity_label) != ''
        THEN 1 ELSE 0
      END) AS confirmed
    FROM speakers
  `).get() as {
    total?: number;
    confirmed?: number;
  };

  return {
    total: Number(row?.total || 0),
    confirmed: Number(row?.confirmed || 0),
  };
}

export function getSpeakerDetail(speakerId: string): SpeakerDetail {
  const speaker = db.prepare(`
    ${BASE_SPEAKER_SELECT}
    WHERE s.id = ?
    GROUP BY
      s.id, s.name, s.status, s.display_label, s.identity_label, s.identity_status, s.notes,
      s.first_seen_at, s.last_seen_at, s.sample_text, s.sample_segment_id, s.sample_audio_path,
      s.created_at, s.updated_at
  `).get(speakerId) as SpeakerRow | undefined;

  if (!speaker) {
    throw new Error(`speaker not found: ${speakerId}`);
  }

  const recentConversations = db.prepare(`
    SELECT
      cs.conversation_id,
      COALESCE(c.first_audio_frame_at, c.created_at) AS started_at,
      c.ended_at,
      c.status,
      COUNT(cs.id) AS segment_count,
      MAX(cs.absolute_end_time) AS latest_segment_time
    FROM conversation_segments cs
    JOIN conversations c ON c.id = cs.conversation_id
    WHERE cs.speaker_id = ?
    GROUP BY cs.conversation_id, c.first_audio_frame_at, c.created_at, c.ended_at, c.status
    ORDER BY COALESCE(MAX(cs.absolute_end_time), c.created_at) DESC
    LIMIT 10
  `).all(speakerId) as SpeakerRecentConversation[];

  const representativeSegments = db.prepare(`
    SELECT
      id,
      conversation_id,
      absolute_start_time,
      absolute_end_time,
      text
    FROM conversation_segments
    WHERE speaker_id = ?
    ORDER BY LENGTH(COALESCE(text, '')) DESC, absolute_start_time DESC
    LIMIT 5
  `).all(speakerId) as SpeakerRepresentativeSegment[];

  const voiceprintFeatures = db.prepare(`
    SELECT
      id,
      provider,
      group_id,
      feature_id,
      feature_version,
      status,
      source_enrollment_batch_id,
      created_at,
      updated_at
    FROM speaker_voiceprint_features
    WHERE speaker_id = ?
    ORDER BY
      CASE WHEN status = 'active' THEN 0 ELSE 1 END,
      updated_at DESC
    LIMIT 10
  `).all(speakerId) as SpeakerVoiceprintFeature[];

  const enrollmentBatches = db.prepare(`
    SELECT
      b.id,
      b.provider,
      b.group_id,
      b.feature_id,
      b.action,
      b.status,
      b.audio_path,
      b.duration_ms,
      b.audio_size_bytes,
      b.error_message,
      COUNT(es.segment_id) AS segment_count,
      b.created_at,
      b.updated_at
    FROM speaker_enrollment_batches b
    LEFT JOIN speaker_enrollment_segments es ON es.enrollment_batch_id = b.id
    WHERE b.speaker_id = ?
    GROUP BY
      b.id, b.provider, b.group_id, b.feature_id, b.action, b.status,
      b.audio_path, b.duration_ms, b.audio_size_bytes, b.error_message,
      b.created_at, b.updated_at
    ORDER BY b.created_at DESC
    LIMIT 10
  `).all(speakerId) as SpeakerEnrollmentBatch[];

  return {
    speaker,
    recentConversations,
    representativeSegments,
    voiceprintFeatures,
    enrollmentBatches,
  };
}

export function updateSpeaker(speakerId: string, input: UpdateSpeakerInput): SpeakerRow {
  if (!speakerId) {
    throw new Error('speakerId is required');
  }

  const speaker = db.prepare(`
    SELECT id, name, identity_label, notes
    FROM speakers
    WHERE id = ?
  `).get(speakerId) as {
    id: string;
    name: string | null;
    identity_label: string | null;
    notes: string | null;
  } | undefined;

  if (!speaker) {
    throw new Error(`speaker not found: ${speakerId}`);
  }

  const name = normalizeOptionalText(input.name === undefined ? speaker.name : input.name);
  const identityLabel = normalizeOptionalText(
    input.identityLabel === undefined ? speaker.identity_label : input.identityLabel,
  );
  const notes = normalizeOptionalText(input.notes === undefined ? speaker.notes : input.notes);
  if (!isValidIdentityLabel(identityLabel)) {
    throw new Error(`identityLabel must be one of: ${IDENTITY_OPTIONS.join(', ')}`);
  }
  const now = new Date().toISOString();
  const status = name ? 'confirmed' : 'anonymous';
  const displayLabel = name || speaker.id;
  const identityStatus = identityLabel ? 'confirmed' : 'unconfirmed';
  const resolutionMethod = identityLabel ? 'manual_identity_confirm' : 'manual_confirm';

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE speakers
      SET
        name = ?,
        status = ?,
        display_label = CASE
          WHEN ? IS NOT NULL AND TRIM(?) != '' THEN ?
          WHEN display_label IS NULL OR TRIM(display_label) = '' THEN ?
          ELSE display_label
        END,
        identity_label = ?,
        identity_status = ?,
        notes = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      name,
      status,
      name,
      name,
      name,
      displayLabel,
      identityLabel,
      identityStatus,
      notes,
      now,
      speakerId,
    );

    db.prepare(`
      UPDATE conversation_segments
      SET
        speaker_name = ?,
        speaker_identity = ?,
        resolution_method = ?,
        updated_at = ?
      WHERE speaker_id = ?
    `).run(
      name,
      identityLabel,
      resolutionMethod,
      now,
      speakerId,
    );
  });

  tx();
  return getSpeakerDetail(speakerId).speaker;
}

export function confirmSpeakerName(
  speakerId: string,
  realName: string,
): { success: true; speakerId: string; realName: string } {
  updateSpeaker(speakerId, { name: realName });
  return {
    success: true,
    speakerId,
    realName: realName.trim(),
  };
}
