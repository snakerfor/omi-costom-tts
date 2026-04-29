import * as fs from 'fs/promises';
import * as path from 'path';
import { db } from '../../db';
import { isValidIdentityLabel } from '../../constants/identity-options';
import { clipsDir } from '../../runtime-paths';
import { prepareEnrollmentAudio, prepareSegmentClip } from './audio-prep';
import {
  createFeature,
  getXfyunVoiceprintConfig,
  isXfyunVoiceprintEnabled,
  queryFeatureList,
  searchFea,
  searchFeaAudioBuffer,
  updateFeature,
  XfyunScoreItem,
} from './xfyun-client';

export interface SegmentVoiceprintMatchRow {
  id: string;
  conversation_id: string;
  segment_id: string;
  provider: string;
  group_id: string | null;
  request_audio_path: string | null;
  request_duration_ms: number | null;
  top_feature_id: string | null;
  top_speaker_id: string | null;
  top_score: number | null;
  second_feature_id: string | null;
  second_speaker_id: string | null;
  second_score: number | null;
  decision: string;
  raw_response_json: string | null;
  error_message: string | null;
  created_at: string;
}

export interface SegmentVoiceprintPendingItem {
  segmentId: string;
  startMs: number;
  endMs: number;
  text: string;
  audioUrl: string | null;
  speakerLabel: string | null;
  sourceSpeakerLabel: string | null;
  decision: string;
  topScore: number | null;
  secondScore: number | null;
  resolutionMethod: string | null;
}

export interface SegmentVoiceprintPendingGroup {
  speakerLabel: string | null;
  segmentCount: number;
  totalDurationMs: number;
  unresolvedCount: number;
  samples: string[];
  segments: SegmentVoiceprintPendingItem[];
}

export interface SegmentVoiceprintStats {
  totalSegments: number;
  autoHitCount: number;
  humanConfirmedCount: number;
  unresolvedCount: number;
  skippedShortCount: number;
  errorCount: number;
}

export interface SegmentVoiceprintPendingResult {
  conversationId: string;
  segments: SegmentVoiceprintPendingItem[];
  groups: SegmentVoiceprintPendingGroup[];
  stats: SegmentVoiceprintStats;
}

export interface VoiceprintScanOptions {
  onlyUnresolved?: boolean;
  limit?: number;
  dryRun?: boolean;
}

export interface VoiceprintScanResult {
  conversationId: string;
  processed: number;
  hit: number;
  lowConfidence: number;
  conflict: number;
  noMatch: number;
  skipped: number;
  error: number;
  dryRun: boolean;
}

export interface VoiceprintEnrollmentRequest {
  conversationId: string;
  segmentIds: string[];
  speakerMode: 'new' | 'existing';
  speakerId?: string | null;
  speakerName?: string | null;
  identityLabel?: string | null;
  notes?: string | null;
  excludedSegmentIds?: string[];
}

export interface VoiceprintEnrollmentResult {
  batchId: string;
  speakerId: string;
  featureId: string;
  action: 'create_feature' | 'update_feature' | 'exclude_segments';
  status: 'success' | 'failed';
  createdNewSpeaker: boolean;
  processedSegmentCount: number;
  excludedSegmentCount: number;
  audioPath: string | null;
  durationMs: number | null;
  audioSizeBytes: number | null;
  errorMessage: string | null;
}

export interface SpeakerMaterialApplyRequest {
  speakerId: string;
  segmentIds?: string[];
  excludedSegmentIds?: string[];
}

export interface SpeakerMaterialApplyResult {
  speakerId: string;
  processedConversations: number;
  processedSegmentCount: number;
  excludedSegmentCount: number;
  batches: VoiceprintEnrollmentResult[];
}

export interface ConversationVoiceprintOverview {
  conversationId: string;
  totalSegments: number;
  unresolvedSegments: number;
  confirmedSegments: number;
  autoHitSegments: number;
  skippedSegments: number;
  errorSegments: number;
}

export interface RealtimeVoiceprintMatchResult {
  decision: string;
  provider: string;
  groupId: string | null;
  speakerId: string | null;
  speakerName: string | null;
  speakerIdentity: string | null;
  score: number | null;
  topFeatureId: string | null;
  topSpeakerId: string | null;
  topSpeakerName: string | null;
  topSpeakerIdentity: string | null;
  secondScore: number | null;
  secondFeatureId: string | null;
  secondSpeakerId: string | null;
  secondSpeakerName: string | null;
  rawResponseJson: string | null;
}

interface ConversationRow {
  id: string;
  audio_file_path: string | null;
}

interface SegmentRow {
  id: string;
  conversation_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  original_speaker_label: string | null;
  speaker_label: string | null;
  speaker_id: string | null;
  speaker_name: string | null;
  speaker_identity: string | null;
  resolution_method: string | null;
}

interface SpeakerRow {
  id: string;
  name: string | null;
  identity_label: string | null;
}

interface FeatureRow {
  id: string;
  speaker_id: string;
  provider: string;
  group_id: string;
  feature_id: string;
  feature_version: number;
  status: string;
  source_enrollment_batch_id: string | null;
}

const AUTO_HIT_METHOD = 'xfyun_segment_hit';
const BACKFILL_HIT_METHOD = 'xfyun_current_conversation_backfill_hit';
const HUMAN_CONFIRMED_METHOD = 'human_segment_confirmed';
const HUMAN_EXCLUDED_METHOD = 'human_segment_excluded';
const LOW_CONFIDENCE_METHOD = 'xfyun_low_confidence';
const CONFLICT_METHOD = 'xfyun_conflict';
const NO_MATCH_METHOD = 'xfyun_no_match';
const SKIPPED_SHORT_METHOD = 'xfyun_skipped_short';
const ERROR_METHOD = 'xfyun_error';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeScore(score: number): number {
  return score <= 1 ? score * 100 : score;
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

function ensureVoiceprintEnabled(): void {
  if (!isXfyunVoiceprintEnabled()) {
    throw new Error('XFYUN_VOICEPRINT_ENABLED is false');
  }
  if (!getXfyunVoiceprintConfig()) {
    throw new Error('XFYUN_APP_ID, XFYUN_API_KEY, XFYUN_API_SECRET and XFYUN_GROUP_ID are required');
  }
}

function getConfigOrThrow() {
  ensureVoiceprintEnabled();
  const config = getXfyunVoiceprintConfig();
  if (!config) {
    throw new Error('XFYUN voiceprint config missing');
  }
  return config;
}

function getConversation(conversationId: string): ConversationRow {
  const conversation = db.prepare(`
    SELECT id, audio_file_path
    FROM conversations
    WHERE id = ?
  `).get(conversationId) as ConversationRow | undefined;
  if (!conversation) {
    throw new Error(`conversation not found: ${conversationId}`);
  }
  return conversation;
}

function getSpeakerById(speakerId: string): SpeakerRow {
  const speaker = db.prepare(`
    SELECT id, name, identity_label
    FROM speakers
    WHERE id = ?
  `).get(speakerId) as SpeakerRow | undefined;
  if (!speaker) {
    throw new Error(`speaker not found: ${speakerId}`);
  }
  return speaker;
}

function getFeatureRowForSpeaker(speakerId: string): FeatureRow | undefined {
  return db.prepare(`
    SELECT id, speaker_id, provider, group_id, feature_id, feature_version, status, source_enrollment_batch_id
    FROM speaker_voiceprint_features
    WHERE speaker_id = ? AND provider = 'xfyun' AND group_id = ? AND status = 'active'
    ORDER BY feature_version DESC, updated_at DESC
    LIMIT 1
  `).get(speakerId, getConfigOrThrow().groupId) as FeatureRow | undefined;
}

function getSegmentMatches(conversationId: string): SegmentVoiceprintMatchRow[] {
  return db.prepare(`
    SELECT
      svm.id,
      svm.conversation_id,
      svm.segment_id,
      svm.provider,
      svm.group_id,
      svm.request_audio_path,
      svm.request_duration_ms,
      svm.top_feature_id,
      svm.top_speaker_id,
      svm.top_score,
      svm.second_feature_id,
      svm.second_speaker_id,
      svm.second_score,
      svm.decision,
      svm.raw_response_json,
      svm.error_message,
      svm.created_at
    FROM segment_voiceprint_matches svm
    JOIN (
      SELECT segment_id, MAX(created_at) AS max_created_at
      FROM segment_voiceprint_matches
      WHERE conversation_id = ?
      GROUP BY segment_id
    ) latest
      ON latest.segment_id = svm.segment_id
     AND latest.max_created_at = svm.created_at
    WHERE svm.conversation_id = ?
  `).all(conversationId, conversationId) as SegmentVoiceprintMatchRow[];
}

function getLatestMatchesMap(conversationId: string): Map<string, SegmentVoiceprintMatchRow> {
  const rows = db.prepare(`
    SELECT
      svm.id,
      svm.conversation_id,
      svm.segment_id,
      svm.provider,
      svm.group_id,
      svm.request_audio_path,
      svm.request_duration_ms,
      svm.top_feature_id,
      svm.top_speaker_id,
      svm.top_score,
      svm.second_feature_id,
      svm.second_speaker_id,
      svm.second_score,
      svm.decision,
      svm.raw_response_json,
      svm.error_message,
      svm.created_at
    FROM segment_voiceprint_matches svm
    WHERE svm.conversation_id = ?
    ORDER BY svm.created_at DESC
  `).all(conversationId) as SegmentVoiceprintMatchRow[];

  const map = new Map<string, SegmentVoiceprintMatchRow>();
  for (const row of rows) {
    if (!map.has(row.segment_id)) {
      map.set(row.segment_id, row);
    }
  }
  return map;
}

function classifyDecision(
  scoreItems: XfyunScoreItem[],
  threshold: number,
  margin: number,
): { decision: string; top?: XfyunScoreItem; second?: XfyunScoreItem } {
  if (!scoreItems.length) {
    return { decision: NO_MATCH_METHOD };
  }
  const [top, second] = scoreItems;
  const topScore = normalizeScore(Number(top?.score ?? NaN));
  const secondScore = Number.isFinite(second?.score as number) ? normalizeScore(Number(second?.score ?? 0)) : 0;
  if (topScore >= threshold && topScore - secondScore >= margin) {
    return { decision: AUTO_HIT_METHOD, top, second };
  }
  if (topScore >= threshold) {
    return { decision: CONFLICT_METHOD, top, second };
  }
  return { decision: LOW_CONFIDENCE_METHOD, top, second };
}

function scoreThresholdForDuration(durationMs: number): number {
  const defaultThreshold = Number(process.env.XFYUN_HIT_SCORE_THRESHOLD || 45);
  const shortSegmentMs = Number(process.env.XFYUN_SHORT_SEGMENT_MS || 3000);
  const shortThreshold = Number(process.env.XFYUN_SHORT_HIT_SCORE_THRESHOLD || Math.max(60, defaultThreshold));
  return durationMs < shortSegmentMs ? shortThreshold : defaultThreshold;
}

function buildMatchRow(input: {
  conversationId: string;
  segmentId: string;
  provider: string;
  groupId: string | null;
  requestAudioPath: string | null;
  requestDurationMs: number | null;
  decision: string;
  topFeatureId: string | null;
  topSpeakerId: string | null;
  topScore: number | null;
  secondFeatureId: string | null;
  secondSpeakerId: string | null;
  secondScore: number | null;
  rawResponseJson: string | null;
  errorMessage: string | null;
}): void {
  db.prepare(`
    INSERT INTO segment_voiceprint_matches (
      id, conversation_id, segment_id, provider, group_id, request_audio_path, request_duration_ms,
      top_feature_id, top_speaker_id, top_score, second_feature_id, second_speaker_id, second_score,
      decision, raw_response_json, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    genId('svm'),
    input.conversationId,
    input.segmentId,
    input.provider,
    input.groupId,
    input.requestAudioPath,
    input.requestDurationMs,
    input.topFeatureId,
    input.topSpeakerId,
    input.topScore,
    input.secondFeatureId,
    input.secondSpeakerId,
    input.secondScore,
    input.decision,
    input.rawResponseJson,
    input.errorMessage,
    new Date().toISOString(),
  );
}

function mapFeatureIdToSpeakerId(groupId: string, featureId: string | null | undefined): string | null {
  if (!featureId) return null;
  const row = db.prepare(`
    SELECT speaker_id
    FROM speaker_voiceprint_features
    WHERE provider = 'xfyun' AND group_id = ? AND feature_id = ?
    LIMIT 1
  `).get(groupId, featureId) as { speaker_id?: string } | undefined;
  return row?.speaker_id || null;
}

function mapFeatureIdToSpeaker(groupId: string, featureId: string | null | undefined): SpeakerRow | null {
  const speakerId = mapFeatureIdToSpeakerId(groupId, featureId);
  if (!speakerId) return null;
  const speaker = db.prepare(`
    SELECT id, name, identity_label
    FROM speakers
    WHERE id = ?
  `).get(speakerId) as SpeakerRow | undefined;
  return speaker || null;
}

export function recordRealtimeVoiceprintMatch(input: {
  conversationId: string;
  segmentId: string;
  durationMs: number | null;
  result: RealtimeVoiceprintMatchResult;
}): void {
  buildMatchRow({
    conversationId: input.conversationId,
    segmentId: input.segmentId,
    provider: input.result.provider,
    groupId: input.result.groupId,
    requestAudioPath: null,
    requestDurationMs: input.durationMs,
    decision: input.result.decision,
    topFeatureId: input.result.topFeatureId,
    topSpeakerId: input.result.topSpeakerId,
    topScore: input.result.score,
    secondFeatureId: input.result.secondFeatureId,
    secondSpeakerId: input.result.secondSpeakerId,
    secondScore: input.result.secondScore,
    rawResponseJson: input.result.rawResponseJson,
    errorMessage: null,
  });
}

function isXfyunEmptyFeatureDbError(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err);
  return message.includes('23008') || message.includes('does not have feature');
}

function getSegmentRows(conversationId: string, onlyUnresolved: boolean, limit: number): SegmentRow[] {
  const unresolvedClause = onlyUnresolved
    ? `AND (
      COALESCE(cs.resolution_method, '') != '${HUMAN_EXCLUDED_METHOD}'
      AND COALESCE(cs.resolution_method, '') != '${SKIPPED_SHORT_METHOD}'
      AND (
        cs.speaker_id IS NULL
        OR cs.resolution_method IS NULL
        OR cs.resolution_method IN (
          '${LOW_CONFIDENCE_METHOD}',
          '${CONFLICT_METHOD}',
          '${NO_MATCH_METHOD}',
          '${ERROR_METHOD}'
        )
      )
    )`
    : '';

  return db.prepare(`
    SELECT
      cs.id,
      cs.conversation_id,
      cs.start_ms,
      cs.end_ms,
      cs.text,
      cs.original_speaker_label,
      cs.speaker_label,
      cs.speaker_id,
      cs.speaker_name,
      cs.speaker_identity,
      cs.resolution_method
    FROM conversation_segments cs
    WHERE cs.conversation_id = ?
    ${unresolvedClause}
    ORDER BY cs.start_ms ASC, cs.created_at ASC
    LIMIT ?
  `).all(conversationId, limit) as SegmentRow[];
}

function getConversationVoiceprintStats(conversationId: string): SegmentVoiceprintStats {
  const rows = db.prepare(`
    SELECT
      COUNT(*) AS totalSegments,
      SUM(CASE WHEN speaker_id IS NOT NULL AND resolution_method = ? THEN 1 ELSE 0 END) AS humanConfirmedCount,
      SUM(CASE WHEN speaker_id IS NOT NULL AND resolution_method IN (?, ?) THEN 1 ELSE 0 END) AS autoHitCount,
      SUM(CASE WHEN resolution_method = ? THEN 1 ELSE 0 END) AS skippedShortCount,
      SUM(CASE WHEN resolution_method = ? THEN 1 ELSE 0 END) AS errorCount,
      SUM(CASE
        WHEN COALESCE(resolution_method, '') != ?
          AND COALESCE(resolution_method, '') != ?
          AND (
            speaker_id IS NULL
            OR resolution_method IS NULL
            OR resolution_method IN (?, ?, ?, ?)
          )
        THEN 1 ELSE 0
      END) AS unresolvedCount
    FROM conversation_segments
    WHERE conversation_id = ?
  `).get(
    HUMAN_CONFIRMED_METHOD,
    AUTO_HIT_METHOD,
    BACKFILL_HIT_METHOD,
    SKIPPED_SHORT_METHOD,
    ERROR_METHOD,
    HUMAN_EXCLUDED_METHOD,
    SKIPPED_SHORT_METHOD,
    LOW_CONFIDENCE_METHOD,
    CONFLICT_METHOD,
    NO_MATCH_METHOD,
    ERROR_METHOD,
    conversationId,
  ) as Partial<SegmentVoiceprintStats>;

  return {
    totalSegments: Number(rows?.totalSegments || 0),
    humanConfirmedCount: Number(rows?.humanConfirmedCount || 0),
    autoHitCount: Number(rows?.autoHitCount || 0),
    skippedShortCount: Number(rows?.skippedShortCount || 0),
    errorCount: Number(rows?.errorCount || 0),
    unresolvedCount: Number(rows?.unresolvedCount || 0),
  };
}

function buildPendingGroups(items: SegmentVoiceprintPendingItem[]): SegmentVoiceprintPendingGroup[] {
  const groups = new Map<string, SegmentVoiceprintPendingGroup>();

  for (const item of items) {
    const label = item.sourceSpeakerLabel || item.speakerLabel || 'unknown';
    const existing = groups.get(label) || {
      speakerLabel: label === 'unknown' ? null : label,
      segmentCount: 0,
      totalDurationMs: 0,
      unresolvedCount: 0,
      samples: [],
      segments: [],
    };
    existing.segmentCount += 1;
    existing.totalDurationMs += Math.max(0, item.endMs - item.startMs);
    existing.unresolvedCount += 1;
    if (existing.samples.length < 3 && item.text) {
      existing.samples.push(item.text);
    }
    existing.segments.push(item);
    groups.set(label, existing);
  }

  return [...groups.values()].sort((a, b) => (
    b.totalDurationMs - a.totalDurationMs ||
    b.segmentCount - a.segmentCount ||
    String(a.speakerLabel || '').localeCompare(String(b.speakerLabel || ''))
  ));
}

function normalizeDecisionForCurrentScheme(input: {
  decision?: string | null;
  resolutionMethod?: string | null;
  speakerId?: string | null;
  startMs?: number | null;
  endMs?: number | null;
}): string {
  const raw = String(input.decision || input.resolutionMethod || '').trim();
  const durationMs = Math.max(0, Number(input.endMs || 0) - Number(input.startMs || 0));

  if (raw === HUMAN_EXCLUDED_METHOD) {
    return HUMAN_EXCLUDED_METHOD;
  }
  if (raw === HUMAN_CONFIRMED_METHOD || raw === 'manual_confirm' || raw === 'manual_identity_confirm') {
    return HUMAN_CONFIRMED_METHOD;
  }
  if (
    raw === AUTO_HIT_METHOD
    || raw === BACKFILL_HIT_METHOD
    || raw === LOW_CONFIDENCE_METHOD
    || raw === CONFLICT_METHOD
    || raw === NO_MATCH_METHOD
    || raw === SKIPPED_SHORT_METHOD
    || raw === ERROR_METHOD
  ) {
    return raw;
  }
  if (input.speakerId) {
    return HUMAN_CONFIRMED_METHOD;
  }
  if (durationMs > 0 && durationMs < 1200) {
    return SKIPPED_SHORT_METHOD;
  }
  return NO_MATCH_METHOD;
}

export async function listVoiceprintFeatureList(): Promise<Array<{ featureId: string; featureInfo?: string }>> {
  const config = getConfigOrThrow();
  return queryFeatureList(config);
}

export async function identifyRealtimeVoiceprintSpeakerFromPcm(
  audioBuffer: Buffer,
  durationMs: number,
): Promise<RealtimeVoiceprintMatchResult | null> {
  if (!isXfyunVoiceprintEnabled()) {
    return null;
  }
  const config = getXfyunVoiceprintConfig();
  if (!config) {
    return null;
  }

  const minSegmentMs = Number(process.env.XFYUN_MIN_SEGMENT_MS || 1000);
  if (durationMs < minSegmentMs || audioBuffer.length === 0) {
    return {
      decision: SKIPPED_SHORT_METHOD,
      provider: 'xfyun',
      groupId: config.groupId,
      speakerId: null,
      speakerName: null,
      speakerIdentity: null,
      score: null,
      topFeatureId: null,
      topSpeakerId: null,
      topSpeakerName: null,
      topSpeakerIdentity: null,
      secondScore: null,
      secondFeatureId: null,
      secondSpeakerId: null,
      secondSpeakerName: null,
      rawResponseJson: null,
    };
  }

  const margin = Number(process.env.XFYUN_HIT_MARGIN || 8);
  try {
    const response = await searchFeaAudioBuffer(config, audioBuffer, 2);
    const scoreList = [...response.scoreList]
      .filter(item => Number.isFinite(Number(item?.score)))
      .sort((a, b) => normalizeScore(Number(b.score)) - normalizeScore(Number(a.score)));
    const threshold = scoreThresholdForDuration(durationMs);
    const { decision, top, second } = classifyDecision(scoreList, threshold, margin);
    const topSpeaker = mapFeatureIdToSpeaker(config.groupId, top?.featureId);
    const secondSpeaker = mapFeatureIdToSpeaker(config.groupId, second?.featureId);
    const topScore = top ? normalizeScore(Number(top.score)) : null;
    const secondScore = second ? normalizeScore(Number(second.score)) : null;
    const topSpeakerId = topSpeaker?.id || mapFeatureIdToSpeakerId(config.groupId, top?.featureId);
    const secondSpeakerId = secondSpeaker?.id || mapFeatureIdToSpeakerId(config.groupId, second?.featureId);
    const rawResponseJson = JSON.stringify(response.raw);

    if (decision === AUTO_HIT_METHOD && topSpeaker) {
      return {
        decision: AUTO_HIT_METHOD,
        provider: 'xfyun',
        groupId: config.groupId,
        speakerId: topSpeaker.id,
        speakerName: topSpeaker.name,
        speakerIdentity: topSpeaker.identity_label,
        score: topScore,
        topFeatureId: top?.featureId || null,
        topSpeakerId,
        topSpeakerName: topSpeaker.name,
        topSpeakerIdentity: topSpeaker.identity_label,
        secondScore,
        secondFeatureId: second?.featureId || null,
        secondSpeakerId,
        secondSpeakerName: secondSpeaker?.name || null,
        rawResponseJson,
      };
    }

    return {
      decision: decision === AUTO_HIT_METHOD ? NO_MATCH_METHOD : decision,
      provider: 'xfyun',
      groupId: config.groupId,
      speakerId: null,
      speakerName: null,
      speakerIdentity: null,
      score: topScore,
      topFeatureId: top?.featureId || null,
      topSpeakerId,
      topSpeakerName: topSpeaker?.name || null,
      topSpeakerIdentity: topSpeaker?.identity_label || null,
      secondScore,
      secondFeatureId: second?.featureId || null,
      secondSpeakerId,
      secondSpeakerName: secondSpeaker?.name || null,
      rawResponseJson,
    };
  } catch (err) {
    if (isXfyunEmptyFeatureDbError(err)) {
      return {
        decision: NO_MATCH_METHOD,
        provider: 'xfyun',
        groupId: config.groupId,
        speakerId: null,
        speakerName: null,
        speakerIdentity: null,
        score: null,
        topFeatureId: null,
        topSpeakerId: null,
        topSpeakerName: null,
        topSpeakerIdentity: null,
        secondScore: null,
        secondFeatureId: null,
        secondSpeakerId: null,
        secondSpeakerName: null,
        rawResponseJson: null,
      };
    }
    throw err;
  }
}

export function getPendingSegments(conversationId: string): SegmentVoiceprintPendingResult {
  const conversation = getConversation(conversationId);
  const stats = getConversationVoiceprintStats(conversationId);
  const latestMap = getLatestMatchesMap(conversationId);
  const rows = getSegmentRows(conversationId, true, 1000);

  const segments = rows.map(row => {
    const match = latestMap.get(row.id);
    return {
      segmentId: row.id,
      startMs: row.start_ms,
      endMs: row.end_ms,
      text: row.text,
      audioUrl: match?.request_audio_path ? match.request_audio_path : null,
      speakerLabel: row.speaker_label,
      sourceSpeakerLabel: row.original_speaker_label || row.speaker_label,
      decision: normalizeDecisionForCurrentScheme({
        decision: match?.decision || null,
        resolutionMethod: row.resolution_method,
        speakerId: row.speaker_id,
        startMs: row.start_ms,
        endMs: row.end_ms,
      }),
      topScore: match?.top_score ?? null,
      secondScore: match?.second_score ?? null,
      resolutionMethod: row.resolution_method,
    };
  });

  return {
    conversationId: conversation.id,
    segments,
    groups: buildPendingGroups(segments),
    stats,
  };
}

export async function scanConversationVoiceprintSegments(
  conversationId: string,
  options: VoiceprintScanOptions = {},
): Promise<VoiceprintScanResult> {
  const config = getConfigOrThrow();
  const conversation = getConversation(conversationId);
  if (!conversation.audio_file_path) {
    throw new Error(`conversation has no audio_file_path: ${conversationId}`);
  }

  const limit = clampPositiveInt(options.limit, 100, 1000);
  const onlyUnresolved = options.onlyUnresolved !== false;
  const dryRun = !!options.dryRun;
  const segments = getSegmentRows(conversationId, onlyUnresolved, limit);
  const margin = Number(process.env.XFYUN_HIT_MARGIN || 8);
  const minSegmentMs = Number(process.env.XFYUN_MIN_SEGMENT_MS || 3000);
  const maxQueryMs = Number(process.env.XFYUN_MAX_QUERY_MS || 8000);

  let processed = 0;
  let hit = 0;
  let lowConfidence = 0;
  let conflict = 0;
  let noMatch = 0;
  let skipped = 0;
  let error = 0;

  for (const segment of segments) {
    processed += 1;
    const prep = await prepareSegmentClip(
      conversation.audio_file_path,
      segment.id,
      conversation.id,
      segment.start_ms,
      segment.end_ms,
      {
        minSegmentMs,
        maxQueryMs,
      },
    );

    if (prep.skipped) {
      skipped += 1;
      if (!dryRun) {
        buildMatchRow({
          conversationId,
          segmentId: segment.id,
          provider: 'xfyun',
          groupId: config.groupId,
          requestAudioPath: null,
          requestDurationMs: prep.durationMs,
          decision: SKIPPED_SHORT_METHOD,
          topFeatureId: null,
          topSpeakerId: null,
          topScore: null,
          secondFeatureId: null,
          secondSpeakerId: null,
          secondScore: null,
          rawResponseJson: null,
          errorMessage: prep.reason || 'segment too short',
        });
        db.prepare(`
          UPDATE conversation_segments
          SET resolution_method = ?, updated_at = ?
          WHERE id = ?
        `).run(SKIPPED_SHORT_METHOD, new Date().toISOString(), segment.id);
      }
      continue;
    }

    try {
      const response = await searchFea(config, prep.filePath, 2);
      const scoreList = [...response.scoreList]
        .filter(item => Number.isFinite(Number(item?.score)))
        .sort((a, b) => normalizeScore(Number(b.score)) - normalizeScore(Number(a.score)));
      const threshold = scoreThresholdForDuration(prep.durationMs);
      const { decision, top, second } = classifyDecision(scoreList, threshold, margin);
      const topSpeaker = mapFeatureIdToSpeaker(config.groupId, top?.featureId);
      const secondSpeaker = mapFeatureIdToSpeaker(config.groupId, second?.featureId);
      const rawResponseJson = JSON.stringify(response.raw);

      const topScoreValue = top ? normalizeScore(Number(top.score)) : null;
      const secondScoreValue = second ? normalizeScore(Number(second.score)) : null;
      const topSpeakerId = topSpeaker?.id || mapFeatureIdToSpeakerId(config.groupId, top?.featureId);
      const secondSpeakerId = secondSpeaker?.id || mapFeatureIdToSpeakerId(config.groupId, second?.featureId);
      const recordDecision = decision === AUTO_HIT_METHOD && !topSpeaker ? NO_MATCH_METHOD : decision;

      if (recordDecision === AUTO_HIT_METHOD && topSpeaker) {
        hit += 1;
        if (!dryRun) {
          db.prepare(`
            UPDATE conversation_segments
            SET
              speaker_id = ?,
              speaker_name = ?,
              speaker_identity = ?,
              confidence = ?,
              resolution_method = ?,
              updated_at = ?
            WHERE id = ?
          `).run(
            topSpeaker.id,
            topSpeaker.name,
            topSpeaker.identity_label,
            topScoreValue,
            AUTO_HIT_METHOD,
            new Date().toISOString(),
            segment.id,
          );
        }
      } else if (recordDecision === AUTO_HIT_METHOD) {
        noMatch += 1;
      } else if (decision === LOW_CONFIDENCE_METHOD) {
        lowConfidence += 1;
      } else if (decision === CONFLICT_METHOD) {
        conflict += 1;
      } else {
        noMatch += 1;
      }

      if (!dryRun) {
        buildMatchRow({
          conversationId,
          segmentId: segment.id,
          provider: 'xfyun',
          groupId: config.groupId,
          requestAudioPath: prep.filePath,
          requestDurationMs: prep.durationMs,
          decision: recordDecision,
          topFeatureId: top?.featureId || null,
          topSpeakerId: topSpeakerId || null,
          topScore: topScoreValue,
          secondFeatureId: second?.featureId || null,
          secondSpeakerId: secondSpeakerId || null,
          secondScore: secondScoreValue,
          rawResponseJson,
          errorMessage: null,
        });
        if (recordDecision !== AUTO_HIT_METHOD) {
          db.prepare(`
            UPDATE conversation_segments
            SET resolution_method = ?, updated_at = ?
            WHERE id = ? AND speaker_id IS NULL
          `).run(recordDecision, new Date().toISOString(), segment.id);
        }
      }
    } catch (err) {
      if (isXfyunEmptyFeatureDbError(err)) {
        noMatch += 1;
        if (!dryRun) {
          buildMatchRow({
            conversationId,
            segmentId: segment.id,
            provider: 'xfyun',
            groupId: config.groupId,
            requestAudioPath: prep.filePath,
            requestDurationMs: prep.durationMs,
            decision: NO_MATCH_METHOD,
            topFeatureId: null,
            topSpeakerId: null,
            topScore: null,
            secondFeatureId: null,
            secondSpeakerId: null,
            secondScore: null,
            rawResponseJson: null,
            errorMessage: String((err as Error)?.message ?? err),
          });
          db.prepare(`
            UPDATE conversation_segments
            SET resolution_method = ?, updated_at = ?
            WHERE id = ? AND speaker_id IS NULL
          `).run(NO_MATCH_METHOD, new Date().toISOString(), segment.id);
        }
        continue;
      }

      error += 1;
      if (!dryRun) {
        buildMatchRow({
          conversationId,
          segmentId: segment.id,
          provider: 'xfyun',
          groupId: config.groupId,
          requestAudioPath: prep.filePath,
          requestDurationMs: prep.durationMs,
          decision: ERROR_METHOD,
          topFeatureId: null,
          topSpeakerId: null,
          topScore: null,
          secondFeatureId: null,
          secondSpeakerId: null,
          secondScore: null,
          rawResponseJson: null,
          errorMessage: String((err as Error)?.message ?? err),
        });
        db.prepare(`
          UPDATE conversation_segments
          SET resolution_method = ?, updated_at = ?
          WHERE id = ? AND speaker_id IS NULL
        `).run(ERROR_METHOD, new Date().toISOString(), segment.id);
      }
    }
  }

  return {
    conversationId,
    processed,
    hit,
    lowConfidence,
    conflict,
    noMatch,
    skipped,
    error,
    dryRun,
  };
}

async function createOrUpdateSpeakerForEnrollment(input: {
  speakerMode: 'new' | 'existing';
  speakerId?: string | null;
  speakerName?: string | null;
  identityLabel?: string | null;
  notes?: string | null;
  enrollmentBatchId: string;
}): Promise<{ speakerId: string; createdNewSpeaker: boolean; speaker: SpeakerRow; action: 'create_feature' | 'update_feature'; featureRow?: FeatureRow }> {
  const config = getConfigOrThrow();
  if (input.speakerMode === 'existing') {
    if (!input.speakerId) {
      throw new Error('speakerId is required for speakerMode=existing');
    }
    const speaker = getSpeakerById(input.speakerId);
    const featureRow = getFeatureRowForSpeaker(speaker.id);
    return {
      speakerId: speaker.id,
      createdNewSpeaker: false,
      speaker,
      action: featureRow ? 'update_feature' : 'create_feature',
      featureRow,
    };
  }

  const speakerName = (input.speakerName || '').trim();
  const notes = (input.notes || '').trim() || null;
  if (!speakerName) {
    throw new Error('speakerName is required for speakerMode=new');
  }
  if (!isValidIdentityLabel(input.identityLabel || null)) {
    throw new Error(`identityLabel must be one of: ${['客户', '销售', '面试官', '候选人', '同事', '老板', '下属', '老师', '学生', '家人', '朋友', '其他'].join(', ')}`);
  }

  const speakerId = genId('spk');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO speakers (
      id, name, status, display_label, identity_label, identity_status, notes,
      first_seen_at, last_seen_at, sample_text, sample_segment_id, sample_audio_path,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    speakerId,
    speakerName,
    'confirmed',
    speakerName,
    input.identityLabel?.trim() || null,
    input.identityLabel?.trim() ? 'confirmed' : 'unconfirmed',
    notes,
    now,
    now,
    null,
    null,
    null,
    now,
    now,
  );

  return {
    speakerId,
    createdNewSpeaker: true,
    speaker: getSpeakerById(speakerId),
    action: 'create_feature',
  };
}

export async function enrollFromSegments(input: VoiceprintEnrollmentRequest): Promise<VoiceprintEnrollmentResult> {
  const config = getConfigOrThrow();
  const conversation = getConversation(input.conversationId);
  if (!conversation.audio_file_path) {
    throw new Error(`conversation has no audio_file_path: ${input.conversationId}`);
  }

  const selectedSegmentIds = [...new Set((input.segmentIds || []).map(id => String(id).trim()).filter(Boolean))];
  const excludedSegmentIds = [...new Set((input.excludedSegmentIds || []).map(id => String(id).trim()).filter(Boolean))];
  if (!selectedSegmentIds.length && !excludedSegmentIds.length) {
    throw new Error('segmentIds or excludedSegmentIds is required');
  }
  const overlap = selectedSegmentIds.filter(id => excludedSegmentIds.includes(id));
  if (overlap.length) {
    throw new Error(`segmentIds and excludedSegmentIds overlap: ${overlap.join(', ')}`);
  }

  const excludeOnly = selectedSegmentIds.length === 0 && excludedSegmentIds.length > 0;

  const allIds = [...selectedSegmentIds, ...excludedSegmentIds];
  const rows = db.prepare(`
    SELECT id, conversation_id, start_ms, end_ms, text, speaker_label, speaker_id, speaker_name, speaker_identity, resolution_method
    FROM conversation_segments
    WHERE conversation_id = ?
      AND id IN (${allIds.map(() => '?').join(', ')})
  `).all(input.conversationId, ...allIds) as SegmentRow[];
  if (rows.length !== allIds.length) {
    throw new Error('one or more segmentIds do not belong to this conversation');
  }

  const batchId = genId('senr');
  const now = new Date().toISOString();
  const enrollmentSpeaker = excludeOnly
    ? null
    : await createOrUpdateSpeakerForEnrollment({
      speakerMode: input.speakerMode,
      speakerId: input.speakerId,
      speakerName: input.speakerName,
      identityLabel: input.identityLabel,
      notes: input.notes,
      enrollmentBatchId: batchId,
    });

  db.prepare(`
    INSERT INTO speaker_enrollment_batches (
      id, speaker_id, provider, group_id, feature_id, action, status,
      audio_path, duration_ms, audio_size_bytes, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    batchId,
    enrollmentSpeaker?.speakerId || null,
    'xfyun',
    config.groupId,
    null,
    excludeOnly ? 'exclude_segments' : enrollmentSpeaker!.action,
    'pending',
    null,
    null,
    null,
    null,
    now,
    now,
  );

  const includeRows = rows.filter(row => selectedSegmentIds.includes(row.id));
  const excludeRows = rows.filter(row => excludedSegmentIds.includes(row.id));

  if (excludeOnly) {
    const clearSegmentStmt = db.prepare(`
      UPDATE conversation_segments
      SET speaker_id = NULL, speaker_name = NULL, speaker_identity = NULL, confidence = NULL, resolution_method = ?, updated_at = ?
      WHERE id = ?
    `);

    const tx = db.transaction(() => {
      for (const row of excludeRows) {
        clearSegmentStmt.run(HUMAN_EXCLUDED_METHOD, new Date().toISOString(), row.id);
        db.prepare(`
          INSERT INTO speaker_enrollment_segments (
            enrollment_batch_id, segment_id, decision, created_at
          ) VALUES (?, ?, ?, ?)
        `).run(batchId, row.id, 'drop', new Date().toISOString());
      }
    });
    tx();

    db.prepare(`
      UPDATE speaker_enrollment_batches
      SET status = ?, action = ?, updated_at = ?
      WHERE id = ?
    `).run('success', 'exclude_segments', new Date().toISOString(), batchId);

    return {
      batchId,
      speakerId: '',
      featureId: '',
      action: 'exclude_segments',
      status: 'success',
      createdNewSpeaker: false,
      processedSegmentCount: 0,
      excludedSegmentCount: excludeRows.length,
      audioPath: null,
      durationMs: null,
      audioSizeBytes: null,
      errorMessage: null,
    };
  }

  if (!enrollmentSpeaker) {
    throw new Error('enrollment speaker could not be resolved');
  }

  const prep = await prepareEnrollmentAudio(
    conversation.audio_file_path,
    includeRows.map(row => ({
      segmentId: row.id,
      startMs: row.start_ms,
      endMs: row.end_ms,
    })),
    input.conversationId,
    batchId,
    {
      minSegmentMs: Number(process.env.XFYUN_MIN_SEGMENT_MS || 3000),
      maxQueryMs: Number(process.env.XFYUN_MAX_QUERY_MS || 8000),
      maxEnrollmentBytes: Number(process.env.XFYUN_MAX_ENROLLMENT_BYTES || 4_000_000),
    },
  );

  if (prep.skipped) {
    db.prepare(`
      UPDATE speaker_enrollment_batches
      SET status = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run('failed', prep.reason || 'audio preparation failed', new Date().toISOString(), batchId);
    throw new Error(prep.reason || 'audio preparation failed');
  }

  const featureInfo = `${enrollmentSpeaker.speaker.name || enrollmentSpeaker.speakerId} | batch:${batchId} | ${now}`;
  let featureId = enrollmentSpeaker.featureRow?.feature_id || genId('vf');
  let featureResponse;

  try {
    if (enrollmentSpeaker.action === 'update_feature' && enrollmentSpeaker.featureRow?.feature_id) {
      featureResponse = await updateFeature(config, prep.filePath, enrollmentSpeaker.featureRow.feature_id, featureInfo);
      featureId = featureResponse.featureId;
      db.prepare(`
        UPDATE speaker_voiceprint_features
        SET feature_version = feature_version + 1,
            status = 'active',
            source_enrollment_batch_id = ?,
            updated_at = ?
        WHERE id = ?
      `).run(batchId, new Date().toISOString(), enrollmentSpeaker.featureRow.id);
    } else {
      featureId = featureId || genId('vf');
      featureResponse = await createFeature(config, prep.filePath, featureId, featureInfo);
      db.prepare(`
        INSERT INTO speaker_voiceprint_features (
          id, speaker_id, provider, group_id, feature_id, feature_version, status,
          source_enrollment_batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId('svf'),
        enrollmentSpeaker.speakerId,
        'xfyun',
        config.groupId,
        featureResponse.featureId,
        1,
        'active',
        batchId,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    }
  } catch (err) {
    db.prepare(`
      UPDATE speaker_enrollment_batches
      SET status = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run('failed', String((err as Error)?.message ?? err), new Date().toISOString(), batchId);
    throw err;
  }

  const updateSegmentStmt = db.prepare(`
    UPDATE conversation_segments
    SET speaker_id = ?, speaker_name = ?, speaker_identity = ?, confidence = ?, resolution_method = ?, updated_at = ?
    WHERE id = ?
  `);
  const clearSegmentStmt = db.prepare(`
    UPDATE conversation_segments
    SET speaker_id = NULL, speaker_name = NULL, speaker_identity = NULL, confidence = NULL, resolution_method = ?, updated_at = ?
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    for (const row of includeRows) {
      updateSegmentStmt.run(
        enrollmentSpeaker.speakerId,
        enrollmentSpeaker.speaker.name,
        enrollmentSpeaker.speaker.identity_label,
        1,
        HUMAN_CONFIRMED_METHOD,
        new Date().toISOString(),
        row.id,
      );
      db.prepare(`
        INSERT INTO speaker_enrollment_segments (
          enrollment_batch_id, segment_id, decision, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(batchId, row.id, 'keep', new Date().toISOString());
    }
    for (const row of excludeRows) {
      clearSegmentStmt.run(HUMAN_EXCLUDED_METHOD, new Date().toISOString(), row.id);
      db.prepare(`
        INSERT INTO speaker_enrollment_segments (
          enrollment_batch_id, segment_id, decision, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(batchId, row.id, 'drop', new Date().toISOString());
    }
  });
  tx();

  db.prepare(`
    UPDATE speaker_enrollment_batches
    SET speaker_id = ?, feature_id = ?, status = ?, audio_path = ?, duration_ms = ?, audio_size_bytes = ?, updated_at = ?
    WHERE id = ?
  `).run(
    enrollmentSpeaker.speakerId,
    featureId,
    'success',
    prep.filePath,
    prep.durationMs,
    prep.sizeBytes,
    new Date().toISOString(),
    batchId,
  );

  return {
    batchId,
    speakerId: enrollmentSpeaker!.speakerId,
    featureId,
    action: enrollmentSpeaker!.action,
    status: 'success',
    createdNewSpeaker: enrollmentSpeaker!.createdNewSpeaker,
    processedSegmentCount: includeRows.length,
    excludedSegmentCount: excludeRows.length,
    audioPath: prep.filePath,
    durationMs: prep.durationMs,
    audioSizeBytes: prep.sizeBytes,
    errorMessage: null,
  };
}

export async function applySpeakerMaterials(input: SpeakerMaterialApplyRequest): Promise<SpeakerMaterialApplyResult> {
  const speakerId = String(input.speakerId || '').trim();
  if (!speakerId) {
    throw new Error('speakerId is required');
  }
  getSpeakerById(speakerId);

  const includeIds = [...new Set((input.segmentIds || []).map(id => String(id).trim()).filter(Boolean))];
  const excludeIds = [...new Set((input.excludedSegmentIds || []).map(id => String(id).trim()).filter(Boolean))];
  if (!includeIds.length && !excludeIds.length) {
    throw new Error('segmentIds or excludedSegmentIds is required');
  }
  const overlap = includeIds.filter(id => excludeIds.includes(id));
  if (overlap.length) {
    throw new Error(`segmentIds and excludedSegmentIds overlap: ${overlap.join(', ')}`);
  }

  const allIds = [...includeIds, ...excludeIds];
  const rows = db.prepare(`
    SELECT id, conversation_id
    FROM conversation_segments
    WHERE id IN (${allIds.map(() => '?').join(', ')})
  `).all(...allIds) as Array<{ id: string; conversation_id: string }>;
  if (rows.length !== allIds.length) {
    throw new Error('one or more segmentIds do not exist');
  }

  const byConversation = new Map<string, { segmentIds: string[]; excludedSegmentIds: string[] }>();
  rows.forEach((row) => {
    const bucket = byConversation.get(row.conversation_id) || { segmentIds: [], excludedSegmentIds: [] };
    if (includeIds.includes(row.id)) bucket.segmentIds.push(row.id);
    if (excludeIds.includes(row.id)) bucket.excludedSegmentIds.push(row.id);
    byConversation.set(row.conversation_id, bucket);
  });

  const batches: VoiceprintEnrollmentResult[] = [];
  for (const [conversationId, group] of byConversation.entries()) {
    batches.push(await enrollFromSegments({
      conversationId,
      segmentIds: group.segmentIds,
      excludedSegmentIds: group.excludedSegmentIds,
      speakerMode: 'existing',
      speakerId,
    }));
  }

  return {
    speakerId,
    processedConversations: byConversation.size,
    processedSegmentCount: batches.reduce((sum, batch) => sum + Number(batch.processedSegmentCount || 0), 0),
    excludedSegmentCount: batches.reduce((sum, batch) => sum + Number(batch.excludedSegmentCount || 0), 0),
    batches,
  };
}

export function backfillConversationVoiceprintSegments(
  conversationId: string,
  options: VoiceprintScanOptions = {},
): Promise<VoiceprintScanResult> {
  return scanConversationVoiceprintSegments(conversationId, {
    ...options,
    onlyUnresolved: true,
  });
}

export function getConversationVoiceprintOverview(conversationId: string): ConversationVoiceprintOverview {
  const stats = getConversationVoiceprintStats(conversationId);
  return {
    conversationId,
    totalSegments: stats.totalSegments,
    unresolvedSegments: stats.unresolvedCount,
    confirmedSegments: stats.humanConfirmedCount + stats.autoHitCount,
    autoHitSegments: stats.autoHitCount,
    skippedSegments: stats.skippedShortCount,
    errorSegments: stats.errorCount,
  };
}
