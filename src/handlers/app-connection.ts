import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { createHash } from 'crypto';
import { validateConnection } from '../middleware/auth';
import { createSonioxSession } from '../services/soniox-session';
import { SegmentBuilder } from '../utils/segment-builder';
import { AudioFileWriter } from '../services/audio-file-writer';
import { AppMessage, Segment, SonioxResponse } from '../types';
import { FinalResultRecorder } from '../services/final-result-recorder';
import { finalizeConversation } from '../services/conversation-finalizer';
import { db } from '../db';
import { mapSpeakersForConversation } from '../services/speaker-mapper';
import { alignConversationSpeakers } from '../services/speaker-alignment';
import { StreamVadGate } from '../services/stream-vad-gate';
import { SentAudioRingBuffer } from '../services/sent-audio-ring-buffer';
import { syncConversationSegments } from '../services/knowledge-ingest';
import { audioUploadsDir, finalizedResultsDir, rawResultsDir } from '../runtime-paths';
import { identifyRealtimeVoiceprintSpeakerFromPcm, recordRealtimeVoiceprintMatch } from '../services/voiceprint/segment-voiceprint-service';
import { getQuietHoursStatus } from '../services/quiet-hours';
import { buildSttUnavailableSegment } from '../services/stt-fallback';

function shouldRunSpeakerIdentityMapping(): boolean {
  return process.env.ENABLE_SPEAKER_IDENTITY_MAPPING === 'true';
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const activeConnectionsByUid = new Map<string, WebSocket>();
const DEFAULT_SESSION_MAX_DURATION_MS = 30 * 60 * 1000;

function readDurationMsEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.warn(`[Config] Invalid ${name}=${raw}; using ${defaultValue}`);
    return defaultValue;
  }

  return value;
}

function resolveClientUid(req: IncomingMessage): string {
  const url = new URL(req.url ?? '', 'ws://localhost');
  const token = url.searchParams.get('api_key') ?? '';
  if (!token) {
    return 'unknown_client';
  }
  const digest = createHash('sha1').update(token).digest('hex').slice(0, 16);
  return `token_${digest}`;
}

export function handleAppConnection(ws: WebSocket, req: IncomingMessage): void {
  // 1. Auth
  if (!validateConnection(req)) {
    ws.close(4401, 'Unauthorized');
    return;
  }

  const initialQuietHours = getQuietHoursStatus();
  if (initialQuietHours.active) {
    console.log(
      `[QuietHours] closing connection during quiet hours, local_time=${initialQuietHours.localTime}, window=${initialQuietHours.config.start}-${initialQuietHours.config.end}, tz=${initialQuietHours.config.timezone}`,
    );
    ws.close(4002, 'quiet_hours_suppressed');
    return;
  }

  const clientUid = resolveClientUid(req);

  const existingConnection = activeConnectionsByUid.get(clientUid);
  if (existingConnection && existingConnection !== ws && existingConnection.readyState === WebSocket.OPEN) {
    console.log(`[SessionGuard] Closing superseded connection for uid=${clientUid}`);
    try {
      existingConnection.close(4001, 'superseded_by_new_connection');
    } catch {
      // Ignore close failures.
    }
  }
  activeConnectionsByUid.set(clientUid, ws);

  const builder = new SegmentBuilder();
  let sonioxSession: ReturnType<typeof createSonioxSession> | null = null;
  let audioQueue: Buffer[] = [];
  let sonioxConnected = false;
  let sonioxAcceptingAudio = false;
  let sonioxUnavailable = false;
  let pendingCloseStream = false;
  let committedEnd = 0; // Track last sent segment end to prevent overlap
  let wavFinalized = false; // Prevent double-finalize
  let finalizeStarted = false;
  let firstAudioFrameAt: string | null = null;
  let receivedAudioBytes = 0;
  let receivedAudioChunks = 0;
  let sonioxPausedByVad = false;
  let lastAudioPacketAtMs = Date.now();
  let accumulatedSilenceMs = 0;
  let idleWatchdog: NodeJS.Timeout | null = null;
  let maxSessionTimer: NodeJS.Timeout | null = null;
  let quietHoursTimer: NodeJS.Timeout | null = null;
  let sentTimelineCursorMs = 0;
  let finalSegmentQueue = Promise.resolve();
  const sentToOriginalTimeline: Array<{
    sent_start_ms: number;
    sent_end_ms: number;
    original_start_ms: number;
    original_end_ms: number;
  }> = [];
  const vadGate = new StreamVadGate({
    mode: process.env.STREAM_VAD_MODE,
    sampleRate: 16000,
    channels: 1,
    bytesPerSample: 2,
    rmsThreshold: Number(process.env.STREAM_VAD_RMS_THRESHOLD ?? 0.015),
    peakThreshold: Number(process.env.STREAM_VAD_PEAK_THRESHOLD ?? 0.055),
    preRollMs: Number(process.env.STREAM_VAD_PRE_ROLL_MS ?? 300),
    hangoverMs: Number(process.env.STREAM_VAD_HANGOVER_MS ?? 2200),
  });
  const sentAudioRing = new SentAudioRingBuffer(
    Number(process.env.XFYUN_REALTIME_RING_BUFFER_MS ?? 120000),
  );
  const realtimeVoiceprintTimeoutMs = readDurationMsEnv('XFYUN_REALTIME_TIMEOUT_MS', 30000);
  const streamSilenceFinalizeMs = readDurationMsEnv('STREAM_SILENCE_FINALIZE_MS', 0);
  const streamNoAudioFinalizeMs = readDurationMsEnv('STREAM_NO_AUDIO_FINALIZE_MS', 0);
  const streamIdleFinalizeMs = readDurationMsEnv('STREAM_IDLE_FINALIZE_MS', 0);
  const sessionMaxDurationMs = readDurationMsEnv('SESSION_MAX_DURATION_MS', DEFAULT_SESSION_MAX_DURATION_MS);

  // Audio file writer - saves WAV with RIFF header
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const connectedAt = new Date().toISOString();
  const conversationId = genId('conv');
  const audioFileId = genId('aud');
  const audioFilePath = path.join(audioUploadsDir, sessionId + '.wav');
  const recorder = new FinalResultRecorder(sessionId, rawResultsDir);
  const wavWriter = new AudioFileWriter(audioFilePath, {
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
  });
  const recorderReady = recorder.init();
  let timelineWriteTimer: NodeJS.Timeout | null = null;
  let timelineWriteInFlight = Promise.resolve();
  let quietHoursFinalizeStarted = false;
  let sttUnavailableSegmentSent = false;

  void recorderReady.catch(err => {
    console.error('[Recorder] init failed:', err);
  });

  try {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE conversations
      SET status = 'failed', ended_at = ?, updated_at = ?,
          error_message = COALESCE(error_message, 'superseded_by_new_connection')
      WHERE uid = ? AND status = 'recording'
    `).run(now, now, clientUid);

    db.prepare(`
      INSERT INTO conversations (
        id, session_id, uid, status, websocket_connected_at, first_audio_frame_at,
        raw_result_path, audio_file_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversationId,
      sessionId,
      clientUid,
      'recording',
      connectedAt,
      null,
      recorder.filePath,
      null,
      connectedAt,
      connectedAt,
    );
  } catch (err) {
    console.error('[DB] failed to insert conversation row:', err);
  }

  async function ensureWavFinalized(logPrefix: string): Promise<void> {
    if (wavFinalized) return;
    wavFinalized = true;
    if (receivedAudioBytes <= 0) {
      try {
        const stat = await fs.stat(audioFilePath);
        if (stat.size <= 44) {
          await fs.unlink(audioFilePath);
        }
      } catch {
        // No file was opened because no audio was written.
      }
      console.log(`${logPrefix} skipped empty WAV session=${sessionId}`);
      return;
    }
    try {
      const filepath = await wavWriter.finish();
      console.log(`${logPrefix} ${filepath}`);
    } catch (err) {
      console.error('[AudioFile] Failed to save WAV:', err);
    }
  }

  function estimateWavDurationMs(): number {
    if (receivedAudioBytes > 0) {
      return Math.max(0, Math.round((receivedAudioBytes / 32000) * 1000));
    }
    try {
      const stat = fsSync.statSync(audioFilePath);
      if (!Number.isFinite(stat.size) || stat.size < 44) {
        return 0;
      }
      return Math.max(0, Math.round(((stat.size - 44) / 32000) * 1000));
    } catch {
      return 0;
    }
  }

  function expandUnavailableSegmentsToAudioDuration(segments: Segment[], durationMs: number): Segment[] {
    if (!durationMs) {
      return segments;
    }

    return segments.map(seg => {
      if (seg.speaker_resolution !== 'stt_unavailable') {
        return seg;
      }
      return {
        ...seg,
        start: 0,
        end: durationMs / 1000,
      };
    });
  }

  function expandFinalizedUnavailableSegmentsToAudioDuration<T extends { start_ms: number; end_ms: number; absolute_start_time: string; absolute_end_time: string; resolution_method?: string | null }>(
    segments: T[],
    durationMs: number,
    recordingStartedAt: string,
  ): T[] {
    if (!durationMs) {
      return segments;
    }

    const startedAtMs = new Date(recordingStartedAt).getTime();
    return segments.map(seg => {
      if (seg.resolution_method !== 'stt_unavailable') {
        return seg;
      }
      return {
        ...seg,
        start_ms: 0,
        end_ms: durationMs,
        absolute_start_time: new Date(startedAtMs).toISOString(),
        absolute_end_time: new Date(startedAtMs + durationMs).toISOString(),
      };
    });
  }

  async function rewriteFinalizedSegments(outPath: string, segments: unknown[]): Promise<void> {
    try {
      const raw = await fs.readFile(outPath, 'utf8');
      const parsed = JSON.parse(raw) as { segments?: unknown[]; segment_count?: number };
      parsed.segments = segments;
      parsed.segment_count = segments.length;
      await fs.writeFile(outPath, JSON.stringify(parsed, null, 2), 'utf8');
    } catch (err) {
      console.warn('[Finalize] failed to rewrite finalized segments:', String((err as Error)?.message ?? err));
    }
  }

  function markNoAudioConversation(reason: string): void {
    const now = new Date().toISOString();
    const vadStats = vadGate.getStatsSnapshot();
    try {
      db.prepare(`
        UPDATE conversations
        SET status = ?, first_audio_frame_at = NULL, ended_at = ?, audio_file_path = NULL,
            updated_at = ?, error_message = ?,
            vad_mode = ?, vad_total_audio_ms = ?, vad_detected_speech_ms = ?, vad_detected_silence_ms = ?,
            vad_sent_audio_ms = ?, vad_suppressed_audio_ms = ?, vad_potential_suppressed_audio_ms = ?, vad_state_transitions = ?
        WHERE id = ?
      `).run(
        'failed',
        now,
        now,
        `no_audio_received: ${reason}`,
        vadStats.mode,
        vadStats.totalAudioMs,
        vadStats.detectedSpeechMs,
        vadStats.detectedSilenceMs,
        vadStats.sentAudioMs,
        vadStats.suppressedAudioMs,
        vadStats.potentialSuppressedAudioMs,
        vadStats.stateTransitions,
        conversationId,
      );
      console.log(
        `[Finalize] session=${sessionId}, reason=${reason}, no_audio_received=true, audio_chunks=${receivedAudioChunks}, audio_bytes=${receivedAudioBytes}, vad_total_ms=${vadStats.totalAudioMs}`,
      );
    } catch (err) {
      console.error('[DB] failed to mark no-audio conversation:', err);
    }
  }

  function markFirstAudioFrameIfNeeded(): void {
    if (firstAudioFrameAt) {
      return;
    }
    firstAudioFrameAt = new Date().toISOString();
    try {
      db.prepare(`
        UPDATE conversations
        SET first_audio_frame_at = ?, audio_file_path = ?, updated_at = ?
        WHERE id = ?
      `).run(firstAudioFrameAt, audioFilePath, firstAudioFrameAt, conversationId);
    } catch (err) {
      console.error('[DB] failed to mark first audio frame:', err);
    }
    console.log(`[AudioFile] first audio frame session=${sessionId}, path=${audioFilePath}`);
  }

  async function finalizeOnce(reason: 'close_stream' | 'ws_close' | 'soniox_error' | 'timeout'): Promise<void> {
    if (finalizeStarted) return;
    finalizeStarted = true;
    clearSessionTimers();

    await recorderReady.catch(() => undefined);
    await finalSegmentQueue.catch(() => undefined);
    try {
      await flushTimelineMapWrite();
    } catch (err) {
      console.warn('[Recorder] timeline map write failed:', String((err as Error)?.message ?? err));
    }
    await ensureWavFinalized('[AudioFile] Saved WAV:');

    if (receivedAudioBytes <= 0) {
      markNoAudioConversation(reason);
      return;
    }

    try {
      const finalized = await finalizeConversation({
        sessionId,
        rawTranscriptPath: recorder.filePath,
        outputDir: finalizedResultsDir,
        recordingStartedAt: firstAudioFrameAt ?? connectedAt,
      });
      const estimatedAudioDurationMs = estimateWavDurationMs();
      finalized.segments = expandFinalizedUnavailableSegmentsToAudioDuration(
        finalized.segments,
        estimatedAudioDurationMs,
        firstAudioFrameAt ?? connectedAt,
      );
      await rewriteFinalizedSegments(finalized.outPath, finalized.segments);
      const aligned = await alignConversationSpeakers({
        sessionId,
        audioPath: audioFilePath,
        segments: finalized.segments,
      });
      const segmentsForStorage = aligned.segments;
      const originalSpeakerBySegmentId = new Map(
        aligned.alignmentRows.map(row => [row.id, row.original_speaker_label]),
      );

      const now = new Date().toISOString();
      const durationMs = Math.max(
        estimatedAudioDurationMs,
        segmentsForStorage.length ? Math.max(...segmentsForStorage.map(seg => seg.end_ms)) : 0,
      );
      const vadStats = vadGate.getStatsSnapshot();

      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO audio_files (
            id, conversation_id, file_path, file_name, duration_ms,
            sample_rate, channels, bits_per_sample, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            conversation_id = VALUES(conversation_id),
            file_path = VALUES(file_path),
            file_name = VALUES(file_name),
            duration_ms = VALUES(duration_ms),
            sample_rate = VALUES(sample_rate),
            channels = VALUES(channels),
            bits_per_sample = VALUES(bits_per_sample),
            updated_at = VALUES(updated_at)
        `).run(
          audioFileId,
          conversationId,
          audioFilePath,
          path.basename(audioFilePath),
          durationMs,
          16000,
          1,
          16,
          now,
          now,
        );

        db.prepare(`
          DELETE FROM conversation_segments WHERE conversation_id = ?
        `).run(conversationId);

        const insertSeg = db.prepare(`
          INSERT INTO conversation_segments (
            id, conversation_id, audio_file_id,
            start_ms, end_ms, absolute_start_time, absolute_end_time,
            original_speaker_label, speaker_label, speaker_id, speaker_name, speaker_identity, text,
            confidence, resolution_method, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const seg of segmentsForStorage) {
          insertSeg.run(
            seg.id,
            conversationId,
            audioFileId,
            seg.start_ms,
            seg.end_ms,
            seg.absolute_start_time,
            seg.absolute_end_time,
            originalSpeakerBySegmentId.get(seg.id) ?? seg.speaker_label,
            seg.speaker_label,
            seg.speaker_id ?? null,
            seg.speaker_name ?? null,
            seg.speaker_identity ?? null,
            seg.text,
            seg.confidence ?? null,
            seg.resolution_method || 'soniox_finalized',
            now,
            now,
          );
        }

        db.prepare(`
          UPDATE conversations
          SET status = ?, first_audio_frame_at = ?, ended_at = ?, raw_result_path = ?, updated_at = ?, error_message = NULL,
              vad_mode = ?, vad_total_audio_ms = ?, vad_detected_speech_ms = ?, vad_detected_silence_ms = ?,
              vad_sent_audio_ms = ?, vad_suppressed_audio_ms = ?, vad_potential_suppressed_audio_ms = ?, vad_state_transitions = ?
          WHERE id = ?
        `).run(
          'completed',
          firstAudioFrameAt ?? connectedAt,
          now,
          finalized.outPath,
          now,
          vadStats.mode,
          vadStats.totalAudioMs,
          vadStats.detectedSpeechMs,
          vadStats.detectedSilenceMs,
          vadStats.sentAudioMs,
          vadStats.suppressedAudioMs,
          vadStats.potentialSuppressedAudioMs,
          vadStats.stateTransitions,
          conversationId,
        );
      });

      tx();

      try {
        const synced = syncConversationSegments(conversationId);
        if (synced > 0) {
          console.log(`[knowledge] incremental sync: ${synced} events from conversation ${conversationId}`);
        }
      } catch (err) {
        console.error('[knowledge] incremental sync failed:', err);
      }

      if (shouldRunSpeakerIdentityMapping()) {
        void mapSpeakersForConversation(conversationId).catch(err => {
          console.error('[SpeakerMapper] failed:', err);
        });
      }

      console.log(
        `[Finalize] session=${sessionId}, reason=${reason}, output=${finalized.outPath}, segments=${segmentsForStorage.length}, audio_chunks=${receivedAudioChunks}, audio_bytes=${receivedAudioBytes}, audio_duration_ms=${estimatedAudioDurationMs}, alignment=${aligned.alignmentOutputPath || 'disabled'}, identity_mapping=${shouldRunSpeakerIdentityMapping() ? 'enabled' : 'disabled'}, vad_mode=${vadStats.mode}, vad_total_ms=${vadStats.totalAudioMs}, vad_speech_ms=${vadStats.detectedSpeechMs}, vad_sent_ms=${vadStats.sentAudioMs}, vad_actual_suppressed_ms=${vadStats.suppressedAudioMs}, vad_potential_suppressed_ms=${vadStats.potentialSuppressedAudioMs}`,
      );
    } catch (err) {
      console.error('[Finalize] failed:', err);
      try {
        const vadStats = vadGate.getStatsSnapshot();
        db.prepare(`
          UPDATE conversations
          SET status = ?, ended_at = ?, error_message = ?, updated_at = ?,
              vad_mode = ?, vad_total_audio_ms = ?, vad_detected_speech_ms = ?, vad_detected_silence_ms = ?,
              vad_sent_audio_ms = ?, vad_suppressed_audio_ms = ?, vad_potential_suppressed_audio_ms = ?, vad_state_transitions = ?
          WHERE id = ?
        `).run(
          'failed',
          new Date().toISOString(),
          String((err as Error)?.message ?? err),
          new Date().toISOString(),
          vadStats.mode,
          vadStats.totalAudioMs,
          vadStats.detectedSpeechMs,
          vadStats.detectedSilenceMs,
          vadStats.sentAudioMs,
          vadStats.suppressedAudioMs,
          vadStats.potentialSuppressedAudioMs,
          vadStats.stateTransitions,
          conversationId,
        );
      } catch (dbErr) {
        console.error('[DB] failed to mark conversation failed:', dbErr);
      }
    }
  }

  function clearIdleWatchdog(): void {
    if (idleWatchdog) {
      clearInterval(idleWatchdog);
      idleWatchdog = null;
    }
  }

  function clearMaxSessionTimer(): void {
    if (maxSessionTimer) {
      clearTimeout(maxSessionTimer);
      maxSessionTimer = null;
    }
  }

  function clearQuietHoursTimer(): void {
    if (quietHoursTimer) {
      clearTimeout(quietHoursTimer);
      quietHoursTimer = null;
    }
  }

  function clearSessionTimers(): void {
    clearIdleWatchdog();
    clearMaxSessionTimer();
    clearQuietHoursTimer();
  }

  function chunkDurationMs(data: Buffer): number {
    // PCM s16le mono 16k
    return Math.round((data.length / 2 / 16000) * 1000);
  }

  function appendTimelineMapping(
    originalStartMs: number,
    originalEndMs: number,
    sentStartMs: number,
    sentEndMs: number,
  ): void {
    const prev = sentToOriginalTimeline[sentToOriginalTimeline.length - 1];
    if (
      prev &&
      prev.original_end_ms === originalStartMs &&
      prev.sent_end_ms === sentStartMs
    ) {
      prev.original_end_ms = originalEndMs;
      prev.sent_end_ms = sentEndMs;
      scheduleTimelineMapWrite();
      return;
    }

    sentToOriginalTimeline.push({
      sent_start_ms: sentStartMs,
      sent_end_ms: sentEndMs,
      original_start_ms: originalStartMs,
      original_end_ms: originalEndMs,
    });
    scheduleTimelineMapWrite();
  }

  function mapSentMsToOriginalMs(value: number): number {
    if (!sentToOriginalTimeline.length || !Number.isFinite(value)) {
      return value;
    }

    for (const entry of sentToOriginalTimeline) {
      if (value < entry.sent_start_ms) {
        continue;
      }
      if (value <= entry.sent_end_ms) {
        const delta = value - entry.sent_start_ms;
        return Math.min(entry.original_end_ms, entry.original_start_ms + delta);
      }
    }

    const last = sentToOriginalTimeline[sentToOriginalTimeline.length - 1];
    const totalAudioMs = vadGate.getStatsSnapshot().totalAudioMs;
    if (value > last.sent_end_ms) {
      return Math.min(totalAudioMs, last.original_end_ms + (value - last.sent_end_ms));
    }

    return Math.min(totalAudioMs, value);
  }

  function remapSegmentToOriginalTimeline(seg: Segment): Segment {
    if (!sentToOriginalTimeline.length) {
      return seg;
    }

    const startMs = Math.round(Number(seg.start || 0) * 1000);
    const endMs = Math.max(startMs, Math.round(Number(seg.end || 0) * 1000));
    const mappedStartMs = mapSentMsToOriginalMs(startMs);
    const mappedEndMs = Math.max(mappedStartMs, mapSentMsToOriginalMs(endMs));

    return {
      ...seg,
      start: mappedStartMs / 1000,
      end: mappedEndMs / 1000,
    };
  }

  async function writeTimelineMapSnapshot(): Promise<void> {
    await recorderReady;
    await fs.writeFile(
      `${recorder.filePath}.timeline.json`,
      JSON.stringify(
        {
          session_id: sessionId,
          generated_at: new Date().toISOString(),
          entries: sentToOriginalTimeline,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  function scheduleTimelineMapWrite(): void {
    if (timelineWriteTimer) return;
    timelineWriteTimer = setTimeout(() => {
      timelineWriteTimer = null;
      timelineWriteInFlight = timelineWriteInFlight
        .then(() => writeTimelineMapSnapshot())
        .catch(err => {
          console.warn('[Recorder] timeline map write failed:', String((err as Error)?.message ?? err));
        });
    }, 1000);
  }

  async function flushTimelineMapWrite(): Promise<void> {
    if (timelineWriteTimer) {
      clearTimeout(timelineWriteTimer);
      timelineWriteTimer = null;
    }
    await timelineWriteInFlight.catch(() => undefined);
    await writeTimelineMapSnapshot();
  }

  function finalizeByTimeout(reason: string, closeCode = 4000): void {
    if (finalizeStarted) {
      return;
    }
    console.log(`[SessionTimeout] session=${sessionId}, reason=${reason}`);

    const seg = builder.flushPending();
    if (seg) {
      sendFinalSegment(seg);
    }

    stopAcceptingAudio();
    void sonioxSession?.finish().catch(err => {
      console.warn('[Soniox] finish failed during timeout finalize:', String((err as Error)?.message ?? err));
    });
    void finalizeOnce('timeout');

    try {
      ws.close(closeCode, reason);
    } catch {
      // Ignore close failure.
    }
  }

  function shouldDropForQuietHours(): boolean {
    const status = getQuietHoursStatus();
    if (!status.active) {
      return false;
    }

    if (!quietHoursFinalizeStarted) {
      quietHoursFinalizeStarted = true;
      console.log(
        `[QuietHours] suppressing audio session=${sessionId}, local_time=${status.localTime}, window=${status.config.start}-${status.config.end}, tz=${status.config.timezone}`,
      );

      if (firstAudioFrameAt) {
        finalizeByTimeout('quiet_hours_suppressed', 4002);
      }
    }

    return true;
  }

  function stopAcceptingAudio(): void {
    sonioxConnected = false;
    sonioxAcceptingAudio = false;
  }

  function sendAudioToSoniox(audioData: Buffer): void {
    if (!sonioxSession || !sonioxConnected || !sonioxAcceptingAudio) {
      return;
    }

    try {
      sonioxSession.sendAudio(audioData);
    } catch (err) {
      stopAcceptingAudio();
      console.warn('[Soniox] sendAudio skipped after session stopped:', String((err as Error)?.message ?? err));
    }
  }

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        err => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  async function enrichSegmentWithRealtimeVoiceprint(seg: Segment): Promise<Segment> {
    const startMs = Math.round(seg.start * 1000);
    const endMs = Math.round(seg.end * 1000);
    const pcm = sentAudioRing.extractBySentRange(startMs, endMs);
    if (!pcm) {
      return seg;
    }

    try {
      const match = await withTimeout(
        identifyRealtimeVoiceprintSpeakerFromPcm(pcm.data, pcm.durationMs),
        realtimeVoiceprintTimeoutMs,
        'xfyun realtime voiceprint',
      );
      if (!match) {
        return seg;
      }

      try {
        recordRealtimeVoiceprintMatch({
          conversationId,
          segmentId: seg.id || genId('seg'),
          durationMs: pcm.durationMs,
          result: match,
        });
      } catch (err) {
        console.warn('[XFYUN] realtime voiceprint match persist failed:', String((err as Error)?.message ?? err));
      }

      const enrichedBase: Segment = {
        ...seg,
        speaker_confidence: match.score ?? undefined,
        speaker_resolution: match.decision || seg.speaker_resolution,
      };
      if (!match.speakerId || !match.speakerName) {
        return enrichedBase;
      }

      return {
        ...enrichedBase,
        speaker_label: seg.speaker,
        speaker: match.speakerName,
        speaker_id: match.speakerId,
        speaker_name: match.speakerName,
        speaker_identity: match.speakerIdentity,
      };
    } catch (err) {
      console.warn('[XFYUN] realtime voiceprint skipped:', String((err as Error)?.message ?? err));
      return {
        ...seg,
        speaker_resolution: 'xfyun_error',
        speaker_error: String((err as Error)?.message ?? err),
      };
    }
  }

  async function recordAndSendFinalSegment(seg: Segment): Promise<void> {
    const segmentId = seg.id || genId('seg');
    const withId: Segment = { ...seg, id: segmentId };
    const [expanded] = expandUnavailableSegmentsToAudioDuration([withId], estimateWavDurationMs());
    const enriched = await enrichSegmentWithRealtimeVoiceprint(expanded);
    try {
      await recorder.appendFinalSegment(enriched, firstAudioFrameAt ?? connectedAt, segmentId);
    } catch (err) {
      console.error('[Recorder] append final segment failed:', err);
    }
    const clientSegment = remapSegmentToOriginalTimeline(enriched);
    console.log('[Soniox] Final:', JSON.stringify(clientSegment));
    ws.send(JSON.stringify({ segments: [clientSegment] }));
  }

  function sendFinalSegment(seg: Segment): void {
    finalSegmentQueue = finalSegmentQueue
      .then(() => recordAndSendFinalSegment(seg))
      .catch(err => {
        console.warn('[Soniox] final segment send failed:', String((err as Error)?.message ?? err));
      });
  }

  function sendSttUnavailableSegment(err: unknown): void {
    if (sttUnavailableSegmentSent) {
      return;
    }
    sttUnavailableSegmentSent = true;
    sendFinalSegment(buildSttUnavailableSegment(err));
  }

  function markSonioxUnavailable(err: unknown): void {
    sonioxUnavailable = true;
    stopAcceptingAudio();
    audioQueue = [];
    sendSttUnavailableSegment(err);
    console.warn('[Soniox] STT unavailable; continuing to record audio locally.');
  }

  function applyVadDecision(audioData: Buffer): void {
    const decision = vadGate.processChunk(audioData);
    const durationMs = chunkDurationMs(audioData);
    const inSpeech = vadGate.getStatsSnapshot().currentlyInSpeech;

    if (decision.isSpeech || inSpeech) {
      accumulatedSilenceMs = 0;
    } else {
      accumulatedSilenceMs += durationMs;
    }

    if (decision.resumeBeforeSend && sonioxSession && sonioxConnected && sonioxAcceptingAudio && sonioxPausedByVad) {
      sonioxSession.resume();
      sonioxPausedByVad = false;
    }

    for (const chunk of decision.sendChunks) {
      const sentStartMs = sentTimelineCursorMs;
      const sentEndMs = sentStartMs + chunk.durationMs;
      appendTimelineMapping(chunk.originalStartMs, chunk.originalEndMs, sentStartMs, sentEndMs);
      sentAudioRing.push({
        sentStartMs,
        sentEndMs,
        originalStartMs: chunk.originalStartMs,
        originalEndMs: chunk.originalEndMs,
        data: Buffer.from(chunk.data),
      });
      sentTimelineCursorMs = sentEndMs;
      sendAudioToSoniox(chunk.data);
    }

    if (decision.pauseAfterSend && sonioxSession && sonioxConnected && sonioxAcceptingAudio && !sonioxPausedByVad) {
      sonioxSession.pause();
      sonioxPausedByVad = true;
    }

    if (
      streamSilenceFinalizeMs > 0 &&
      vadGate.getMode() === 'active' &&
      accumulatedSilenceMs >= streamSilenceFinalizeMs &&
      !finalizeStarted
    ) {
      finalizeByTimeout(`silence_timeout_${streamSilenceFinalizeMs}ms`);
    }
  }

  // 2. Connect to Soniox
  try {
    sonioxSession = createSonioxSession();
  } catch (err) {
    console.error('[Soniox] Failed to create session:', err);
    markSonioxUnavailable(err);
    return;
  }

  // 3. Listen for Soniox results
  sonioxSession.on('result', (result: SonioxResponse) => {
    const tokens = result.tokens;

    if (tokens.length === 0) {
      return;
    }

    void recorder.appendResult(result).catch(err => {
      console.error('[Recorder] append failed:', err);
    });

    // Filter tokens: only keep those ending at or after committedEnd (in ms)
    // This prevents overlapping segments from being sent
    const newTokens = tokens.filter(t => {
      const endMs = t.end_ms ?? 0;
      return endMs >= committedEnd * 1000;
    });

    if (newTokens.length === 0) {
      return;
    }

    // Check if tokens are final
    const isFinal = newTokens[0].is_final;

    if (isFinal) {
      const seg = builder.consumeFinal(newTokens);

      if (seg) {
        committedEnd = seg.end;
        sendFinalSegment(seg);
      }
    } else {
      // Partial: only log, don't send to APP
      builder.setPartial(newTokens);
      const partial = builder.getLastPartial();
      if (partial) {
        console.log('[Soniox] Partial:', JSON.stringify(partial));
      }
    }
  });

  sonioxSession.on('error', (err: Error) => {
    console.error('[Soniox] Session error:', err);
    markSonioxUnavailable(err);
  });

  sonioxSession.on('disconnected', (reason?: string) => {
    stopAcceptingAudio();
    console.log('[Soniox] Disconnected:', reason);
  });

  sonioxSession.on('connected', () => {
    console.log('[Soniox] Connected');
    sonioxConnected = true;
    sonioxAcceptingAudio = true;

    if (vadGate.wantsStreamPaused()) {
      sonioxSession?.pause();
      sonioxPausedByVad = true;
    }

    // Process queued audio through VAD gate so ordering and pre-roll remain intact.
    for (const audioData of audioQueue) {
      applyVadDecision(audioData);
    }
    audioQueue = [];

    // Handle CloseStream if received before connected
    if (pendingCloseStream) {
      console.log('[APP] Processing pending CloseStream after Soniox connected');
      pendingCloseStream = false;
      const seg = builder.flushPending();
      if (seg) {
        sendFinalSegment(seg);
      }
      stopAcceptingAudio();
      sonioxSession?.finish();
    }
  });

  // 4. Connect (async)
  sonioxSession.connect().catch((err: Error) => {
    console.error('[Soniox] Connect failed:', err);
    markSonioxUnavailable(err);
  });

  // 5. Handle APP messages
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const audioData = data as Buffer;
      lastAudioPacketAtMs = Date.now();
      if (shouldDropForQuietHours()) {
        return;
      }
      if (!firstAudioFrameAt) {
        markFirstAudioFrameIfNeeded();
      }
      if (!wavFinalized) {
        wavWriter.write(audioData);
        receivedAudioBytes += audioData.length;
        receivedAudioChunks += 1;
      }

      if (sonioxConnected && sonioxAcceptingAudio && sonioxSession) {
        applyVadDecision(audioData);
      } else if (!finalizeStarted && !sonioxUnavailable) {
        // Queue raw chunks so VAD can replay them in-order once Soniox is connected.
        audioQueue.push(audioData);
      }
    } else {
      // Text: JSON control message
      try {
        const msg = JSON.parse(data.toString()) as AppMessage;
          if (msg.type === 'CloseStream') {
            console.log('[APP] Received CloseStream');
            if (sonioxConnected) {
              const seg = builder.flushPending();
              if (seg) {
                sendFinalSegment(seg);
              }
              stopAcceptingAudio();
              sonioxSession?.finish();
              void finalizeOnce('close_stream');
            } else {
            pendingCloseStream = true;
          }
          if (!sonioxConnected) {
            void finalizeOnce('close_stream');
          }
        }
      } catch {
        // Ignore non-JSON messages
      }
    }
  });

  // 6. Cleanup
  ws.on('close', () => {
    console.log('[APP] Connection closed');
    if (activeConnectionsByUid.get(clientUid) === ws) {
      activeConnectionsByUid.delete(clientUid);
    }
    stopAcceptingAudio();
    void Promise.resolve(sonioxSession?.close()).catch(err => {
      console.warn('[Soniox] close skipped during websocket shutdown:', String((err as Error)?.message ?? err));
    });
    clearSessionTimers();
    void finalizeOnce('ws_close');
  });

  ws.on('error', (err: Error) => {
    console.error('[APP] WebSocket error:', err);
  });

  idleWatchdog = setInterval(() => {
    if (finalizeStarted) {
      return;
    }
    const nowMs = Date.now();
    const idleMs = nowMs - lastAudioPacketAtMs;
    if (!firstAudioFrameAt && streamNoAudioFinalizeMs > 0 && idleMs >= streamNoAudioFinalizeMs) {
      finalizeByTimeout(`no_audio_timeout_${streamNoAudioFinalizeMs}ms`);
      return;
    }
    if (firstAudioFrameAt && streamIdleFinalizeMs > 0 && idleMs >= streamIdleFinalizeMs) {
      finalizeByTimeout(`idle_timeout_${streamIdleFinalizeMs}ms`);
    }
  }, 5000);

  if (sessionMaxDurationMs > 0) {
    maxSessionTimer = setTimeout(() => {
      finalizeByTimeout(`max_session_duration_${sessionMaxDurationMs}ms`);
    }, sessionMaxDurationMs);
  }

  const nextQuietHours = getQuietHoursStatus();
  if (!nextQuietHours.active && nextQuietHours.minutesUntilStart != null) {
    quietHoursTimer = setTimeout(() => {
      if (getQuietHoursStatus().active) {
        finalizeByTimeout('quiet_hours_suppressed', 4002);
      }
    }, nextQuietHours.minutesUntilStart * 60 * 1000);
  }
}
