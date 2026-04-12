import 'dotenv/config';
import { db, initDb } from '../src/db';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface CountResult { total: number }

// ─── 1. conversation_segments → speech_segment ───

function importSpeechSegments(): number {
  const rows = db.prepare(`
    SELECT
      cs.id,
      cs.conversation_id,
      cs.absolute_start_time,
      cs.absolute_end_time,
      cs.text,
      cs.speaker_label,
      cs.speaker_id,
      cs.speaker_name,
      cs.speaker_identity,
      cs.confidence,
      c.session_id
    FROM conversation_segments cs
    LEFT JOIN conversations c ON c.id = cs.conversation_id
    WHERE cs.absolute_start_time IS NOT NULL
      AND cs.text IS NOT NULL
      AND cs.text != ''
  `).all() as Array<{
    id: string;
    conversation_id: string;
    absolute_start_time: string;
    absolute_end_time: string | null;
    text: string;
    speaker_label: string | null;
    speaker_id: string | null;
    speaker_name: string | null;
    speaker_identity: string | null;
    confidence: number | null;
    session_id: string | null;
  }>;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO knowledge_events (
      id, source_type, source_table, source_row_id, source_key,
      session_ref, conversation_ref, event_type,
      started_at, ended_at, content_text, title,
      participants_json, metadata_json, quality_score, dedupe_key,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  let count = 0;

  for (const row of rows) {
    const participants = {
      speaker_label: row.speaker_label,
      speaker_id: row.speaker_id,
      speaker_name: row.speaker_name,
      speaker_identity: row.speaker_identity,
    };

    insert.run(
      genId('ke'),
      'audio_realtime',
      'conversation_segments',
      row.id,
      null,
      row.session_id,
      row.conversation_id,
      'speech_segment',
      row.absolute_start_time,
      row.absolute_end_time,
      row.text,
      null,
      JSON.stringify(participants),
      null,
      row.confidence,
      `speech_segment:${row.id}`,
      now,
      now,
    );
    count++;
  }
  return count;
}

// ─── 2. omi_transcription_segments → desktop_transcript ───

function importDesktopTranscripts(): number {
  const rows = db.prepare(`
    SELECT
      seg.id,
      seg.source_key,
      seg.source_session_id,
      seg.speaker,
      seg.speaker_label,
      seg.text,
      seg.start_time,
      seg.end_time,
      sess.started_at AS session_started_at
    FROM omi_transcription_segments seg
    LEFT JOIN omi_transcription_sessions sess
      ON seg.source_key = sess.source_key
      AND seg.source_session_id = sess.source_session_id
    WHERE seg.text IS NOT NULL AND seg.text != ''
  `).all() as Array<{
    id: string;
    source_key: string;
    source_session_id: number;
    speaker: number | null;
    speaker_label: string | null;
    text: string;
    start_time: number | null;
    end_time: number | null;
    session_started_at: string | null;
  }>;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO knowledge_events (
      id, source_type, source_table, source_row_id, source_key,
      session_ref, conversation_ref, event_type,
      started_at, ended_at, content_text, title,
      participants_json, metadata_json, quality_score, dedupe_key,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  let count = 0;

  for (const row of rows) {
    const baseTime = row.session_started_at
      ? new Date(row.session_started_at).getTime()
      : 0;

    let startedAt: string;
    let endedAt: string | null = null;

    if (baseTime && row.start_time != null) {
      startedAt = new Date(baseTime + row.start_time * 1000).toISOString();
      if (row.end_time != null) {
        endedAt = new Date(baseTime + row.end_time * 1000).toISOString();
      }
    } else {
      startedAt = row.session_started_at || now;
    }

    const participants = row.speaker_label
      ? { speaker_label: row.speaker_label, speaker_index: row.speaker }
      : null;

    insert.run(
      genId('ke'),
      'desktop_sync',
      'omi_transcription_segments',
      row.id,
      row.source_key,
      `transcription_session:${row.source_session_id}`,
      null,
      'desktop_transcript',
      startedAt,
      endedAt,
      row.text,
      null,
      participants ? JSON.stringify(participants) : null,
      null,
      null,
      `desktop_transcript:${row.id}`,
      now,
      now,
    );
    count++;
  }
  return count;
}

// ─── 3. omi_screenshots → screenshot ───

function importScreenshots(): number {
  const rows = db.prepare(`
    SELECT
      id, source_key, ts, app_name, window_title,
      ocr_text, image_path, video_chunk_path, frame_offset
    FROM omi_screenshots
    WHERE ts IS NOT NULL
  `).all() as Array<{
    id: string;
    source_key: string;
    ts: string;
    app_name: string;
    window_title: string | null;
    ocr_text: string | null;
    image_path: string | null;
    video_chunk_path: string | null;
    frame_offset: number | null;
  }>;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO knowledge_events (
      id, source_type, source_table, source_row_id, source_key,
      session_ref, conversation_ref, event_type,
      started_at, ended_at, content_text, title,
      participants_json, metadata_json, quality_score, dedupe_key,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  let count = 0;

  for (const row of rows) {
    const titleStr = [row.app_name, row.window_title].filter(Boolean).join(' - ');
    const metadata = {
      image_path: row.image_path,
      video_chunk_path: row.video_chunk_path,
      frame_offset: row.frame_offset,
    };

    insert.run(
      genId('ke'),
      'desktop_sync',
      'omi_screenshots',
      row.id,
      row.source_key,
      null,
      null,
      'screenshot',
      row.ts,
      null,
      row.ocr_text,
      titleStr || null,
      null,
      JSON.stringify(metadata),
      null,
      `screenshot:${row.id}`,
      now,
      now,
    );
    count++;
  }
  return count;
}

// ─── 4. omi_observations → observation ───

function importObservations(): number {
  const rows = db.prepare(`
    SELECT
      id, source_key, source_screenshot_id,
      app_name, context_summary, current_activity,
      has_task, task_title, created_at AS obs_created_at
    FROM omi_observations
  `).all() as Array<{
    id: string;
    source_key: string;
    source_screenshot_id: number | null;
    app_name: string;
    context_summary: string | null;
    current_activity: string | null;
    has_task: number;
    task_title: string | null;
    obs_created_at: string;
  }>;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO knowledge_events (
      id, source_type, source_table, source_row_id, source_key,
      session_ref, conversation_ref, event_type,
      started_at, ended_at, content_text, title,
      participants_json, metadata_json, quality_score, dedupe_key,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  let count = 0;

  // observation 自身没有精确时间戳，尝试从关联 screenshot 取 ts
  const screenshotTsLookup = new Map<number, string>();
  if (rows.some(r => r.source_screenshot_id != null)) {
    const ssRows = db.prepare(`
      SELECT source_screenshot_id, ts FROM omi_screenshots
    `).all() as Array<{ source_screenshot_id: number; ts: string }>;
    for (const ss of ssRows) {
      screenshotTsLookup.set(ss.source_screenshot_id, ss.ts);
    }
  }

  for (const row of rows) {
    const startedAt = (row.source_screenshot_id != null
      ? screenshotTsLookup.get(row.source_screenshot_id)
      : null) || row.obs_created_at;

    const contentParts = [
      row.context_summary,
      row.current_activity,
      row.task_title ? `[task] ${row.task_title}` : null,
    ].filter(Boolean);

    const metadata = {
      app_name: row.app_name,
      has_task: row.has_task === 1,
      source_screenshot_id: row.source_screenshot_id,
    };

    insert.run(
      genId('ke'),
      'desktop_sync',
      'omi_observations',
      row.id,
      row.source_key,
      null,
      null,
      'observation',
      startedAt,
      null,
      contentParts.join('\n') || null,
      row.app_name,
      null,
      JSON.stringify(metadata),
      null,
      `observation:${row.id}`,
      now,
      now,
    );
    count++;
  }
  return count;
}

// ─── CLI 入口 ───

function parseArgs(): { mode: 'full' | 'date'; date?: string } {
  const dateArg = process.argv.find(a => a.startsWith('--date='));
  if (dateArg) {
    return { mode: 'date', date: dateArg.split('=')[1] };
  }
  return { mode: 'full' };
}

function main(): void {
  initDb();

  const args = parseArgs();

  if (args.mode === 'date' && args.date) {
    console.log(`[rebuild] date-scoped rebuild for ${args.date}`);
    const startOfDay = `${args.date}T00:00:00.000Z`;
    const endOfDay = `${args.date}T23:59:59.999Z`;
    db.prepare(`
      DELETE FROM knowledge_events WHERE started_at >= ? AND started_at <= ?
    `).run(startOfDay, endOfDay);
  } else {
    console.log('[rebuild] full rebuild — clearing knowledge_events');
    db.exec('DELETE FROM knowledge_events');
  }

  const tx = db.transaction(() => {
    const c1 = importSpeechSegments();
    console.log(`[rebuild] speech_segment: ${c1} events`);

    const c2 = importDesktopTranscripts();
    console.log(`[rebuild] desktop_transcript: ${c2} events`);

    const c3 = importScreenshots();
    console.log(`[rebuild] screenshot: ${c3} events`);

    const c4 = importObservations();
    console.log(`[rebuild] observation: ${c4} events`);

    console.log(`[rebuild] total: ${c1 + c2 + c3 + c4} events`);
  });
  tx();

  const stats = db.prepare(`
    SELECT event_type, COUNT(*) AS cnt
    FROM knowledge_events
    GROUP BY event_type
    ORDER BY cnt DESC
  `).all() as Array<{ event_type: string; cnt: number }>;

  console.log('\n[rebuild] final stats:');
  for (const s of stats) {
    console.log(`  ${s.event_type}: ${s.cnt}`);
  }

  const total = (db.prepare('SELECT COUNT(*) AS total FROM knowledge_events').get() as CountResult).total;
  console.log(`  TOTAL: ${total}`);
}

main();
