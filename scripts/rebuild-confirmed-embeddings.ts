import 'dotenv/config';
import { db, initDb } from '../src/db';
import { buildEmbedding } from '../src/services/embedding-provider';
import { clipsDir } from '../src/runtime-paths';
import * as fs from 'fs';
import * as path from 'path';

interface Args {
  apply: boolean;
  speakerIds: Set<string>;
}

function parseArgs(): Args {
  const ids = new Set<string>();
  const rawIds = process.argv.find(arg => arg.startsWith('--speaker-ids='));
  if (rawIds) {
    const values = rawIds.slice('--speaker-ids='.length).split(',');
    for (const value of values) {
      const id = value.trim();
      if (id) ids.add(id);
    }
  }

  return {
    apply: process.argv.includes('--apply'),
    speakerIds: ids,
  };
}

function resolveSamplePath(sampleAudioPath: string | null): string | null {
  if (!sampleAudioPath) return null;
  if (fs.existsSync(sampleAudioPath)) return sampleAudioPath;

  const basename = path.basename(sampleAudioPath);
  const fallback = path.join(clipsDir, basename);
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function main(): Promise<void> {
  initDb();
  const args = parseArgs();

  const all = db.prepare(`
    SELECT id, name, display_label, sample_audio_path
    FROM speakers
    WHERE status = 'confirmed'
    ORDER BY COALESCE(updated_at, created_at) DESC
  `).all() as Array<{
    id: string;
    name: string | null;
    display_label: string | null;
    sample_audio_path: string | null;
  }>;

  const rows = args.speakerIds.size
    ? all.filter(row => args.speakerIds.has(row.id))
    : all;

  console.log(`[rebuild-confirmed] mode=${args.apply ? 'apply' : 'dry-run'} target=${rows.length}`);

  const deleteEmbeddings = db.prepare(`DELETE FROM speaker_embeddings WHERE speaker_id = ?`);
  const insertEmbedding = db.prepare(`
    INSERT INTO speaker_embeddings (
      id, speaker_id, embedding_json, sample_rate, duration_ms,
      source_audio_file_id, source_segment_id, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const label = row.name || row.display_label || row.id;
    const samplePath = resolveSamplePath(row.sample_audio_path);
    if (!samplePath) {
      console.log(`skip|${row.id}|${label}|missing_sample`);
      skipped += 1;
      continue;
    }

    const embeddingResult = await buildEmbedding({
      speakerLabel: null,
      tokens: [],
      textSample: label,
      audioPaths: [samplePath],
    });

    if (!embeddingResult.usableForIdentity || !embeddingResult.embedding.length) {
      console.log(`skip|${row.id}|${label}|provider=${embeddingResult.provider}|usable=${embeddingResult.usableForIdentity ? 1 : 0}`);
      skipped += 1;
      continue;
    }

    if (!args.apply) {
      console.log(`plan|${row.id}|${label}|dim=${embeddingResult.embedding.length}|sample=${samplePath}`);
      updated += 1;
      continue;
    }

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      deleteEmbeddings.run(row.id);
      insertEmbedding.run(
        genId('emb'),
        row.id,
        JSON.stringify(embeddingResult.embedding),
        16000,
        null,
        null,
        null,
        're_enrolled_from_sample_audio',
        now,
      );
    });
    tx();
    console.log(`updated|${row.id}|${label}|dim=${embeddingResult.embedding.length}|sample=${samplePath}`);
    updated += 1;
  }

  console.log(`summary|updated=${updated}|skipped=${skipped}|mode=${args.apply ? 'apply' : 'dry-run'}`);
}

main().catch(err => {
  console.error('[rebuild-confirmed] failed:', err);
  process.exit(1);
});

