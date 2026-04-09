/**
 * Generate raw Opus frames for testing
 * Usage: npx ts-node tests/generate-opus.ts
 */

import OpusScript from '../src/services/audio-converter';
import fs from 'fs';

// Generate 3 seconds of PCM audio (440Hz sine wave)
const sampleRate = 16000;
const durationSec = 3;
const frequency = 440;
const samples: number[] = [];

for (let i = 0; i < sampleRate * durationSec; i++) {
  const t = i / sampleRate;
  const amplitude = 8000;
  const sample = Math.floor(amplitude * Math.sin(2 * Math.PI * frequency * t));
  // Little-endian 16-bit
  samples.push(sample & 0xff);
  samples.push((sample >> 8) & 0xff);
}

const pcmBuffer = Buffer.from(samples);
console.log('[Generate] PCM generated, size:', pcmBuffer.length, 'bytes');

// Encode to Opus using opusscript
const encoder = new OpusScript(16000, 1, OpusScript.Application.AUDIO);

// OpusScript encodes in frames, we need to encode the whole buffer
const frameSize = 960; // 60ms at 16kHz
const opusFrames: Buffer[] = [];

for (let offset = 0; offset < pcmBuffer.length; offset += frameSize * 2) {
  const frame = pcmBuffer.slice(offset, offset + frameSize * 2);
  if (frame.length < frameSize * 2) break;
  const encoded = encoder.encode(frame, frameSize);
  opusFrames.push(Buffer.from(encoded));
  console.log('[Generate] Encoded frame, size:', encoded.length);
}

encoder.delete();

// Concatenate all Opus frames
const rawOpus = Buffer.concat(opusFrames);
console.log('[Generate] Total raw Opus size:', rawOpus.length, 'bytes');

// Save to file
fs.writeFileSync('tests/test-raw-opus.raw', rawOpus);
console.log('[Generate] Saved to tests/test-raw-opus.raw');
