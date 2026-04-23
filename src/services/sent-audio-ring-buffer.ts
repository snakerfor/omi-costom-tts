export interface SentAudioChunk {
  sentStartMs: number;
  sentEndMs: number;
  originalStartMs: number;
  originalEndMs: number;
  data: Buffer;
}

export interface ExtractedPcmAudio {
  data: Buffer;
  durationMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class SentAudioRingBuffer {
  private readonly chunks: SentAudioChunk[] = [];

  constructor(
    private readonly maxBufferMs: number,
    private readonly bytesPerMs = 32,
  ) {}

  push(chunk: SentAudioChunk): void {
    if (chunk.sentEndMs <= chunk.sentStartMs || chunk.data.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.prune(chunk.sentEndMs);
  }

  extractBySentRange(startMs: number, endMs: number): ExtractedPcmAudio | null {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return null;
    }

    const parts: Buffer[] = [];
    for (const chunk of this.chunks) {
      if (chunk.sentEndMs <= startMs) continue;
      if (chunk.sentStartMs >= endMs) break;

      const overlapStart = Math.max(startMs, chunk.sentStartMs);
      const overlapEnd = Math.min(endMs, chunk.sentEndMs);
      if (overlapEnd <= overlapStart) continue;

      const startOffset = this.msToByteOffset(overlapStart - chunk.sentStartMs, chunk.data.length);
      const endOffset = this.msToByteOffset(overlapEnd - chunk.sentStartMs, chunk.data.length);
      if (endOffset > startOffset) {
        parts.push(chunk.data.subarray(startOffset, endOffset));
      }
    }

    if (!parts.length) {
      return null;
    }

    const data = Buffer.concat(parts);
    return {
      data,
      durationMs: Math.round(data.length / this.bytesPerMs),
    };
  }

  private prune(latestSentEndMs: number): void {
    const minSentStartMs = latestSentEndMs - this.maxBufferMs;
    while (this.chunks.length > 0 && this.chunks[0].sentEndMs < minSentStartMs) {
      this.chunks.shift();
    }
  }

  private msToByteOffset(offsetMs: number, maxBytes: number): number {
    const raw = Math.round(offsetMs * this.bytesPerMs);
    const aligned = raw - (raw % 2);
    return clamp(aligned, 0, maxBytes);
  }
}
