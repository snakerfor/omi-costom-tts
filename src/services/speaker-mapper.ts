import { db } from '../db';
import { buildEmbedding, EmbeddingBuildResult } from './embedding-provider';
import { cosineSimilarity } from '../utils/similarity';
import { clipAudioSegment } from './audio-clipper';
import * as path from 'path';
import * as fs from 'fs/promises';
import { clipsDir } from '../runtime-paths';
import { CandidateDecisionReason, clearPendingCandidatesForConversation, createSpeakerCandidate } from './speaker-candidate-service';
import { isAIAvailable, chatCompletion, parseJSON } from './minimax-client';

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

interface MatchEvaluation {
  best: SpeakerMatch | null;
  second: SpeakerMatch | null;
  selected: SpeakerMatch | null;
  reason: CandidateDecisionReason | null;
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
  clipArtifacts: Array<{
    candidate: CandidateSegment;
    clipPath: string;
  }>;
  embedding: number[] | null;
  embeddingResult: EmbeddingBuildResult | null;
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

function dominantClusterLabel(cluster: LocalCluster): string | null {
  let bestLabel: string | null = null;
  let bestCount = -1;
  for (const [label, count] of cluster.labelCounts.entries()) {
    if (count > bestCount) {
      bestLabel = label;
      bestCount = count;
    }
  }
  return bestLabel;
}

function mergeLocalClustersSecondPass(
  items: LocalClusterInput[],
  assignments: LocalClusterAssignment[],
  clusters: LocalCluster[],
  threshold: number,
): { assignments: LocalClusterAssignment[]; clusters: LocalCluster[] } {
  if (clusters.length <= 1) {
    return { assignments, clusters };
  }

  const parent = clusters.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootB] = rootA;
    }
  };

  for (let i = 0; i < clusters.length; i++) {
    const left = clusters[i];
    const leftLabel = dominantClusterLabel(left);
    if (!left.centroid.length || !leftLabel) continue;

    for (let j = i + 1; j < clusters.length; j++) {
      const right = clusters[j];
      const rightLabel = dominantClusterLabel(right);
      if (!right.centroid.length || !rightLabel) continue;
      if (leftLabel !== rightLabel) continue;

      const similarity = cosineSimilarity(left.centroid, right.centroid);
      if (similarity >= threshold) {
        union(i, j);
      }
    }
  }

  const mergedByRoot = new Map<number, LocalCluster>();
  for (let index = 0; index < clusters.length; index++) {
    const root = find(index);
    const source = clusters[index];
    const existing = mergedByRoot.get(root);
    if (!existing) {
      mergedByRoot.set(root, {
        blockIndexes: [...source.blockIndexes],
        centroid: source.centroid,
        labelCounts: new Map(source.labelCounts),
        firstStartMs: source.firstStartMs,
        lastEndMs: source.lastEndMs,
      });
      continue;
    }

    existing.blockIndexes.push(...source.blockIndexes);
    existing.firstStartMs = Math.min(existing.firstStartMs, source.firstStartMs);
    existing.lastEndMs = Math.max(existing.lastEndMs, source.lastEndMs);
    for (const [label, count] of source.labelCounts.entries()) {
      existing.labelCounts.set(label, (existing.labelCounts.get(label) || 0) + count);
    }
  }

  const mergedClusters = [...mergedByRoot.values()]
    .map(cluster => {
      const embeddings = cluster.blockIndexes
        .map(blockIndex => items.find(item => item.blockIndex === blockIndex)?.embedding || null)
        .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.length > 0);
      return {
        ...cluster,
        blockIndexes: [...new Set(cluster.blockIndexes)].sort((a, b) => a - b),
        centroid: averageEmbeddings(embeddings),
      };
    })
    .sort((a, b) => a.firstStartMs - b.firstStartMs);

  const blockToMergedCluster = new Map<number, number>();
  mergedClusters.forEach((cluster, mergedIndex) => {
    for (const blockIndex of cluster.blockIndexes) {
      blockToMergedCluster.set(blockIndex, mergedIndex);
    }
  });

  const remappedAssignments = assignments.map(item => ({
    ...item,
    clusterIndex: item.clusterIndex == null ? null : (blockToMergedCluster.get(item.blockIndex) ?? null),
  }));

  return {
    assignments: remappedAssignments,
    clusters: mergedClusters,
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
): MatchEvaluation {
  if (!rows.length) {
    return {
      best: null,
      second: null,
      selected: null,
      reason: 'low_confidence',
    };
  }

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

  if (!best) {
    return {
      best: null,
      second: null,
      selected: null,
      reason: 'low_confidence',
    };
  }
  if (best.similarity < threshold) {
    console.log(`[SpeakerMapper] Best match ${best.similarity.toFixed(3)} < threshold ${threshold}, creating new speaker.`);
    return {
      best,
      second: second || null,
      selected: null,
      reason: 'low_confidence',
    };
  }
  if (second && (best.similarity - second.similarity) < margin) {
    console.log(
      `[SpeakerMapper] Ambiguous match best=${best.similarity.toFixed(3)} second=${second.similarity.toFixed(3)} margin=${margin}, deferring speaker binding.`,
    );
    return {
      best,
      second,
      selected: null,
      reason: 'conflict',
    };
  }

  return {
    best,
    second: second || null,
    selected: best,
    reason: null,
  };
}

function findBestMatch(embedding: number[], threshold: number, margin: number): MatchEvaluation {
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
    WHERE s.status = 'confirmed'
  `).all() as EmbeddingRow[];

  return findBestMatchFromRows(embedding, rows, threshold, margin);
}

async function buildClipArtifacts(
  conversationId: string,
  speakerLabel: string,
  rows: SegmentRow[],
  prefix: string = '',
): Promise<Array<{ candidate: CandidateSegment; clipPath: string }>> {
  const conv = db.prepare(`SELECT audio_file_path FROM conversations WHERE id = ?`).get(conversationId) as {
    audio_file_path?: string;
  } | undefined;

  const sourceAudio = conv?.audio_file_path;
  if (!sourceAudio) return [];

  await fs.mkdir(clipsDir, { recursive: true });

  const candidates = pickCandidateSegments(rows);

  const out: Array<{ candidate: CandidateSegment; clipPath: string }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const clipPath = path.join(clipsDir, `${conversationId}_${speakerLabel}_${prefix}${i}.wav`);
    try {
      await clipAudioSegment(sourceAudio, clipPath, Number(c.start_ms || 0), Number(c.end_ms || 0));
      out.push({ candidate: c, clipPath });
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

async function mergeClustersBySemanticContext(
  blockAnalyses: BlockAnalysis[],
  assignments: LocalClusterAssignment[],
  clusters: LocalCluster[],
  minSimilarityFallback: number = 0.55
): Promise<{ assignments: LocalClusterAssignment[]; clusters: LocalCluster[] }> {
  if (clusters.length <= 1) return { assignments, clusters };

  const scriptLines: string[] = [];
  const blockToClusterMap = new Map<number, number>();
  assignments.forEach(a => {
    if (a.clusterIndex != null) blockToClusterMap.set(a.blockIndex, a.clusterIndex);
  });

  const orderedBlocks = [...blockAnalyses].sort((a, b) => a.start_ms - b.start_ms);
  
  for (const block of orderedBlocks) {
    const clusterIdx = blockToClusterMap.get(block.index);
    if (clusterIdx == null) continue;
    const text = block.segments.map(s => s.text).join(' ');
    if (text.trim()) {
      scriptLines.push(`[Speaker L${clusterIdx + 1}] (${block.start_ms}ms): ${text}`);
    }
  }

  const scriptText = scriptLines.join('\n');

  const prompt = `Here is a transcription of a conversation. Due to voice fluctuations, the speaker diarization system has overly fragmented the speakers into multiple local clusters (L1, L2, L3, etc.).
Your task is to analyze the semantic flow, dialogue context, and Q&A relationships to determine which of these "Speaker Lx" labels actually belong to the exact same person.

Transcript:
${scriptText}

Return a JSON object containing a single array named "same_speaker_groups".
Each element in the array should be an array of speaker labels (e.g., ["L1", "L3", "L5"]) that belong to the same person.
Only group them if you are highly confident based on the conversational logic. If a speaker is unique, you can omit them or put them in an array by themselves.
Output ONLY valid JSON.
Example format:
{
  "same_speaker_groups": [
    ["L1", "L3"],
    ["L2", "L4", "L5"]
  ]
}`;

  try {
    const aiResponseText = await chatCompletion(prompt, {
      temperature: 0.1,
      systemPrompt: "You are an expert conversational analyst. You fix over-fragmented speaker diarization by grouping speaker labels that are semantically the same person.",
    });

    const parsed = parseJSON<{ same_speaker_groups: string[][] }>(aiResponseText);
    const groups = parsed.same_speaker_groups || [];

    const parent = clusters.map((_, index) => index);
    const find = (index: number): number => {
      let current = index;
      while (parent[current] !== current) {
        parent[current] = parent[parent[current]];
        current = parent[current];
      }
      return current;
    };
    const union = (a: number, b: number): void => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[rootB] = rootA;
    };

    let mergedCount = 0;
    for (const group of groups) {
      const indices = group
        .map(g => parseInt(g.replace('L', ''), 10) - 1)
        .filter(idx => !isNaN(idx) && idx >= 0 && idx < clusters.length);

      for (let i = 0; i < indices.length; i++) {
        for (let j = i + 1; j < indices.length; j++) {
          const idxA = indices[i];
          const idxB = indices[j];
          
          const clusterA = clusters[idxA];
          const clusterB = clusters[idxB];
          if (clusterA.centroid.length > 0 && clusterB.centroid.length > 0) {
             const sim = cosineSimilarity(clusterA.centroid, clusterB.centroid);
             if (sim < minSimilarityFallback) {
                console.warn(`[Semantic Merge] Refusing to merge L${idxA+1} and L${idxB+1} due to low similarity: ${sim}`);
                continue;
             }
          }
          union(idxA, idxB);
          mergedCount++;
        }
      }
    }

    if (mergedCount === 0) {
      return { assignments, clusters };
    }

    const mergedByRoot = new Map<number, LocalCluster>();
    for (let index = 0; index < clusters.length; index++) {
      const root = find(index);
      const source = clusters[index];
      const existing = mergedByRoot.get(root);
      if (!existing) {
        mergedByRoot.set(root, {
          blockIndexes: [...source.blockIndexes],
          centroid: source.centroid,
          labelCounts: new Map(source.labelCounts),
          firstStartMs: source.firstStartMs,
          lastEndMs: source.lastEndMs,
        });
        continue;
      }

      existing.blockIndexes.push(...source.blockIndexes);
      existing.firstStartMs = Math.min(existing.firstStartMs, source.firstStartMs);
      existing.lastEndMs = Math.max(existing.lastEndMs, source.lastEndMs);
      for (const [label, count] of source.labelCounts.entries()) {
        existing.labelCounts.set(label, (existing.labelCounts.get(label) || 0) + count);
      }
    }

    const mergedClusters = [...mergedByRoot.values()]
      .map(cluster => {
        const embeddings = cluster.blockIndexes
          .map(blockIndex => blockAnalyses.find(block => block.index === blockIndex)?.embedding || null)
          .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.length > 0);
        return {
          ...cluster,
          blockIndexes: [...new Set(cluster.blockIndexes)].sort((a, b) => a - b),
          centroid: embeddings.length > 0 ? averageEmbeddings(embeddings) : [],
        };
      })
      .sort((a, b) => a.firstStartMs - b.firstStartMs);

    const blockToMergedCluster = new Map<number, number>();
    mergedClusters.forEach((cluster, mergedIndex) => {
      for (const blockIndex of cluster.blockIndexes) {
        blockToMergedCluster.set(blockIndex, mergedIndex);
      }
    });

    const remappedAssignments = assignments.map(item => ({
      ...item,
      clusterIndex: item.clusterIndex == null ? null : (blockToMergedCluster.get(item.blockIndex) ?? null),
    }));

    return {
      assignments: remappedAssignments,
      clusters: mergedClusters,
    };

  } catch (error) {
    console.error(`[Semantic Merge] Failed to use LLM for semantic merge:`, error);
    return { assignments, clusters };
  }
}

export async function mapSpeakersForConversation(conversationId: string): Promise<void> {
  const conversationMeta = db.prepare(`
    SELECT session_id
    FROM conversations
    WHERE id = ?
  `).get(conversationId) as { session_id?: string | null } | undefined;
  clearPendingCandidatesForConversation(conversationId);
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
  const localThreshold = Number(process.env.LOCAL_SPEAKER_CLUSTER_THRESHOLD || 0.68);
  const localMargin = Number(process.env.LOCAL_SPEAKER_CLUSTER_MARGIN || 0.04);
  const localGapMs = Number(process.env.LOCAL_SPEAKER_CLUSTER_GAP_MS || 12000);
  const localMergeThreshold = Number(process.env.LOCAL_SPEAKER_CLUSTER_MERGE_THRESHOLD || 0.80);

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
    let clipArtifacts: Array<{ candidate: CandidateSegment; clipPath: string }> = [];
    let embedding: number[] | null = null;
    let embeddingResult: EmbeddingBuildResult | null = null;

    if (rep && candidateDuration >= minEnrollmentMs) {
      clipArtifacts = await buildClipArtifacts(conversationId, block.speaker_label, candidates, `blk${i}_`);
      if (clipArtifacts.length > 0) {
        const textSample = block.segments.map(segment => segment.text).join('').slice(0, 500);
        embeddingResult = await buildEmbedding({
          speakerLabel: block.speaker_label === 'unknown' ? null : block.speaker_label,
          tokens: [],
          textSample,
          audioPaths: clipArtifacts.map(item => item.clipPath),
        });
        if (embeddingResult.usableForIdentity && embeddingResult.embedding.length) {
          embedding = embeddingResult.embedding;
        } else {
          console.warn(
            `[SpeakerMapper] Identity disabled for conversation=${conversationId} speaker_label=${block.speaker_label} provider=${embeddingResult.provider}`,
          );
        }
      }
    }

    blockAnalyses.push({
      ...block,
      index: i,
      candidates,
      rep,
      candidateDuration,
      clipArtifacts,
      embedding,
      embeddingResult,
    });
  }

  const localInputs: LocalClusterInput[] = blockAnalyses.map(block => ({
    blockIndex: block.index,
    speakerLabel: block.speaker_label,
    startMs: block.start_ms,
    endMs: block.end_ms,
    embedding: block.embedding,
  }));
  const initialClustering = buildLocalSpeakerClustersDetailed(
    localInputs,
    localThreshold,
    localMargin,
    localGapMs,
  );
  let { assignments, clusters } = mergeLocalClustersSecondPass(
    localInputs,
    initialClustering.assignments,
    initialClustering.clusters,
    localMergeThreshold,
  );

  if (isAIAvailable() && clusters.length > 1) {
    const semanticResult = await mergeClustersBySemanticContext(
      blockAnalyses,
      assignments,
      clusters,
    );
    assignments = semanticResult.assignments;
    clusters = semanticResult.clusters;
  }

  const clusterMatchByIndex = new Map<number, { matchInfo: MatchInfo | null; resolutionMethod: string }>();
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
    const repClipPath =
      representative?.clipArtifacts.find(item => item.candidate.id === rep?.id)?.clipPath ||
      representative?.clipArtifacts[0]?.clipPath ||
      null;

    if (!centroid.length || !representative || !rep) {
      continue;
    }

    const matchEvaluation = findBestMatch(centroid, threshold, margin);
    if (matchEvaluation.selected) {
      const match = matchEvaluation.selected;
      clusterMatchByIndex.set(clusterIndex, {
        matchInfo: {
          speaker_id: match.speaker_id,
          speaker_name: match.speaker_name,
          identity_label: match.identity_label,
          status: match.speaker_status,
          similarity: match.similarity,
        },
        resolutionMethod: 'cluster_embedding_match',
      });
      continue;
    }

    const decisionReason: CandidateDecisionReason = matchEvaluation.reason || 'low_confidence';
    const clipRows = clusterBlocks.flatMap(block =>
      block.clipArtifacts.map(item => ({
        segmentId: item.candidate.id || null,
        clipPath: item.clipPath,
        text: item.candidate.text || null,
        startMs: item.candidate.start_ms,
        endMs: item.candidate.end_ms,
        durationMs: item.candidate.duration,
      })),
    );
    const dedupedClipRows = Array.from(
      new Map(
        clipRows.map(clip => [
          clip.segmentId || `${clip.startMs || 0}-${clip.endMs || 0}-${clip.clipPath}`,
          clip,
        ]),
      ).values(),
    )
      .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
      .slice(0, 5);
    const segmentIds = clusterBlocks.flatMap(block => block.segments.map(segment => segment.id));
    const rawLabelSummary = [...cluster.labelCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, count]) => `${label}:${count}`)
      .join(', ');

    createSpeakerCandidate({
      conversationId,
      sessionId: conversationMeta?.session_id || null,
      speakerLabel: representative.speaker_label,
      localSpeakerKey: `L${clusterIndex + 1}`,
      rawLabelSummary: rawLabelSummary || null,
      rawEmbedding: centroid,
      bestMatchSpeakerId: matchEvaluation.best?.speaker_id || null,
      bestScore: matchEvaluation.best?.similarity ?? null,
      secondMatchSpeakerId: matchEvaluation.second?.speaker_id || null,
      secondScore: matchEvaluation.second?.similarity ?? null,
      decisionReason,
      sampleClipPath: repClipPath,
      sampleText: rep.text || null,
      segmentIds,
      clips: dedupedClipRows,
    });

    clusterMatchByIndex.set(clusterIndex, {
      matchInfo: null,
      resolutionMethod: 'candidate_pending',
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
    const usedMethod = clusterMatch
      ? clusterMatch.resolutionMethod
      : (
        block.embeddingResult &&
        !block.embeddingResult.usableForIdentity &&
        block.candidateDuration >= minEnrollmentMs
          ? 'embedding_unavailable'
          : assignment.method
      );
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
