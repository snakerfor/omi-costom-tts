import { db } from '../db';
import { extractNewMemories } from './knowledge-ingest';
import { isAIAvailable } from './minimax-client';

interface OmiMemoryRow {
  source_key: string;
  source_memory_id: number;
  backend_id: string | null;
  content: string;
  category: string;
  source_app: string | null;
  confidence: number | null;
  created_at_source: string | null;
  updated_at_source: string | null;
  raw_payload_json: string | null;
}

interface KnowledgeMemoryRow {
  id: string;
  canonical_text: string;
  category: string;
  confidence: number | null;
  source_refs_json: string;
  first_observed_at: string | null;
  last_observed_at: string | null;
}

interface LastRunSummary {
  startedAt: string;
  finishedAt: string;
  mode: 'omi_import' | 'ai_supplement';
  sourceRows?: number;
  inserted?: number;
  merged?: number;
  skipped?: number;
  promoted?: number;
  totalActive?: number;
  error?: string;
}

export interface KnowledgeMemoryImportResult {
  sourceRows: number;
  inserted: number;
  merged: number;
  skipped: number;
  totalActive: number;
}

export interface KnowledgeMemoryStatus {
  omiMemoryCount: number;
  knowledgeMemoryCount: number;
  candidateCount: number;
  aiSupplementEnabled: boolean;
  aiAvailableFromEnv: boolean;
  aiJobRunning: boolean;
  lastOmiImport: LastRunSummary | null;
  lastAiSupplement: LastRunSummary | null;
}

let aiSupplementRunning = false;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, ' ').trim();
}

function parseSourceRefs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
  } catch {
    return [];
  }
}

function mergeRefs(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming])];
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function settingKeyAiEnabled(): string {
  return 'ai_memory_supplement_enabled';
}

function settingKeyLastOmiImport(): string {
  return 'knowledge_memory_last_omi_import_json';
}

function settingKeyLastAiSupplement(): string {
  return 'knowledge_memory_last_ai_supplement_json';
}

function getSetting(key: string): string | null {
  const row = db.prepare(`
    SELECT value_text
    FROM knowledge_runtime_settings
    WHERE \`key\` = ?
  `).get(key) as { value_text: string | null } | undefined;
  return row?.value_text ?? null;
}

function setSetting(key: string, value: string | null): void {
  db.prepare(`
    INSERT INTO knowledge_runtime_settings (\`key\`, value_text, updated_at)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      value_text = VALUES(value_text),
      updated_at = VALUES(updated_at)
  `).run(key, value, nowIso());
}

function parseRunSummary(raw: string | null): LastRunSummary | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastRunSummary;
  } catch {
    return null;
  }
}

function buildSourceRefs(row: OmiMemoryRow): string[] {
  const refs = [`omi_memory:${row.source_key}:${row.source_memory_id}`];
  if (row.backend_id) refs.push(`omi_memory_backend:${row.backend_id}`);
  if (row.source_app) refs.push(`omi_memory_source_app:${row.source_app}`);
  if (row.raw_payload_json) {
    try {
      const payload = JSON.parse(row.raw_payload_json) as { conversationId?: string | number; screenshotId?: string | number };
      if (typeof payload.conversationId === 'string' || typeof payload.conversationId === 'number') {
        refs.push(`omi_conversation:${String(payload.conversationId)}`);
      }
      if (typeof payload.screenshotId === 'string' || typeof payload.screenshotId === 'number') {
        refs.push(`omi_screenshot:${String(payload.screenshotId)}`);
      }
    } catch {}
  }
  return refs;
}

function chooseCategory(row: OmiMemoryRow): string {
  const category = (row.category || '').trim();
  return category || 'interesting';
}

function deterministicImportedId(row: OmiMemoryRow): string {
  return `kmomi:${row.source_key}:${row.source_memory_id}`;
}

export function isAiMemorySupplementEnabled(): boolean {
  return getSetting(settingKeyAiEnabled()) === '1';
}

export function setAiMemorySupplementEnabled(enabled: boolean): boolean {
  setSetting(settingKeyAiEnabled(), enabled ? '1' : '0');
  return enabled;
}

export function importOmiMemoriesToKnowledge(options?: { sourceKey?: string }): KnowledgeMemoryImportResult {
  const startedAt = nowIso();
  try {
    const params: unknown[] = [];
    let sql = `
      SELECT
        source_key,
        source_memory_id,
        backend_id,
        content,
        category,
        source_app,
        confidence,
        created_at_source,
        updated_at_source,
        raw_payload_json
      FROM omi_memories
      WHERE content IS NOT NULL AND trim(content) != ''
    `;
    if (options?.sourceKey) {
      sql += ' AND source_key = ?';
      params.push(options.sourceKey);
    }
    sql += ' ORDER BY COALESCE(created_at_source, updated_at_source, created_at) ASC';

    const rows = db.prepare(sql).all(...params) as OmiMemoryRow[];
    const existing = db.prepare(`
      SELECT
        id,
        canonical_text,
        category,
        confidence,
        source_refs_json,
        first_observed_at,
        last_observed_at
      FROM knowledge_memories
      WHERE status = 'active'
    `).all() as KnowledgeMemoryRow[];

    const byNormalized = new Map<string, KnowledgeMemoryRow>();
    const byId = new Map<string, KnowledgeMemoryRow>();
    for (const row of existing) {
      const normalized = normalizeForDedup(row.canonical_text).slice(0, 120);
      if (normalized && !byNormalized.has(normalized)) {
        byNormalized.set(normalized, row);
      }
      byId.set(row.id, row);
    }

    const insertMemory = db.prepare(`
      INSERT INTO knowledge_memories (
        id, canonical_text, category, subject_key, confidence,
        source_refs_json, first_observed_at, last_observed_at,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateMemory = db.prepare(`
      UPDATE knowledge_memories
      SET canonical_text = ?, category = ?, confidence = ?, source_refs_json = ?, first_observed_at = ?, last_observed_at = ?, updated_at = ?
      WHERE id = ?
    `);

    let inserted = 0;
    let merged = 0;
    let skipped = 0;
    const now = nowIso();

    db.transaction(() => {
      for (const row of rows) {
        const canonicalText = row.content.trim();
        if (!canonicalText) {
          skipped++;
          continue;
        }
        const normalized = normalizeForDedup(canonicalText).slice(0, 120);
        if (!normalized) {
          skipped++;
          continue;
        }

        const memoryId = deterministicImportedId(row);
        const category = chooseCategory(row);
        const sourceRefs = buildSourceRefs(row);
        const existingRow = byNormalized.get(normalized) || byId.get(memoryId);
        const observedAt = row.created_at_source ?? row.updated_at_source ?? now;
        const lastObservedAt = row.updated_at_source ?? row.created_at_source ?? observedAt;

        if (existingRow) {
          const previousNormalized = normalizeForDedup(existingRow.canonical_text).slice(0, 120);
          const mergedRefs = mergeRefs(parseSourceRefs(existingRow.source_refs_json), sourceRefs);
          const confidence = existingRow.confidence == null
            ? row.confidence
            : row.confidence == null
              ? existingRow.confidence
              : Math.max(existingRow.confidence, row.confidence);
          const firstObservedAt = minIso(existingRow.first_observed_at, observedAt);
          const latestObservedAt = maxIso(existingRow.last_observed_at, lastObservedAt);
          const nextText = existingRow.id.startsWith('kmomi:') ? canonicalText : existingRow.canonical_text;
          const nextCategory = existingRow.id.startsWith('kmomi:') ? category : existingRow.category;
          updateMemory.run(
            nextText,
            nextCategory,
            confidence,
            JSON.stringify(mergedRefs),
            firstObservedAt,
            latestObservedAt,
            now,
            existingRow.id,
          );
          existingRow.canonical_text = nextText;
          existingRow.category = nextCategory;
          existingRow.confidence = confidence;
          existingRow.source_refs_json = JSON.stringify(mergedRefs);
          existingRow.first_observed_at = firstObservedAt;
          existingRow.last_observed_at = latestObservedAt;
          byId.set(existingRow.id, existingRow);
          if (previousNormalized && previousNormalized !== normalized) {
            byNormalized.delete(previousNormalized);
          }
          byNormalized.set(normalized, existingRow);
          merged++;
          continue;
        }

        insertMemory.run(
          memoryId,
          canonicalText,
          category,
          null,
          row.confidence,
          JSON.stringify(sourceRefs),
          observedAt,
          lastObservedAt,
          'active',
          now,
          now,
        );
        const insertedRow: KnowledgeMemoryRow = {
          id: memoryId,
          canonical_text: canonicalText,
          category,
          confidence: row.confidence,
          source_refs_json: JSON.stringify(sourceRefs),
          first_observed_at: observedAt,
          last_observed_at: lastObservedAt,
        };
        byNormalized.set(normalized, insertedRow);
        byId.set(memoryId, insertedRow);
        inserted++;
      }
    })();

    const totalActive = (db.prepare(`
      SELECT COUNT(*) AS total
      FROM knowledge_memories
      WHERE status = 'active'
    `).get() as { total: number }).total;

    const result: KnowledgeMemoryImportResult = {
      sourceRows: rows.length,
      inserted,
      merged,
      skipped,
      totalActive,
    };
    setSetting(settingKeyLastOmiImport(), JSON.stringify({
      startedAt,
      finishedAt: nowIso(),
      mode: 'omi_import',
      ...result,
    } satisfies LastRunSummary));
    return result;
  } catch (error) {
    setSetting(settingKeyLastOmiImport(), JSON.stringify({
      startedAt,
      finishedAt: nowIso(),
      mode: 'omi_import',
      error: String((error as Error)?.message ?? error),
    } satisfies LastRunSummary));
    throw error;
  }
}

export async function runAiMemorySupplement(options?: { apiKey?: string }): Promise<{ promoted: number; totalActive: number }> {
  if (!isAiMemorySupplementEnabled()) {
    throw new Error('AI memory supplement is disabled');
  }
  if (aiSupplementRunning) {
    throw new Error('AI memory supplement is already running');
  }

  const startedAt = nowIso();
  aiSupplementRunning = true;
  try {
    const promoted = await extractNewMemories({
      requireAI: true,
      apiKey: options?.apiKey?.trim() || undefined,
    });
    const totalActive = (db.prepare(`
      SELECT COUNT(*) AS total
      FROM knowledge_memories
      WHERE status = 'active'
    `).get() as { total: number }).total;
    setSetting(settingKeyLastAiSupplement(), JSON.stringify({
      startedAt,
      finishedAt: nowIso(),
      mode: 'ai_supplement',
      promoted,
      totalActive,
    } satisfies LastRunSummary));
    return { promoted, totalActive };
  } catch (error) {
    setSetting(settingKeyLastAiSupplement(), JSON.stringify({
      startedAt,
      finishedAt: nowIso(),
      mode: 'ai_supplement',
      error: String((error as Error)?.message ?? error),
    } satisfies LastRunSummary));
    throw error;
  } finally {
    aiSupplementRunning = false;
  }
}

export function getKnowledgeMemoryStatus(): KnowledgeMemoryStatus {
  const counts = {
    omiMemoryCount: (db.prepare(`SELECT COUNT(*) AS total FROM omi_memories`).get() as { total: number }).total,
    knowledgeMemoryCount: (db.prepare(`SELECT COUNT(*) AS total FROM knowledge_memories WHERE status = 'active'`).get() as { total: number }).total,
    candidateCount: (db.prepare(`SELECT COUNT(*) AS total FROM knowledge_memory_candidates`).get() as { total: number }).total,
  };
  return {
    ...counts,
    aiSupplementEnabled: isAiMemorySupplementEnabled(),
    aiAvailableFromEnv: isAIAvailable(),
    aiJobRunning: aiSupplementRunning,
    lastOmiImport: parseRunSummary(getSetting(settingKeyLastOmiImport())),
    lastAiSupplement: parseRunSummary(getSetting(settingKeyLastAiSupplement())),
  };
}
