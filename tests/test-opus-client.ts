/**
 * Test with Opus Audio
 *
 * To generate test Opus audio, use ffmpeg:
 *   ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -acodec libopus -ar 16000 -ac 1 tests/test.opus
 *
 * Or convert from any audio file:
 *   ffmpeg -i input.mp3 -acodec libopus -ar 16000 -ac 1 tests/test.opus
 *
 * Then run this test:
 *   TEST_OPUS_FILE=tests/test.opus npm run test:opus
 */

import WebSocket from 'ws';
import fs from 'fs';

const SERVER_URL = process.env.TEST_SERVER_URL ?? 'ws://localhost:8080/stt';
const API_TOKEN = process.env.TEST_API_TOKEN ?? 'token-device-a';
const OPUS_FILE = process.env.TEST_OPUS_FILE ?? 'tests/test.opus';

async function main() {
  if (!fs.existsSync(OPUS_FILE)) {
    console.error('[Test] Opus file not found:', OPUS_FILE);
    console.error('[Test] Generate with: ffmpeg -f lavfi -i "sine=frequency=440:duration=3" -acodec libopus -ar 16000 -ac 1', OPUS_FILE);
    process.exit(1);
  }

  const opusBuffer = fs.readFileSync(OPUS_FILE);
  console.log('[Test] Loaded Opus file, size:', opusBuffer.length, 'bytes');

  const url = new URL(SERVER_URL);
  url.searchParams.set('api_key', API_TOKEN);
  url.searchParams.set('language', 'zh');

  console.log('[Test] Connecting to:', url.toString());
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[Test] Connected, sending Opus audio...');
    ws.send(opusBuffer);

    setTimeout(() => {
      console.log('[Test] Sending CloseStream...');
      ws.send(JSON.stringify({ type: 'CloseStream' }));
    }, 1000);
  });

  ws.on('message', (data) => {
    console.log('[Test] Received:', data.toString());
  });

  ws.on('close', (code) => {
    console.log('[Test] Connection closed, code:', code);
  });

  ws.on('error', (err) => {
    console.error('[Test] Error:', err.message);
  });
}

main().catch(console.error);
