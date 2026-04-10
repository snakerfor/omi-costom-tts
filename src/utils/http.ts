import { IncomingMessage, ServerResponse } from 'http';

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const bodyRaw = Buffer.concat(chunks).toString('utf8').trim();
  return JSON.parse(bodyRaw || '{}') as T;
}

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function sendText(res: ServerResponse, statusCode: number, payload: string, contentType: string): void {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(payload);
}

export function parseNumber(value: string | null, fallback: number): number {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
