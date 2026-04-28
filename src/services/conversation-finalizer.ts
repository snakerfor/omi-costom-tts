import * as fs from 'fs/promises';
import * as path from 'path';
import { RawTranscriptEvent } from './final-result-recorder';
import { SonioxToken } from '../types';
import { isZeroDurationStartupNoise, isZeroDurationStartupNoiseTokens } from '../utils/transcript-noise';

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
  speaker_id?: string | null;
  speaker_name?: string | null;
  speaker_identity?: string | null;
  confidence?: number | null;
  resolution_method?: string | null;
  error_message?: string | null;
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

interface TimelineMapEntry {
  sent_start_ms: number;
  sent_end_ms: number;
  original_start_ms: number;
  original_end_ms: number;
}

function hasMeaningfulContent(text: string): boolean {
  return /[\p{Script=Han}\p{L}\p{N}]/u.test(text);
}

function isStandalonePunctuation(text: string): boolean {
  return !hasMeaningfulContent(text);
}

function shouldMergeShortSegment(current: FinalizedSegment, next: FinalizedSegment): boolean {
  const currentDuration = current.end_ms - current.start_ms;
  const nextDuration = next.end_ms - next.start_ms;
  const gap = next.start_ms - current.end_ms;

  if (current.speaker_label !== next.speaker_label) {
    return false;
  }

  if (gap > 1500) {
    return false;
  }

  if (isStandalonePunctuation(current.text) || isStandalonePunctuation(next.text)) {
    return true;
  }

  return current.text.length <= 2 || next.text.length <= 2 || currentDuration <= 800 || nextDuration <= 800;
}

function mergeSegmentPair(current: FinalizedSegment, next: FinalizedSegment): FinalizedSegment {
  return {
    ...current,
    end_ms: next.end_ms,
    absolute_end_time: next.absolute_end_time,
    text: `${current.text}${next.text}`.trim(),
  };
}

function compactSegments(segments: FinalizedSegment[]): FinalizedSegment[] {
  const filtered = segments.filter(seg => hasMeaningfulContent(seg.text));
  if (!filtered.length) {
    return [];
  }

  const compacted: FinalizedSegment[] = [];
  for (const seg of filtered) {
    const prev = compacted.at(-1);
    if (prev && shouldMergeShortSegment(prev, seg)) {
      compacted[compacted.length - 1] = mergeSegmentPair(prev, seg);
      continue;
    }
    compacted.push(seg);
  }

  return compacted;
}

function parseNdjson(content: string): RawTranscriptEvent[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as RawTranscriptEvent);
}

function normalizeFinalSegments(events: RawTranscriptEvent[]): FinalizedSegment[] {
  const seen = new Set<string>();
  const out: FinalizedSegment[] = [];

  for (const event of events) {
    const segment = event.segment;
    if (event.event !== 'final_segment' || !segment) {
      continue;
    }

    const text = String(segment.text || '').trim();
    if (!text) {
      continue;
    }
    if (isZeroDurationStartupNoise({
      text,
      startMs: Number(segment.start_ms || 0),
      endMs: Number(segment.end_ms || 0),
    })) {
      continue;
    }

    const normalized: FinalizedSegment = {
      id: segment.id,
      start_ms: Number(segment.start_ms || 0),
      end_ms: Number(segment.end_ms || 0),
      absolute_start_time: segment.absolute_start_time,
      absolute_end_time: segment.absolute_end_time,
      speaker_label: segment.speaker_label,
      text,
      speaker_id: segment.speaker_id,
      speaker_name: segment.speaker_name,
      speaker_identity: segment.speaker_identity,
      confidence: segment.confidence,
      resolution_method: segment.resolution_method,
      error_message: segment.error_message,
    };
    normalized.end_ms = Math.max(normalized.start_ms, normalized.end_ms);

    const key = [
      normalized.id,
      normalized.start_ms,
      normalized.end_ms,
      normalized.speaker_label ?? '',
      normalized.text,
    ].join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }

  out.sort((a, b) => (a.start_ms - b.start_ms) || (a.end_ms - b.end_ms) || a.id.localeCompare(b.id));
  return out;
}

function normalizeFinalTokens(events: RawTranscriptEvent[]): SonioxToken[] {
  const seen = new Set<string>();
  const out: SonioxToken[] = [];
  for (const e of events) {
    if (!Array.isArray(e.tokens)) continue;
    if (isZeroDurationStartupNoiseTokens(e.tokens)) continue;
    for (const t of e.tokens) {
      if (!t?.is_final) continue;
      const text = (t.text || '').trim();
      if (!text) continue;
      const normalizedToken: SonioxToken = {
        ...t,
        text,
        start_ms: Number(t.start_ms || 0),
        end_ms: Number(t.end_ms || 0),
      };
      const key = [
        normalizedToken.start_ms,
        normalizedToken.end_ms,
        normalizedToken.speaker ?? '',
        normalizedToken.text,
      ].join('|');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(normalizedToken);
    }
  }

  out.sort((a, b) => (Number(a.start_ms || 0) - Number(b.start_ms || 0)) || (Number(a.end_ms || 0) - Number(b.end_ms || 0)));
  return out;
}

async function readTimelineMap(rawTranscriptPath: string): Promise<TimelineMapEntry[]> {
  const sidecarPath = `${rawTranscriptPath}.timeline.json`;
  try {
    const raw = await fs.readFile(sidecarPath, 'utf8');
    const parsed = JSON.parse(raw) as { entries?: TimelineMapEntry[] };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return entries
      .filter(entry => (
        Number.isFinite(entry.sent_start_ms) &&
        Number.isFinite(entry.sent_end_ms) &&
        Number.isFinite(entry.original_start_ms) &&
        Number.isFinite(entry.original_end_ms) &&
        entry.sent_end_ms > entry.sent_start_ms &&
        entry.original_end_ms >= entry.original_start_ms
      ))
      .sort((a, b) => a.sent_start_ms - b.sent_start_ms);
  } catch {
    return [];
  }
}

function mapSentMsToOriginalMs(value: number, timeline: TimelineMapEntry[]): number {
  if (!timeline.length || !Number.isFinite(value)) {
    return value;
  }

  for (const entry of timeline) {
    if (value < entry.sent_start_ms) {
      continue;
    }
    if (value <= entry.sent_end_ms) {
      const delta = value - entry.sent_start_ms;
      return Math.min(entry.original_end_ms, entry.original_start_ms + delta);
    }
  }

  const last = timeline[timeline.length - 1];
  if (value > last.sent_end_ms) {
    return last.original_end_ms + (value - last.sent_end_ms);
  }

  return value;
}

function remapTokensToOriginalTimeline(tokens: SonioxToken[], timeline: TimelineMapEntry[]): SonioxToken[] {
  if (!timeline.length) {
    return tokens;
  }

  return tokens.map(token => {
    const startMs = Number(token.start_ms || 0);
    const endMs = Number(token.end_ms || startMs);
    const mappedStart = mapSentMsToOriginalMs(startMs, timeline);
    const mappedEnd = Math.max(mappedStart, mapSentMsToOriginalMs(endMs, timeline));
    return {
      ...token,
      start_ms: mappedStart,
      end_ms: mappedEnd,
    };
  });
}

function remapSegmentsToOriginalTimeline(
  segments: FinalizedSegment[],
  timeline: TimelineMapEntry[],
  recordingStartedAt: string,
): FinalizedSegment[] {
  if (!timeline.length) {
    return segments;
  }

  const baseTime = new Date(recordingStartedAt).getTime();
  return segments.map(segment => {
    const mappedStart = mapSentMsToOriginalMs(segment.start_ms, timeline);
    const mappedEnd = Math.max(mappedStart, mapSentMsToOriginalMs(segment.end_ms, timeline));
    return {
      ...segment,
      start_ms: mappedStart,
      end_ms: mappedEnd,
      absolute_start_time: new Date(baseTime + mappedStart).toISOString(),
      absolute_end_time: new Date(baseTime + mappedEnd).toISOString(),
    };
  });
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
        resolution_method: 'soniox_finalized',
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
      resolution_method: 'soniox_finalized',
    });
  }

  return compactSegments(segments);
}

export async function finalizeConversation(options: FinalizeConversationOptions): Promise<FinalizeConversationResult> {
  let raw = '';
  try {
    raw = await fs.readFile(options.rawTranscriptPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw err;
    }
  }

  const events = raw ? parseNdjson(raw) : [];
  const timeline = await readTimelineMap(options.rawTranscriptPath);
  const finalSegments = remapSegmentsToOriginalTimeline(
    normalizeFinalSegments(events),
    timeline,
    options.recordingStartedAt,
  );
  const finalTokens = remapTokensToOriginalTimeline(normalizeFinalTokens(events), timeline);
  const segments = finalSegments.length ? finalSegments : buildSegments(finalTokens, options.recordingStartedAt);

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
