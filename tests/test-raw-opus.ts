/**
 * Test with Real Raw Opus Frames
 *
 * Flow: PCM -> opusscript encode (20ms frames) -> WebSocket
 *
 * This simulates what OMI App actually does:
 * - Audio captured -> encoded to raw Opus frames -> sent via WebSocket
 */

import WebSocket from 'ws';
import fs from 'fs';
import OpusScript from 'opusscript';

const SERVER_URL = process.env.TEST_SERVER_URL ?? 'ws://localhost:8080/stt';
const API_TOKEN = process.env.TEST_API_TOKEN ?? 'token-device-a';
const PCM_FILE = process.env.TEST_PCM_FILE ?? 'tests/test.pcm';

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_SIZE_MS = 20;
const FRAME_SIZE_SAMPLES = SAMPLE_RATE * FRAME_SIZE_MS / 1000; // 320 samples

async function main() {
  if (!fs.existsSync(PCM_FILE)) {
    console.error('[Test] PCM file not found:', PCM_FILE);
    console.error('[Test] Generate with: ffmpeg -i tests/test.m4a -f s16le -ar 16000 -ac 1 tests/test.pcm');
    process.exit(1);
  }

  const pcmBuffer = fs.readFileSync(PCM_FILE);
  console.log('[Test] Loaded PCM file, size:', pcmBuffer.length, 'bytes');
  console.log('[Test] Duration:', (pcmBuffer.length / (SAMPLE_RATE * 2)), 'seconds');

  // Create Opus encoder
  const encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
  console.log('[Test] Opus encoder created, frame size:', FRAME_SIZE_SAMPLES, 'samples');

  // Connect to server
  const url = new URL(SERVER_URL);
  url.searchParams.set('api_key', API_TOKEN);
  url.searchParams.set('language', 'zh');

  console.log('[Test] Connecting to:', url.toString());
  const ws = new WebSocket(url);

  ws.on('open', async () => {
    console.log('[Test] Connected, encoding and sending Opus frames...');

    let frameCount = 0;
    let bytesSent = 0;

    // Encode PCM to Opus frames and send
    for (let offset = 0; offset < pcmBuffer.length; offset += FRAME_SIZE_SAMPLES * 2) {
      const frame = pcmBuffer.slice(offset, offset + FRAME_SIZE_SAMPLES * 2);
      if (frame.length < FRAME_SIZE_SAMPLES * 2) break;

      const opusFrame = encoder.encode(frame, FRAME_SIZE_SAMPLES);
      const opusBuffer = Buffer.from(opusFrame);

      ws.send(opusBuffer);
      frameCount++;
      bytesSent += opusBuffer.length;

      // Small delay to simulate real-time streaming (optional)
      // await new Promise(resolve => setTimeout(resolve, FRAME_SIZE_MS));
    }

    console.log('[Test] Sent', frameCount, 'Opus frames, total:', bytesSent, 'bytes');

    // Send CloseStream
    setTimeout(() => {
      console.log('[Test] Sending CloseStream...');
      ws.send(JSON.stringify({ type: 'CloseStream' }));
    }, 500);
  });

  ws.on('message', (data) => {
    console.log('[Test] Received:', data.toString());
  });

  ws.on('close', (code) => {
    console.log('[Test] Connection closed, code:', code);
    encoder.delete();
  });

  ws.on('error', (err) => {
    console.error('[Test] Error:', err.message);
    encoder.delete();
  });
}

main().catch(console.error);
