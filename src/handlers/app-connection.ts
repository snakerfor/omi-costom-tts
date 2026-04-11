import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import * as path from 'path';
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

function shouldRunSpeakerIdentityMapping(): boolean {
  return process.env.ENABLE_SPEAKER_IDENTITY_MAPPING === 'true';
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function handleAppConnection(ws: WebSocket, req: IncomingMessage): void {
  // 1. Auth
  if (!validateConnection(req)) {
    ws.close(4401, 'Unauthorized');
    return;
  }

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
    db.prepare(`
      INSERT INTO conversations (
        id, session_id, status, websocket_connected_at, first_audio_frame_at,
        raw_result_path, audio_file_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversationId,
      sessionId,
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
          SET status = ?, first_audio_frame_at = ?, ended_at = ?, raw_result_path = ?, updated_at = ?, error_message = NULL
          WHERE id = ?
        `).run(
          'completed',
          firstAudioFrameAt ?? connectedAt,
          now,
          finalized.outPath,
          now,
          conversationId,
        );
      });

      tx();

      if (shouldRunSpeakerIdentityMapping()) {
        void mapSpeakersForConversation(conversationId).catch(err => {
          console.error('[SpeakerMapper] failed:', err);
        });
      }

      console.log(
        `[Finalize] session=${sessionId}, reason=${reason}, output=${finalized.outPath}, segments=${segmentsForStorage.length}, alignment=${aligned.alignmentOutputPath || 'disabled'}, identity_mapping=${shouldRunSpeakerIdentityMapping() ? 'enabled' : 'disabled'}`,
      );
    } catch (err) {
      console.error('[Finalize] failed:', err);
      try {
        db.prepare(`
          UPDATE conversations
          SET status = ?, ended_at = ?, error_message = ?, updated_at = ?
          WHERE id = ?
        `).run(
          'failed',
          new Date().toISOString(),
          String((err as Error)?.message ?? err),
          new Date().toISOString(),
          conversationId,
        );
      } catch (dbErr) {
        console.error('[DB] failed to mark conversation failed:', dbErr);
      }
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

    // Process queued audio - direct PCM send
    for (const audioData of audioQueue) {
      sendAudioToSoniox(audioData);
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
      if (!firstAudioFrameAt) {
        firstAudioFrameAt = new Date().toISOString();
      }
      // Write to WAV file
      wavWriter.write(audioData);

      if (sonioxConnected && sonioxAcceptingAudio && sonioxSession) {
        // OMI APP sends PCM s16le directly - no decoding needed
        sendAudioToSoniox(audioData);
      } else if (!finalizeStarted) {
        // Queue while waiting for Soniox
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
    stopAcceptingAudio();
    try {
      sonioxSession?.close();
    } catch {
      // Ignore
    }
    void finalizeOnce('ws_close');
  });

  ws.on('error', (err: Error) => {
    console.error('[APP] WebSocket error:', err);
  });
}
