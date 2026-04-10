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

interface CandidateSegment extends SegmentRow {
  duration: number;
  textLen: number;
  score: number;
}

interface SpeakerMatch {
  speaker_id: string;
  speaker_name: string | null;
  speaker_status: string;
  identity_label: string | null;
  similarity: number;
}

export interface LocalClusterInput {
  blockIndex: number;
  speakerLabel: string;
  startMs: number;
  endMs: number;
  embedding: number[] | null;
}

export interface LocalClusterAssignment {
  blockIndex: number;
  clusterIndex: number | null;
  method: string;
}

interface LocalCluster {
  blockIndexes: number[];
  centroid: number[];
  labelCounts: Map<string, number>;
  firstStartMs: number;
  lastEndMs: number;
}

interface BlockAnalysis extends Block {
  index: number;
  candidates: CandidateSegment[];
  rep: CandidateSegment | null;
  candidateDuration: number;
  clipPaths: string[];
  embedding: number[] | null;
}

function getNextAnonymousDisplayLabel(): string {
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM speakers WHERE status = 'anonymous'`).get() as { cnt?: number };
  const next = (row?.cnt || 0) + 1;
  return `未命名发言人${next}`;
}

function pickCandidateSegments(rows: SegmentRow[], maxCount: number = 3): CandidateSegment[] {
  return rows
    .map(row => {
      const duration = Number(row.end_ms || 0) - Number(row.start_ms || 0);
      const textLen = (row.text || '').trim().length;
      return {
        ...row,
        duration,
        textLen,
        score: duration + textLen * 120,
      };
    })
    .filter(row => row.duration >= 900 && row.textLen >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCount);
}

function averageEmbeddings(embeddings: number[][]): number[] {
  if (!embeddings.length) return [];
  const dims = embeddings[0]?.length || 0;
  if (!dims) return [];

  const sum = new Array<number>(dims).fill(0);
  for (const embedding of embeddings) {
    if (embedding.length !== dims) continue;
    for (let i = 0; i < dims; i++) {
      sum[i] += embedding[i];
    }
  }

  return sum.map(value => value / embeddings.length);
}

function incrementLabelCount(labelCounts: Map<string, number>, label: string): void {
  labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
}

function findNearestAssignedCluster(
  items: LocalClusterInput[],
  assignments: LocalClusterAssignment[],
  startIndex: number,
  direction: -1 | 1,
  maxGapMs: number,
): LocalClusterAssignment | null {
  const origin = items[startIndex];
  let pointer = startIndex + direction;

  while (pointer >= 0 && pointer < items.length) {
    const candidate = items[pointer];
    const assignment = assignments.find(item => item.blockIndex === candidate.blockIndex) || null;
    if (assignment?.clusterIndex != null) {
      const gapMs =
        direction < 0
          ? Math.max(0, origin.startMs - candidate.endMs)
          : Math.max(0, candidate.startMs - origin.endMs);
      return gapMs <= maxGapMs ? assignment : null;
    }
    pointer += direction;
  }

  return null;
}

function buildLocalSpeakerClustersDetailed(
  items: LocalClusterInput[],
  threshold: number,
  margin: number,
  maxGapMs: number,
): { assignments: LocalClusterAssignment[]; clusters: LocalCluster[] } {
  const ordered = [...items].sort((a, b) => a.startMs - b.startMs);
  const clusters: LocalCluster[] = [];
  const assignments = new Map<number, LocalClusterAssignment>();

  for (const item of ordered) {
    if (!item.embedding?.length) {
      continue;
    }

    const ranked = clusters
      .map((cluster, index) => ({
        clusterIndex: index,
        similarity: cosineSimilarity(item.embedding as number[], cluster.centroid),
      }))
      .sort((a, b) => b.similarity - a.similarity);

    const best = ranked[0];
    const second = ranked[1];
    const shouldReuseCluster =
      !!best &&
      best.similarity >= threshold &&
      (!second || (best.similarity - second.similarity) >= margin);

    if (!shouldReuseCluster) {
      const clusterIndex = clusters.length;
      const labelCounts = new Map<string, number>();
      incrementLabelCount(labelCounts, item.speakerLabel);
      clusters.push({
        blockIndexes: [item.blockIndex],
        centroid: item.embedding,
        labelCounts,
        firstStartMs: item.startMs,
        lastEndMs: item.endMs,
      });
      assignments.set(item.blockIndex, {
        blockIndex: item.blockIndex,
        clusterIndex,
        method: 'cluster_seed',
      });
      continue;
    }

    const cluster = clusters[best.clusterIndex];
    cluster.blockIndexes.push(item.blockIndex);
    cluster.firstStartMs = Math.min(cluster.firstStartMs, item.startMs);
    cluster.lastEndMs = Math.max(cluster.lastEndMs, item.endMs);
    incrementLabelCount(cluster.labelCounts, item.speakerLabel);
    cluster.centroid = averageEmbeddings(
      cluster.blockIndexes
        .map(blockIndex => items.find(candidate => candidate.blockIndex === blockIndex)?.embedding || null)
        .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.length > 0),
    );
    assignments.set(item.blockIndex, {
      blockIndex: item.blockIndex,
      clusterIndex: best.clusterIndex,
      method: 'cluster_seed',
    });
  }

  const labelToClusters = new Map<string, Set<number>>();
  for (const assignment of assignments.values()) {
    if (assignment.clusterIndex == null) continue;
    const item = ordered.find(candidate => candidate.blockIndex === assignment.blockIndex);
    if (!item) continue;
    const entry = labelToClusters.get(item.speakerLabel) || new Set<number>();
    entry.add(assignment.clusterIndex);
    labelToClusters.set(item.speakerLabel, entry);
  }

  for (let index = 0; index < ordered.length; index++) {
    const item = ordered[index];
    if (assignments.has(item.blockIndex)) {
      continue;
    }

    const prev = findNearestAssignedCluster(ordered, [...assignments.values()], index, -1, maxGapMs);
    const next = findNearestAssignedCluster(ordered, [...assignments.values()], index, 1, maxGapMs);
    const labelClusters = [...(labelToClusters.get(item.speakerLabel) || [])];

    let clusterIndex: number | null = null;
    let method = 'deferred_unresolved';

    if (prev?.clusterIndex != null && next?.clusterIndex != null && prev.clusterIndex === next.clusterIndex) {
      clusterIndex = prev.clusterIndex;
      method = 'neighbor_bridge';
    } else if (labelClusters.length === 1) {
      clusterIndex = labelClusters[0];
      method = 'label_fallback';
    } else if (prev?.clusterIndex != null && next?.clusterIndex == null) {
      clusterIndex = prev.clusterIndex;
      method = 'neighbor_prev';
    } else if (next?.clusterIndex != null && prev?.clusterIndex == null) {
      clusterIndex = next.clusterIndex;
      method = 'neighbor_next';
    }

    assignments.set(item.blockIndex, {
      blockIndex: item.blockIndex,
      clusterIndex,
      method,
    });
  }

  return {
    assignments: ordered.map(item => assignments.get(item.blockIndex) || {
      blockIndex: item.blockIndex,
      clusterIndex: null,
      method: 'deferred_unresolved',
    }),
    clusters,
  };
}

export function assignLocalSpeakerClusters(
  items: LocalClusterInput[],
  threshold: number,
  margin: number,
  maxGapMs: number,
): LocalClusterAssignment[] {
  return buildLocalSpeakerClustersDetailed(items, threshold, margin, maxGapMs).assignments;
}

export function findBestMatchFromRows(
  embedding: number[],
  rows: EmbeddingRow[],
  threshold: number,
  margin: number,
): SpeakerMatch | null {
  if (!rows.length) return null;

  const grouped = new Map<string, SpeakerMatch & { similarities: number[] }>();
  for (const row of rows) {
    let known: number[] = [];
    try {
      known = JSON.parse(row.embedding_json) as number[];
    } catch {
      known = [];
    }

    const score = cosineSimilarity(embedding, known);
    const existing = grouped.get(row.speaker_id);
    if (existing) {
      existing.similarities.push(score);
      existing.similarity =
        existing.similarities.reduce((sum, value) => sum + value, 0) / existing.similarities.length;
      continue;
    }

    grouped.set(row.speaker_id, {
      speaker_id: row.speaker_id,
      speaker_name: row.speaker_name,
      speaker_status: row.speaker_status,
      identity_label: row.identity_label,
      similarity: score,
      similarities: [score],
    });
  }

  const ranked = [...grouped.values()]
    .map(candidate => ({
      speaker_id: candidate.speaker_id,
      speaker_name: candidate.speaker_name,
      speaker_status: candidate.speaker_status,
      identity_label: candidate.identity_label,
      similarity: candidate.similarity,
    }))
    .sort((a, b) => b.similarity - a.similarity);

  const best = ranked[0];
  const second = ranked[1];

  if (!best) return null;
  if (best.similarity < threshold) {
    console.log(`[SpeakerMapper] Best match ${best.similarity.toFixed(3)} < threshold ${threshold}, creating new speaker.`);
    return null;
  }
  if (second && (best.similarity - second.similarity) < margin) {
    console.log(
      `[SpeakerMapper] Ambiguous match best=${best.similarity.toFixed(3)} second=${second.similarity.toFixed(3)} margin=${margin}, deferring speaker binding.`,
    );
    return null;
  }

  return best;
}

function findBestMatch(embedding: number[], threshold: number, margin: number): SpeakerMatch | null {
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

  return findBestMatchFromRows(embedding, rows, threshold, margin);
}

async function buildClipPaths(conversationId: string, speakerLabel: string, rows: SegmentRow[], prefix: string = ''): Promise<string[]> {
  const conv = db.prepare(`SELECT audio_file_path FROM conversations WHERE id = ?`).get(conversationId) as {
    audio_file_path?: string;
  } | undefined;

  const sourceAudio = conv?.audio_file_path;
  if (!sourceAudio) return [];

  const clipsDir = path.join(process.cwd(), 'data', 'clips');
  await fs.mkdir(clipsDir, { recursive: true });

  const candidates = pickCandidateSegments(rows);

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

  const threshold = Number(process.env.SPEAKER_MATCH_THRESHOLD || 0.78);
  const margin = Number(process.env.SPEAKER_MATCH_MARGIN || 0.06);
  const minEnrollmentMs = Number(process.env.SPEAKER_MIN_ENROLLMENT_MS || 2500);
  const localThreshold = Number(process.env.LOCAL_SPEAKER_CLUSTER_THRESHOLD || 0.72);
  const localMargin = Number(process.env.LOCAL_SPEAKER_CLUSTER_MARGIN || 0.04);
  const localGapMs = Number(process.env.LOCAL_SPEAKER_CLUSTER_GAP_MS || 12000);

  interface MatchInfo {
    speaker_id: string;
    speaker_name: string | null;
    identity_label: string | null;
    status: string;
    similarity: number | null;
  }
  const blockAnalyses: BlockAnalysis[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const candidates = pickCandidateSegments(block.segments);
    const rep = candidates[0] || null;
    const candidateDuration = candidates.reduce((sum, row) => sum + row.duration, 0);
    let clipPaths: string[] = [];
    let embedding: number[] | null = null;

    if (rep && candidateDuration >= minEnrollmentMs) {
      clipPaths = await buildClipPaths(conversationId, block.speaker_label, candidates, `blk${i}_`);
      if (clipPaths.length > 0) {
        const textSample = block.segments.map(segment => segment.text).join('').slice(0, 500);
        embedding = await buildEmbedding({
          speakerLabel: block.speaker_label === 'unknown' ? null : block.speaker_label,
          tokens: [],
          textSample,
          audioPaths: clipPaths,
        });
      }
    }

    blockAnalyses.push({
      ...block,
      index: i,
      candidates,
      rep,
      candidateDuration,
      clipPaths,
      embedding,
    });
  }

  const localInputs: LocalClusterInput[] = blockAnalyses.map(block => ({
    blockIndex: block.index,
    speakerLabel: block.speaker_label,
    startMs: block.start_ms,
    endMs: block.end_ms,
    embedding: block.embedding,
  }));
  const { assignments, clusters } = buildLocalSpeakerClustersDetailed(
    localInputs,
    localThreshold,
    localMargin,
    localGapMs,
  );

  const clusterMatchByIndex = new Map<number, { matchInfo: MatchInfo; resolutionMethod: string }>();
  for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
    const cluster = clusters[clusterIndex];
    const clusterBlocks = cluster.blockIndexes
      .map(blockIndex => blockAnalyses.find(block => block.index === blockIndex) || null)
      .filter((block): block is BlockAnalysis => !!block);
    const embeddings = clusterBlocks
      .map(block => block.embedding)
      .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.length > 0);
    const centroid = averageEmbeddings(embeddings);
    const representative = [...clusterBlocks]
      .sort((a, b) => b.candidateDuration - a.candidateDuration)[0];
    const rep = representative?.rep || null;
    const repClipPath = representative?.clipPaths[0] || null;
    const now = new Date().toISOString();

    if (!centroid.length || !representative || !rep) {
      continue;
    }

    const match = findBestMatch(centroid, threshold, margin);
    if (match) {
      clusterMatchByIndex.set(clusterIndex, {
        matchInfo: {
          speaker_id: match.speaker_id,
          speaker_name: match.speaker_name,
          identity_label: match.identity_label,
          status: match.speaker_status,
          similarity: match.similarity,
        },
        resolutionMethod: match.speaker_status === 'confirmed' ? 'cluster_embedding_match' : 'cluster_anonymous_match',
      });
      continue;
    }

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
      newSpeakerId,
      null,
      'anonymous',
      displayLabel,
      null,
      'unconfirmed',
      null,
      representative.segments[0]?.absolute_start_time || now,
      representative.segments[representative.segments.length - 1]?.absolute_end_time || now,
      rep.text || null,
      rep.id || null,
      repClipPath,
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
      newSpeakerId,
      JSON.stringify(centroid),
      16000,
      representative.candidateDuration,
      null,
      rep.id || null,
      'auto_discovered',
      now,
    );

    clusterMatchByIndex.set(clusterIndex, {
      matchInfo: {
        speaker_id: newSpeakerId,
        speaker_name: null,
        identity_label: null,
        status: 'anonymous',
        similarity: null,
      },
      resolutionMethod: 'cluster_anonymous_match',
    });
  }

  for (const block of blockAnalyses) {
    const assignment = assignments.find(item => item.blockIndex === block.index) || {
      blockIndex: block.index,
      clusterIndex: null,
      method: 'deferred_unresolved',
    };
    const clusterMatch = assignment.clusterIndex != null ? clusterMatchByIndex.get(assignment.clusterIndex) : null;
    const matchInfo = clusterMatch?.matchInfo || null;
    const usedMethod =
      assignment.method === 'cluster_seed'
        ? clusterMatch?.resolutionMethod || 'deferred_unresolved'
        : assignment.method;
    const now = new Date().toISOString();

    for (const seg of block.segments) {
      db.prepare(`
        UPDATE conversation_segments
        SET speaker_id = ?, speaker_name = ?, speaker_identity = ?, confidence = ?, resolution_method = ?, updated_at = ?
        WHERE id = ?
      `).run(
        matchInfo?.speaker_id ?? null,
        matchInfo?.speaker_name ?? null,
        matchInfo?.identity_label ?? null,
        matchInfo?.similarity ?? null,
        usedMethod,
        now,
        seg.id,
      );
    }

    if (!matchInfo) {
      continue;
    }

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
      matchInfo.speaker_id,
    );
  }
}
