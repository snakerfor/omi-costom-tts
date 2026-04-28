import { SonioxToken, Segment } from '../types';
import { isZeroDurationStartupNoise } from './transcript-noise';

const SILENCE_GAP_MS = 500;
const MAX_DURATION_MS = 15000;

export class SegmentBuilder {
  private buffer: SonioxToken[] = [];
  private timeOffsetMs = 0;
  private lastPartialSegment: Segment | null = null;

  setTimeOffset(ms: number): void {
    this.timeOffsetMs = ms;
  }

  setPartial(tokens: SonioxToken[]): void {
    this.buffer = [...tokens];
    this.lastPartialSegment = this.buildSegment(this.buffer);
  }

  consumeFinal(tokens: SonioxToken[]): Segment | null {
    const seg = this.buildSegment(tokens);
    this.buffer = [];
    this.lastPartialSegment = null;
    return seg;
  }

  flushPending(): Segment | null {
    const seg = this.buildSegment(this.buffer);
    this.buffer = [];
    this.lastPartialSegment = null;
    return seg;
  }

  /**
   * Get the last partial segment (for UI updates)
   */
  getLastPartial(): Segment | null {
    return this.lastPartialSegment;
  }

  private buildSegment(tokens: SonioxToken[]): Segment | null {
    if (tokens.length === 0) return null;

    const text = tokens.map(t => t.text).join('').trim();
    if (!text) {
      return null;
    }

    const startMs = tokens[0]?.start_ms ?? 0;
    const endMs = tokens.at(-1)?.end_ms ?? startMs;
    const safeStart = Math.min(startMs, endMs) + this.timeOffsetMs;
    const safeEnd = Math.max(startMs, endMs) + this.timeOffsetMs;
    if (isZeroDurationStartupNoise({ text, startMs: safeStart, endMs: safeEnd })) {
      return null;
    }
    const speaker = tokens[0]?.speaker;

    const seg: Segment = {
      text,
      start: safeStart / 1000,
      end: safeEnd / 1000,
      speaker: speaker ? `SPEAKER_${String(speaker).padStart(2, '0')}` : undefined,
    };

    return seg;
  }
}
