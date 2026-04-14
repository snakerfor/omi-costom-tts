import * as fs from 'fs/promises';
import * as path from 'path';
import { FinalizedSegment } from './conversation-finalizer';
import { PyannoteTurn, pyannoteEnabled, runPyannoteDiarization } from './pyannote-diarization';
import { previewResultsDir } from '../runtime-paths';

export interface AlignmentRow {
  id: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  original_speaker_label: string | null;
  aligned_speaker: string | null;
  overlap_ratio: number;
  text: string;
}

interface AlignmentContext {
  sessionId: string;
  segments: FinalizedSegment[];
  turns: PyannoteTurn[];
}

export interface AlignConversationSpeakersOptions {
  sessionId: string;
  audioPath: string;
  segments: FinalizedSegment[];
}

export interface AlignConversationSpeakersResult {
  segments: FinalizedSegment[];
  alignmentRows: AlignmentRow[];
  diarizationOutputPath: string | null;
  alignmentOutputPath: string | null;
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

export function alignByOverlap(segments: FinalizedSegment[], turns: PyannoteTurn[]): AlignmentRow[] {
  return segments.map(segment => {
    const durationMs = Math.max(1, segment.end_ms - segment.start_ms);
    const overlaps = new Map<string, number>();

    for (const turn of turns) {
      const overlap = overlapMs(segment.start_ms, segment.end_ms, turn.start_ms, turn.end_ms);
      if (!overlap) continue;
      overlaps.set(turn.speaker, (overlaps.get(turn.speaker) || 0) + overlap);
    }

    let bestSpeaker: string | null = null;
    let bestOverlap = 0;
    for (const [speaker, overlap] of overlaps.entries()) {
      if (overlap > bestOverlap) {
        bestSpeaker = speaker;
        bestOverlap = overlap;
      }
    }

    return {
      id: segment.id,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      duration_ms: durationMs,
      original_speaker_label: segment.speaker_label,
      aligned_speaker: bestSpeaker,
      overlap_ratio: bestOverlap / durationMs,
      text: segment.text,
    };
  });
}

export function smoothBoundaryRows(rows: AlignmentRow[]): AlignmentRow[] {
  const out = rows.map(row => ({ ...row }));

  for (let index = 0; index < out.length; index++) {
    const current = out[index];
    const prev = out[index - 1] || null;
    const next = out[index + 1] || null;
    const shortText = current.text.trim().length <= 6 || current.duration_ms <= 1500;
    const weakAlignment = current.overlap_ratio < 0.5;

    if (prev && next && prev.aligned_speaker && prev.aligned_speaker === next.aligned_speaker) {
      if ((weakAlignment || shortText) && current.aligned_speaker !== prev.aligned_speaker) {
        current.aligned_speaker = prev.aligned_speaker;
        current.overlap_ratio = Math.max(current.overlap_ratio, 0.51);
      }
      continue;
    }

    if (index === 0 && next?.aligned_speaker && (weakAlignment || shortText)) {
      current.aligned_speaker = next.aligned_speaker;
      current.overlap_ratio = Math.max(current.overlap_ratio, 0.51);
      continue;
    }

    if (index === out.length - 1 && prev?.aligned_speaker && (weakAlignment || shortText)) {
      current.aligned_speaker = prev.aligned_speaker;
      current.overlap_ratio = Math.max(current.overlap_ratio, 0.51);
      continue;
    }

    if (!current.aligned_speaker && prev?.aligned_speaker && next?.aligned_speaker && prev.aligned_speaker === next.aligned_speaker) {
      current.aligned_speaker = prev.aligned_speaker;
      current.overlap_ratio = Math.max(current.overlap_ratio, 0.51);
    }
  }

  return out;
}

function applyAlignedSpeakers(segments: FinalizedSegment[], rows: AlignmentRow[]): FinalizedSegment[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  return segments.map(segment => {
    const row = byId.get(segment.id);
    return {
      ...segment,
      speaker_label: row?.aligned_speaker || segment.speaker_label,
    };
  });
}

async function writeAlignmentArtifacts(
  context: AlignmentContext,
  alignmentRows: AlignmentRow[],
  diarizationOutputPath: string | null,
): Promise<string | null> {
  const outPath = path.join(previewResultsDir, `${context.sessionId}_speaker_alignment.json`);
  const alignedSpeakers = [...new Set(alignmentRows.map(row => row.aligned_speaker).filter(Boolean))];

  await fs.mkdir(previewResultsDir, { recursive: true });
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        sessionId: context.sessionId,
        segmentCount: alignmentRows.length,
        alignedSpeakerCount: alignedSpeakers.length,
        diarizationOutputPath,
        aligned: alignmentRows,
      },
      null,
      2,
    ),
    'utf8',
  );

  return outPath;
}

export async function alignConversationSpeakers(
  options: AlignConversationSpeakersOptions,
): Promise<AlignConversationSpeakersResult> {
  if (!pyannoteEnabled()) {
    return {
      segments: options.segments,
      alignmentRows: [],
      diarizationOutputPath: null,
      alignmentOutputPath: null,
    };
  }

  const diarizationOutputPath = path.join(previewResultsDir, `${options.sessionId}_pyannote.json`);
  try {
    const diarization = await runPyannoteDiarization({
      audioPath: options.audioPath,
      sessionId: options.sessionId,
      outputPath: diarizationOutputPath,
    });

    const rawRows = alignByOverlap(options.segments, diarization.turns);
    const smoothedRows = smoothBoundaryRows(rawRows);
    const alignedSegments = applyAlignedSpeakers(options.segments, smoothedRows);
    const alignmentOutputPath = await writeAlignmentArtifacts(
      {
        sessionId: options.sessionId,
        segments: options.segments,
        turns: diarization.turns,
      },
      smoothedRows,
      diarization.outputPath,
    );

    return {
      segments: alignedSegments,
      alignmentRows: smoothedRows,
      diarizationOutputPath: diarization.outputPath,
      alignmentOutputPath,
    };
  } catch (err) {
    console.warn('[SpeakerAlignment] pyannote alignment skipped:', String((err as Error)?.message ?? err));
    return {
      segments: options.segments,
      alignmentRows: [],
      diarizationOutputPath: diarizationOutputPath,
      alignmentOutputPath: null,
    };
  }
}
