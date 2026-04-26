import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const LEGACY_UNRESOLVED_METHODS = [
  'soniox_finalized',
  'candidate_pending',
  'deferred_unresolved',
  'label_fallback',
  'neighbor_bridge',
  'neighbor_prev',
  'neighbor_next',
  'pending',
] as const;

const LEGACY_MANUAL_METHODS = [
  'manual_confirm',
  'manual_identity_confirm',
] as const;

function resolveDbPath(): string {
  const explicitArg = process.argv.find(arg => arg.startsWith('--db='));
  if (explicitArg) {
    return path.resolve(explicitArg.slice('--db='.length));
  }
  if (process.env.DB_PATH) {
    return path.resolve(process.env.DB_PATH);
  }
  return path.resolve(process.cwd(), 'app.db');
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function placeholders(values: readonly string[]): string {
  return values.map(() => '?').join(', ');
}

function readSummary(db: Database.Database) {
  const legacyResolution = db.prepare(`
    SELECT COALESCE(resolution_method, '<null>') AS method, COUNT(*) AS count
    FROM conversation_segments
    WHERE resolution_method IN (${placeholders(LEGACY_UNRESOLVED_METHODS)})
       OR resolution_method IN (${placeholders(LEGACY_MANUAL_METHODS)})
    GROUP BY resolution_method
    ORDER BY count DESC, method ASC
  `).all(...LEGACY_UNRESOLVED_METHODS, ...LEGACY_MANUAL_METHODS) as Array<{ method: string; count: number }>;

  const legacyBreakdown = db.prepare(`
    SELECT
      resolution_method AS method,
      SUM(CASE WHEN speaker_id IS NOT NULL THEN 1 ELSE 0 END) AS with_speaker,
      SUM(CASE WHEN speaker_id IS NULL THEN 1 ELSE 0 END) AS without_speaker
    FROM conversation_segments
    WHERE resolution_method IN (${placeholders(LEGACY_UNRESOLVED_METHODS)})
       OR resolution_method IN (${placeholders(LEGACY_MANUAL_METHODS)})
    GROUP BY resolution_method
    ORDER BY (with_speaker + without_speaker) DESC, method ASC
  `).all(...LEGACY_UNRESOLVED_METHODS, ...LEGACY_MANUAL_METHODS) as Array<{
    method: string;
    with_speaker: number;
    without_speaker: number;
  }>;

  const candidateCounts = db.prepare(`
    SELECT 'speaker_candidates' AS name, COUNT(*) AS count FROM speaker_candidates
    UNION ALL
    SELECT 'speaker_candidate_segments' AS name, COUNT(*) AS count FROM speaker_candidate_segments
    UNION ALL
    SELECT 'speaker_candidate_clips' AS name, COUNT(*) AS count FROM speaker_candidate_clips
  `).all() as Array<{ name: string; count: number }>;

  return { legacyResolution, legacyBreakdown, candidateCounts };
}

function printSummary(title: string, summary: ReturnType<typeof readSummary>): void {
  console.log(`\n[${title}] legacy resolution methods`);
  if (!summary.legacyResolution.length) {
    console.log('  none');
  } else {
    for (const row of summary.legacyResolution) {
      console.log(`  ${row.method}: ${row.count}`);
    }
  }

  console.log(`\n[${title}] legacy method speaker binding`);
  if (!summary.legacyBreakdown.length) {
    console.log('  none');
  } else {
    for (const row of summary.legacyBreakdown) {
      console.log(`  ${row.method}: with_speaker=${row.with_speaker}, without_speaker=${row.without_speaker}`);
    }
  }

  console.log(`\n[${title}] legacy candidate tables`);
  for (const row of summary.candidateCounts) {
    console.log(`  ${row.name}: ${row.count}`);
  }
}

function main(): void {
  const dbPath = resolveDbPath();
  const apply = hasFlag('--apply');
  const purgeCandidates = hasFlag('--purge-candidates');
  const db = new Database(dbPath);

  console.log(`DB_PATH=${dbPath}`);
  console.log(`mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(`purge_candidates=${purgeCandidates ? 'true' : 'false'}`);

  const before = readSummary(db);
  printSummary('before', before);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write changes.');
    db.close();
    return;
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const normalizedManual = db.prepare(`
      UPDATE conversation_segments
      SET resolution_method = 'human_segment_confirmed', updated_at = ?
      WHERE resolution_method IN (${placeholders(LEGACY_MANUAL_METHODS)})
        AND speaker_id IS NOT NULL
    `).run(now, ...LEGACY_MANUAL_METHODS);

    const clearedLegacyUnresolved = db.prepare(`
      UPDATE conversation_segments
      SET resolution_method = NULL, confidence = NULL, updated_at = ?
      WHERE resolution_method IN (${placeholders(LEGACY_UNRESOLVED_METHODS)})
        AND speaker_id IS NULL
    `).run(now, ...LEGACY_UNRESOLVED_METHODS);

    let deletedCandidates = 0;
    let deletedCandidateSegments = 0;
    let deletedCandidateClips = 0;

    if (purgeCandidates) {
      deletedCandidateClips = db.prepare(`DELETE FROM speaker_candidate_clips`).run().changes;
      deletedCandidateSegments = db.prepare(`DELETE FROM speaker_candidate_segments`).run().changes;
      deletedCandidates = db.prepare(`DELETE FROM speaker_candidates`).run().changes;
    }

    return {
      normalizedManual: normalizedManual.changes,
      clearedLegacyUnresolved: clearedLegacyUnresolved.changes,
      deletedCandidates,
      deletedCandidateSegments,
      deletedCandidateClips,
    };
  });

  const result = tx();
  console.log('\n[apply] changed rows');
  console.log(`  normalized_manual: ${result.normalizedManual}`);
  console.log(`  cleared_legacy_unresolved: ${result.clearedLegacyUnresolved}`);
  console.log(`  deleted_speaker_candidates: ${result.deletedCandidates}`);
  console.log(`  deleted_speaker_candidate_segments: ${result.deletedCandidateSegments}`);
  console.log(`  deleted_speaker_candidate_clips: ${result.deletedCandidateClips}`);

  const after = readSummary(db);
  printSummary('after', after);
  db.close();
}

main();
