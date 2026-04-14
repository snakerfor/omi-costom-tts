import 'dotenv/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SonioxNodeClient } from '@soniox/node';
import { db, initDb } from '../src/db';
import { finalizeConversation } from '../src/services/conversation-finalizer';
import { mapSpeakersForConversation } from '../src/services/speaker-mapper';
import { alignConversationSpeakers } from '../src/services/speaker-alignment';
import { SonioxToken } from '../src/types';
import { audioUploadsDir, finalizedResultsDir, rawResultsDir } from '../src/runtime-paths';

function shouldRunSpeakerIdentityMapping(): boolean {
  return process.env.ENABLE_SPEAKER_IDENTITY_MAPPING === 'true';
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function requireArg(name: string): string {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (key?.startsWith('--') && value) {
      args.set(key.slice(2), value);
    }
  }
  const value = args.get(name);
  if (!value) {
    throw new Error(`missing required arg --${name}`);
  }
  return value;
}

async function pollTranscription(client: SonioxNodeClient, transcriptionId: string): Promise<any> {
  let transcription: any = await client.stt.get(transcriptionId);
  while (transcription && transcription.status !== 'completed' && transcription.status !== 'failed' && transcription.status !== 'error') {
    console.log(`[AsyncRebuild] transcription status=${String(transcription.status)}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    transcription = await client.stt.get(transcriptionId);
  }
  return transcription;
}

function normalizeTokens(rawTokens: any[]): SonioxToken[] {
  return rawTokens
    .map(token => ({
      text: String(token?.text || '').trim(),
      start_ms: Number(token?.start_ms || 0),
      end_ms: Number(token?.end_ms || 0),
      confidence: token?.confidence == null ? undefined : Number(token.confidence),
      is_final: true,
      speaker: token?.speaker == null ? undefined : String(token.speaker),
    }))
    .filter(token => !!token.text);
}

async function main(): Promise<void> {
  initDb();

  const audioPath = requireArg('audio-path');
  const sourceSessionId = requireArg('source-session-id');
  const sessionId = `${sourceSessionId}_async_${Date.now().toString(36)}`;

  const apiKey = process.env.SONIOX_API_KEY;
  if (!apiKey) {
    throw new Error('SONIOX_API_KEY is required');
  }

  const sourceConversation = db.prepare(`
    SELECT id, websocket_connected_at, first_audio_frame_at, audio_file_path
    FROM conversations
    WHERE session_id = ?
  `).get(sourceSessionId) as {
    id: string;
    websocket_connected_at: string | null;
    first_audio_frame_at: string | null;
    audio_file_path: string | null;
  } | undefined;

  const recordingStartedAt =
    sourceConversation?.first_audio_frame_at ||
    sourceConversation?.websocket_connected_at ||
    new Date().toISOString();

  const client = new SonioxNodeClient({ api_key: apiKey });
  const stream = (await import('fs')).createReadStream(audioPath);
  console.log(`[AsyncRebuild] uploading ${audioPath}`);
  const file = await client.files.upload(stream, { filename: path.basename(audioPath) });
  console.log(`[AsyncRebuild] uploaded file_id=${file.id}`);

  const languageHints = (process.env.SONIOX_LANGUAGE_HINTS || 'zh,en')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  const transcription = await client.stt.create({
    model: 'stt-async-v4',
    file_id: file.id,
    enable_speaker_diarization: true,
    language_hints: languageHints,
  });
  console.log(`[AsyncRebuild] transcription created id=${transcription.id}`);

  const completed = await pollTranscription(client, transcription.id);
  if (!completed || completed.status !== 'completed') {
    throw new Error(`transcription failed with status=${String(completed?.status)}`);
  }

  const transcript = await completed.getTranscript();
  const tokens = normalizeTokens(Array.isArray(transcript?.tokens) ? transcript.tokens : []);
  if (!tokens.length) {
    throw new Error('transcription returned no tokens');
  }

  await fs.mkdir(rawResultsDir, { recursive: true });
  const rawTranscriptPath = path.join(rawResultsDir, `${sessionId}.ndjson`);
  const rawEvent = {
    ts: new Date().toISOString(),
    event: 'soniox_result',
    session_id: sessionId,
    result_index: 0,
    is_final: true,
    tokens,
  };
  await fs.writeFile(rawTranscriptPath, `${JSON.stringify(rawEvent)}\n`, 'utf8');

  const finalized = await finalizeConversation({
    sessionId,
    rawTranscriptPath,
    outputDir: finalizedResultsDir,
    recordingStartedAt,
  });
  const aligned = await alignConversationSpeakers({
    sessionId,
    audioPath,
    segments: finalized.segments,
  });
  const segmentsForStorage = aligned.segments;
  const originalSpeakerBySegmentId = new Map(
    aligned.alignmentRows.map(row => [row.id, row.original_speaker_label]),
  );

  await fs.mkdir(audioUploadsDir, { recursive: true });
  const importedAudioPath = path.join(audioUploadsDir, `${sessionId}.wav`);
  if (path.resolve(importedAudioPath) !== path.resolve(audioPath)) {
    await fs.copyFile(audioPath, importedAudioPath);
  }

  const conversationId = genId('conv');
  const audioFileId = genId('aud');
  const now = new Date().toISOString();
  const durationMs = segmentsForStorage.length
    ? Math.max(...segmentsForStorage.map(segment => segment.end_ms))
    : 0;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO conversations (
        id, session_id, status, websocket_connected_at, first_audio_frame_at,
        ended_at, raw_result_path, audio_file_path, created_at, updated_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversationId,
      sessionId,
      'completed',
      recordingStartedAt,
      recordingStartedAt,
      now,
      finalized.outPath,
      importedAudioPath,
      now,
      now,
      null,
    );

    db.prepare(`
      INSERT INTO audio_files (
        id, conversation_id, file_path, file_name, duration_ms,
        sample_rate, channels, bits_per_sample, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      audioFileId,
      conversationId,
      importedAudioPath,
      path.basename(importedAudioPath),
      durationMs,
      16000,
      1,
      16,
      now,
      now,
    );

    const insertSegment = db.prepare(`
      INSERT INTO conversation_segments (
        id, conversation_id, audio_file_id,
        start_ms, end_ms, absolute_start_time, absolute_end_time,
        original_speaker_label, speaker_label, speaker_id, speaker_name, text,
        confidence, resolution_method, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const segment of segmentsForStorage) {
      insertSegment.run(
        segment.id,
        conversationId,
        audioFileId,
        segment.start_ms,
        segment.end_ms,
        segment.absolute_start_time,
        segment.absolute_end_time,
        originalSpeakerBySegmentId.get(segment.id) ?? segment.speaker_label,
        segment.speaker_label,
        null,
        null,
        segment.text,
        null,
        'soniox_async_finalized',
        now,
        now,
      );
    }
  });
  tx();

  if (shouldRunSpeakerIdentityMapping()) {
    await mapSpeakersForConversation(conversationId);
  }

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS segment_count,
      COUNT(DISTINCT COALESCE(speaker_id, 'unresolved')) AS resolved_speaker_count,
      COUNT(DISTINCT COALESCE(speaker_label, 'unknown')) AS diarization_label_count
    FROM conversation_segments
    WHERE conversation_id = ?
  `).get(conversationId) as {
    segment_count: number;
    resolved_speaker_count: number;
    diarization_label_count: number;
  };

  console.log(
    JSON.stringify(
      {
        sessionId,
        conversationId,
        rawTranscriptPath,
        finalizedPath: finalized.outPath,
        alignmentPath: aligned.alignmentOutputPath,
        stats,
      },
      null,
      2,
    ),
  );
}

main().catch(err => {
  console.error('[AsyncRebuild] failed:', err);
  process.exit(1);
});
