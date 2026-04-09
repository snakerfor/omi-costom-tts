import { createHash } from 'crypto';
import { SonioxToken } from '../types';
import { extractEmbeddingWithPython } from './python-embedding';

export interface BuildEmbeddingInput {
  speakerLabel: string | null;
  tokens: SonioxToken[];
  textSample: string;
  audioPaths?: string[];
}

/**
 * 优先真实 Python embedding，失败时回退占位 embedding。
 */
export async function buildEmbedding(input: BuildEmbeddingInput): Promise<number[]> {
  if (input.audioPaths?.length) {
    try {
      const pyEmbedding = await extractEmbeddingWithPython(input.audioPaths);
      if (pyEmbedding.length) {
        return pyEmbedding;
      }
    } catch (err) {
      console.warn('[Embedding] python fallback to deterministic:', String((err as Error)?.message ?? err));
    }
  }

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
