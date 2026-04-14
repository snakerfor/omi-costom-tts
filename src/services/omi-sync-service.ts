import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import { syncOmiMetadataBatch } from './knowledge-ingest';
import { omiSyncVideoRoot } from '../runtime-paths';

export type OmiEntityName =
  | 'screenshots'
  | 'transcription_sessions'
  | 'transcription_segments'
  | 'observations'
  | 'memories';

type OmiPayloadRow = Record<string, unknown> & { id: number };

export interface OmiMetadataPayload {
  sourceKey: string;
  sourceName?: string;
  batches: Partial<Record<OmiEntityName, OmiPayloadRow[]>>;
}

export interface VideoUploadRequest {
  sourceKey: string;
  videoChunkPath: string;
  sha256?: string;
  sizeBytes?: number;
}

const ENTITY_TABLES: Record<OmiEntityName, string> = {
  screenshots: 'omi_screenshots',
  transcription_sessions: 'omi_transcription_sessions',
  transcription_segments: 'omi_transcription_segments',
  observations: 'omi_observations',
  memories: 'omi_memories',
};

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureSource(sourceKey: string, sourceName?: string): void {
  const now = nowIso();
  db.prepare(`
    INSERT INTO omi_sync_sources (source_key, display_name, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      display_name = excluded.display_name,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `).run(sourceKey, sourceName ?? null, now, now, now);
}

function updateCheckpoint(sourceKey: string, entityName: OmiEntityName, lastReceivedId: number): void {
  const now = nowIso();
  db.prepare(`
    INSERT INTO omi_sync_checkpoints (source_key, entity_name, last_received_id, last_received_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_key, entity_name) DO UPDATE SET
      last_received_id = MAX(omi_sync_checkpoints.last_received_id, excluded.last_received_id),
      last_received_at = excluded.last_received_at,
      updated_at = excluded.updated_at
  `).run(sourceKey, entityName, lastReceivedId, now, now);
}

function upsertScreenshot(sourceKey: string, row: OmiPayloadRow): void {
  const now = nowIso();
  db.prepare(`
    INSERT INTO omi_screenshots (
      id, source_key, source_screenshot_id, ts, app_name, window_title, image_path, ocr_text,
      focus_status, video_chunk_path, frame_offset, raw_payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_screenshot_id) DO UPDATE SET
      ts = excluded.ts,
      app_name = excluded.app_name,
      window_title = excluded.window_title,
      image_path = excluded.image_path,
      ocr_text = excluded.ocr_text,
      focus_status = excluded.focus_status,
      video_chunk_path = excluded.video_chunk_path,
      frame_offset = excluded.frame_offset,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = excluded.updated_at
  `).run(
    genId('omiscr'),
    sourceKey,
    row.id,
    String(row.timestamp ?? ''),
    String(row.appName ?? ''),
    row.windowTitle == null ? null : String(row.windowTitle),
    row.imagePath == null ? null : String(row.imagePath),
    row.ocrText == null ? null : String(row.ocrText),
    row.focusStatus == null ? null : String(row.focusStatus),
    row.videoChunkPath == null ? null : String(row.videoChunkPath),
    row.frameOffset == null ? null : Number(row.frameOffset),
    JSON.stringify(row),
    now,
    now,
  );
}

function upsertTranscriptionSession(sourceKey: string, row: OmiPayloadRow): void {
  const now = nowIso();
  db.prepare(`
    INSERT INTO omi_transcription_sessions (
      id, source_key, source_session_id, started_at, finished_at, source, language, status,
      title, overview, raw_payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_session_id) DO UPDATE SET
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      source = excluded.source,
      language = excluded.language,
      status = excluded.status,
      title = excluded.title,
      overview = excluded.overview,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = excluded.updated_at
  `).run(
    genId('omits'),
    sourceKey,
    row.id,
    String(row.startedAt ?? ''),
    row.finishedAt == null ? null : String(row.finishedAt),
    String(row.source ?? ''),
    row.language == null ? null : String(row.language),
    row.status == null ? null : String(row.status),
    row.title == null ? null : String(row.title),
    row.overview == null ? null : String(row.overview),
    JSON.stringify(row),
    now,
    now,
  );
}

function upsertTranscriptionSegment(sourceKey: string, row: OmiPayloadRow): void {
  const now = nowIso();
  db.prepare(`
    INSERT INTO omi_transcription_segments (
      id, source_key, source_segment_id, source_session_id, speaker, speaker_label, text,
      start_time, end_time, segment_order, raw_payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_segment_id) DO UPDATE SET
      source_session_id = excluded.source_session_id,
      speaker = excluded.speaker,
      speaker_label = excluded.speaker_label,
      text = excluded.text,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      segment_order = excluded.segment_order,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = excluded.updated_at
  `).run(
    genId('omitseg'),
    sourceKey,
    row.id,
    Number(row.sessionId),
    row.speaker == null ? null : Number(row.speaker),
    row.speakerLabel == null ? null : String(row.speakerLabel),
    String(row.text ?? ''),
    row.startTime == null ? null : Number(row.startTime),
    row.endTime == null ? null : Number(row.endTime),
    row.segmentOrder == null ? null : Number(row.segmentOrder),
    JSON.stringify(row),
    now,
    now,
  );
}

function upsertObservation(sourceKey: string, row: OmiPayloadRow): void {
  const now = nowIso();
  const originalCreatedAt = row.createdAt ? String(row.createdAt) : now;
  db.prepare(`
    INSERT INTO omi_observations (
      id, source_key, source_observation_id, source_screenshot_id, app_name, context_summary,
      current_activity, has_task, task_title, raw_payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_observation_id) DO UPDATE SET
      source_screenshot_id = excluded.source_screenshot_id,
      app_name = excluded.app_name,
      context_summary = excluded.context_summary,
      current_activity = excluded.current_activity,
      has_task = excluded.has_task,
      task_title = excluded.task_title,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = excluded.updated_at
  `).run(
    genId('omiobs'),
    sourceKey,
    row.id,
    row.screenshotId == null ? null : Number(row.screenshotId),
    String(row.appName ?? ''),
    row.contextSummary == null ? null : String(row.contextSummary),
    row.currentActivity == null ? null : String(row.currentActivity),
    row.hasTask ? 1 : 0,
    row.taskTitle == null ? null : String(row.taskTitle),
    JSON.stringify(row),
    originalCreatedAt,
    now,
  );
}

function upsertMemory(sourceKey: string, row: OmiPayloadRow): void {
  const now = nowIso();
  db.prepare(`
    INSERT INTO omi_memories (
      id, source_key, source_memory_id, backend_id, content, category, source_app, confidence,
      created_at_source, updated_at_source, raw_payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_memory_id) DO UPDATE SET
      backend_id = excluded.backend_id,
      content = excluded.content,
      category = excluded.category,
      source_app = excluded.source_app,
      confidence = excluded.confidence,
      created_at_source = excluded.created_at_source,
      updated_at_source = excluded.updated_at_source,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = excluded.updated_at
  `).run(
    genId('omimem'),
    sourceKey,
    row.id,
    row.backendId == null ? null : String(row.backendId),
    String(row.content ?? ''),
    String(row.category ?? ''),
    row.sourceApp == null ? null : String(row.sourceApp),
    row.confidence == null ? null : Number(row.confidence),
    row.createdAt == null ? null : String(row.createdAt),
    row.updatedAt == null ? null : String(row.updatedAt),
    JSON.stringify(row),
    now,
    now,
  );
}

const UPSERT_BY_ENTITY: Record<OmiEntityName, (sourceKey: string, row: OmiPayloadRow) => void> = {
  screenshots: upsertScreenshot,
  transcription_sessions: upsertTranscriptionSession,
  transcription_segments: upsertTranscriptionSegment,
  observations: upsertObservation,
  memories: upsertMemory,
};

export function verifySyncToken(token: string | undefined): boolean {
  const expected = process.env.OMI_SYNC_TOKEN;
  if (!expected) return true;
  return token === expected;
}

export function ingestMetadata(payload: OmiMetadataPayload): Record<string, unknown> {
  const runId = genId('omirun');
  const startedAt = nowIso();
  const summary: Record<string, number> = {};
  const checkpoints: Partial<Record<OmiEntityName, number>> = {};

  const tx = db.transaction(() => {
    ensureSource(payload.sourceKey, payload.sourceName);
    db.prepare(`
      INSERT INTO omi_import_runs (id, source_key, started_at, status)
      VALUES (?, ?, ?, ?)
    `).run(runId, payload.sourceKey, startedAt, 'running');

    (Object.keys(ENTITY_TABLES) as OmiEntityName[]).forEach((entityName) => {
      const rows = payload.batches[entityName] ?? [];
      if (!rows.length) {
        summary[entityName] = 0;
        return;
      }

      const upsert = UPSERT_BY_ENTITY[entityName];
      let maxId = 0;
      for (const row of rows) {
        upsert(payload.sourceKey, row);
        if (row.id > maxId) {
          maxId = row.id;
        }
      }
      updateCheckpoint(payload.sourceKey, entityName, maxId);
      summary[entityName] = rows.length;
      checkpoints[entityName] = maxId;
    });

    const finishedAt = nowIso();
    db.prepare(`
      UPDATE omi_import_runs
      SET finished_at = ?, status = ?, metadata_summary_json = ?
      WHERE id = ?
    `).run(finishedAt, 'completed', JSON.stringify(summary), runId);
  });

  tx();

  try {
    const ingestedEntities = Object.keys(summary).filter(k => (summary[k] ?? 0) > 0);
    if (ingestedEntities.length) {
      const synced = syncOmiMetadataBatch(payload.sourceKey, ingestedEntities);
      if (synced > 0) {
        console.log(`[knowledge] incremental sync: ${synced} new events from omi-sync`);
      }
    }
  } catch (err) {
    console.error('[knowledge] incremental sync failed:', err);
  }

  return {
    runId,
    sourceKey: payload.sourceKey,
    summary,
    checkpoints,
  };
}

export function storeVideoChunk(request: VideoUploadRequest, body: Buffer): Record<string, unknown> {
  const now = nowIso();
  const safeRelativePath = request.videoChunkPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(path.sep);
  const targetPath = path.join(omiSyncVideoRoot, request.sourceKey, safeRelativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, body);

  const sha256 = request.sha256 || crypto.createHash('sha256').update(body).digest('hex');
  const sizeBytes = request.sizeBytes ?? body.length;

  ensureSource(request.sourceKey);
  db.prepare(`
    INSERT INTO omi_video_chunks (
      id, source_key, video_chunk_path, sha256, size_bytes, storage_path, upload_status,
      first_seen_at, last_uploaded_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, video_chunk_path) DO UPDATE SET
      sha256 = excluded.sha256,
      size_bytes = excluded.size_bytes,
      storage_path = excluded.storage_path,
      upload_status = excluded.upload_status,
      last_uploaded_at = excluded.last_uploaded_at,
      updated_at = excluded.updated_at
  `).run(
    genId('omivid'),
    request.sourceKey,
    request.videoChunkPath,
    sha256,
    sizeBytes,
    targetPath,
    'uploaded',
    now,
    now,
    now,
    now,
  );

  return {
    sourceKey: request.sourceKey,
    videoChunkPath: request.videoChunkPath,
    storagePath: targetPath,
    sha256,
    sizeBytes,
  };
}

