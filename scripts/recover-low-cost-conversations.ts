import 'dotenv/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { db, initDb } from '../src/db';
import { finalizeConversation, FinalizedSegment } from '../src/services/conversation-finalizer';
import { dataRoot, finalizedResultsDir, previewResultsDir } from '../src/runtime-paths';

type RecommendedAction = 'import_from_finalized' | 'finalize_raw_then_import';

interface RecoveryAuditRecord {
  key: string;
  sessionId: string | null;
  status: string;
  recommendedAction: string;
  anchorStartAt: string | null;
  anchorEndAt: string | null;
  audioPath: string | null;
  rawPath: string | null;
  finalizedPath: string | null;
}

interface RecoveryAuditPayload {
  generatedAt: string;
  device: {
    records: RecoveryAuditRecord[];
  };
}

interface ParsedFinalizedFile {
  recordingStartedAt: string;
  segments: FinalizedSegment[];
}

interface AlignmentArtifact {
  aligned?: Array<{
    id?: string;
    original_speaker_label?: string | null;
    aligned_speaker?: string | null;
  }>;
}

interface RecoveredSegments {
  segments: FinalizedSegment[];
  originalSpeakerBySegmentId: Map<string, string | null>;
}

interface BuiltRecoveryData extends RecoveredSegments {
  recordingStartedAt: string;
  finalizedPath: string;
  notes: string[];
}

interface RecoveryResult {
  sessionId: string;
  action: RecommendedAction;
  result: 'recovered' | 'skipped' | 'failed';
  conversationId?: string;
  notes: string[];
  error?: string;
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseArgs(): { auditJsonPath: string; limit: number | null; dryRun: boolean } {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i];
    if (!key?.startsWith('--')) continue;
    const value = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : 'true';
    args.set(key.slice(2), value);
  }

  return {
    auditJsonPath: args.get('audit-json') || '',
    limit: args.has('limit') ? Number(args.get('limit')) : null,
    dryRun: args.get('dry-run') === 'true',
  };
}

async function resolveAuditJsonPath(explicitPath: string): Promise<string> {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const auditDir = path.join(dataRoot, 'recovery_audit');
  const entries = await fs.readdir(auditDir, { withFileTypes: true });
  const latest = entries
    .filter(entry => entry.isFile() && /^recovery-audit-.*\.json$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .at(-1);

  if (!latest) {
    throw new Error(`no recovery audit json found under ${auditDir}`);
  }

  return path.join(auditDir, latest);
}

async function loadAuditPayload(auditJsonPath: string): Promise<RecoveryAuditPayload> {
  try {
    const raw = await fs.readFile(auditJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as RecoveryAuditPayload;
    if (!Array.isArray(parsed.device?.records)) {
      throw new Error(`malformed audit payload in ${auditJsonPath}: missing device.records array`);
    }
    return parsed;
  } catch (err) {
    throw new Error(`failed to load audit payload ${auditJsonPath}: ${String((err as Error)?.message ?? err)}`);
  }
}

function parseSessionTimestamp(sessionId: string): string | null {
  const match = sessionId.match(/^session_(\d{13})_/);
  if (!match) return null;
  const millis = Number(match[1]);
  if (!Number.isFinite(millis)) return null;
  return new Date(millis).toISOString();
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

async function readJson<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (err) {
    throw new Error(`failed to parse json ${filePath}: ${String((err as Error)?.message ?? err)}`);
  }
}

function normalizeSegment(segment: FinalizedSegment): FinalizedSegment {
  return {
    ...segment,
    speaker_label: segment.speaker_label == null ? null : String(segment.speaker_label),
    text: String(segment.text ?? '').trim(),
    start_ms: Number(segment.start_ms ?? 0),
    end_ms: Number(segment.end_ms ?? 0),
    absolute_start_time: String(segment.absolute_start_time ?? '').trim(),
    absolute_end_time: String(segment.absolute_end_time ?? '').trim(),
  };
}

async function loadAlignmentArtifact(sessionId: string): Promise<AlignmentArtifact | null> {
  const filePath = path.join(previewResultsDir, `${sessionId}_speaker_alignment.json`);
  if (!await fileExists(filePath)) {
    return null;
  }
  try {
    return await readJson<AlignmentArtifact>(filePath);
  } catch {
    return null;
  }
}

async function loadFinalizedSegments(sessionId: string, finalizedPath: string): Promise<RecoveredSegments & { recordingStartedAt: string }> {
  const parsed = await readJson<{
    recording_started_at?: string;
    segments?: FinalizedSegment[];
  }>(finalizedPath);

  const rawSegments = Array.isArray(parsed.segments) ? parsed.segments.map(normalizeSegment) : [];
  const segments = rawSegments.filter(
    segment => segment.text && segment.absolute_start_time && segment.absolute_end_time,
  );
  if (!segments.length) {
    throw new Error(`finalized file has no usable segments: ${finalizedPath}`);
  }

  const originalSpeakerBySegmentId = new Map<string, string | null>(
    segments.map(segment => [segment.id, segment.speaker_label ?? null]),
  );

  const alignment = await loadAlignmentArtifact(sessionId);
  if (alignment?.aligned?.length) {
    const byId = new Map(
      alignment.aligned
        .filter(row => row?.id)
        .map(row => [String(row.id), {
          original: row.original_speaker_label == null ? null : String(row.original_speaker_label),
          aligned: row.aligned_speaker == null ? null : String(row.aligned_speaker),
        }]),
    );
    for (const segment of segments) {
      const row = byId.get(segment.id);
      if (!row) continue;
      originalSpeakerBySegmentId.set(segment.id, row.original);
      segment.speaker_label = row.aligned ?? segment.speaker_label;
    }
  }

  const recordingStartedAt =
    parsed.recording_started_at ||
    parseSessionTimestamp(sessionId) ||
    segments[0]?.absolute_start_time;

  if (!recordingStartedAt) {
    throw new Error(`unable to determine recording_started_at for ${sessionId}`);
  }

  return { recordingStartedAt, segments, originalSpeakerBySegmentId };
}

async function buildSegmentsForRecord(record: RecoveryAuditRecord, action: RecommendedAction): Promise<BuiltRecoveryData> {
  if (!record.sessionId) {
    throw new Error(`record ${record.key} has no sessionId`);
  }

  const notes: string[] = [];

  if (action === 'import_from_finalized') {
    if (!record.finalizedPath) {
      throw new Error(`record ${record.sessionId} missing finalizedPath`);
    }
    const loaded = await loadFinalizedSegments(record.sessionId, record.finalizedPath);
    return {
      ...loaded,
      finalizedPath: record.finalizedPath,
      notes,
    };
  }

  if (!record.rawPath) {
    throw new Error(`record ${record.sessionId} missing rawPath`);
  }

  const sessionStartedAt = parseSessionTimestamp(record.sessionId);
  const anchorStartedAt = record.anchorStartAt;
  const recordingStartedAt = sessionStartedAt || anchorStartedAt || nowIso();
  if (!sessionStartedAt && !anchorStartedAt) {
    const note = 'recordingStartedAt fell back to recovery time because no session timestamp or audit anchor was available';
    notes.push(note);
    console.warn(`[recover] warning session=${record.sessionId}: ${note}`);
  }

  const finalized = await finalizeConversation({
    sessionId: record.sessionId,
    rawTranscriptPath: record.rawPath,
    outputDir: finalizedResultsDir,
    recordingStartedAt,
  });

  const originalSpeakerBySegmentId = new Map<string, string | null>(
    finalized.segments.map(segment => [segment.id, segment.speaker_label ?? null]),
  );

  return {
    recordingStartedAt,
    finalizedPath: finalized.outPath,
    segments: finalized.segments,
    originalSpeakerBySegmentId,
    notes,
  };
}

function existingConversationId(sessionId: string): string | null {
  const row = db.prepare('SELECT id FROM conversations WHERE session_id = ?').get(sessionId) as { id?: string } | undefined;
  return row?.id ?? null;
}

function existingAudioFileId(filePath: string): string | null {
  const row = db.prepare('SELECT id FROM audio_files WHERE file_path = ?').get(filePath) as { id?: string } | undefined;
  return row?.id ?? null;
}

function insertRecoveredConversation(input: {
  sessionId: string;
  action: RecommendedAction;
  recordingStartedAt: string;
  finalizedPath: string;
  audioPath: string | null;
  segments: FinalizedSegment[];
  originalSpeakerBySegmentId: Map<string, string | null>;
  notes: string[];
  dryRun: boolean;
}): RecoveryResult {
  const notes = [...input.notes];
  const existingConversation = existingConversationId(input.sessionId);
  if (existingConversation) {
    return {
      sessionId: input.sessionId,
      action: input.action,
      result: 'skipped',
      conversationId: existingConversation,
      notes: ['conversation already exists'],
    };
  }

  if (!input.segments.length) {
    return {
      sessionId: input.sessionId,
      action: input.action,
      result: 'failed',
      notes,
      error: 'no segments to import',
    };
  }

  const conversationId = genId('conv');
  const audioFileId = input.audioPath ? genId('aud') : null;
  const createdAt = input.recordingStartedAt;
  const updatedAt = nowIso();
  const endedAt = input.segments.at(-1)?.absolute_end_time ?? input.recordingStartedAt;
  const durationMs = input.segments.reduce((max, segment) => Math.max(max, segment.end_ms), 0);
  const resolutionMethod = input.action === 'import_from_finalized'
    ? 'recovery_import_finalized'
    : 'recovery_finalize_raw';

  if (input.audioPath) {
    const duplicateAudioFileId = existingAudioFileId(input.audioPath);
    if (duplicateAudioFileId) {
      notes.push(`audio_files already contains path; conversation will reference path without new audio_files row (${duplicateAudioFileId})`);
    }
  }

  if (input.dryRun) {
    return {
      sessionId: input.sessionId,
      action: input.action,
      result: 'recovered',
      conversationId,
      notes: ['dry-run', ...notes],
    };
  }

  const tx = db.transaction(() => {
    db.prepare(`
        INSERT INTO conversations (
          id, session_id, status, websocket_connected_at, first_audio_frame_at,
          ended_at, raw_result_path, audio_file_path, created_at, updated_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conversationId,
        input.sessionId,
        'completed',
        input.recordingStartedAt,
        input.recordingStartedAt,
        endedAt,
        input.finalizedPath,
        input.audioPath,
        createdAt,
        updatedAt,
        null,
      );

    if (input.audioPath && !existingAudioFileId(input.audioPath) && audioFileId) {
      db.prepare(`
          INSERT INTO audio_files (
            id, conversation_id, file_path, file_name, duration_ms,
            sample_rate, channels, bits_per_sample, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          audioFileId,
          conversationId,
          input.audioPath,
          path.basename(input.audioPath),
          durationMs,
          16000,
          1,
          16,
          createdAt,
          updatedAt,
        );
    }

    const insertSeg = db.prepare(`
        INSERT INTO conversation_segments (
          id, conversation_id, audio_file_id,
          start_ms, end_ms, absolute_start_time, absolute_end_time,
          original_speaker_label, speaker_label, speaker_id, speaker_name, text,
          confidence, resolution_method, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

    for (const segment of input.segments) {
      insertSeg.run(
        genId('seg'),
        conversationId,
        audioFileId,
        segment.start_ms,
        segment.end_ms,
        segment.absolute_start_time,
        segment.absolute_end_time,
        input.originalSpeakerBySegmentId.get(segment.id) ?? segment.speaker_label,
        segment.speaker_label,
        null,
        null,
        segment.text,
        null,
        resolutionMethod,
        createdAt,
        updatedAt,
      );
    }
  });

  try {
    tx();
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (message.includes('UNIQUE constraint failed: conversations.session_id')) {
      return {
        sessionId: input.sessionId,
        action: input.action,
        result: 'skipped',
        conversationId: existingConversationId(input.sessionId) ?? undefined,
        notes: [...notes, 'concurrent insert detected; conversation already exists'],
      };
    }
    throw err;
  }

  return {
    sessionId: input.sessionId,
    action: input.action,
    result: 'recovered',
    conversationId,
    notes,
  };
}

async function main(): Promise<void> {
  initDb();
  const { auditJsonPath: explicitAuditPath, limit, dryRun } = parseArgs();
  const auditJsonPath = await resolveAuditJsonPath(explicitAuditPath);
  const payload = await loadAuditPayload(auditJsonPath);
  const targets = payload.device.records
    .filter((record): record is RecoveryAuditRecord & { sessionId: string } =>
      !!record.sessionId &&
      (record.recommendedAction === 'import_from_finalized' || record.recommendedAction === 'finalize_raw_then_import'),
    )
    .sort((a, b) => (a.anchorStartAt ?? '').localeCompare(b.anchorStartAt ?? '') || a.sessionId.localeCompare(b.sessionId));

  const limitedTargets = limit == null ? targets : targets.slice(0, limit);
  const results: RecoveryResult[] = [];

  for (const record of limitedTargets) {
    const action = record.recommendedAction as RecommendedAction;
    try {
      const built = await buildSegmentsForRecord(record, action);
      const result = insertRecoveredConversation({
        sessionId: record.sessionId,
        action,
        recordingStartedAt: built.recordingStartedAt,
        finalizedPath: built.finalizedPath,
        audioPath: record.audioPath,
        segments: built.segments,
        originalSpeakerBySegmentId: built.originalSpeakerBySegmentId,
        notes: built.notes,
        dryRun,
      });
      results.push(result);
      console.log(`[recover] ${result.result} session=${record.sessionId} action=${action}${result.notes.length ? ` notes=${result.notes.join(' | ')}` : ''}`);
    } catch (err) {
      const result: RecoveryResult = {
        sessionId: record.sessionId,
        action,
        result: 'failed',
        notes: [],
        error: String((err as Error)?.message ?? err),
      };
      results.push(result);
      console.error(`[recover] failed session=${record.sessionId} action=${action}: ${result.error}`);
    }
  }

  const summary = {
    auditJsonPath,
    generatedAt: nowIso(),
    totalCandidates: targets.length,
    processed: limitedTargets.length,
    recovered: results.filter(result => result.result === 'recovered').length,
    skipped: results.filter(result => result.result === 'skipped').length,
    failed: results.filter(result => result.result === 'failed').length,
    dryRun,
  };

  const outDir = path.join(dataRoot, 'recovery_audit');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `recover-low-cost-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify({ summary, results }, null, 2), 'utf8');

  console.log('[recover] summary:', JSON.stringify(summary, null, 2));
  console.log(`[recover] report: ${outPath}`);
}

main().catch(err => {
  console.error('[recover] fatal:', err);
  process.exit(1);
});
