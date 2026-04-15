import 'dotenv/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { db, initDb } from '../src/db';
import { audioUploadsDir, dataRoot, finalizedResultsDir, omiSyncVideoRoot, previewResultsDir, rawResultsDir } from '../src/runtime-paths';

type RecoveryStatus =
  | 'db_and_files_ok'
  | 'files_only_need_import'
  | 'db_only_keep'
  | 'partial_db_keep'
  | 'raw_audio_only'
  | 'invalid_files_manual_review';

interface FinalizedSummary {
  recordingStartedAt: string | null;
  finalizedAt: string | null;
  segmentCount: number;
  firstAbsoluteStart: string | null;
  lastAbsoluteEnd: string | null;
  textPreview: string | null;
}

interface RawSummary {
  eventCount: number;
  tokenCount: number;
  firstTs: string | null;
  lastTs: string | null;
}

interface EvidenceRecord {
  key: string;
  sessionId: string | null;
  conversationId: string | null;
  status: RecoveryStatus;
  recommendedAction: string;
  anchorStartAt: string | null;
  anchorEndAt: string | null;
  hasConversation: boolean;
  segmentCount: number;
  hasAudioFile: boolean;
  hasRawFile: boolean;
  hasFinalizedFile: boolean;
  previewFileCount: number;
  audioPath: string | null;
  rawPath: string | null;
  finalizedPath: string | null;
  notes: string[];
}

interface DeviceSummary {
  total: number;
  byStatus: Record<RecoveryStatus, number>;
}

interface DesktopSummary {
  screenshotRows: number;
  transcriptionSessionRows: number;
  transcriptionSegmentRows: number;
  observationRows: number;
  memoryRows: number;
  videoChunkRows: number;
  videoFilesOnDisk: number;
}

interface CloudSummary {
  conversationsTableExists: boolean;
  conversationRows: number;
  memoriesTableExists: boolean;
  memoryRows: number;
}

function basenameWithoutExt(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function normalizeSessionLikeKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const base = basenameWithoutExt(trimmed);
  if (base.startsWith('session_')) return base;
  return null;
}

function previewSessionKey(fileName: string): string | null {
  const base = basenameWithoutExt(fileName);
  const match = base.match(/^(session_[^_]+_[^_]+)_(speaker_alignment|pyannote)$/);
  return match ? match[1] : normalizeSessionLikeKey(base);
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => entry.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

async function fileExists(filePath: string | null | undefined): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function summarizeFinalized(filePath: string): Promise<FinalizedSummary | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as {
      recording_started_at?: string;
      finalized_at?: string;
      segment_count?: number;
      segments?: Array<{
        absolute_start_time?: string;
        absolute_end_time?: string;
        text?: string;
      }>;
    };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
    const meaningfulSegments = segments.filter(
      segment =>
        typeof segment === 'object' &&
        segment !== null &&
        (
          typeof segment.absolute_start_time === 'string' ||
          typeof segment.absolute_end_time === 'string' ||
          typeof segment.text === 'string'
        ),
    );
    const segmentCount = meaningfulSegments.length;
    if (!meaningfulSegments.length) {
      return null;
    }
    return {
      recordingStartedAt: parsed.recording_started_at ?? null,
      finalizedAt: parsed.finalized_at ?? null,
      segmentCount,
      firstAbsoluteStart: meaningfulSegments[0]?.absolute_start_time ?? null,
      lastAbsoluteEnd: meaningfulSegments.at(-1)?.absolute_end_time ?? null,
      textPreview: meaningfulSegments.slice(0, 2).map(segment => (segment.text ?? '').trim()).filter(Boolean).join(' ').slice(0, 160) || null,
    };
  } catch {
    return null;
  }
}

async function summarizeRaw(filePath: string): Promise<RawSummary | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      return null;
    }
    const parsed = lines.map(line => JSON.parse(line) as {
      ts?: string;
      event?: string;
      tokens?: Array<{ is_final?: boolean; text?: string }>;
    });
    const valid = parsed.filter(item => {
      if (item.event !== 'soniox_result' || !Array.isArray(item.tokens)) {
        return false;
      }
      return item.tokens.some(token => token?.is_final && typeof token.text === 'string' && token.text.trim());
    });
    const tokenCount = valid.reduce(
      (sum, item) => sum + (item.tokens?.filter(token => token?.is_final && typeof token.text === 'string' && token.text.trim()).length ?? 0),
      0,
    );
    if (!valid.length || tokenCount === 0) {
      return null;
    }
    return {
      eventCount: valid.length,
      tokenCount,
      firstTs: valid[0]?.ts ?? null,
      lastTs: valid.at(-1)?.ts ?? null,
    };
  } catch {
    return null;
  }
}

async function countFilesRecursively(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      if (entry.isFile()) total++;
    }
  }
  return total;
}

async function tableExists(tableName: string): Promise<boolean> {
  const row = db.prepare(`
    SELECT 1 AS ok
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName) as { ok?: number } | undefined;
  return row?.ok === 1;
}

async function buildDeviceRecords(): Promise<{ records: EvidenceRecord[]; summary: DeviceSummary }> {
  const audioFiles = await listFiles(audioUploadsDir);
  const rawFiles = await listFiles(rawResultsDir);
  const finalizedFiles = (await listFiles(finalizedResultsDir)).filter(name => name.endsWith('.json'));
  const previewFiles = (await listFiles(previewResultsDir)).filter(name => name.endsWith('.json'));

  const evidence = new Map<string, Partial<EvidenceRecord>>();

  const ensure = (key: string): Partial<EvidenceRecord> => {
    let row = evidence.get(key);
    if (!row) {
      row = {
        key,
        notes: [],
        previewFileCount: 0,
        segmentCount: 0,
      };
      evidence.set(key, row);
    }
    return row;
  };

  for (const name of audioFiles) {
    const key = normalizeSessionLikeKey(name);
    if (!key) continue;
    const row = ensure(key);
    row.sessionId = row.sessionId ?? key;
    row.audioPath = path.join(audioUploadsDir, name);
    row.hasAudioFile = true;
  }

  for (const name of rawFiles) {
    const key = normalizeSessionLikeKey(name);
    if (!key) continue;
    const row = ensure(key);
    row.sessionId = row.sessionId ?? key;
    row.rawPath = path.join(rawResultsDir, name);
    row.hasRawFile = true;
  }

  const finalizedMeta = new Map<string, FinalizedSummary | null>();
  for (const name of finalizedFiles) {
    const key = normalizeSessionLikeKey(name);
    if (!key) continue;
    const row = ensure(key);
    row.sessionId = row.sessionId ?? key;
    row.finalizedPath = path.join(finalizedResultsDir, name);
    row.hasFinalizedFile = true;
    const summary = await summarizeFinalized(row.finalizedPath);
    finalizedMeta.set(key, summary);
  }

  const rawMeta = new Map<string, RawSummary | null>();
  for (const name of rawFiles) {
    const key = normalizeSessionLikeKey(name);
    if (!key) continue;
    rawMeta.set(key, await summarizeRaw(path.join(rawResultsDir, name)));
  }

  for (const name of previewFiles) {
    const key = previewSessionKey(name);
    if (!key) continue;
    const row = ensure(key);
    row.sessionId = row.sessionId ?? key;
    row.previewFileCount = (row.previewFileCount ?? 0) + 1;
  }

  const dbRows = db.prepare(`
    SELECT
      c.id AS conversation_id,
      c.session_id,
      c.status,
      c.created_at,
      c.websocket_connected_at,
      c.first_audio_frame_at,
      c.ended_at,
      c.audio_file_path,
      c.raw_result_path,
      COUNT(cs.id) AS segment_count,
      MIN(cs.absolute_start_time) AS segment_start_at,
      MAX(cs.absolute_end_time) AS segment_end_at
    FROM conversations c
    LEFT JOIN conversation_segments cs ON cs.conversation_id = c.id
    GROUP BY c.id
  `).all() as Array<{
    conversation_id: string;
    session_id: string | null;
    status: string | null;
    created_at: string | null;
    websocket_connected_at: string | null;
    first_audio_frame_at: string | null;
    ended_at: string | null;
    audio_file_path: string | null;
    raw_result_path: string | null;
    segment_count: number;
    segment_start_at: string | null;
    segment_end_at: string | null;
  }>;

  for (const dbRow of dbRows) {
    const key =
      normalizeSessionLikeKey(dbRow.session_id) ||
      normalizeSessionLikeKey(dbRow.audio_file_path) ||
      normalizeSessionLikeKey(dbRow.raw_result_path) ||
      `conversation:${dbRow.conversation_id}`;
    const row = ensure(key);
    row.sessionId = row.sessionId ?? normalizeSessionLikeKey(dbRow.session_id);
    row.conversationId = dbRow.conversation_id;
    row.hasConversation = true;
    row.segmentCount = dbRow.segment_count;
    row.anchorStartAt = row.anchorStartAt ?? dbRow.segment_start_at ?? dbRow.first_audio_frame_at ?? dbRow.websocket_connected_at ?? dbRow.created_at ?? null;
    row.anchorEndAt = row.anchorEndAt ?? dbRow.segment_end_at ?? dbRow.ended_at ?? null;
    row.audioPath = row.audioPath ?? dbRow.audio_file_path;
    if (dbRow.raw_result_path) {
      if (dbRow.raw_result_path.endsWith('.json')) {
        row.finalizedPath = row.finalizedPath ?? dbRow.raw_result_path;
      } else if (dbRow.raw_result_path.endsWith('.ndjson')) {
        row.rawPath = row.rawPath ?? dbRow.raw_result_path;
      }
    }
  }

  const records: EvidenceRecord[] = [];
  const summary: DeviceSummary = {
    total: 0,
    byStatus: {
      db_and_files_ok: 0,
      files_only_need_import: 0,
      db_only_keep: 0,
      partial_db_keep: 0,
      raw_audio_only: 0,
      invalid_files_manual_review: 0,
    },
  };

  for (const [key, partial] of evidence.entries()) {
    const sessionId = partial.sessionId ?? (key.startsWith('session_') ? key : null);
    const finalizedSummary = partial.finalizedPath ? finalizedMeta.get(key) ?? null : null;
    const rawSummary = partial.rawPath ? rawMeta.get(key) ?? null : null;
    const hasAudioFile = !!partial.audioPath && await fileExists(partial.audioPath);
    const rawFilePresent = !!partial.rawPath && await fileExists(partial.rawPath);
    const finalizedFilePresent = !!partial.finalizedPath && await fileExists(partial.finalizedPath);
    const hasRawFile = rawFilePresent && !!rawSummary;
    const hasFinalizedFile = finalizedFilePresent && !!finalizedSummary;
    const hasConversation = !!partial.hasConversation;
    const segmentCount = partial.segmentCount ?? 0;

    const notes = [...(partial.notes ?? [])];
    if (rawFilePresent && !rawSummary) {
      notes.push('Raw transcript file exists but failed validation/parsing.');
    }
    if (finalizedFilePresent && !finalizedSummary) {
      notes.push('Finalized transcript file exists but failed validation/parsing.');
    }
    if (hasConversation && segmentCount > 0 && !hasAudioFile && !hasRawFile && !hasFinalizedFile) {
      notes.push('DB still has transcript data even though no recoverable device files remain.');
    }
    if (!hasConversation && hasFinalizedFile) {
      notes.push('Finalized transcript exists on disk but no conversation row matched in DB.');
    }
    if (!hasConversation && !hasFinalizedFile && hasRawFile) {
      notes.push('Raw transcript exists on disk; can be re-finalized before import.');
    }
    if (hasConversation && segmentCount === 0 && hasFinalizedFile) {
      notes.push('Conversation row exists but segment table is empty; finalized file can backfill segments.');
    }

    let status: RecoveryStatus;
    let recommendedAction: string;
    if (!hasConversation && hasFinalizedFile) {
      status = 'files_only_need_import';
      recommendedAction = 'import_from_finalized';
    } else if (!hasConversation && hasRawFile) {
      status = 'files_only_need_import';
      recommendedAction = 'finalize_raw_then_import';
    } else if (!hasConversation && hasAudioFile) {
      status = 'raw_audio_only';
      recommendedAction = 'retranscribe_audio_then_import';
    } else if (!hasConversation && (rawFilePresent || finalizedFilePresent)) {
      status = 'invalid_files_manual_review';
      recommendedAction = 'inspect_or_restore_corrupt_files';
    } else if (hasConversation && !hasAudioFile && !hasRawFile && !hasFinalizedFile) {
      status = 'db_only_keep';
      recommendedAction = 'preserve_db_only';
    } else if (hasConversation && segmentCount > 0 && hasFinalizedFile) {
      status = (hasAudioFile && hasRawFile) ? 'db_and_files_ok' : 'partial_db_keep';
      recommendedAction = status === 'db_and_files_ok' ? 'no_action' : 'preserve_db_and_optional_backfill';
    } else {
      status = 'partial_db_keep';
      recommendedAction = 'preserve_db_and_optional_backfill';
    }

    const record: EvidenceRecord = {
      key,
      sessionId,
      conversationId: partial.conversationId ?? null,
      status,
      recommendedAction,
      anchorStartAt:
        finalizedSummary?.firstAbsoluteStart ??
        rawSummary?.firstTs ??
        partial.anchorStartAt ??
        finalizedSummary?.recordingStartedAt ??
        null,
      anchorEndAt:
        finalizedSummary?.lastAbsoluteEnd ??
        rawSummary?.lastTs ??
        partial.anchorEndAt ??
        finalizedSummary?.finalizedAt ??
        null,
      hasConversation,
      segmentCount,
      hasAudioFile,
      hasRawFile,
      hasFinalizedFile,
      previewFileCount: partial.previewFileCount ?? 0,
      audioPath: partial.audioPath ?? null,
      rawPath: partial.rawPath ?? null,
      finalizedPath: partial.finalizedPath ?? null,
      notes,
    };
    records.push(record);
    summary.byStatus[status] += 1;
  }

  records.sort((a, b) => {
    const ta = a.anchorStartAt ?? '';
    const tb = b.anchorStartAt ?? '';
    return ta.localeCompare(tb) || a.key.localeCompare(b.key);
  });
  summary.total = records.length;
  return { records, summary };
}

async function buildDesktopSummary(): Promise<DesktopSummary> {
  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
    return row.cnt;
  };
  return {
    screenshotRows: count('omi_screenshots'),
    transcriptionSessionRows: count('omi_transcription_sessions'),
    transcriptionSegmentRows: count('omi_transcription_segments'),
    observationRows: count('omi_observations'),
    memoryRows: count('omi_memories'),
    videoChunkRows: count('omi_video_chunks'),
    videoFilesOnDisk: await countFilesRecursively(omiSyncVideoRoot),
  };
}

async function buildCloudSummary(): Promise<CloudSummary> {
  const conversationsTableExists = await tableExists('omi_cloud_conversations');
  const memoriesTableExists = await tableExists('omi_cloud_memories');
  return {
    conversationsTableExists,
    conversationRows: conversationsTableExists
      ? (db.prepare('SELECT COUNT(*) AS cnt FROM omi_cloud_conversations').get() as { cnt: number }).cnt
      : 0,
    memoriesTableExists,
    memoryRows: memoriesTableExists
      ? (db.prepare('SELECT COUNT(*) AS cnt FROM omi_cloud_memories').get() as { cnt: number }).cnt
      : 0,
  };
}

function buildMarkdownReport(
  device: { records: EvidenceRecord[]; summary: DeviceSummary },
  desktop: DesktopSummary,
  cloud: CloudSummary,
): string {
  const lines: string[] = [];
  lines.push('# Recovery Audit');
  lines.push('');
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Device Summary');
  lines.push('');
  lines.push(`- Total evidence groups: ${device.summary.total}`);
  for (const [status, count] of Object.entries(device.summary.byStatus)) {
    lines.push(`- ${status}: ${count}`);
  }
  lines.push('');
  lines.push('## Desktop Sync Summary');
  lines.push('');
  lines.push(`- omi_screenshots: ${desktop.screenshotRows}`);
  lines.push(`- omi_transcription_sessions: ${desktop.transcriptionSessionRows}`);
  lines.push(`- omi_transcription_segments: ${desktop.transcriptionSegmentRows}`);
  lines.push(`- omi_observations: ${desktop.observationRows}`);
  lines.push(`- omi_memories: ${desktop.memoryRows}`);
  lines.push(`- omi_video_chunks: ${desktop.videoChunkRows}`);
  lines.push(`- video files on disk: ${desktop.videoFilesOnDisk}`);
  lines.push('');
  lines.push('## OMI Cloud Summary');
  lines.push('');
  lines.push(`- omi_cloud_conversations table: ${cloud.conversationsTableExists ? 'present' : 'missing'} (${cloud.conversationRows})`);
  lines.push(`- omi_cloud_memories table: ${cloud.memoriesTableExists ? 'present' : 'missing'} (${cloud.memoryRows})`);
  lines.push('');

  const highlightStatuses: RecoveryStatus[] = [
    'files_only_need_import',
    'raw_audio_only',
    'invalid_files_manual_review',
    'db_only_keep',
    'partial_db_keep',
  ];
  for (const status of highlightStatuses) {
    const subset = device.records.filter(record => record.status === status).slice(0, 20);
    lines.push(`## ${status}`);
    lines.push('');
    if (!subset.length) {
      lines.push('- none');
      lines.push('');
      continue;
    }
    for (const record of subset) {
      lines.push(`- ${record.key}`);
      lines.push(`  start: ${record.anchorStartAt ?? 'unknown'}`);
      lines.push(`  end: ${record.anchorEndAt ?? 'unknown'}`);
      lines.push(`  action: ${record.recommendedAction}`);
      lines.push(`  db: conversation=${record.hasConversation} segments=${record.segmentCount}`);
      lines.push(`  files: audio=${record.hasAudioFile} raw=${record.hasRawFile} finalized=${record.hasFinalizedFile} preview=${record.previewFileCount}`);
      if (record.notes.length) {
        lines.push(`  notes: ${record.notes.join(' | ')}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  initDb();
  const device = await buildDeviceRecords();
  const desktop = await buildDesktopSummary();
  const cloud = await buildCloudSummary();

  const auditDir = path.join(dataRoot, 'recovery_audit');
  await fs.mkdir(auditDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(auditDir, `recovery-audit-${stamp}.json`);
  const mdPath = path.join(auditDir, `recovery-audit-${stamp}.md`);

  const payload = {
    generatedAt: new Date().toISOString(),
    dataRoot,
    device,
    desktop,
    cloud,
  };

  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(mdPath, buildMarkdownReport(device, desktop, cloud), 'utf8');

  console.log(`[recovery] json: ${jsonPath}`);
  console.log(`[recovery] markdown: ${mdPath}`);
  console.log('[recovery] device summary:');
  for (const [status, count] of Object.entries(device.summary.byStatus)) {
    console.log(`  ${status}: ${count}`);
  }
  console.log('[recovery] desktop summary:');
  console.log(`  screenshots=${desktop.screenshotRows}, transcription_sessions=${desktop.transcriptionSessionRows}, transcription_segments=${desktop.transcriptionSegmentRows}, observations=${desktop.observationRows}, memories=${desktop.memoryRows}, video_chunk_rows=${desktop.videoChunkRows}, video_files=${desktop.videoFilesOnDisk}`);
  console.log('[recovery] cloud summary:');
  console.log(`  conversations_table=${cloud.conversationsTableExists}, conversation_rows=${cloud.conversationRows}, memories_table=${cloud.memoriesTableExists}, memory_rows=${cloud.memoryRows}`);
}

main().catch(err => {
  console.error('[recovery] failed:', err);
  process.exit(1);
});
