import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import * as path from 'path';
import { validateConnection } from '../middleware/auth';
import { createSonioxSession } from '../services/soniox-session';
import { SegmentBuilder } from '../utils/segment-builder';
import { AudioFileWriter } from '../services/audio-file-writer';
import { AppMessage } from '../types';

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
  let pendingCloseStream = false;
  let committedEnd = 0; // Track last sent segment end to prevent overlap
  let wavFinalized = false; // Prevent double-finalize

  // Audio file writer - saves WAV with RIFF header
  const AUDIO_DIR = path.join(process.cwd(), 'audio-uploads');
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const audioFilePath = path.join(AUDIO_DIR, sessionId + '.wav');
  const wavWriter = new AudioFileWriter(audioFilePath, {
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
  });

  // 2. Connect to Soniox
  try {
    sonioxSession = createSonioxSession();
  } catch (err) {
    console.error('[Soniox] Failed to create session:', err);
    ws.close(1011, 'STT init error');
    return;
  }

  // 3. Listen for Soniox results
  sonioxSession.on('result', (result: { tokens: any[] }) => {
    const tokens = result.tokens;

    if (tokens.length === 0) {
      return;
    }

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
      // Final: build segment from filtered tokens
      builder.setBuffer(newTokens);
      const seg = builder.flush();

      if (seg) {
        console.log('[Soniox] Final:', JSON.stringify(seg));
        ws.send(JSON.stringify({ segments: [seg] }));
        committedEnd = seg.end;
      }
    } else {
      // Partial: only log, don't send to APP
      builder.setBuffer(newTokens);
      const partial = builder.getLastPartial();
      if (partial) {
        console.log('[Soniox] Partial:', JSON.stringify(partial));
      }
    }
  });

  sonioxSession.on('error', (err: Error) => {
    console.error('[Soniox] Session error:', err);
    ws.close(1011, 'STT error');
  });

  sonioxSession.on('disconnected', (reason?: string) => {
    console.log('[Soniox] Disconnected:', reason);
  });

  sonioxSession.on('connected', () => {
    console.log('[Soniox] Connected');
    sonioxConnected = true;

    // Process queued audio - direct PCM send
    for (const audioData of audioQueue) {
      sonioxSession?.sendAudio(audioData);
    }
    audioQueue = [];

    // Handle CloseStream if received before connected
    if (pendingCloseStream) {
      console.log('[APP] Processing pending CloseStream after Soniox connected');
      pendingCloseStream = false;
      const seg = builder.flush();
      if (seg) {
        ws.send(JSON.stringify({ segments: [seg] }));
      }
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
      // Write to WAV file
      wavWriter.write(audioData);

      if (sonioxConnected && sonioxSession) {
        // OMI APP sends PCM s16le directly - no decoding needed
        sonioxSession.sendAudio(audioData);
      } else {
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
            const seg = builder.flush();
            if (seg) {
              ws.send(JSON.stringify({ segments: [seg] }));
            }
            sonioxSession?.finish();
          } else {
            pendingCloseStream = true;
          }
          // Finalize WAV file
          wavFinalized = true;
          wavWriter.finish()
            .then((filepath) => {
              console.log(`[AudioFile] Saved WAV: ${filepath}`);
            })
            .catch((err) => {
              console.error('[AudioFile] Failed to save WAV:', err);
            });
        }
      } catch {
        // Ignore non-JSON messages
      }
    }
  });

  // 6. Cleanup
  ws.on('close', () => {
    console.log('[APP] Connection closed');
    try {
      sonioxSession?.close();
    } catch {
      // Ignore
    }
    // Finalize WAV only if not already done (e.g., abnormal disconnect without CloseStream)
    if (!wavFinalized) {
      wavWriter.finish()
        .then((filepath) => {
          console.log(`[AudioFile] Saved WAV on close: ${filepath}`);
        })
        .catch((err) => {
          console.error('[AudioFile] Failed to save WAV on close:', err);
        });
    }
  });

  ws.on('error', (err: Error) => {
    console.error('[APP] WebSocket error:', err);
  });
}
