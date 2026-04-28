import { SonioxToken } from '../types';

const ZERO_DURATION_STARTUP_TEXT = new Set([
  'but',
  'but.',
]);

function normalizeTranscriptText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function isZeroDurationStartupNoise(input: {
  text: string;
  startMs: number;
  endMs: number;
}): boolean {
  const startMs = Number(input.startMs || 0);
  const endMs = Number(input.endMs || 0);
  if (startMs !== 0 || endMs !== 0) {
    return false;
  }
  return ZERO_DURATION_STARTUP_TEXT.has(normalizeTranscriptText(input.text));
}

export function isZeroDurationStartupNoiseTokens(tokens: SonioxToken[]): boolean {
  if (!tokens.length) {
    return false;
  }
  const text = tokens.map(token => token.text || '').join('').trim();
  const startMs = Math.min(...tokens.map(token => Number(token.start_ms || 0)));
  const endMs = Math.max(...tokens.map(token => Number(token.end_ms || 0)));
  return isZeroDurationStartupNoise({ text, startMs, endMs });
}
