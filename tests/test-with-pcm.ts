import WebSocket from 'ws';

// Configuration
const SERVER_URL = process.env.TEST_SERVER_URL ?? 'ws://localhost:8080/stt';
const API_TOKEN = process.env.TEST_API_TOKEN ?? 'token-device-a';

// Build WebSocket URL with query params
const url = new URL(SERVER_URL);
url.searchParams.set('api_key', API_TOKEN);
url.searchParams.set('language', 'zh');

console.log('[Test PCM] Connecting to:', url.toString());

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('[Test PCM] Connected');

  // Generate test PCM: 16kHz, 16bit, mono, 3 seconds
  // 16000 samples/sec * 2 bytes/sample * 3 sec = 96000 bytes
  const durationSec = 3;
  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const numBytes = sampleRate * (bitsPerSample / 8) * numChannels * durationSec;

  // Generate a simple tone (440Hz sine wave) for 3 seconds
  const frequency = 440;
  const samples = [];
  for (let i = 0; i < sampleRate * durationSec; i++) {
    const t = i / sampleRate;
    const amplitude = 16000;
    const sample = Math.floor(amplitude * Math.sin(2 * Math.PI * frequency * t));
    // Little-endian 16-bit
    samples.push(sample & 0xff);
    samples.push((sample >> 8) & 0xff);
  }

  const pcmBuffer = Buffer.from(samples);
  console.log('[Test PCM] Sending', pcmBuffer.length, 'bytes (', durationSec, 'sec PCM)...');
  ws.send(pcmBuffer);

  // Send CloseStream after a delay
  setTimeout(() => {
    console.log('[Test PCM] Sending CloseStream...');
    ws.send(JSON.stringify({ type: 'CloseStream' }));
  }, 4000);
});

ws.on('message', (data) => {
  console.log('[Test PCM] Received:', data.toString());
});

ws.on('close', (code, reason) => {
  console.log('[Test PCM] Connection closed, code:', code);
});

ws.on('error', (err) => {
  console.error('[Test PCM] Error:', err.message);
});
