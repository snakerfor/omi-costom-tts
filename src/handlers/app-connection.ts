import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import * as path from 'path';
import { createHash } from 'crypto';
import { validateConnection } from '../middleware/auth';
import { createSonioxSession } from '../services/soniox-session';
import { SegmentBuilder } from '../utils/segment-builder';
import { AudioFileWriter } from '../services/audio-file-writer';
import { AppMessage, SonioxResponse } from '../types';
import { FinalResultRecorder } from '../services/final-result-recorder';
import { finalizeConversation } from '../services/conversation-finalizer';
import { db } from '../db';
import { mapSpeakersForConversation } from '../services/speaker-mapper';
import { alignConversationSpeakers } from '../services/speaker-alignment';
import { StreamVadGate } from '../services/stream-vad-gate';
import { syncConversationSegments } from '../services/knowledge-ingest';

function shouldRunSpeakerIdentityMapping(): boolean {
  return process.env.ENABLE_SPEAKER_IDENTITY_MAPPING === 'true';
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const activeConnectionsByUid = new Map<string, WebSocket>();

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
  let pendingCloseStream = false;
  let committedEnd = 0; // Track last sent segment end to prevent overlap
  let wavFinalized = false; // Prevent double-finalize
  let finalizeStarted = false;
  let firstAudioFrameAt: string | null = null;
  let sonioxPausedByVad = false;
  let lastAudioPacketAtMs = Date.now();
  let accumulatedSilenceMs = 0;
  let idleWatchdog: NodeJS.Timeout | null = null;
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
  const streamSilenceFinalizeMs = Number(process.env.STREAM_SILENCE_FINALIZE_MS ?? 0);
  const streamNoAudioFinalizeMs = Number(process.env.STREAM_NO_AUDIO_FINALIZE_MS ?? 0);
  const streamIdleFinalizeMs = Number(process.env.STREAM_IDLE_FINALIZE_MS ?? 0);

  // Audio file writer - saves WAV with RIFF header
  const AUDIO_DIR = path.join(process.cwd(), 'audio-uploads');
  const RAW_RESULTS_DIR = path.join(process.cwd(), 'raw_results');
  const FINALIZED_RESULTS_DIR = path.join(process.cwd(), 'finalized_results');
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const connectedAt = new Date().toISOString();
  const conversationId = genId('conv');
  const audioFileId = genId('aud');
  const audioFilePath = path.join(AUDIO_DIR, sessionId + '.wav');
  const recorder = new FinalResultRecorder(sessionId, RAW_RESULTS_DIR);
  const wavWriter = new AudioFileWriter(audioFilePath, {
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
  });
  const recorderReady = recorder.init();

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
      connectedAt,
      recorder.filePath,
      audioFilePath,
      connectedAt,
      connectedAt,
    );
  } catch (err) {
    console.error('[DB] failed to insert conversation row:', err);
  }

  async function ensureWavFinalized(logPrefix: string): Promise<void> {
    if (wavFinalized) return;
    wavFinalized = true;
    try {
      const filepath = await wavWriter.finish();
      console.log(`${logPrefix} ${filepath}`);
    } catch (err) {
      console.error('[AudioFile] Failed to save WAV:', err);
    }
  }

  async function finalizeOnce(reason: 'close_stream' | 'ws_close' | 'soniox_error'): Promise<void> {
    if (finalizeStarted) return;
    finalizeStarted = true;

    await recorderReady.catch(() => undefined);
    await ensureWavFinalized('[AudioFile] Saved WAV:');

    try {
      const finalized = await finalizeConversation({
        sessionId,
        rawTranscriptPath: recorder.filePath,
        outputDir: FINALIZED_RESULTS_DIR,
        recordingStartedAt: firstAudioFrameAt ?? connectedAt,
      });
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
      const durationMs = segmentsForStorage.length
        ? Math.max(...segmentsForStorage.map(seg => seg.end_ms))
        : 0;
      const vadStats = vadGate.getStatsSnapshot();

      const tx = db.transaction(() => {
        db.prepare(`
          INSERT OR REPLACE INTO audio_files (
            id, conversation_id, file_path, file_name, duration_ms,
            sample_rate, channels, bits_per_sample, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            original_speaker_label, speaker_label, speaker_id, speaker_name, text,
            confidence, resolution_method, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            null,
            null,
            seg.text,
            null,
            'soniox_finalized',
            now,
            now,
          );
        }

        db.prepare(`
          UPDATE conversations
          SET status = ?, first_audio_frame_at = ?, ended_at = ?, raw_result_path = ?, updated_at = ?, error_message = NULL,
              vad_mode = ?, vad_total_audio_ms = ?, vad_detected_speech_ms = ?, vad_detected_silence_ms = ?,
              vad_sent_audio_ms = ?, vad_suppressed_audio_ms = ?, vad_state_transitions = ?
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
        `[Finalize] session=${sessionId}, reason=${reason}, output=${finalized.outPath}, segments=${segmentsForStorage.length}, alignment=${aligned.alignmentOutputPath || 'disabled'}, identity_mapping=${shouldRunSpeakerIdentityMapping() ? 'enabled' : 'disabled'}, vad_mode=${vadStats.mode}, vad_total_ms=${vadStats.totalAudioMs}, vad_speech_ms=${vadStats.detectedSpeechMs}, vad_sent_ms=${vadStats.sentAudioMs}, vad_suppressed_ms=${vadStats.suppressedAudioMs}`,
      );
    } catch (err) {
      console.error('[Finalize] failed:', err);
      try {
        const vadStats = vadGate.getStatsSnapshot();
        db.prepare(`
          UPDATE conversations
          SET status = ?, ended_at = ?, error_message = ?, updated_at = ?,
              vad_mode = ?, vad_total_audio_ms = ?, vad_detected_speech_ms = ?, vad_detected_silence_ms = ?,
              vad_sent_audio_ms = ?, vad_suppressed_audio_ms = ?, vad_state_transitions = ?
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

  function chunkDurationMs(data: Buffer): number {
    // PCM s16le mono 16k
    return Math.round((data.length / 2 / 16000) * 1000);
  }

  function finalizeByTimeout(reason: string): void {
    if (finalizeStarted) {
      return;
    }
    console.log(`[SessionTimeout] session=${sessionId}, reason=${reason}`);

    const seg = builder.flushPending();
    if (seg) {
      ws.send(JSON.stringify({ segments: [seg] }));
    }

    stopAcceptingAudio();
    void sonioxSession?.finish().catch(err => {
      console.warn('[Soniox] finish failed during timeout finalize:', String((err as Error)?.message ?? err));
    });
    void finalizeOnce('ws_close');

    try {
      ws.close(4000, reason);
    } catch {
      // Ignore close failure.
    }
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

    for (const buffer of decision.sendBuffers) {
      sendAudioToSoniox(buffer);
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
    ws.close(1011, 'STT init error');
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
        console.log('[Soniox] Final:', JSON.stringify(seg));
        ws.send(JSON.stringify({ segments: [seg] }));
        committedEnd = seg.end;
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
    stopAcceptingAudio();
    console.error('[Soniox] Session error:', err);
    void finalizeOnce('soniox_error');
    ws.close(1011, 'STT error');
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
        ws.send(JSON.stringify({ segments: [seg] }));
      }
      stopAcceptingAudio();
      sonioxSession?.finish();
    }
  });

  // 4. Connect (async)
  sonioxSession.connect().catch((err: Error) => {
    console.error('[Soniox] Connect failed:', err);
    ws.close(1011, 'STT connect error');
  });

  // 5. Handle APP messages
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const audioData = data as Buffer;
      lastAudioPacketAtMs = Date.now();
      if (!firstAudioFrameAt) {
        firstAudioFrameAt = new Date().toISOString();
      }
      if (!wavFinalized) {
        wavWriter.write(audioData);
      }

      if (sonioxConnected && sonioxAcceptingAudio && sonioxSession) {
        applyVadDecision(audioData);
      } else if (!finalizeStarted) {
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
                ws.send(JSON.stringify({ segments: [seg] }));
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
    try {
      sonioxSession?.close();
    } catch {
      // Ignore
    }
    clearIdleWatchdog();
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
}
