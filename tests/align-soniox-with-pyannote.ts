import * as fs from 'fs/promises';
import * as path from 'path';

interface SonioxSegment {
  id: string;
  start_ms: number;
  end_ms: number;
  speaker_label: string | null;
  text: string;
}

interface PyannoteTurn {
  speaker: string;
  start: number;
  end: number;
}

interface AlignmentRow {
  id: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  original_speaker_label: string | null;
  aligned_speaker: string | null;
  overlap_ratio: number;
  text: string;
}

function parseArgs(): { soniox: string; pyannote: string; output: string } {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (key?.startsWith('--') && value) {
      args.set(key.slice(2), value);
    }
  }

  const soniox = args.get('soniox');
  const pyannote = args.get('pyannote');
  if (!soniox || !pyannote) {
    throw new Error('missing required args --soniox and --pyannote');
  }

  return {
    soniox: path.resolve(soniox),
    pyannote: path.resolve(pyannote),
    output: path.resolve(args.get('output') || path.join(process.cwd(), 'preview_results', 'soniox-pyannote-alignment.json')),
  };
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const sonioxJson = JSON.parse(await fs.readFile(options.soniox, 'utf8')) as {
    session_id: string;
    segments: SonioxSegment[];
  };
  const pyJson = JSON.parse(await fs.readFile(options.pyannote, 'utf8')) as {
    job: { output: { diarization: PyannoteTurn[] } };
  };

  const sonioxSegments = sonioxJson.segments || [];
  const pyTurns = (pyJson.job?.output?.diarization || []).map(turn => ({
    speaker: turn.speaker,
    start_ms: Math.round(Number(turn.start || 0) * 1000),
    end_ms: Math.round(Number(turn.end || 0) * 1000),
  }));

  const aligned: AlignmentRow[] = sonioxSegments.map(segment => {
    const durationMs = Math.max(1, segment.end_ms - segment.start_ms);
    const overlaps = new Map<string, number>();

    for (const turn of pyTurns) {
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

  const originalLabels = [...new Set(aligned.map(row => row.original_speaker_label).filter(Boolean))];
  const alignedSpeakers = [...new Set(aligned.map(row => row.aligned_speaker).filter(Boolean))];
  const byAlignedSpeaker = Object.fromEntries(
    alignedSpeakers.map(speaker => [
      speaker,
      aligned.filter(row => row.aligned_speaker === speaker).length,
    ]),
  );

  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(
    options.output,
    JSON.stringify(
      {
        sonioxSessionId: sonioxJson.session_id,
        segmentCount: aligned.length,
        originalSpeakerLabelCount: originalLabels.length,
        alignedSpeakerCount: alignedSpeakers.length,
        byAlignedSpeaker,
        aligned,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(
    JSON.stringify(
      {
        segmentCount: aligned.length,
        originalSpeakerLabelCount: originalLabels.length,
        alignedSpeakerCount: alignedSpeakers.length,
        byAlignedSpeaker,
      },
      null,
      2,
    ),
  );
}

main().catch(err => {
  console.error('[Align] failed:', err);
  process.exit(1);
});
