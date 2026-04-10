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

  if (!best) return null;
  if (best.similarity < threshold) {
    console.log(`[SpeakerMapper] Best match ${best.similarity.toFixed(3)} < threshold ${threshold}, creating new speaker.`);
    return null;
  }
  return best;
}

async function buildClipPaths(conversationId: string, speakerLabel: string, rows: SegmentRow[], prefix: string = ''): Promise<string[]> {
  const conv = db.prepare(`SELECT audio_file_path FROM conversations WHERE id = ?`).get(conversationId) as {
    audio_file_path?: string;
  } | undefined;

  const sourceAudio = conv?.audio_file_path;
  if (!sourceAudio) return [];

  const clipsDir = path.join(process.cwd(), 'data', 'clips');
  await fs.mkdir(clipsDir, { recursive: true });

  const candidates = [...rows]
    .map(r => ({ ...r, duration: Number(r.end_ms || 0) - Number(r.start_ms || 0), textLen: (r.text || '').length }))
    .filter(r => r.duration >= 600)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 2);

  const out: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const clipPath = path.join(clipsDir, `${conversationId}_${speakerLabel}_${prefix}${i}.wav`);
    try {
      await clipAudioSegment(sourceAudio, clipPath, Number(c.start_ms || 0), Number(c.end_ms || 0));
      out.push(clipPath);
    } catch (err) {
      console.warn('[SpeakerMapper] clip failed:', String((err as Error)?.message ?? err));
    }
  }

  return out;
}

interface Block {
  speaker_label: string;
  segments: SegmentRow[];
  start_ms: number;
  end_ms: number;
}

export async function mapSpeakersForConversation(conversationId: string): Promise<void> {
  const segments = db.prepare(`
    SELECT id, start_ms, end_ms, absolute_start_time, absolute_end_time, speaker_label, text
    FROM conversation_segments
    WHERE conversation_id = ?
    ORDER BY start_ms ASC
  `).all(conversationId) as SegmentRow[];

  if (!segments.length) return;

  // 1. Group contiguous segments of the SAME speaker_label into Blocks
  const blocks: Block[] = [];
  let currentBlock: Block | null = null;

  for (const seg of segments) {
    const label = seg.speaker_label ?? 'unknown';
    // Break block if label changes, or gap > 5 seconds
    if (currentBlock && currentBlock.speaker_label === label && (seg.start_ms - currentBlock.end_ms) < 5000) {
      currentBlock.segments.push(seg);
      currentBlock.end_ms = Math.max(currentBlock.end_ms, seg.end_ms);
    } else {
      currentBlock = {
        speaker_label: label,
        segments: [seg],
        start_ms: seg.start_ms,
        end_ms: seg.end_ms
      };
      blocks.push(currentBlock);
    }
  }

  const threshold = Number(process.env.SPEAKER_MATCH_THRESHOLD || 0.45); // lowered threshold for short segments
  
  interface MatchInfo {
    speaker_id: string;
    speaker_name: string | null;
    identity_label: string | null;
    status: string;
    similarity: number | null;
  }
  const labelToSpeakerMap = new Map<string, MatchInfo>();

  // 2. Process each block
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    
    const candidates = [...block.segments]
      .map(r => ({ ...r, duration: r.end_ms - r.start_ms }))
      .sort((a, b) => b.duration - a.duration);
      
    const rep = candidates[0]; // longest segment in this block
    let matchInfo: MatchInfo | null = null;
    let usedMethod = 'anonymous_match';

    if (rep && rep.duration >= 1500) {
      // Extract embedding for this block using its longest segment
      const clipPaths = await buildClipPaths(conversationId, block.speaker_label, [rep], `blk${i}_`);
      if (clipPaths.length > 0) {
        const textSample = block.segments.map(s => s.text).join('').slice(0, 500);
        const embedding = await buildEmbedding({
          speakerLabel: block.speaker_label === 'unknown' ? null : block.speaker_label,
          tokens: [],
          textSample,
          audioPaths: clipPaths,
        });

        const match = findBestMatch(embedding, threshold);
        const now = new Date().toISOString();

        if (match) {
          matchInfo = {
            speaker_id: match.speaker_id,
            speaker_name: match.speaker_name,
            identity_label: match.identity_label,
            status: match.speaker_status,
            similarity: match.similarity
          };
          usedMethod = match.speaker_status === 'confirmed' ? 'embedding_match' : 'anonymous_match';
        } else {
          // Create new speaker & embedding in DB
          const newSpeakerId = genId('spk');
          const embeddingId = genId('emb');
          const displayLabel = getNextAnonymousDisplayLabel();

          db.prepare(`
            INSERT INTO speakers (
              id, name, status, display_label, identity_label, identity_status, notes,
              first_seen_at, last_seen_at, sample_text, sample_segment_id, sample_audio_path,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            newSpeakerId, null, 'anonymous', displayLabel, null, 'unconfirmed', null,
            block.segments[0]?.absolute_start_time || now,
            block.segments[block.segments.length - 1]?.absolute_end_time || now,
            rep.text || null, rep.id || null, clipPaths[0] || null, now, now
          );

          db.prepare(`
            INSERT INTO speaker_embeddings (
              id, speaker_id, embedding_json, sample_rate, duration_ms,
              source_audio_file_id, source_segment_id, source, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            embeddingId, newSpeakerId, JSON.stringify(embedding), 16000, rep.duration,
            null, rep.id || null, 'auto_discovered', now
          );

          matchInfo = {
            speaker_id: newSpeakerId,
            speaker_name: null,
            identity_label: null,
            status: 'anonymous',
            similarity: null
          };
          usedMethod = 'anonymous_match';
        }
      }
    }

    if (matchInfo) {
      labelToSpeakerMap.set(block.speaker_label, matchInfo);
    } else {
      // Fallback to recent mapping for this Soniox label if block is too short
      const fallback = labelToSpeakerMap.get(block.speaker_label);
      if (fallback) {
        matchInfo = fallback;
        usedMethod = 'short_segment_fallback';
      } else {
        // First time seeing this label and it's too short to extract? Unlikely but possible.
        // We defer or just create a dummy anonymous without embedding.
        // For simplicity, create dummy anonymous:
        const now = new Date().toISOString();
        const newSpeakerId = genId('spk');
        const displayLabel = getNextAnonymousDisplayLabel();
        db.prepare(`
          INSERT INTO speakers (
            id, name, status, display_label, identity_label, identity_status, notes,
            first_seen_at, last_seen_at, sample_text, sample_segment_id, sample_audio_path,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newSpeakerId, null, 'anonymous', displayLabel, null, 'unconfirmed', null,
          block.segments[0]?.absolute_start_time || now,
          block.segments[block.segments.length - 1]?.absolute_end_time || now,
          block.segments[0]?.text || null, block.segments[0]?.id || null, null, now, now
        );
        matchInfo = {
          speaker_id: newSpeakerId,
          speaker_name: null,
          identity_label: null,
          status: 'anonymous',
          similarity: null
        };
        usedMethod = 'dummy_fallback';
        labelToSpeakerMap.set(block.speaker_label, matchInfo);
      }
    }

    // 3. Update DB for all segments in this block
    const now = new Date().toISOString();
    for (const seg of block.segments) {
      db.prepare(`
        UPDATE conversation_segments
        SET speaker_id = ?, speaker_name = ?, speaker_identity = ?, confidence = ?, resolution_method = ?, updated_at = ?
        WHERE id = ?
      `).run(
        matchInfo.speaker_id,
        matchInfo.speaker_name,
        matchInfo.identity_label,
        matchInfo.similarity,
        usedMethod,
        now,
        seg.id
      );
    }

    // Update speaker last_seen_at
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
      block.segments[0]?.absolute_start_time || now,
      block.segments[block.segments.length - 1]?.absolute_end_time || now,
      block.segments[block.segments.length - 1]?.absolute_end_time || now,
      now,
      matchInfo.speaker_id
    );
  }
}
