import 'dotenv/config';
import { db, initDb } from '../src/db';

interface Args {
  apply: boolean;
  dim: number;
  before: string | null;
  limit: number | null;
}

interface TargetRow {
  id: string;
  speaker_id: string;
  source: string | null;
  created_at: string | null;
  dim: number;
  display_label: string | null;
}

function parseArgs(): Args {
  const dimArg = process.argv.find(arg => arg.startsWith('--dim='));
  const beforeArg = process.argv.find(arg => arg.startsWith('--before='));
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));

  const dim = dimArg ? Number(dimArg.slice('--dim='.length)) : 32;
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : null;

  return {
    apply: process.argv.includes('--apply'),
    dim: Number.isFinite(dim) && dim > 0 ? Math.floor(dim) : 32,
    before: beforeArg ? beforeArg.slice('--before='.length).trim() || null : null,
    limit: limit != null && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null,
  };
}

function ensureArchiveTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS speaker_embeddings_archive (
      archived_id TEXT PRIMARY KEY,
      embedding_id TEXT NOT NULL,
      speaker_id TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      sample_rate INTEGER,
      duration_ms INTEGER,
      source_audio_file_id TEXT,
      source_segment_id TEXT,
      source TEXT,
      created_at TEXT,
      archived_at TEXT NOT NULL,
      archive_reason TEXT NOT NULL
    )
  `);
}

function buildTargetSql(limit: number | null, withBefore: boolean): string {
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const beforeClause = withBefore ? `AND (se.created_at IS NULL OR se.created_at < ?)` : '';
  return `
    SELECT
      se.id,
      se.speaker_id,
      se.source,
      se.created_at,
      json_array_length(se.embedding_json) AS dim,
      s.display_label
    FROM speaker_embeddings se
    JOIN speakers s ON s.id = se.speaker_id
    WHERE s.status = 'anonymous'
      AND json_array_length(se.embedding_json) = ?
      ${beforeClause}
    ORDER BY se.created_at ASC
    ${limitClause}
  `;
}

function genArchiveId(): string {
  return `arch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function main(): Promise<void> {
  initDb();
  const args = parseArgs();
  ensureArchiveTable();

  const sql = buildTargetSql(args.limit, !!args.before);
  const targetRows = (args.before
    ? db.prepare(sql).all(args.dim, args.before)
    : db.prepare(sql).all(args.dim)) as TargetRow[];

  console.log(`[disable-legacy] mode=${args.apply ? 'apply' : 'dry-run'} dim=${args.dim} target=${targetRows.length}`);
  if (!targetRows.length) {
    return;
  }

  const preview = targetRows.slice(0, 20);
  for (const row of preview) {
    console.log(`target|${row.id}|speaker=${row.speaker_id}|label=${row.display_label || ''}|source=${row.source || ''}|created=${row.created_at || ''}|dim=${row.dim}`);
  }
  if (targetRows.length > preview.length) {
    console.log(`... (${targetRows.length - preview.length} more)`);
  }

  if (!args.apply) {
    return;
  }

  const archiveInsert = db.prepare(`
    INSERT INTO speaker_embeddings_archive (
      archived_id, embedding_id, speaker_id, embedding_json, sample_rate, duration_ms,
      source_audio_file_id, source_segment_id, source, created_at, archived_at, archive_reason
    )
    SELECT
      ?, se.id, se.speaker_id, se.embedding_json, se.sample_rate, se.duration_ms,
      se.source_audio_file_id, se.source_segment_id, se.source, se.created_at, ?, ?
    FROM speaker_embeddings se
    WHERE se.id = ?
  `);

  const remove = db.prepare(`DELETE FROM speaker_embeddings WHERE id = ?`);
  const now = new Date().toISOString();
  const reason = `disable_legacy_anonymous_dim_${args.dim}`;

  const tx = db.transaction((rows: TargetRow[]) => {
    for (const row of rows) {
      archiveInsert.run(genArchiveId(), now, reason, row.id);
      remove.run(row.id);
    }
  });
  tx(targetRows);

  console.log(`[disable-legacy] archived+deleted=${targetRows.length}`);
}

main().catch(err => {
  console.error('[disable-legacy] failed:', err);
  process.exit(1);
});

