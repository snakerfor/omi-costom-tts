/**
 * Check what format opusscript outputs
 */
import OpusScript from 'opusscript';
import fs from 'fs';

// Read PCM file
const pcmBuffer = fs.readFileSync('tests/test-voice.pcm');
console.log('[Check] PCM buffer length:', pcmBuffer.length);

// Create encoder
const encoder = new OpusScript(16000, 1, OpusScript.Application.AUDIO);

// Encode first frame
const frameSize = 320; // 20ms at 16kHz
const pcmFrame = pcmBuffer.slice(0, frameSize * 2);
console.log('[Check] PCM frame length:', pcmFrame.length);

// Check PCM format - should be Int16
console.log('[Check] First 4 bytes as Int16:', pcmFrame.readInt16LE(0), pcmFrame.readInt16LE(2));

// Encode to Opus
const opusFrame = encoder.encode(pcmFrame, frameSize);
console.log('[Check] Opus frame length:', opusFrame.length);

// Decode back
const decodedPcm = encoder.decode(Buffer.from(opusFrame));
console.log('[Check] Decoded PCM type:', typeof decodedPcm, decodedPcm.constructor.name);
console.log('[Check] Decoded PCM length:', decodedPcm.length);

// Check if it's a Buffer or Uint8Array
if (decodedPcm instanceof Uint8Array) {
  console.log('[Check] Output is Uint8Array');
  const int16View = new Int16Array(decodedPcm.buffer, decodedPcm.byteOffset, decodedPcm.byteLength / 2);
  console.log('[Check] First 4 Int16 values:', int16View[0], int16View[1], int16View[2], int16View[3]);
}

encoder.delete();

// Save decoded PCM to file
fs.writeFileSync('tests/decoded.pcm', Buffer.from(decodedPcm));
console.log('[Check] Saved decoded PCM to tests/decoded.pcm');
