import 'dotenv/config';
import { initDb } from '../src/db';
import { importOmiMemoriesToKnowledge } from '../src/services/knowledge-memory-service';

function main(): void {
  initDb();
  const result = importOmiMemoriesToKnowledge();
  console.log(`[omi-memory-import] source rows: ${result.sourceRows}`);
  console.log(`[omi-memory-import] inserted: ${result.inserted}`);
  console.log(`[omi-memory-import] merged: ${result.merged}`);
  console.log(`[omi-memory-import] skipped: ${result.skipped}`);
  console.log(`[omi-memory-import] active knowledge memories: ${result.totalActive}`);
}

main();
