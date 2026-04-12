import * as fs from 'fs';
import * as path from 'path';

const MINIMAX_BASE_URL = 'https://api.minimaxi.com/anthropic/v1/messages';
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M2.7-highspeed';

function loadApiKeyFromOpenClaw(): string | null {
  try {
    const authPath = path.join(
      process.env.HOME || '/Users/snaker',
      '.openclaw/agents/main/agent/auth-profiles.json',
    );
    const raw = fs.readFileSync(authPath, 'utf-8');
    const data = JSON.parse(raw);
    const profile = data?.profiles?.['minimax-cn:default'];
    if (profile?.key) return profile.key;
  } catch {}
  return null;
}

function getApiKey(): string {
  const key = process.env.MINIMAX_API_KEY || loadApiKeyFromOpenClaw();
  if (!key) {
    throw new Error(
      'MiniMax API key not found. Set MINIMAX_API_KEY or install OpenClaw with MiniMax configured.',
    );
  }
  return key;
}

export function isAIAvailable(): boolean {
  try {
    getApiKey();
    return true;
  } catch {
    return false;
  }
}

export async function chatCompletion(prompt: string, options?: {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}): Promise<string> {
  const apiKey = getApiKey();
  const maxTokens = options?.maxTokens ?? 2048;
  const temperature = options?.temperature ?? 0.3;

  const messages: Array<{ role: string; content: string }> = [];
  if (options?.systemPrompt) {
    messages.push({ role: 'user', content: `[system instruction]\n${options.systemPrompt}\n[end system instruction]\n\n${prompt}` });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let resp: Response;
  try {
    resp = await fetch(MINIMAX_BASE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        max_tokens: maxTokens,
        messages,
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`MiniMax API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json() as any;

  const contentBlocks = data?.content;
  if (!Array.isArray(contentBlocks) || !contentBlocks.length) {
    throw new Error(`MiniMax returned empty content: ${JSON.stringify(data)}`);
  }

  const textBlock = contentBlocks.find((b: any) => b.type === 'text');
  const text = textBlock?.text || contentBlocks[0]?.text;
  if (!text) {
    throw new Error(`MiniMax returned no text block: ${JSON.stringify(data)}`);
  }
  return text;
}

export function parseJSON<T = any>(text: string): T {
  const cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
  return JSON.parse(cleaned);
}
