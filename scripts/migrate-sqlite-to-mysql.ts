import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';

type TableMap = {
  source: string;
  target: string;
};

type SqliteColumn = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

const SQLITE_DB_PATH = path.resolve(process.env.SQLITE_DB_PATH || process.env.DB_PATH || path.join(process.cwd(), 'app.db'));
const MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'omi_custom_tts';
const MYSQL_SOCKET_PATH = process.env.MYSQL_SOCKET_PATH || '/var/lib/mysql/mysql.sock';

const TABLES: TableMap[] = [
  { source: 'conversations', target: 'conversations' },
  { source: 'audio_files', target: 'audio_files' },
  { source: 'conversation_segments', target: 'conversation_segments' },
  { source: 'speakers', target: 'speakers' },
  { source: 'speaker_embeddings', target: 'speaker_embeddings' },
  { source: 'speaker_candidates', target: 'speaker_candidates' },
  { source: 'speaker_candidate_segments', target: 'speaker_candidate_segments' },
  { source: 'speaker_candidate_clips', target: 'speaker_candidate_clips' },
  { source: 'omi_sync_sources', target: 'omi_sync_sources' },
  { source: 'omi_sync_checkpoints', target: 'omi_sync_checkpoints' },
  { source: 'omi_video_chunks', target: 'omi_video_chunks' },
  { source: 'omi_screenshots', target: 'omi_screenshots' },
  { source: 'omi_transcription_sessions', target: 'omi_transcription_sessions' },
  { source: 'omi_transcription_segments', target: 'omi_transcription_segments' },
  { source: 'omi_observations', target: 'omi_observations' },
  { source: 'omi_memories', target: 'omi_memories' },
  { source: 'omi_import_runs', target: 'omi_import_runs' },
  { source: 'knowledge_conversations', target: 'knowledge_conversations' },
  { source: 'knowledge_conversation_items', target: 'knowledge_conversation_items' },
  { source: 'knowledge_memory_candidates', target: 'knowledge_memory_candidates' },
  { source: 'knowledge_memories', target: 'knowledge_memories' },
  { source: 'knowledge_runtime_settings', target: 'knowledge_runtime_settings' },
  { source: 'knowledge_events', target: 'knowledge_events' },
  { source: 'oauth_clients', target: 'oauth_clients' },
  { source: 'oauth_authorization_codes', target: 'oauth_authorization_codes' },
  { source: 'oauth_tokens', target: 'oauth_tokens' },
  { source: 'speaker_voiceprint_features', target: 'speaker_voiceprint_features' },
  { source: 'speaker_voiceprint_materials', target: 'speaker_voiceprint_materials' },
  { source: 'segment_voiceprint_matches', target: 'segment_voiceprint_matches' },
  { source: 'speaker_enrollment_batches', target: 'speaker_enrollment_batches' },
  { source: 'speaker_enrollment_segments', target: 'speaker_enrollment_segments' },
];

function quoteId(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``;
}

function normalizeType(rawType: string): string {
  const t = rawType.trim().toUpperCase();
  if (!t) return 'LONGTEXT';
  if (t.includes('INT')) return 'BIGINT';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'DOUBLE';
  if (t.includes('BLOB')) return 'LONGBLOB';
  if (t.includes('JSON')) return 'JSON';
  return 'LONGTEXT';
}

function buildCreateTableSql(columns: SqliteColumn[]): string {
  const defs = columns.map((col) => {
    const mysqlType = col.pk > 0 ? 'VARCHAR(255)' : normalizeType(col.type);
    const nullable = col.pk > 0 || col.notnull ? 'NOT NULL' : 'NULL';
    const autoIncrement = col.pk === 1 && mysqlType === 'BIGINT' ? ' AUTO_INCREMENT' : '';
    return `${quoteId(col.name)} ${mysqlType}${autoIncrement} ${nullable}`;
  });

  const pkCols = columns.filter(col => col.pk > 0).sort((a, b) => a.pk - b.pk).map(col => quoteId(col.name));
  if (pkCols.length) {
    defs.push(`PRIMARY KEY (${pkCols.join(', ')})`);
  }

  return `CREATE TABLE IF NOT EXISTS ${quoteId('placeholder')} (${defs.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
}

function createCreateTableSql(table: string, columns: SqliteColumn[]): string {
  return buildCreateTableSql(columns).replace(quoteId('placeholder'), quoteId(table));
}

function buildInsertSql(table: string, columns: SqliteColumn[]): string {
  const colNames = columns.map(col => quoteId(col.name)).join(', ');
  return `INSERT INTO ${quoteId(table)} (${colNames}) VALUES ?`;
}

function convertValue(value: any): any {
  if (value === undefined) return null;
  return value;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function getTables(sqliteDb: Database.Database): string[] {
  const rows = sqliteDb.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all() as Array<{ name: string }>;
  return rows.map(row => row.name);
}

function getColumns(sqliteDb: Database.Database, table: string): SqliteColumn[] {
  return sqliteDb.prepare(`PRAGMA table_info(${quoteId(table)})`).all() as SqliteColumn[];
}

async function main(): Promise<void> {
  if (!fs.existsSync(SQLITE_DB_PATH)) {
    throw new Error(`SQLite db not found: ${SQLITE_DB_PATH}`);
  }

  const sqliteDb = new Database(SQLITE_DB_PATH, { readonly: true });
  const mysqlConn = await mysql.createConnection({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    socketPath: MYSQL_SOCKET_PATH,
    multipleStatements: false,
  });

  await mysqlConn.execute(`CREATE DATABASE IF NOT EXISTS ${quoteId(MYSQL_DATABASE)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await mysqlConn.changeUser({ database: MYSQL_DATABASE });
  await mysqlConn.execute(`SET foreign_key_checks = 0`);

  console.log(`[migrate] sqlite=${SQLITE_DB_PATH}`);
  console.log(`[migrate] mysql=${MYSQL_USER}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}`);

  const existingTables = new Set(getTables(sqliteDb));

  for (const table of TABLES) {
    if (!existingTables.has(table.source)) {
      console.log(`[skip] ${table.source} missing in sqlite`);
      continue;
    }

    const columns = getColumns(sqliteDb, table.source);
    if (!columns.length) {
      console.log(`[skip] ${table.source} has no columns`);
      continue;
    }

    await mysqlConn.execute(`DROP TABLE IF EXISTS ${quoteId(table.target)}`);
    await mysqlConn.execute(createCreateTableSql(table.target, columns));

    const rows = sqliteDb.prepare(
      `SELECT ${columns.map(col => quoteId(col.name)).join(', ')} FROM ${quoteId(table.source)}`
    ).all() as Record<string, any>[];

    const insertSql = buildInsertSql(table.target, columns);
    let imported = 0;
    for (const chunk of chunkArray(rows, 500)) {
      const values = chunk.map(row => columns.map(col => convertValue(row[col.name])));
      await mysqlConn.query(insertSql, [values]);
      imported += chunk.length;
    }

    console.log(`[ok] ${table.source} -> ${table.target}: ${imported} rows`);
  }

  await mysqlConn.execute(`SET foreign_key_checks = 1`);
  await mysqlConn.end();
  sqliteDb.close();
  console.log('[migrate] done');
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
