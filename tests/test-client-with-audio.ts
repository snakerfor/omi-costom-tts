import WebSocket from 'ws';
import fs from 'fs';

// Configuration
const SERVER_URL = process.env.TEST_SERVER_URL ?? 'ws://localhost:8080/stt';
const API_TOKEN = process.env.TEST_API_TOKEN ?? 'token-device-a';
const AUDIO_FILE = ''; // Force PCM silence test

// 建议使用 WAV 或 MP3 格式测试，避免 m4a/aac 容器问题
// macOS 转换: afconvert test.m4a test.wav
// ffmpeg 转换: ffmpeg -i test.m4a -ar 16000 -ac 1 test.wav

// Build WebSocket URL with query params
const url = new URL(SERVER_URL);
url.searchParams.set('api_key', API_TOKEN);
url.searchParams.set('language', 'zh');

console.log('[Test] Connecting to:', url.toString());

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('[Test] Connected');

  if (AUDIO_FILE && fs.existsSync(AUDIO_FILE)) {
    // Send real audio file
    console.log('[Test] Sending audio file:', AUDIO_FILE);
    const audioBuffer = fs.readFileSync(AUDIO_FILE);
    ws.send(audioBuffer);
    console.log('[Test] Audio sent, size:', audioBuffer.length, 'bytes');
  } else {
    // Send silence PCM (1 second, 16kHz, 16bit, mono)
    console.log('[Test] No audio file, sending 1s silence PCM...');
    const silenceBuffer = Buffer.alloc(32000, 0); // 16000 * 1 * 2
    ws.send(silenceBuffer);
    console.log('[Test] Silence sent, size:', silenceBuffer.length, 'bytes');
  }

  // Send CloseStream after a delay
  setTimeout(() => {
    console.log('[Test] Sending CloseStream...');
    ws.send(JSON.stringify({ type: 'CloseStream' }));
  }, 2000);
});

ws.on('message', (data) => {
  console.log('[Test] Received:', data.toString());
});

ws.on('close', (code, reason) => {
  console.log('[Test] Connection closed, code:', code, 'reason:', reason?.toString());
});

ws.on('error', (err) => {
  console.error('[Test] Error:', err.message);
});
