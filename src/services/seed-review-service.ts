import * as fs from 'fs/promises';
import * as path from 'path';
import { seedCandidatesDir } from '../runtime-paths';

export type SeedDecision = 'keep' | 'drop' | 'uncertain';

interface SeedCandidate {
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

interface SeedManifest {
  generated_at: string;
  conversation: {
    id: string;
    session_id: string;
    created_at: string;
    first_audio_frame_at: string | null;
    audio_file_path: string | null;
  };
  params: {
    per_speaker: number;
    min_duration_ms: number;
  };
  speaker_count: number;
  candidate_count: number;
  candidates: SeedCandidate[];
}

interface DecisionItem {
  segment_id: string;
  speaker_label: string;
  decision: SeedDecision;
  person_name: string | null;
  note: string | null;
  updated_at: string;
}

interface DecisionFile {
  updated_at: string;
  items: DecisionItem[];
}

export interface SeedBatchSummary {
  id: string;
  generated_at: string;
  conversation_id: string;
  session_id: string;
  speaker_count: number;
  candidate_count: number;
  decided_count: number;
  keep_count: number;
  drop_count: number;
  uncertain_count: number;
}

export interface SeedBatchDetail extends SeedBatchSummary {
  output_dir: string;
  candidates: Array<SeedCandidate & {
    decision: SeedDecision | null;
    person_name: string | null;
    note: string | null;
  }>;
}

function resolveBatchDir(batchId: string): string {
  const target = path.resolve(seedCandidatesDir, batchId);
  const relative = path.relative(path.resolve(seedCandidatesDir), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`invalid batch id: ${batchId}`);
  }
  return target;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function readManifest(batchDir: string): Promise<SeedManifest> {
  const filePath = path.join(batchDir, 'manifest.json');
  return readJson<SeedManifest>(filePath);
}

async function readDecisionMap(batchDir: string): Promise<Map<string, DecisionItem>> {
  const filePath = path.join(batchDir, 'decisions.json');
  try {
    const parsed = await readJson<DecisionFile>(filePath);
    const rows = Array.isArray(parsed.items) ? parsed.items : [];
    return new Map(rows.map(item => [item.segment_id, item]));
  } catch {
    return new Map<string, DecisionItem>();
  }
}

function summarize(
  batchId: string,
  manifest: SeedManifest,
  decisionMap: Map<string, DecisionItem>,
): SeedBatchSummary {
  let keep = 0;
  let drop = 0;
  let uncertain = 0;
  for (const row of decisionMap.values()) {
    if (row.decision === 'keep') keep += 1;
    if (row.decision === 'drop') drop += 1;
    if (row.decision === 'uncertain') uncertain += 1;
  }
  return {
    id: batchId,
    generated_at: manifest.generated_at,
    conversation_id: manifest.conversation.id,
    session_id: manifest.conversation.session_id,
    speaker_count: manifest.speaker_count,
    candidate_count: manifest.candidate_count,
    decided_count: decisionMap.size,
    keep_count: keep,
    drop_count: drop,
    uncertain_count: uncertain,
  };
}

export async function listSeedBatches(): Promise<SeedBatchSummary[]> {
  await fs.mkdir(seedCandidatesDir, { recursive: true });
  const entries = await fs.readdir(seedCandidatesDir, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  const items: SeedBatchSummary[] = [];
  for (const dirName of directories) {
    const batchDir = resolveBatchDir(dirName);
    const manifestPath = path.join(batchDir, 'manifest.json');
    try {
      await fs.access(manifestPath);
    } catch {
      continue;
    }
    const manifest = await readManifest(batchDir);
    const decisionMap = await readDecisionMap(batchDir);
    items.push(summarize(dirName, manifest, decisionMap));
  }
  items.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  return items;
}

export async function getSeedBatchDetail(batchId: string): Promise<SeedBatchDetail> {
  const batchDir = resolveBatchDir(batchId);
  const manifest = await readManifest(batchDir);
  const decisionMap = await readDecisionMap(batchDir);
  const base = summarize(batchId, manifest, decisionMap);
  return {
    ...base,
    output_dir: batchDir,
    candidates: manifest.candidates.map(candidate => {
      const decision = decisionMap.get(candidate.segment_id);
      return {
        ...candidate,
        decision: decision?.decision || null,
        person_name: decision?.person_name || null,
        note: decision?.note || null,
      };
    }),
  };
}

export async function saveSeedBatchDecisions(
  batchId: string,
  decisions: Array<{ segment_id: string; decision: SeedDecision; person_name?: string | null; note?: string | null }>,
): Promise<SeedBatchDetail> {
  const batchDir = resolveBatchDir(batchId);
  const manifest = await readManifest(batchDir);
  const validSegments = new Set(manifest.candidates.map(item => item.segment_id));
  const now = new Date().toISOString();

  const items: DecisionItem[] = [];
  for (const item of decisions) {
    if (!item || !validSegments.has(item.segment_id)) {
      throw new Error(`invalid segment_id: ${String(item?.segment_id || '')}`);
    }
    if (!['keep', 'drop', 'uncertain'].includes(item.decision)) {
      throw new Error(`invalid decision for segment ${item.segment_id}`);
    }
    const personName = item.person_name == null ? null : String(item.person_name).trim() || null;
    if (item.decision === 'keep' && !personName) {
      throw new Error(`person_name is required when decision=keep for segment ${item.segment_id}`);
    }
    const candidate = manifest.candidates.find(row => row.segment_id === item.segment_id);
    items.push({
      segment_id: item.segment_id,
      speaker_label: candidate?.speaker_label || 'unknown',
      decision: item.decision,
      person_name: personName,
      note: item.note == null ? null : String(item.note).trim() || null,
      updated_at: now,
    });
  }

  const payload: DecisionFile = {
    updated_at: now,
    items,
  };
  await fs.writeFile(path.join(batchDir, 'decisions.json'), JSON.stringify(payload, null, 2), 'utf8');
  return getSeedBatchDetail(batchId);
}
