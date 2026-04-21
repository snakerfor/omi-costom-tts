import { IncomingMessage } from 'http';

function parseTokens(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map(token => token.trim()).filter(Boolean));
}

export function getKnowledgeApiTokens(): Set<string> {
  const dedicated = parseTokens(process.env.KNOWLEDGE_API_TOKENS);
  if (dedicated.size > 0) return dedicated;
  return parseTokens(process.env.ACCESS_TOKENS);
}

function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function extractKnowledgeApiToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const bearer = extractBearerToken(authValue);
  if (bearer) return bearer;

  const xApiTokenHeader = req.headers['x-api-token'];
  const xApiToken = Array.isArray(xApiTokenHeader) ? xApiTokenHeader[0] : xApiTokenHeader;
  if (xApiToken && xApiToken.trim()) return xApiToken.trim();

  const url = new URL(req.url ?? '', 'http://localhost');
  const queryToken = url.searchParams.get('api_key');
  return queryToken && queryToken.trim() ? queryToken.trim() : null;
}

export function isKnowledgeApiAuthorized(req: IncomingMessage): boolean {
  const validTokens = getKnowledgeApiTokens();
  if (validTokens.size === 0) {
    return true;
  }

  const token = extractKnowledgeApiToken(req);
  if (!token) return false;
  return validTokens.has(token);
}
