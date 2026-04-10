import { db } from '../db';
import { buildEmbedding } from './embedding-provider';
import { cosineSimilarity } from '../utils/similarity';
import { clipAudioSegment } from './audio-clipper';
import * as path from 'path';
import * as fs from 'fs/promises';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface SegmentRow {
  id: string;
  start_ms: number;
  end_ms: number;
  absolute_start_time: string | null;
  absolute_end_time: string | null;
  speaker_label: string | null;
  text: string;
}

interface EmbeddingRow {
  speaker_id: string;
  embedding_json: string;
  speaker_name: string | null;
  speaker_status: string;
  identity_label: string | null;
  display_label: string | null;
}

function getNextAnonymousDisplayLabel(): string {
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM speakers WHERE status = 'anonymous'`).get() as { cnt?: number };
  const next = (row?.cnt || 0) + 1;
  return `未命名发言人${next}`;
}

function findBestMatch(embedding: number[], threshold: number): {
  speaker_id: string;
  speaker_name: string | null;
  speaker_status: string;
  identity_label: string | null;
  similarity: number;
} | null {
  const rows = db.prepare(`
    SELECT
      se.speaker_id,
      se.embedding_json,
      s.name AS speaker_name,
      s.status AS speaker_status,
      s.identity_label,
      s.display_label
    FROM speaker_embeddings se
    JOIN speakers s ON s.id = se.speaker_id
  `).all() as EmbeddingRow[];

  if (!rows.length) return null;

  let best: {
    speaker_id: string;
    speaker_name: string | null;
    speaker_status: string;
    identity_label: string | null;
    similarity: number;
  } | null = null;
  for (const row of rows) {
    let known: number[] = [];
    try {
      known = JSON.parse(row.embedding_json) as number[];
    } catch {
      known = [];
    }
    const score = cosineSimilarity(embedding, known);
    if (!best || score > best.similarity) {
      best = {
        speaker_id: row.speaker_id,
        speaker_name: row.speaker_name,
        speaker_status: row.speaker_status,
        identity_label: row.identity_label,
        similarity: score,
      };
    }
  }

  if (!best || best.similarity < threshold) return null;
  return best;
}

async function buildClipPaths(conversationId: string, speakerLabel: string, rows: SegmentRow[]): Promise<string[]> {
  const conv = db.prepare(`SELECT audio_file_path FROM conversations WHERE id = ?`).get(conversationId) as {
    audio_file_path?: string;
  } | undefined;

  const sourceAudio = conv?.audio_file_path;
  if (!sourceAudio) return [];

  const clipsDir = path.join(process.cwd(), 'data', 'clips');
  await fs.mkdir(clipsDir, { recursive: true });

  const candidates = [...rows]
    .map(r => ({ ...r, duration: Number(r.end_ms || 0) - Number(r.start_ms || 0), textLen: (r.text || '').length }))
    .filter(r => r.duration >= 600 && r.textLen >= 2)
    .sort((a, b) => (b.duration + b.textLen * 80) - (a.duration + a.textLen * 80))
    .slice(0, 3);

  const out: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const clipPath = path.join(clipsDir, `${conversationId}_${speakerLabel}_${i}.wav`);
    try {
      await clipAudioSegment(sourceAudio, clipPath, Number(c.start_ms || 0), Number(c.end_ms || 0));
      out.push(clipPath);
    } catch (err) {
      console.warn('[SpeakerMapper] clip failed:', String((err as Error)?.message ?? err));
    }
  }

  return out;
}

export async function mapSpeakersForConversation(conversationId: string): Promise<void> {
  const segments = db.prepare(`
    SELECT id, start_ms, end_ms, absolute_start_time, absolute_end_time, speaker_label, text
    FROM conversation_segments
    WHERE conversation_id = ?
    ORDER BY start_ms ASC
  `).all(conversationId) as SegmentRow[];

  if (!segments.length) return;

  const grouped = new Map<string, SegmentRow[]>();
  for (const seg of segments) {
    const key = seg.speaker_label ?? 'unknown';
    const arr = grouped.get(key) || [];
    arr.push(seg);
    grouped.set(key, arr);
  }

  const threshold = Number(process.env.SPEAKER_MATCH_THRESHOLD || 0.82);

  for (const [speakerLabel, rows] of grouped.entries()) {
    const textSample = rows.map(r => r.text).join('').slice(0, 500);
    const clipPaths = await buildClipPaths(conversationId, speakerLabel, rows);
    const embedding = await buildEmbedding({
      speakerLabel: speakerLabel === 'unknown' ? null : speakerLabel,
      tokens: [],
      textSample,
      audioPaths: clipPaths,
    });

    const match = findBestMatch(embedding, threshold);
    const now = new Date().toISOString();

    let speakerId: string;
    let speakerName: string | null = null;
    let resolutionMethod = 'anonymous_match';
    let confidence: number | null = null;

    if (match) {
      speakerId = match.speaker_id;
      speakerName = match.speaker_name;
      resolutionMethod = match.speaker_status === 'confirmed' ? 'embedding_match' : 'anonymous_match';
      confidence = match.similarity;
    } else {
      speakerId = genId('spk');
      const embeddingId = genId('emb');
      const displayLabel = getNextAnonymousDisplayLabel();

      const representative = rows.find(r => (r.text || '').trim().length >= 4) || rows[0];

      db.prepare(`
        INSERT INTO speakers (
          id, name, status, display_label, identity_label, identity_status, notes,
          first_seen_at, last_seen_at, sample_text, sample_segment_id, sample_audio_path,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        speakerId,
        null,
        'anonymous',
        displayLabel,
        null,
        'unconfirmed',
        null,
        rows[0]?.absolute_start_time || now,
        rows[rows.length - 1]?.absolute_end_time || now,
        representative?.text || null,
        representative?.id || null,
        clipPaths[0] || null,
        now,
        now,
      );

      db.prepare(`
        INSERT INTO speaker_embeddings (
          id, speaker_id, embedding_json, sample_rate, duration_ms,
          source_audio_file_id, source_segment_id, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        embeddingId,
        speakerId,
        JSON.stringify(embedding),
        16000,
        null,
        null,
        representative?.id || null,
        'auto_discovered',
        now,
      );
    }

    db.prepare(`
      UPDATE conversation_segments
      SET speaker_id = ?, speaker_name = ?, speaker_identity = ?, confidence = ?, resolution_method = ?, updated_at = ?
      WHERE conversation_id = ? AND IFNULL(speaker_label, 'unknown') = ?
    `).run(
      speakerId,
      speakerName,
      match?.identity_label || null,
      confidence,
      resolutionMethod,
      now,
      conversationId,
      speakerLabel,
    );

    db.prepare(`
      UPDATE speakers
      SET first_seen_at = COALESCE(first_seen_at, ?),
          last_seen_at = CASE
            WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ?
            ELSE last_seen_at
          END,
          updated_at = ?
      WHERE id = ?
    `).run(
      rows[0]?.absolute_start_time || now,
      rows[rows.length - 1]?.absolute_end_time || now,
      rows[rows.length - 1]?.absolute_end_time || now,
      now,
      speakerId,
    );
  }
}
