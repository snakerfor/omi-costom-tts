import { SonioxToken, Segment } from '../types';

const SILENCE_GAP_MS = 500;
const MAX_DURATION_MS = 15000;

export class SegmentBuilder {
  private buffer: SonioxToken[] = [];
  private timeOffsetMs = 0;
  private lastPartialSegment: Segment | null = null;

  setTimeOffset(ms: number): void {
    this.timeOffsetMs = ms;
  }

  /**
   * Push a token and return a segment if ready.
   * - Non-final: Soniox returns cumulative tokens, REPLACE buffer (not append)
   * - Final tokens: flush buffer and return final segment
   */
  push(token: SonioxToken): Segment | null {
    if (!token.is_final) {
      // Non-final: Soniox sends ALL tokens seen so far, replace buffer entirely
      // The token parameter is one of the cumulative tokens, but we rebuild from accumulated state
      // Actually, for non-final we should rebuild from current buffer state
      this.lastPartialSegment = this.flush();
      return null;
    }

    // Final token: flush and emit
    const prev = this.buffer.at(-1);
    const shouldFlush =
      this.buffer.length > 0 &&
      (token.speaker !== prev?.speaker ||
        token.start_ms - (prev?.end_ms ?? 0) > SILENCE_GAP_MS ||
        token.end_ms - (this.buffer[0]?.start_ms ?? 0) > MAX_DURATION_MS);

    if (shouldFlush) {
      const seg = this.flush();
      this.buffer = [token];
      this.lastPartialSegment = null;
      return seg;
    }

    this.buffer.push(token);
    const seg = this.flush();
    this.buffer = [];
    this.lastPartialSegment = null;
    return seg;
  }

  /**
   * Add token to buffer (called externally when processing Soniox results)
   * For non-final: REPLACE buffer since Soniox sends cumulative tokens
   * For final: APPEND to buffer
   */
  addToken(token: SonioxToken): void {
    if (!token.is_final) {
      // Non-final: Soniox cumulative tokens - reset buffer and add this token
      // But since we get cumulative tokens in result.tokens, we should clear and rebuild
      this.buffer = [token];
    } else {
      // Final: append
      this.buffer.push(token);
    }
  }

  /**
   * Set buffer directly (for non-final cumulative tokens)
   */
  setBuffer(tokens: SonioxToken[]): void {
    this.buffer = [...tokens];
    this.lastPartialSegment = this.flush();
  }

  /**
   * Get the last partial segment (for UI updates)
   */
  getLastPartial(): Segment | null {
    return this.lastPartialSegment;
  }

  flush(): Segment | null {
    if (this.buffer.length === 0) return null;

    const text = this.buffer.map(t => t.text).join('').trim();
    if (!text) {
      return null;
    }

    // Calculate time with protection against start > end
    const startMs = this.buffer[0]?.start_ms ?? 0;
    const endMs = this.buffer.at(-1)?.end_ms ?? startMs;
    const safeStart = Math.min(startMs, endMs) + this.timeOffsetMs;
    const safeEnd = Math.max(startMs, endMs) + this.timeOffsetMs;

    const seg: Segment = {
      text,
      start: safeStart / 1000,
      end: safeEnd / 1000,
      speaker: `SPEAKER_${String(this.buffer[0].speaker ?? '0').padStart(2, '0')}`,
    };

    return seg;
  }
}
