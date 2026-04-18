import { initDb, db } from '../src/db';
import { mapSpeakersForConversation } from '../src/services/speaker-mapper';
import * as path from 'path';
import * as fs from 'fs/promises';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function main() {
  process.env.ALLOW_DETERMINISTIC_EMBEDDINGS = 'true';
  process.env.SPEAKER_MIN_ENROLLMENT_MS = '900';
  initDb();
  db.exec(`
    DELETE FROM conversation_segments;
    DELETE FROM audio_files;
    DELETE FROM speaker_embeddings;
    DELETE FROM speakers;
    DELETE FROM conversations;
  `);

  const conversationId = genId('conv');
  const audioFileId = genId('aud');
  const now = new Date().toISOString();
  const baseAudioPath = path.join(process.cwd(), 'tests', 'test.opus');
  const tmpDir = path.join(process.cwd(), 'tests', '.tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const audioPath = path.join(tmpDir, `${conversationId}.opus`);
  await fs.copyFile(baseAudioPath, audioPath);

  db.prepare(`
    INSERT INTO conversations (
      id, session_id, status, websocket_connected_at, first_audio_frame_at,
      raw_result_path, audio_file_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    conversationId,
    genId('session'),
    'completed',
    now,
    now,
    null,
    audioPath,
    now,
    now,
  );

  db.prepare(`
    INSERT INTO audio_files (
      id, conversation_id, file_path, file_name, duration_ms,
      sample_rate, channels, bits_per_sample, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    audioFileId,
    conversationId,
    audioPath,
    path.basename(audioPath),
    3000,
    16000,
    1,
    16,
    now,
    now,
  );

  const insertSeg = db.prepare(`
    INSERT INTO conversation_segments (
      id, conversation_id, audio_file_id,
      start_ms, end_ms, absolute_start_time, absolute_end_time,
      speaker_label, speaker_id, speaker_name, text,
      confidence, resolution_method, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertSeg.run(genId('seg'), conversationId, audioFileId, 0, 1200, now, now, '1', null, null, '你好，我是测试发言人A。', null, 'seed', now, now);
  insertSeg.run(genId('seg'), conversationId, audioFileId, 1300, 2600, now, now, '2', null, null, '你好，我是测试发言人B。', null, 'seed', now, now);

  await mapSpeakersForConversation(conversationId);

  const rows = db.prepare(`
    SELECT speaker_label, speaker_id, speaker_name, confidence, resolution_method
    FROM conversation_segments
    WHERE conversation_id = ?
    ORDER BY start_ms ASC
  `).all(conversationId);

  console.log(JSON.stringify({ conversationId, rows }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
