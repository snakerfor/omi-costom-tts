import Database from 'better-sqlite3';

export const db: any = new Database('app.db');

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
      speaker_label TEXT,
      speaker_id TEXT,
      speaker_name TEXT,
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
  `);
}
