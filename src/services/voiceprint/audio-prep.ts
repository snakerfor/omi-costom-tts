import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { clipsDir } from '../../runtime-paths';
import { clipAudioSegment } from '../audio-clipper';

export interface ClipWindow {
  startMs: number;
  endMs: number;
}

export interface PreparedClipResult {
  filePath: string;
  durationMs: number;
  sizeBytes: number;
  skipped: boolean;
  reason?: string;
}

export interface SegmentAudioPrepOptions {
  minSegmentMs: number;
  maxQueryMs: number;
}

export interface EnrollmentAudioPrepOptions extends SegmentAudioPrepOptions {
  maxEnrollmentBytes: number;
}

export function estimateWavBytes(durationMs: number): number {
  const pcmBytesPerSecond = 16000 * 1 * 16 / 8;
  return 44 + Math.ceil(Math.max(0, durationMs) / 1000) * pcmBytesPerSecond;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function chooseClipWindow(startMs: number, endMs: number, maxQueryMs: number): ClipWindow {
  const durationMs = Math.max(0, endMs - startMs);
  if (durationMs <= maxQueryMs) {
    return { startMs, endMs };
  }

  const center = startMs + durationMs / 2;
  const half = maxQueryMs / 2;
  const clippedStart = clamp(Math.round(center - half), startMs, endMs - maxQueryMs);
  return {
    startMs: clippedStart,
    endMs: clippedStart + maxQueryMs,
  };
}

export async function prepareSegmentClip(
  sourceAudioPath: string,
  segmentId: string,
  conversationId: string,
  startMs: number,
  endMs: number,
  options: SegmentAudioPrepOptions,
): Promise<PreparedClipResult> {
  const durationMs = Math.max(0, endMs - startMs);
  if (durationMs < options.minSegmentMs) {
    return {
      filePath: '',
      durationMs,
      sizeBytes: 0,
      skipped: true,
      reason: 'segment_too_short',
    };
  }

  const window = chooseClipWindow(startMs, endMs, options.maxQueryMs);
  const outDir = path.join(clipsDir, 'voiceprint', 'segments', conversationId);
  const outPath = path.join(outDir, `${segmentId}_${window.startMs}_${window.endMs}.wav`);
  await fs.mkdir(outDir, { recursive: true });
  await clipAudioSegment(sourceAudioPath, outPath, window.startMs, window.endMs);
  const stat = await fs.stat(outPath);
  return {
    filePath: outPath,
    durationMs: window.endMs - window.startMs,
    sizeBytes: stat.size,
    skipped: false,
  };
}

export async function concatWavFiles(inputPaths: string[], outputPath: string): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });
  const listPath = path.join(dir, `.concat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.txt`);
  const listContent = inputPaths
    .map(item => `file '${item.replace(/'/g, `'\\''`)}'`)
    .join('\n');
  await fs.writeFile(listPath, listContent, 'utf8');

  try {
    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c',
        'copy',
        outputPath,
      ]);

      let stderr = '';
      ff.stderr.on('data', d => {
        stderr += d.toString();
      });
      ff.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg concat failed (${code}): ${stderr}`));
        }
      });
    });
  } finally {
    await fs.rm(listPath, { force: true });
  }
}

export async function prepareEnrollmentAudio(
  sourceAudioPath: string,
  segmentWindows: Array<{ segmentId: string; startMs: number; endMs: number }>,
  conversationId: string,
  enrollmentBatchId: string,
  options: EnrollmentAudioPrepOptions,
): Promise<PreparedClipResult> {
  const outDir = path.join(clipsDir, 'voiceprint', 'enrollments', conversationId, enrollmentBatchId);
  await fs.mkdir(outDir, { recursive: true });

  const tempClips: string[] = [];
  const usableSegments = [...segmentWindows].sort((a, b) => a.startMs - b.startMs);

  for (const item of usableSegments) {
    const prep = await prepareSegmentClip(
      sourceAudioPath,
      item.segmentId,
      conversationId,
      item.startMs,
      item.endMs,
      options,
    );
    if (!prep.skipped && prep.filePath) {
      tempClips.push(prep.filePath);
    }
  }

  if (!tempClips.length) {
    return {
      filePath: '',
      durationMs: 0,
      sizeBytes: 0,
      skipped: true,
      reason: 'no_usable_segments',
    };
  }

  let selectedClips = [...tempClips];
  let outputPath = path.join(outDir, `${enrollmentBatchId}.wav`);

  while (selectedClips.length) {
    await concatWavFiles(selectedClips, outputPath);
    const stat = await fs.stat(outputPath);
    if (stat.size <= options.maxEnrollmentBytes) {
      const durationMs = selectedClips.reduce((sum, clipPath) => {
        const base = path.basename(clipPath, '.wav');
        const parts = base.split('_');
        const start = Number(parts[parts.length - 2]);
        const end = Number(parts[parts.length - 1]);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          return sum + 0;
        }
        return sum + Math.max(0, end - start);
      }, 0);

      return {
        filePath: outputPath,
        durationMs,
        sizeBytes: stat.size,
        skipped: false,
      };
    }
    selectedClips = selectedClips.slice(0, -1);
  }

  return {
    filePath: '',
    durationMs: 0,
    sizeBytes: 0,
    skipped: true,
    reason: 'enrollment_too_large',
  };
}

export async function prepareMultiSourceEnrollmentAudio(
  segmentWindows: Array<{
    segmentId: string;
    conversationId: string;
    sourceAudioPath: string;
    startMs: number;
    endMs: number;
  }>,
  outputScopeId: string,
  enrollmentBatchId: string,
  options: EnrollmentAudioPrepOptions,
): Promise<PreparedClipResult> {
  const outDir = path.join(clipsDir, 'voiceprint', 'enrollments', outputScopeId, enrollmentBatchId);
  await fs.mkdir(outDir, { recursive: true });

  const tempClips: string[] = [];
  const usableSegments = [...segmentWindows].sort((a, b) => (
    a.conversationId.localeCompare(b.conversationId) ||
    a.startMs - b.startMs ||
    a.endMs - b.endMs
  ));

  for (const item of usableSegments) {
    const prep = await prepareSegmentClip(
      item.sourceAudioPath,
      item.segmentId,
      item.conversationId,
      item.startMs,
      item.endMs,
      options,
    );
    if (!prep.skipped && prep.filePath) {
      tempClips.push(prep.filePath);
    }
  }

  if (!tempClips.length) {
    return {
      filePath: '',
      durationMs: 0,
      sizeBytes: 0,
      skipped: true,
      reason: 'no_usable_segments',
    };
  }

  const outputPath = path.join(outDir, `${enrollmentBatchId}.wav`);
  await concatWavFiles(tempClips, outputPath);
  const stat = await fs.stat(outputPath);
  if (stat.size > options.maxEnrollmentBytes) {
    return {
      filePath: outputPath,
      durationMs: 0,
      sizeBytes: stat.size,
      skipped: true,
      reason: 'enrollment_too_large',
    };
  }

  const durationMs = usableSegments.reduce((sum, item) => sum + Math.max(0, item.endMs - item.startMs), 0);
  return {
    filePath: outputPath,
    durationMs,
    sizeBytes: stat.size,
    skipped: false,
  };
}
