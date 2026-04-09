import * as fs from 'fs/promises';
import * as path from 'path';
import { RawTranscriptEvent } from './final-result-recorder';
import { SonioxToken } from '../types';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface FinalizedSegment {
  id: string;
  start_ms: number;
  end_ms: number;
  absolute_start_time: string;
  absolute_end_time: string;
  speaker_label: string | null;
  text: string;
}

export interface FinalizeConversationOptions {
  sessionId: string;
  rawTranscriptPath: string;
  outputDir: string;
  recordingStartedAt: string;
}

export interface FinalizeConversationResult {
  outPath: string;
  segments: FinalizedSegment[];
}

function parseNdjson(content: string): RawTranscriptEvent[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as RawTranscriptEvent);
}

function normalizeFinalTokens(events: RawTranscriptEvent[]): SonioxToken[] {
  const out: SonioxToken[] = [];
  for (const e of events) {
    if (!e.is_final || !Array.isArray(e.tokens)) continue;
    for (const t of e.tokens) {
      if (!t?.is_final) continue;
      const text = (t.text || '').trim();
      if (!text) continue;
      out.push({
        ...t,
        text,
        start_ms: Number(t.start_ms || 0),
        end_ms: Number(t.end_ms || 0),
      });
    }
  }

  out.sort((a, b) => (Number(a.start_ms || 0) - Number(b.start_ms || 0)) || (Number(a.end_ms || 0) - Number(b.end_ms || 0)));
  return out;
}

function buildSegments(tokens: SonioxToken[], recordingStartedAt: string): FinalizedSegment[] {
  if (!tokens.length) return [];

  const MAX_GAP_MS = 1200;
  const segments: FinalizedSegment[] = [];

  let current: {
    id: string;
    start_ms: number;
    end_ms: number;
    speaker_label: string | null;
    parts: string[];
  } | null = null;

  for (const token of tokens) {
    const speakerLabel = token.speaker != null ? String(token.speaker) : null;
    const startMs = Number(token.start_ms || 0);
    const endMs = Number(token.end_ms || startMs);
    const text = token.text.trim();

    if (!current) {
      current = {
        id: genId('seg'),
        start_ms: startMs,
        end_ms: endMs,
        speaker_label: speakerLabel,
        parts: [text],
      };
      continue;
    }

    const gap = startMs - current.end_ms;
    const sameSpeaker = current.speaker_label === speakerLabel;
    const prevText = current.parts[current.parts.length - 1] || '';
    const shouldSplit = !sameSpeaker || gap > MAX_GAP_MS || /[。！？.!?]$/.test(prevText);

    if (shouldSplit) {
      const absStart = new Date(new Date(recordingStartedAt).getTime() + current.start_ms).toISOString();
      const absEnd = new Date(new Date(recordingStartedAt).getTime() + current.end_ms).toISOString();
      segments.push({
        id: current.id,
        start_ms: current.start_ms,
        end_ms: current.end_ms,
        absolute_start_time: absStart,
        absolute_end_time: absEnd,
        speaker_label: current.speaker_label,
        text: current.parts.join('').trim(),
      });

      current = {
        id: genId('seg'),
        start_ms: startMs,
        end_ms: endMs,
        speaker_label: speakerLabel,
        parts: [text],
      };
    } else {
      current.end_ms = endMs;
      current.parts.push(text);
    }
  }

  if (current) {
    const absStart = new Date(new Date(recordingStartedAt).getTime() + current.start_ms).toISOString();
    const absEnd = new Date(new Date(recordingStartedAt).getTime() + current.end_ms).toISOString();
    segments.push({
      id: current.id,
      start_ms: current.start_ms,
      end_ms: current.end_ms,
      absolute_start_time: absStart,
      absolute_end_time: absEnd,
      speaker_label: current.speaker_label,
      text: current.parts.join('').trim(),
    });
  }

  return segments;
}

export async function finalizeConversation(options: FinalizeConversationOptions): Promise<FinalizeConversationResult> {
  const raw = await fs.readFile(options.rawTranscriptPath, 'utf8');
  const events = parseNdjson(raw);
  const finalTokens = normalizeFinalTokens(events);
  const segments = buildSegments(finalTokens, options.recordingStartedAt);

  await fs.mkdir(options.outputDir, { recursive: true });
  const outPath = path.join(options.outputDir, `${options.sessionId}.json`);
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        session_id: options.sessionId,
        recording_started_at: options.recordingStartedAt,
        finalized_at: new Date().toISOString(),
        segment_count: segments.length,
        segments,
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    outPath,
    segments,
  };
}
