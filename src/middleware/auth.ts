import { IncomingMessage } from 'http';

function getValidTokens(): Set<string> {
  return new Set(
    (process.env.ACCESS_TOKENS ?? '').split(',').map(t => t.trim()).filter(Boolean)
  );
}

function maskToken(token: string): string {
  if (token.length <= 6) {
    return `${token.slice(0, 2)}***`;
  }
  return `${token.slice(0, 3)}***${token.slice(-2)}`;
}

export function validateConnection(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '', 'ws://localhost');
  const token = url.searchParams.get('api_key');

  if (!token) {
    console.log('[Auth] No api_key in query string');
    return false;
  }

  const validTokens = getValidTokens();
  if (!validTokens.has(token)) {
    console.log('[Auth] Invalid token:', maskToken(token), 'Configured token count:', validTokens.size);
    return false;
  }

  console.log('[Auth] Token validated successfully');
  return true;
}
