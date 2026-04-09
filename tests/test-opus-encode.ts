import WebSocket from 'ws';
import { AudioConverter } from '../src/services/audio-converter';

// This script generates Opus audio from PCM and sends it to test the Opus decoding flow
// Usage:
//   1. First generate Opus test file: npx ts-node tests/generate-test-opus.ts
//   2. Then run this test: npm run test:opus

async function generateTestOpus() {
  const converter = new AudioConverter();

  // Generate 3 seconds of PCM audio (440Hz sine wave)
  const sampleRate = 16000;
  const durationSec = 3;
  const frequency = 440;
  const samples: number[] = [];

  for (let i = 0; i < sampleRate * durationSec; i++) {
    const t = i / sampleRate;
    const amplitude = 8000; // lower amplitude for voice-like level
    const sample = Math.floor(amplitude * Math.sin(2 * Math.PI * frequency * t));
    samples.push(sample & 0xff);
    samples.push((sample >> 8) & 0xff);
  }

  const pcmBuffer = Buffer.from(samples);
  console.log('[Generate] PCM generated, size:', pcmBuffer.length, 'bytes');

  // Encode to Opus
  const opusBuffer = converter.encodePcm(pcmBuffer);
  console.log('[Generate] Opus encoded, size:', opusBuffer.length, 'bytes');

  // Save to file
  const fs = await import('fs');
  fs.writeFileSync('tests/test-opus.raw', opusBuffer);
  console.log('[Generate] Saved to tests/test-opus.raw');

  converter.destroy();
}

// Run if called directly
generateTestOpus().catch(console.error);
