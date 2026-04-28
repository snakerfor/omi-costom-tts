import { db } from '../../db';
import { isValidIdentityLabel } from '../../constants/identity-options';
import { prepareMultiSourceEnrollmentAudio } from './audio-prep';
import {
  createFeature,
  getXfyunVoiceprintConfig,
  isXfyunVoiceprintEnabled,
  updateFeature,
} from './xfyun-client';

type MaterialStatus = 'candidate' | 'formal';

interface SpeakerRow {
  id: string;
  name: string | null;
  status: string;
  display_label: string | null;
  identity_label: string | null;
  identity_status: string | null;
  notes: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  sample_text: string | null;
  sample_segment_id: string | null;
  sample_audio_path: string | null;
  created_at: string;
  updated_at: string;
}

interface FeatureRow {
  id: string;
  speaker_id: string;
  provider: string;
  group_id: string;
  feature_id: string;
  feature_version: number;
  status: string;
  source_enrollment_batch_id: string | null;
}

interface MaterialSegmentRow {
  material_id: string;
  material_status: MaterialStatus;
  source: string | null;
  note: string | null;
  sort_order: number | null;
  material_created_at: string;
  material_updated_at: string;
  id: string;
  conversation_id: string;
  started_at: string | null;
  audio_file_path: string | null;
  start_ms: number;
  end_ms: number;
  absolute_start_time: string | null;
  absolute_end_time: string | null;
  text: string;
  original_speaker_label: string | null;
  speaker_label: string | null;
  speaker_id: string | null;
  speaker_name: string | null;
  speaker_identity: string | null;
  resolution_method: string | null;
  confidence: number | null;
  voiceprint_top_score: number | null;
  voiceprint_top_speaker_id: string | null;
  voiceprint_second_score: number | null;
}

interface CandidateFilters {
  q?: string;
  speakerId?: string;
  startTime?: string;
  endTime?: string;
  page?: number;
  pageSize?: number;
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

function normalizeStatus(value: string | null | undefined): MaterialStatus {
  if (value === 'candidate' || value === 'formal') return value;
  throw new Error('materialStatus must be candidate or formal');
}

function getSpeakerById(speakerId: string): SpeakerRow {
  const speaker = db.prepare(`
    SELECT
      id,
      name,
      status,
      display_label,
      identity_label,
      identity_status,
      notes,
      first_seen_at,
      last_seen_at,
      sample_text,
      sample_segment_id,
      sample_audio_path,
      created_at,
      updated_at
    FROM speakers
    WHERE id = ?
  `).get(speakerId) as SpeakerRow | undefined;
  if (!speaker) {
    throw new Error(`speaker not found: ${speakerId}`);
  }
  return speaker;
}

function getConfigOrThrow() {
  if (!isXfyunVoiceprintEnabled()) {
    throw new Error('XFYUN_VOICEPRINT_ENABLED is false');
  }
  const config = getXfyunVoiceprintConfig();
  if (!config) {
    throw new Error('XFYUN_APP_ID, XFYUN_API_KEY, XFYUN_API_SECRET and XFYUN_GROUP_ID are required');
  }
  return config;
}

function getActiveFeatureForSpeaker(speakerId: string, groupId?: string): FeatureRow | undefined {
  const params: unknown[] = [speakerId];
  const groupClause = groupId ? 'AND group_id = ?' : '';
  if (groupId) params.push(groupId);
  return db.prepare(`
    SELECT id, speaker_id, provider, group_id, feature_id, feature_version, status, source_enrollment_batch_id
    FROM speaker_voiceprint_features
    WHERE speaker_id = ? AND provider = 'xfyun' AND status = 'active'
      ${groupClause}
    ORDER BY feature_version DESC, updated_at DESC
    LIMIT 1
  `).get(...params) as FeatureRow | undefined;
}

function listMaterialRows(speakerId: string): MaterialSegmentRow[] {
  return db.prepare(`
    SELECT
      m.id AS material_id,
      m.material_status,
      m.source,
      m.note,
      m.sort_order,
      m.created_at AS material_created_at,
      m.updated_at AS material_updated_at,
      cs.id,
      cs.conversation_id,
      COALESCE(c.first_audio_frame_at, c.created_at) AS started_at,
      c.audio_file_path,
      cs.start_ms,
      cs.end_ms,
      cs.absolute_start_time,
      cs.absolute_end_time,
      cs.text,
      cs.original_speaker_label,
      cs.speaker_label,
      cs.speaker_id,
      cs.speaker_name,
      cs.speaker_identity,
      cs.resolution_method,
      cs.confidence,
      svm.top_score AS voiceprint_top_score,
      svm.top_speaker_id AS voiceprint_top_speaker_id,
      svm.second_score AS voiceprint_second_score
    FROM speaker_voiceprint_materials m
    JOIN conversation_segments cs ON cs.id = m.segment_id
    JOIN conversations c ON c.id = cs.conversation_id
    LEFT JOIN segment_voiceprint_matches svm ON svm.id = (
      SELECT svm2.id
      FROM segment_voiceprint_matches svm2
      WHERE svm2.segment_id = cs.id
      ORDER BY svm2.created_at DESC
      LIMIT 1
    )
    WHERE m.speaker_id = ?
    ORDER BY
      COALESCE(m.sort_order, 2147483647) ASC,
      COALESCE(cs.absolute_start_time, c.first_audio_frame_at, c.created_at) ASC,
      cs.start_ms ASC
  `).all(speakerId) as MaterialSegmentRow[];
}

function getRecentEnrollmentBatches(speakerId: string) {
  return db.prepare(`
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
  `).all(speakerId);
}

export function getSpeakerVoiceprintMaterials(speakerId: string) {
  const speaker = getSpeakerById(speakerId);
  const rows = listMaterialRows(speakerId);
  return {
    speaker,
    candidateMaterials: rows.filter(row => row.material_status === 'candidate'),
    formalMaterials: rows.filter(row => row.material_status === 'formal'),
    enrollmentBatches: getRecentEnrollmentBatches(speakerId),
    activeFeature: getActiveFeatureForSpeaker(speakerId) || null,
  };
}

export function searchVoiceprintMaterialCandidates(filters: CandidateFilters) {
  const pageSize = clampPositiveInt(filters.pageSize, 30, 100);
  const page = clampPositiveInt(filters.page, 1, 100000);
  const offset = (page - 1) * pageSize;
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.q?.trim()) {
    const q = `%${filters.q.trim()}%`;
    where.push(`(
      COALESCE(cs.text, '') LIKE ?
      OR COALESCE(cs.speaker_name, '') LIKE ?
      OR COALESCE(cs.speaker_label, '') LIKE ?
      OR COALESCE(cs.original_speaker_label, '') LIKE ?
    )`);
    params.push(q, q, q, q);
  }
  if (filters.speakerId?.trim()) {
    where.push(`(
      cs.speaker_id = ?
      OR svm.top_speaker_id = ?
      OR EXISTS (
        SELECT 1 FROM speaker_voiceprint_materials m
        WHERE m.segment_id = cs.id AND m.speaker_id = ?
      )
    )`);
    params.push(filters.speakerId, filters.speakerId, filters.speakerId);
  }
  if (filters.startTime?.trim()) {
    where.push(`COALESCE(cs.absolute_start_time, c.first_audio_frame_at, c.created_at) >= ?`);
    params.push(filters.startTime);
  }
  if (filters.endTime?.trim()) {
    where.push(`COALESCE(cs.absolute_end_time, c.ended_at, c.created_at) <= ?`);
    params.push(filters.endTime);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const count = db.prepare(`
    SELECT COUNT(*) AS total
    FROM conversation_segments cs
    JOIN conversations c ON c.id = cs.conversation_id
    LEFT JOIN segment_voiceprint_matches svm ON svm.id = (
      SELECT svm2.id
      FROM segment_voiceprint_matches svm2
      WHERE svm2.segment_id = cs.id
      ORDER BY svm2.created_at DESC
      LIMIT 1
    )
    ${whereClause}
  `).get(...params) as { total?: number };

  const data = db.prepare(`
    SELECT
      cs.id,
      cs.conversation_id,
      COALESCE(c.first_audio_frame_at, c.created_at) AS started_at,
      c.audio_file_path,
      cs.start_ms,
      cs.end_ms,
      cs.absolute_start_time,
      cs.absolute_end_time,
      cs.text,
      cs.original_speaker_label,
      cs.speaker_label,
      cs.speaker_id,
      cs.speaker_name,
      cs.speaker_identity,
      cs.resolution_method,
      cs.confidence,
      svm.top_score AS voiceprint_top_score,
      svm.top_speaker_id AS voiceprint_top_speaker_id,
      svm.second_score AS voiceprint_second_score,
      existing.speaker_id AS material_speaker_id,
      existing.material_status AS existing_material_status
    FROM conversation_segments cs
    JOIN conversations c ON c.id = cs.conversation_id
    LEFT JOIN segment_voiceprint_matches svm ON svm.id = (
      SELECT svm2.id
      FROM segment_voiceprint_matches svm2
      WHERE svm2.segment_id = cs.id
      ORDER BY svm2.created_at DESC
      LIMIT 1
    )
    LEFT JOIN speaker_voiceprint_materials existing ON existing.segment_id = cs.id
    ${whereClause}
    ORDER BY
      COALESCE(cs.absolute_start_time, c.first_audio_frame_at, c.created_at) DESC,
      cs.start_ms DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const total = Number(count?.total || 0);
  return {
    data,
    page,
    pageSize,
    total,
    totalPages: total > 0 ? Math.ceil(total / pageSize) : 1,
  };
}

export function addSpeakerVoiceprintMaterials(input: {
  speakerId: string;
  segmentIds: string[];
  materialStatus: string;
  source?: string | null;
  note?: string | null;
}) {
  const speakerId = String(input.speakerId || '').trim();
  getSpeakerById(speakerId);
  const status = normalizeStatus(input.materialStatus);
  const segmentIds = [...new Set((input.segmentIds || []).map(id => String(id).trim()).filter(Boolean))];
  if (!segmentIds.length) {
    throw new Error('segmentIds is required');
  }

  const rows = db.prepare(`
    SELECT id
    FROM conversation_segments
    WHERE id IN (${segmentIds.map(() => '?').join(', ')})
  `).all(...segmentIds) as Array<{ id: string }>;
  if (rows.length !== segmentIds.length) {
    throw new Error('one or more segmentIds do not exist');
  }

  const conflictRows = db.prepare(`
    SELECT speaker_id, segment_id
    FROM speaker_voiceprint_materials
    WHERE segment_id IN (${segmentIds.map(() => '?').join(', ')})
      AND speaker_id != ?
  `).all(...segmentIds, speakerId) as Array<{ speaker_id: string; segment_id: string }>;
  if (conflictRows.length) {
    throw new Error(`one or more segmentIds already belong to another speaker: ${conflictRows.map(row => row.segment_id).join(', ')}`);
  }

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO speaker_voiceprint_materials (
      id, speaker_id, segment_id, material_status, source, note, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(speaker_id, segment_id) DO UPDATE SET
      material_status = excluded.material_status,
      source = COALESCE(excluded.source, speaker_voiceprint_materials.source),
      note = COALESCE(excluded.note, speaker_voiceprint_materials.note),
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction(() => {
    for (const segmentId of segmentIds) {
      stmt.run(
        genId('svmtr'),
        speakerId,
        segmentId,
        status,
        input.source?.trim() || 'manual',
        input.note?.trim() || null,
        now,
        now,
      );
    }
  });
  tx();
  return getSpeakerVoiceprintMaterials(speakerId);
}

export function removeSpeakerVoiceprintMaterial(speakerId: string, segmentId: string) {
  getSpeakerById(speakerId);
  db.prepare(`
    DELETE FROM speaker_voiceprint_materials
    WHERE speaker_id = ? AND segment_id = ?
  `).run(speakerId, segmentId);
  return getSpeakerVoiceprintMaterials(speakerId);
}

export function createVoiceprintSpeakerWithMaterials(input: {
  speakerName?: string | null;
  identityLabel?: string | null;
  notes?: string | null;
  segmentIds?: string[];
  materialStatus?: string;
}) {
  const speakerName = (input.speakerName || '').trim();
  if (!speakerName) {
    throw new Error('speakerName is required');
  }
  const identityLabel = (input.identityLabel || '').trim() || null;
  if (!isValidIdentityLabel(identityLabel)) {
    throw new Error('identityLabel is invalid');
  }

  const speakerId = genId('spk');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO speakers (
      id, name, status, display_label, identity_label, identity_status, notes,
      first_seen_at, last_seen_at, sample_text, sample_segment_id, sample_audio_path,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    speakerId,
    speakerName,
    'confirmed',
    speakerName,
    identityLabel,
    identityLabel ? 'confirmed' : 'unconfirmed',
    (input.notes || '').trim() || null,
    now,
    now,
    null,
    null,
    null,
    now,
    now,
  );

  if (Array.isArray(input.segmentIds) && input.segmentIds.length) {
    addSpeakerVoiceprintMaterials({
      speakerId,
      segmentIds: input.segmentIds,
      materialStatus: input.materialStatus || 'candidate',
      source: 'new_speaker',
    });
  }

  return getSpeakerVoiceprintMaterials(speakerId);
}

function getFormalMaterialRowsForAudio(speakerId: string): MaterialSegmentRow[] {
  const formalRows = listMaterialRows(speakerId).filter(row => row.material_status === 'formal');
  if (!formalRows.length) {
    throw new Error('speaker has no formal voiceprint materials');
  }
  const missingAudio = formalRows.filter(row => !row.audio_file_path);
  if (missingAudio.length) {
    throw new Error(`one or more formal materials have no source audio: ${missingAudio.map(row => row.id).join(', ')}`);
  }
  return formalRows;
}

async function prepareFormalMaterialAudio(speakerId: string, batchId: string) {
  const formalRows = getFormalMaterialRowsForAudio(speakerId);
  const prep = await prepareMultiSourceEnrollmentAudio(
    formalRows.map(row => ({
      segmentId: row.id,
      conversationId: row.conversation_id,
      sourceAudioPath: row.audio_file_path as string,
      startMs: row.start_ms,
      endMs: row.end_ms,
    })),
    speakerId,
    batchId,
    {
      minSegmentMs: Number(process.env.XFYUN_MIN_SEGMENT_MS || 3000),
      maxQueryMs: Number(process.env.XFYUN_MAX_QUERY_MS || 8000),
      maxEnrollmentBytes: Number(process.env.XFYUN_MAX_ENROLLMENT_BYTES || 4_000_000),
    },
  );

  if (prep.skipped) {
    throw new Error(prep.reason || 'audio preparation failed');
  }
  return { formalRows, prep };
}

export async function previewSpeakerVoiceprintMaterials(speakerId: string) {
  getSpeakerById(speakerId);
  const batchId = genId('svprev');
  const { formalRows, prep } = await prepareFormalMaterialAudio(speakerId, batchId);
  return {
    speakerId,
    previewId: batchId,
    audioPath: prep.filePath,
    durationMs: prep.durationMs,
    audioSizeBytes: prep.sizeBytes,
    segmentCount: formalRows.length,
  };
}

export async function syncSpeakerVoiceprintMaterials(speakerId: string) {
  const speaker = getSpeakerById(speakerId);
  const config = getConfigOrThrow();
  const batchId = genId('senr');
  const now = new Date().toISOString();
  const activeFeature = getActiveFeatureForSpeaker(speakerId, config.groupId);
  const action = activeFeature ? 'update_feature' : 'create_feature';

  db.prepare(`
    INSERT INTO speaker_enrollment_batches (
      id, speaker_id, provider, group_id, feature_id, action, status,
      audio_path, duration_ms, audio_size_bytes, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    batchId,
    speakerId,
    'xfyun',
    config.groupId,
    activeFeature?.feature_id || null,
    action,
    'pending',
    null,
    null,
    null,
    null,
    now,
    now,
  );

  let formalRows: MaterialSegmentRow[] = [];
  let prep;
  try {
    const prepared = await prepareFormalMaterialAudio(speakerId, batchId);
    formalRows = prepared.formalRows;
    prep = prepared.prep;
  } catch (err) {
    db.prepare(`
      UPDATE speaker_enrollment_batches
      SET status = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run('failed', String((err as Error)?.message ?? err), new Date().toISOString(), batchId);
    throw err;
  }

  const txSegments = db.transaction(() => {
    const insertSegment = db.prepare(`
      INSERT OR REPLACE INTO speaker_enrollment_segments (
        enrollment_batch_id, segment_id, decision, created_at
      ) VALUES (?, ?, ?, ?)
    `);
    for (const row of formalRows) {
      insertSegment.run(batchId, row.id, 'keep', new Date().toISOString());
    }
    db.prepare(`
      UPDATE speaker_enrollment_batches
      SET audio_path = ?, duration_ms = ?, audio_size_bytes = ?, updated_at = ?
      WHERE id = ?
    `).run(prep.filePath, prep.durationMs, prep.sizeBytes, new Date().toISOString(), batchId);
  });
  txSegments();

  const featureInfo = `${speaker.name || speaker.id} | materials:${formalRows.length} | batch:${batchId} | ${now}`;
  let featureId = activeFeature?.feature_id || genId('vf');
  try {
    const featureResponse = activeFeature
      ? await updateFeature(config, prep.filePath, activeFeature.feature_id, featureInfo)
      : await createFeature(config, prep.filePath, featureId, featureInfo);
    featureId = featureResponse.featureId;

    if (activeFeature) {
      db.prepare(`
        UPDATE speaker_voiceprint_features
        SET feature_id = ?,
            feature_version = feature_version + 1,
            status = 'active',
            source_enrollment_batch_id = ?,
            updated_at = ?
        WHERE id = ?
      `).run(featureId, batchId, new Date().toISOString(), activeFeature.id);
    } else {
      db.prepare(`
        INSERT INTO speaker_voiceprint_features (
          id, speaker_id, provider, group_id, feature_id, feature_version, status,
          source_enrollment_batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId('svf'),
        speakerId,
        'xfyun',
        config.groupId,
        featureId,
        1,
        'active',
        batchId,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    }
  } catch (err) {
    db.prepare(`
      UPDATE speaker_enrollment_batches
      SET status = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run('failed', String((err as Error)?.message ?? err), new Date().toISOString(), batchId);
    throw err;
  }

  db.prepare(`
    UPDATE speaker_enrollment_batches
    SET feature_id = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(featureId, 'success', new Date().toISOString(), batchId);

  return {
    batchId,
    speakerId,
    featureId,
    action,
    status: 'success',
    processedSegmentCount: formalRows.length,
    audioPath: prep.filePath,
    durationMs: prep.durationMs,
    audioSizeBytes: prep.sizeBytes,
    errorMessage: null,
  };
}
