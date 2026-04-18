import { createHash } from 'crypto';
import { SonioxToken } from '../types';
import { extractEmbeddingWithPython } from './python-embedding';

export interface BuildEmbeddingInput {
  speakerLabel: string | null;
  tokens: SonioxToken[];
  textSample: string;
  audioPaths?: string[];
}

export type EmbeddingProviderKind = 'python' | 'deterministic';

export interface EmbeddingBuildResult {
  embedding: number[];
  provider: EmbeddingProviderKind;
  usableForIdentity: boolean;
}

function buildDeterministicEmbedding(input: BuildEmbeddingInput): number[] {
  const seed = `${input.speakerLabel ?? 'unknown'}|${input.textSample}|${input.tokens.length}`;
  const digest = createHash('sha256').update(seed).digest();

  const dims = 32;
  const out: number[] = [];
  for (let i = 0; i < dims; i++) {
    const byte = digest[i % digest.length];
    out.push((byte / 255) * 2 - 1);
  }

  return out;
}

/**
 * 优先真实 Python embedding。
 * 若显式允许 deterministic fallback，则仅用于本地联调/测试。
 */
export async function buildEmbedding(input: BuildEmbeddingInput): Promise<EmbeddingBuildResult> {
  const allowDeterministic = process.env.ALLOW_DETERMINISTIC_EMBEDDINGS === 'true';

  if (input.audioPaths?.length) {
    try {
      const pyEmbedding = await extractEmbeddingWithPython(input.audioPaths);
      if (pyEmbedding.length) {
        return {
          embedding: pyEmbedding,
          provider: 'python',
          usableForIdentity: true,
        };
      }
    } catch (err) {
      console.warn('[Embedding] python extraction failed:', String((err as Error)?.message ?? err));
    }
  }

  const embedding = buildDeterministicEmbedding(input);
  if (!allowDeterministic) {
    console.warn('[Embedding] deterministic fallback disabled; skipping identity mapping for this sample');
  }

  return {
    embedding,
    provider: 'deterministic',
    usableForIdentity: allowDeterministic,
  };
}
