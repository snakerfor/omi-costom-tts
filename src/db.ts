import Database from 'better-sqlite3';

const dbPath = process.env.DB_PATH ?? 'app.db';

export const db: any = new Database(dbPath);

function hasColumn(tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some(row => row.name === columnName);
}

function addColumnIfMissing(tableName: string, columnName: string, definition: string): void {
  if (!hasColumn(tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function recoverDanglingRecordingConversations(): void {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE conversations
    SET status = 'failed',
        ended_at = COALESCE(ended_at, ?),
        updated_at = ?,
        error_message = COALESCE(error_message, 'recovered_after_server_restart')
    WHERE status = 'recording'
  `).run(now, now) as { changes?: number };

  if ((result?.changes ?? 0) > 0) {
    console.log(`[DB] recovered dangling recording conversations: ${result.changes}`);
  }
}

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      uid TEXT,
      language TEXT,
      status TEXT NOT NULL,
      websocket_connected_at TEXT,
      first_audio_frame_at TEXT,
      ended_at TEXT,
      raw_result_path TEXT,
      audio_file_path TEXT,
      vad_mode TEXT,
      vad_total_audio_ms INTEGER,
      vad_detected_speech_ms INTEGER,
      vad_detected_silence_ms INTEGER,
      vad_sent_audio_ms INTEGER,
      vad_suppressed_audio_ms INTEGER,
      vad_state_transitions INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audio_files (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      duration_ms INTEGER,
      sample_rate INTEGER,
      channels INTEGER,
      bits_per_sample INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_segments (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      audio_file_id TEXT,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      absolute_start_time TEXT,
      absolute_end_time TEXT,
      original_speaker_label TEXT,
      speaker_label TEXT,
      speaker_id TEXT,
      speaker_name TEXT,
      speaker_identity TEXT,
      text TEXT NOT NULL,
      confidence REAL,
      resolution_method TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS speakers (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL,
      display_label TEXT,
      identity_label TEXT,
      identity_status TEXT,
      notes TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      sample_text TEXT,
      sample_segment_id TEXT,
      sample_audio_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS speaker_embeddings (
      id TEXT PRIMARY KEY,
      speaker_id TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      sample_rate INTEGER,
      duration_ms INTEGER,
      source_audio_file_id TEXT,
      source_segment_id TEXT,
      source TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS omi_sync_sources (
      source_key TEXT PRIMARY KEY,
      display_name TEXT,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS omi_sync_checkpoints (
      source_key TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      last_received_id INTEGER NOT NULL DEFAULT 0,
      last_received_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_key, entity_name)
    );

    CREATE TABLE IF NOT EXISTS omi_video_chunks (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      video_chunk_path TEXT NOT NULL,
      sha256 TEXT,
      size_bytes INTEGER,
      storage_path TEXT NOT NULL,
      upload_status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_uploaded_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS omi_screenshots (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      source_screenshot_id INTEGER NOT NULL,
      ts TEXT NOT NULL,
      app_name TEXT NOT NULL,
      window_title TEXT,
      image_path TEXT,
      ocr_text TEXT,
      focus_status TEXT,
      video_chunk_path TEXT,
      frame_offset INTEGER,
      raw_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS omi_transcription_sessions (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      source_session_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      source TEXT NOT NULL,
      language TEXT,
      status TEXT,
      title TEXT,
      overview TEXT,
      raw_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS omi_transcription_segments (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      source_segment_id INTEGER NOT NULL,
      source_session_id INTEGER NOT NULL,
      speaker INTEGER,
      speaker_label TEXT,
      text TEXT NOT NULL,
      start_time REAL,
      end_time REAL,
      segment_order INTEGER,
      raw_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS omi_observations (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      source_observation_id INTEGER NOT NULL,
      source_screenshot_id INTEGER,
      app_name TEXT NOT NULL,
      context_summary TEXT,
      current_activity TEXT,
      has_task INTEGER NOT NULL DEFAULT 0,
      task_title TEXT,
      raw_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS omi_memories (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      source_memory_id INTEGER NOT NULL,
      backend_id TEXT,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      source_app TEXT,
      confidence REAL,
      created_at_source TEXT,
      updated_at_source TEXT,
      raw_payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS omi_import_runs (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      metadata_summary_json TEXT,
      notes TEXT
    );
  `);

  addColumnIfMissing('speakers', 'identity_label', 'TEXT');
  addColumnIfMissing('speakers', 'identity_status', `TEXT NOT NULL DEFAULT 'unconfirmed'`);
  addColumnIfMissing('speakers', 'notes', 'TEXT');
  addColumnIfMissing('speakers', 'first_seen_at', 'TEXT');
  addColumnIfMissing('speakers', 'last_seen_at', 'TEXT');
  addColumnIfMissing('conversation_segments', 'speaker_identity', 'TEXT');
  addColumnIfMissing('conversation_segments', 'original_speaker_label', 'TEXT');
  addColumnIfMissing('conversations', 'vad_mode', 'TEXT');
  addColumnIfMissing('conversations', 'vad_total_audio_ms', 'INTEGER');
  addColumnIfMissing('conversations', 'vad_detected_speech_ms', 'INTEGER');
  addColumnIfMissing('conversations', 'vad_detected_silence_ms', 'INTEGER');
  addColumnIfMissing('conversations', 'vad_sent_audio_ms', 'INTEGER');
  addColumnIfMissing('conversations', 'vad_suppressed_audio_ms', 'INTEGER');
  addColumnIfMissing('conversations', 'vad_state_transitions', 'INTEGER');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_speakers_status ON speakers(status);
    CREATE INDEX IF NOT EXISTS idx_speakers_name ON speakers(name);
    CREATE INDEX IF NOT EXISTS idx_speakers_last_seen_at ON speakers(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_first_audio_frame_at ON conversations(first_audio_frame_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_segments_conversation_id ON conversation_segments(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_segments_speaker_id ON conversation_segments(speaker_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_segments_absolute_start_time ON conversation_segments(absolute_start_time);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_omi_video_chunks_unique ON omi_video_chunks(source_key, video_chunk_path);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_omi_screenshots_unique ON omi_screenshots(source_key, source_screenshot_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_omi_transcription_sessions_unique ON omi_transcription_sessions(source_key, source_session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_omi_transcription_segments_unique ON omi_transcription_segments(source_key, source_segment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_omi_observations_unique ON omi_observations(source_key, source_observation_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_omi_memories_unique ON omi_memories(source_key, source_memory_id);
    CREATE INDEX IF NOT EXISTS idx_omi_screenshots_ts ON omi_screenshots(ts);
    CREATE INDEX IF NOT EXISTS idx_omi_screenshots_video_chunk_path ON omi_screenshots(video_chunk_path);
    CREATE INDEX IF NOT EXISTS idx_omi_transcription_segments_session_id ON omi_transcription_segments(source_session_id);
    CREATE INDEX IF NOT EXISTS idx_omi_memories_backend_id ON omi_memories(backend_id);
  `);

  recoverDanglingRecordingConversations();
}
