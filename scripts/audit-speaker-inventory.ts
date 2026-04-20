import 'dotenv/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { db, initDb } from '../src/db';
import { clipsDir, dataRoot } from '../src/runtime-paths';

interface Args {
  from: string | null;
  output: string | null;
  sampleLimit: number;
}

interface CountRow {
  key: string;
  cnt: number;
}

function parseArgs(): Args {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token?.startsWith('--')) continue;
    const next = process.argv[i + 1];
    const value = next && !next.startsWith('--') ? next : 'true';
    args.set(token.slice(2), value);
  }

  const sampleLimit = Number(args.get('sample-limit') || '20');
  return {
    from: args.get('from') || null,
    output: args.get('output') || null,
    sampleLimit: Number.isFinite(sampleLimit) && sampleLimit > 0 ? Math.floor(sampleLimit) : 20,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveAlternateClipPath(sampleAudioPath: string | null): string | null {
  if (!sampleAudioPath) return null;
  const basename = path.basename(sampleAudioPath);
  if (!basename) return null;
  return path.join(clipsDir, basename);
}

async function exists(filePath: string | null): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  initDb();
  const args = parseArgs();

  const speakerStatusRows = db.prepare(`
    SELECT status AS key, COUNT(*) AS cnt
    FROM speakers
    GROUP BY status
    ORDER BY cnt DESC
  `).all() as CountRow[];

  const embeddingDimsRows = db.prepare(`
    SELECT
      CAST(json_array_length(se.embedding_json) AS TEXT) AS key,
      COUNT(*) AS cnt
    FROM speaker_embeddings se
    GROUP BY json_array_length(se.embedding_json)
    ORDER BY cnt DESC
  `).all() as CountRow[];

  const embeddingSourceRows = db.prepare(`
    SELECT COALESCE(source, 'null') AS key, COUNT(*) AS cnt
    FROM speaker_embeddings
    GROUP BY source
    ORDER BY cnt DESC
  `).all() as CountRow[];

  const anonymousEmbeddingRows = db.prepare(`
    SELECT
      CAST(json_array_length(se.embedding_json) AS TEXT) AS key,
      COUNT(*) AS cnt
    FROM speaker_embeddings se
    JOIN speakers s ON s.id = se.speaker_id
    WHERE s.status = 'anonymous'
    GROUP BY json_array_length(se.embedding_json)
    ORDER BY cnt DESC
  `).all() as CountRow[];

  const methodRowsSql = args.from
    ? `
      SELECT COALESCE(cs.resolution_method, 'null') AS key, COUNT(*) AS cnt
      FROM conversation_segments cs
      JOIN conversations c ON c.id = cs.conversation_id
      WHERE c.created_at >= ?
      GROUP BY cs.resolution_method
      ORDER BY cnt DESC
    `
    : `
      SELECT COALESCE(cs.resolution_method, 'null') AS key, COUNT(*) AS cnt
      FROM conversation_segments cs
      GROUP BY cs.resolution_method
      ORDER BY cnt DESC
    `;
  const methodRows = (args.from
    ? db.prepare(methodRowsSql).all(args.from)
    : db.prepare(methodRowsSql).all()) as CountRow[];

  const confirmedRows = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.display_label,
      s.identity_label,
      s.sample_audio_path,
      COUNT(se.id) AS embedding_count,
      MIN(json_array_length(se.embedding_json)) AS min_dim,
      MAX(json_array_length(se.embedding_json)) AS max_dim
    FROM speakers s
    LEFT JOIN speaker_embeddings se ON se.speaker_id = s.id
    WHERE s.status = 'confirmed'
    GROUP BY s.id, s.name, s.display_label, s.identity_label, s.sample_audio_path
    ORDER BY COALESCE(s.updated_at, s.created_at) DESC
  `).all() as Array<{
    id: string;
    name: string | null;
    display_label: string | null;
    identity_label: string | null;
    sample_audio_path: string | null;
    embedding_count: number;
    min_dim: number | null;
    max_dim: number | null;
  }>;

  const confirmedWithPathAudit = await Promise.all(
    confirmedRows.map(async row => {
      const alternatePath = resolveAlternateClipPath(row.sample_audio_path);
      const sampleExists = await exists(row.sample_audio_path);
      const alternateExists = await exists(alternatePath);
      return {
        ...row,
        sample_exists: sampleExists,
        alternate_path: alternatePath,
        alternate_exists: alternateExists,
      };
    }),
  );

  const candidateAnonymousRows = db.prepare(`
    SELECT
      s.id,
      s.display_label,
      s.sample_audio_path,
      COUNT(se.id) AS embedding_count,
      MIN(json_array_length(se.embedding_json)) AS min_dim,
      MAX(json_array_length(se.embedding_json)) AS max_dim
    FROM speakers s
    LEFT JOIN speaker_embeddings se ON se.speaker_id = s.id
    WHERE s.status = 'anonymous'
    GROUP BY s.id, s.display_label, s.sample_audio_path
    ORDER BY COALESCE(s.updated_at, s.created_at) DESC
    LIMIT ?
  `).all(args.sampleLimit) as Array<{
    id: string;
    display_label: string | null;
    sample_audio_path: string | null;
    embedding_count: number;
    min_dim: number | null;
    max_dim: number | null;
  }>;

  const report = {
    generatedAt: nowIso(),
    dbPath: process.env.DB_PATH || '(default)',
    from: args.from,
    summary: {
      speakersByStatus: speakerStatusRows,
      embeddingsByDim: embeddingDimsRows,
      embeddingsBySource: embeddingSourceRows,
      anonymousEmbeddingsByDim: anonymousEmbeddingRows,
      segmentResolutionMethods: methodRows,
    },
    confirmedSpeakers: confirmedWithPathAudit,
    anonymousSpeakerSamples: candidateAnonymousRows,
  };

  if (args.output) {
    const outPath = path.resolve(args.output);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[audit] wrote report: ${outPath}`);
  } else {
    const outDir = path.join(dataRoot, 'recovery_audit');
    await fs.mkdir(outDir, { recursive: true });
    const fileName = `speaker-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const outPath = path.join(outDir, fileName);
    await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[audit] wrote report: ${outPath}`);
  }

  console.log('[audit] summary');
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch(err => {
  console.error('[audit] failed:', err);
  process.exit(1);
});

