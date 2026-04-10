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
  `);

  addColumnIfMissing('speakers', 'identity_label', 'TEXT');
  addColumnIfMissing('speakers', 'identity_status', `TEXT NOT NULL DEFAULT 'unconfirmed'`);
  addColumnIfMissing('speakers', 'notes', 'TEXT');
  addColumnIfMissing('speakers', 'first_seen_at', 'TEXT');
  addColumnIfMissing('speakers', 'last_seen_at', 'TEXT');
  addColumnIfMissing('conversation_segments', 'speaker_identity', 'TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_speakers_status ON speakers(status);
    CREATE INDEX IF NOT EXISTS idx_speakers_name ON speakers(name);
    CREATE INDEX IF NOT EXISTS idx_speakers_last_seen_at ON speakers(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_first_audio_frame_at ON conversations(first_audio_frame_at);
    CREATE INDEX IF NOT EXISTS idx_conversation_segments_conversation_id ON conversation_segments(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_segments_speaker_id ON conversation_segments(speaker_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_segments_absolute_start_time ON conversation_segments(absolute_start_time);
  `);
}
