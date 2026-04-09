import OpusScript from 'opusscript';

/**
 * Convert Float32Array to PCM s16le Buffer
 * Soniox expects Int16 little-endian PCM, but opusscript decode returns Float32
 */
function float32ToPcm16Buffer(float32Array: Float32Array): Buffer {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    // Clamp and convert: Float32 [-1, 1] -> Int16 [-32768, 32767]
    const clamped = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = Math.round(clamped * 32767);
  }
  return Buffer.from(int16Array.buffer);
}

export class AudioConverter {
  private encoder: OpusScript | null = null;
  private sampleRate: 8000 | 12000 | 16000 | 24000 | 48000 = 16000;
  private channels = 1;
  private frameSize = 960; // 60ms at 16kHz

  constructor(sampleRate: 8000 | 12000 | 16000 | 24000 | 48000 = 16000, channels = 1) {
    this.sampleRate = sampleRate;
    this.channels = channels;
  }

  /**
   * Decode Opus audio to PCM s16le
   * Note: opusscript decode() returns Float32Array, but Soniox expects Int16 PCM s16le
   */
  decodeOpus(opusBuffer: Buffer): Buffer {
    if (!this.encoder) {
      this.encoder = new OpusScript(this.sampleRate, this.channels, OpusScript.Application.AUDIO);
    }

    try {
      const decoded = this.encoder.decode(opusBuffer) as unknown;
      // Convert Float32 to Int16 PCM s16le
      return float32ToPcm16Buffer(decoded as Float32Array);
    } catch (err) {
      console.error('[AudioConverter] Opus decode error:', err);
      throw err;
    }
  }

  /**
   * Encode PCM to Opus
   */
  encodePcm(pcmBuffer: Buffer): Buffer {
    if (!this.encoder) {
      this.encoder = new OpusScript(this.sampleRate, this.channels, OpusScript.Application.AUDIO);
    }

    try {
      const opusBuffer = this.encoder.encode(pcmBuffer, this.frameSize);
      return Buffer.from(opusBuffer);
    } catch (err) {
      console.error('[AudioConverter] Opus encode error:', err);
      throw err;
    }
  }

  destroy(): void {
    if (this.encoder) {
      this.encoder.delete();
      this.encoder = null;
    }
  }
}
