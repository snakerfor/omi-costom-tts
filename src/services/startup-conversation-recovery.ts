import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import { finalizedResultsDir, rawResultsDir } from '../runtime-paths';
import { finalizeConversation, FinalizedSegment } from './conversation-finalizer';
import { syncConversationSegments } from './knowledge-ingest';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface DanglingConversationRow {
  id: string;
  session_id: string;
  created_at: string;
  websocket_connected_at: string | null;
  first_audio_frame_at: string | null;
  raw_result_path: string | null;
  audio_file_path: string | null;
}

function fileExistsWithContent(filePath: string | null): boolean {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function resolveRawTranscriptPath(row: DanglingConversationRow): string | null {
  if (fileExistsWithContent(row.raw_result_path)) {
    return row.raw_result_path;
  }

  const fallback = path.join(rawResultsDir, `${row.session_id}.ndjson`);
  return fileExistsWithContent(fallback) ? fallback : null;
}

function existingAudioFileId(filePath: string | null): string | null {
  if (!filePath) return null;
  const row = db.prepare('SELECT id FROM audio_files WHERE file_path = ?').get(filePath) as { id?: string } | undefined;
  return row?.id ?? null;
}

function markConversationFailed(conversationId: string, reason: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE conversations
    SET status = 'failed',
        ended_at = COALESCE(ended_at, ?),
        updated_at = ?,
        error_message = ?
    WHERE id = ?
  `).run(now, now, reason, conversationId);
}

function importRecoveredSegments(input: {
  row: DanglingConversationRow;
  rawTranscriptPath: string;
  finalizedPath: string;
  recordingStartedAt: string;
  segments: FinalizedSegment[];
}): void {
  const now = new Date().toISOString();
  const endedAt = input.segments.at(-1)?.absolute_end_time ?? now;
  const durationMs = input.segments.reduce((max, segment) => Math.max(max, Number(segment.end_ms || 0)), 0);
  const audioPath = input.row.audio_file_path && fs.existsSync(input.row.audio_file_path)
    ? input.row.audio_file_path
    : null;
  const audioFileId = existingAudioFileId(audioPath) ?? (audioPath ? genId('aud') : null);

  const tx = db.transaction(() => {
    if (audioPath && audioFileId && !existingAudioFileId(audioPath)) {
      db.prepare(`
        INSERT INTO audio_files (
          id, conversation_id, file_path, file_name, duration_ms,
          sample_rate, channels, bits_per_sample, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        audioFileId,
        input.row.id,
        audioPath,
        path.basename(audioPath),
        durationMs,
        16000,
        1,
        16,
        now,
        now,
      );
    }

    db.prepare('DELETE FROM conversation_segments WHERE conversation_id = ?').run(input.row.id);

    const insertSeg = db.prepare(`
      INSERT INTO conversation_segments (
        id, conversation_id, audio_file_id,
        start_ms, end_ms, absolute_start_time, absolute_end_time,
        original_speaker_label, speaker_label, speaker_id, speaker_name, speaker_identity, text,
        confidence, resolution_method, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const segment of input.segments) {
      insertSeg.run(
        segment.id || genId('seg'),
        input.row.id,
        audioFileId,
        segment.start_ms,
        segment.end_ms,
        segment.absolute_start_time,
        segment.absolute_end_time,
        segment.speaker_label ?? null,
        segment.speaker_label ?? null,
        segment.speaker_id ?? null,
        segment.speaker_name ?? null,
        segment.speaker_identity ?? null,
        segment.text,
        segment.confidence ?? null,
        segment.resolution_method || 'recovery_finalize_raw',
        now,
        now,
      );
    }

    db.prepare(`
      UPDATE conversations
      SET status = 'completed',
          first_audio_frame_at = COALESCE(first_audio_frame_at, ?),
          ended_at = ?,
          raw_result_path = ?,
          updated_at = ?,
          error_message = NULL
      WHERE id = ?
    `).run(input.recordingStartedAt, endedAt, input.finalizedPath, now, input.row.id);
  });

  tx();
}

async function recoverConversation(row: DanglingConversationRow): Promise<'recovered' | 'failed'> {
  const rawTranscriptPath = resolveRawTranscriptPath(row);
  if (!rawTranscriptPath) {
    markConversationFailed(row.id, 'recovered_after_server_restart');
    return 'failed';
  }

  const recordingStartedAt = row.first_audio_frame_at || row.websocket_connected_at || row.created_at || new Date().toISOString();
  try {
    const finalized = await finalizeConversation({
      sessionId: row.session_id,
      rawTranscriptPath,
      outputDir: finalizedResultsDir,
      recordingStartedAt,
    });

    if (!finalized.segments.length) {
      markConversationFailed(row.id, 'recovered_after_server_restart_no_segments');
      return 'failed';
    }

    importRecoveredSegments({
      row,
      rawTranscriptPath,
      finalizedPath: finalized.outPath,
      recordingStartedAt,
      segments: finalized.segments,
    });

    try {
      const synced = syncConversationSegments(row.id);
      if (synced > 0) {
        console.log(`[StartupRecovery] knowledge sync: ${synced} events from conversation ${row.id}`);
      }
    } catch (err) {
      console.error(`[StartupRecovery] knowledge sync failed conversation=${row.id}:`, err);
    }

    console.log(`[StartupRecovery] recovered conversation=${row.id} session=${row.session_id} segments=${finalized.segments.length}`);
    return 'recovered';
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    markConversationFailed(row.id, `recovered_after_server_restart_finalize_failed: ${message.slice(0, 500)}`);
    console.error(`[StartupRecovery] finalize failed conversation=${row.id} session=${row.session_id}:`, err);
    return 'failed';
  }
}

export async function recoverDanglingRecordingConversations(): Promise<void> {
  const rows = db.prepare(`
    SELECT id, session_id, created_at, websocket_connected_at, first_audio_frame_at, raw_result_path, audio_file_path
    FROM conversations
    WHERE status = 'recording'
    ORDER BY created_at ASC
  `).all() as DanglingConversationRow[];

  if (!rows.length) return;

  console.log(`[StartupRecovery] found dangling recording conversations: ${rows.length}`);
  let recovered = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await recoverConversation(row);
    if (result === 'recovered') recovered += 1;
    else failed += 1;
  }
  console.log(`[StartupRecovery] completed: recovered=${recovered}, failed=${failed}`);
}
