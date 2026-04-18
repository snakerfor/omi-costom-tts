import { initDb, db } from '../src/db';
import { mapSpeakersForConversation } from '../src/services/speaker-mapper';
import { confirmSpeakerName } from '../src/services/speaker-service';
import * as fs from 'fs/promises';
import * as path from 'path';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function seedConversation(audioPath: string, speakerLabel: string, text: string): Promise<string> {
  const conversationId = genId('conv');
  const audioFileId = genId('aud');
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO conversations (
      id, session_id, status, websocket_connected_at, first_audio_frame_at,
      raw_result_path, audio_file_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(conversationId, genId('session'), 'completed', now, now, null, audioPath, now, now);

  db.prepare(`
    INSERT INTO audio_files (
      id, conversation_id, file_path, file_name, duration_ms,
      sample_rate, channels, bits_per_sample, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(audioFileId, conversationId, audioPath, path.basename(audioPath), 3000, 16000, 1, 16, now, now);

  db.prepare(`
    INSERT INTO conversation_segments (
      id, conversation_id, audio_file_id,
      start_ms, end_ms, absolute_start_time, absolute_end_time,
      speaker_label, speaker_id, speaker_name, text,
      confidence, resolution_method, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(genId('seg'), conversationId, audioFileId, 0, 1800, now, now, speakerLabel, null, null, text, null, 'seed', now, now);

  return conversationId;
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

  const baseAudioPath = path.join(process.cwd(), 'tests', 'test.opus');
  const tmpDir = path.join(process.cwd(), 'tests', '.tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  const audioPath1 = path.join(tmpDir, `${genId('audio')}.opus`);
  const audioPath2 = path.join(tmpDir, `${genId('audio')}.opus`);
  await fs.copyFile(baseAudioPath, audioPath1);
  await fs.copyFile(baseAudioPath, audioPath2);

  const conv1 = await seedConversation(audioPath1, '1', '这是第一次会话中的同一个说话人。');
  await mapSpeakersForConversation(conv1);
  const first = db.prepare(`SELECT speaker_id FROM conversation_segments WHERE conversation_id = ? LIMIT 1`).get(conv1) as { speaker_id: string };

  const conv2 = await seedConversation(audioPath2, '1', '这是第二次会话中的同一个说话人。');
  await mapSpeakersForConversation(conv2);
  const second = db.prepare(`SELECT speaker_id FROM conversation_segments WHERE conversation_id = ? LIMIT 1`).get(conv2) as { speaker_id: string };

  if (!first?.speaker_id || !second?.speaker_id) {
    throw new Error('speaker mapping failed: missing speaker_id');
  }

  // 验证复用
  const reused = first.speaker_id === second.speaker_id;

  // 验证确认回填
  const confirmResult = confirmSpeakerName(first.speaker_id, '张三(联调)');

  const afterConfirm = db.prepare(`
    SELECT conversation_id, speaker_id, speaker_name
    FROM conversation_segments
    WHERE speaker_id = ?
    ORDER BY created_at ASC
  `).all(first.speaker_id) as Array<{ conversation_id: string; speaker_id: string; speaker_name: string | null }>;

  console.log(
    JSON.stringify(
      {
        conv1,
        conv2,
        firstSpeakerId: first.speaker_id,
        secondSpeakerId: second.speaker_id,
        reused,
        confirmResult,
        afterConfirm,
      },
      null,
      2,
    ),
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
