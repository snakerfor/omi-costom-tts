import 'dotenv/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { db, initDb } from '../src/db';
import { clipAudioSegment } from '../src/services/audio-clipper';
import { dataRoot } from '../src/runtime-paths';

interface Args {
  conversationId: string | null;
  perSpeaker: number;
  minDurationMs: number;
  outputDir: string;
}

interface SegmentRow {
  id: string;
  speaker_label: string | null;
  start_ms: number;
  end_ms: number;
  absolute_start_time: string | null;
  text: string;
}

interface CandidateRow {
  speaker_label: string;
  segment_id: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  absolute_start_time: string | null;
  text: string;
  score: number;
  clip_path: string;
}

function parseArgs(): Args {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token?.startsWith('--')) continue;
    const next = process.argv[i + 1];
    const value = next && !next.startsWith('--') ? next : 'true';
    args.set(token.slice(2), value);
  }

  const perSpeakerRaw = Number(args.get('per-speaker') || '5');
  const minDurationRaw = Number(args.get('min-duration-ms') || '1500');
  return {
    conversationId: args.get('conversation-id') || null,
    perSpeaker: Number.isFinite(perSpeakerRaw) && perSpeakerRaw > 0 ? Math.floor(perSpeakerRaw) : 5,
    minDurationMs: Number.isFinite(minDurationRaw) && minDurationRaw > 0 ? Math.floor(minDurationRaw) : 1500,
    outputDir: path.resolve(args.get('output-dir') || path.join(dataRoot, 'seed_candidates')),
  };
}

function findTargetConversationId(explicitConversationId: string | null): string {
  if (explicitConversationId) return explicitConversationId;

  const row = db.prepare(`
    SELECT c.id
    FROM conversations c
    WHERE c.status = 'completed'
      AND c.audio_file_path IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM conversation_segments cs
        WHERE cs.conversation_id = c.id
      )
    ORDER BY COALESCE(c.first_audio_frame_at, c.created_at) DESC
    LIMIT 1
  `).get() as { id?: string } | undefined;

  if (!row?.id) {
    throw new Error('no eligible completed conversation found');
  }
  return row.id;
}

function safeSpeakerLabel(raw: string | null): string {
  const normalized = String(raw || 'unknown').trim() || 'unknown';
  return normalized.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function main(): Promise<void> {
  initDb();
  const args = parseArgs();
  const conversationId = findTargetConversationId(args.conversationId);

  const conversation = db.prepare(`
    SELECT id, session_id, audio_file_path, created_at, first_audio_frame_at
    FROM conversations
    WHERE id = ?
  `).get(conversationId) as {
    id: string;
    session_id: string;
    audio_file_path: string | null;
    created_at: string;
    first_audio_frame_at: string | null;
  } | undefined;

  if (!conversation) {
    throw new Error(`conversation not found: ${conversationId}`);
  }
  if (!conversation.audio_file_path) {
    throw new Error(`conversation has no audio file path: ${conversationId}`);
  }

  const segments = db.prepare(`
    SELECT id, speaker_label, start_ms, end_ms, absolute_start_time, text
    FROM conversation_segments
    WHERE conversation_id = ?
    ORDER BY start_ms ASC
  `).all(conversationId) as SegmentRow[];

  if (!segments.length) {
    throw new Error(`conversation has no segments: ${conversationId}`);
  }

  const bySpeaker = new Map<string, SegmentRow[]>();
  for (const segment of segments) {
    const key = String(segment.speaker_label || 'unknown');
    const bucket = bySpeaker.get(key) || [];
    bucket.push(segment);
    bySpeaker.set(key, bucket);
  }

  const createdDirName = `${conversation.id}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const baseDir = path.join(args.outputDir, createdDirName);
  await fs.mkdir(baseDir, { recursive: true });

  const candidates: CandidateRow[] = [];
  for (const [speakerLabel, rows] of bySpeaker.entries()) {
    const selected = rows
      .map(row => {
        const duration = Math.max(0, Number(row.end_ms) - Number(row.start_ms));
        const textLen = String(row.text || '').trim().length;
        const score = duration + textLen * 80;
        return { row, duration, score, textLen };
      })
      .filter(item => item.duration >= args.minDurationMs && item.textLen >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, args.perSpeaker);

    const speakerFolder = path.join(baseDir, safeSpeakerLabel(speakerLabel));
    await fs.mkdir(speakerFolder, { recursive: true });

    for (let index = 0; index < selected.length; index++) {
      const item = selected[index];
      const clipPath = path.join(speakerFolder, `${index + 1}_${item.row.id}.wav`);
      await clipAudioSegment(
        conversation.audio_file_path,
        clipPath,
        Number(item.row.start_ms),
        Number(item.row.end_ms),
      );
      candidates.push({
        speaker_label: speakerLabel,
        segment_id: item.row.id,
        start_ms: item.row.start_ms,
        end_ms: item.row.end_ms,
        duration_ms: item.duration,
        absolute_start_time: item.row.absolute_start_time,
        text: item.row.text,
        score: item.score,
        clip_path: clipPath,
      });
    }
  }

  const manifestPath = path.join(baseDir, 'manifest.json');
  const manifest = {
    generated_at: new Date().toISOString(),
    conversation: {
      id: conversation.id,
      session_id: conversation.session_id,
      created_at: conversation.created_at,
      first_audio_frame_at: conversation.first_audio_frame_at,
      audio_file_path: conversation.audio_file_path,
    },
    params: {
      per_speaker: args.perSpeaker,
      min_duration_ms: args.minDurationMs,
    },
    speaker_count: bySpeaker.size,
    candidate_count: candidates.length,
    candidates,
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(
    JSON.stringify(
      {
        conversation_id: conversation.id,
        session_id: conversation.session_id,
        speaker_count: bySpeaker.size,
        candidate_count: candidates.length,
        output_dir: baseDir,
        manifest_path: manifestPath,
      },
      null,
      2,
    ),
  );
}

main().catch(err => {
  console.error('[generate-seed-candidates] failed:', err);
  process.exit(1);
});
