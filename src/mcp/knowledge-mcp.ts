import { IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { db } from '../db';
import {
  listKnowledgeConversations,
  listKnowledgeTimeline,
  listSpeakerReviewSegments,
} from '../services/knowledge-query-service';
import { readJsonBody, sendJson } from '../utils/http';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');

type McpTransport = any;

const transports = new Map<string, McpTransport>();
const DEFAULT_OAUTH_SCOPE = 'omi.read';
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

function parseTokenList(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map(item => item.trim()).filter(Boolean));
}

function firstConfiguredToken(): string | null {
  return Array.from(validMcpTokens())[0] || null;
}

function validMcpTokens(): Set<string> {
  const mcpTokens = parseTokenList(process.env.MCP_ACCESS_TOKENS || process.env.MCP_ACCESS_TOKEN);
  if (mcpTokens.size) return mcpTokens;
  return parseTokenList(process.env.ACCESS_TOKENS);
}

function getRequestToken(req: IncomingMessage, urlObj: URL): string | null {
  const auth = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const bearer = /^Bearer\s+(.+)$/i.exec(auth || '');
  if (bearer?.[1]) return bearer[1].trim();
  return urlObj.searchParams.get('api_key') || urlObj.searchParams.get('access_token');
}

function safeTokenEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isConfiguredToken(token: string): boolean {
  for (const validToken of validMcpTokens()) {
    if (safeTokenEqual(token, validToken)) return true;
  }
  return false;
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function isoAfter(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function isValidOAuthAccessToken(token: string): boolean {
  const row = db.prepare(`
    SELECT access_token_hash, expires_at, revoked_at
    FROM oauth_tokens
    WHERE access_token_hash = ?
  `).get(tokenHash(token)) as { expires_at?: string; revoked_at?: string | null } | undefined;

  return !!row && !row.revoked_at && new Date(row.expires_at || 0).getTime() > Date.now();
}

function authorizeMcpRequest(req: IncomingMessage, res: ServerResponse, urlObj: URL): boolean {
  if (!validMcpTokens().size && !process.env.MCP_OAUTH_APPROVAL_TOKEN) {
    sendJson(res, 503, {
      ok: false,
      error: 'MCP access is disabled. Set MCP_ACCESS_TOKENS, ACCESS_TOKENS, or MCP_OAUTH_APPROVAL_TOKEN.',
    });
    return false;
  }

  const token = getRequestToken(req, urlObj);
  if (!token || (!isConfiguredToken(token) && !isValidOAuthAccessToken(token))) {
    const metadataUrl = `${publicBaseUrl(req, urlObj)}/.well-known/oauth-protected-resource/mcp`;
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"`,
    });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return false;
  }
  return true;
}

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function makeLike(value: string): string {
  return `%${value.trim()}%`;
}

function mcpDefaultTimeZone(): string {
  return process.env.MCP_DEFAULT_TIMEZONE || process.env.TZ || 'Asia/Shanghai';
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return asUtc - date.getTime();
}

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function addLocalDays(parts: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localDayRangeUtc(parts: { year: number; month: number; day: number }, timeZone: string): { from: string; to: string; label: string } {
  const next = addLocalDays(parts, 1);
  const startApprox = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  const endApprox = new Date(Date.UTC(next.year, next.month - 1, next.day, 12));
  const startOffset = getTimeZoneOffsetMs(startApprox, timeZone);
  const endOffset = getTimeZoneOffsetMs(endApprox, timeZone);
  const startUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day) - startOffset;
  const endUtcMs = Date.UTC(next.year, next.month - 1, next.day) - endOffset - 1;
  const label = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  return {
    from: new Date(startUtcMs).toISOString(),
    to: new Date(endUtcMs).toISOString(),
    label,
  };
}

function detectDateRange(query: string, timeZone: string): { from: string; to: string; label: string; kind: string } | null {
  const nowParts = localDateParts(new Date(), timeZone);
  const normalized = query.trim();

  if (/(今天|今日|today)/i.test(normalized)) {
    return { ...localDayRangeUtc(nowParts, timeZone), kind: 'today' };
  }

  if (/(昨天|昨日|yesterday)/i.test(normalized)) {
    return { ...localDayRangeUtc(addLocalDays(nowParts, -1), timeZone), kind: 'yesterday' };
  }

  const fullDate = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.exec(normalized);
  if (fullDate) {
    return {
      ...localDayRangeUtc({
        year: Number(fullDate[1]),
        month: Number(fullDate[2]),
        day: Number(fullDate[3]),
      }, timeZone),
      kind: 'date',
    };
  }

  const monthDay = /(?:^|[^\d])(\d{1,2})月(\d{1,2})日?/.exec(normalized);
  if (monthDay) {
    return {
      ...localDayRangeUtc({
        year: nowParts.year,
        month: Number(monthDay[1]),
        day: Number(monthDay[2]),
      }, timeZone),
      kind: 'date',
    };
  }

  return null;
}

function stripDateAndGenericTerms(query: string): string {
  return query
    .replace(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/g, ' ')
    .replace(/(?:^|[^\d])\d{1,2}月\d{1,2}日?/g, ' ')
    .replace(/今天|今日|昨天|昨日|today|yesterday/gi, ' ')
    .replace(/我|我的|的|一下|查|查找|看看|看下|记录|活动|事情|相关|今天|昨天/g, ' ')
    .replace(/做了啥|做了什么|干了啥|干了什么|发生了什么|happened|what did i do/gi, ' ')
    .replace(/[，。！？、,.!?()"“”'@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function publicBaseUrl(req: IncomingMessage, urlObj: URL): string {
  if (process.env.MCP_PUBLIC_BASE_URL) {
    return process.env.MCP_PUBLIC_BASE_URL.replace(/\/+$/, '');
  }
  const protoHeader = req.headers['x-forwarded-proto'];
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  return `${proto || urlObj.protocol.replace(':', '')}://${host || urlObj.host}`;
}

function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendRedirect(res: ServerResponse, target: string): void {
  res.writeHead(302, { Location: target });
  res.end();
}

function sendOAuthError(res: ServerResponse, statusCode: number, error: string, description?: string): void {
  sendJson(res, statusCode, {
    error,
    ...(description ? { error_description: description } : {}),
  });
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readRawBody(req));
}

function redirectWithOAuthError(redirectUri: string, state: string | null, error: string, description?: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  if (description) target.searchParams.set('error_description', description);
  if (state) target.searchParams.set('state', state);
  return target.toString();
}

function validateRedirectUri(client: any, redirectUri: string): boolean {
  try {
    const redirectUris = JSON.parse(client.redirect_uris_json || '[]');
    return Array.isArray(redirectUris) && redirectUris.includes(redirectUri);
  } catch {
    return false;
  }
}

function oauthMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [DEFAULT_OAUTH_SCOPE],
  };
}

function protectedResourceMetadata(baseUrl: string, resourcePath: '/mcp' | '/sse') {
  return {
    resource: `${baseUrl}${resourcePath}`,
    authorization_servers: [baseUrl],
    scopes_supported: [DEFAULT_OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'OMI Personal Knowledge MCP',
  };
}

async function handleOAuthRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendOAuthError(res, 405, 'invalid_request', 'registration requires POST');
    return;
  }

  const body = await readJsonBody<any>(req);
  if (!Array.isArray(body.redirect_uris) || !body.redirect_uris.length) {
    sendOAuthError(res, 400, 'invalid_client_metadata', 'redirect_uris is required');
    return;
  }

  for (const uri of body.redirect_uris) {
    try {
      const parsed = new URL(String(uri));
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('bad protocol');
    } catch {
      sendOAuthError(res, 400, 'invalid_client_metadata', 'redirect_uris must contain valid URLs');
      return;
    }
  }

  const now = isoNow();
  const clientId = `client_${randomBytes(18).toString('base64url')}`;
  const metadata = {
    ...body,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: body.scope || DEFAULT_OAUTH_SCOPE,
  };

  db.prepare(`
    INSERT INTO oauth_clients (
      client_id, client_secret, redirect_uris_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    clientId,
    null,
    JSON.stringify(body.redirect_uris),
    JSON.stringify(metadata),
    now,
    now,
  );

  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...metadata,
  });
}

function authorizationParamsFromUrl(urlObj: URL): Record<string, string> {
  return {
    response_type: urlObj.searchParams.get('response_type') || '',
    client_id: urlObj.searchParams.get('client_id') || '',
    redirect_uri: urlObj.searchParams.get('redirect_uri') || '',
    scope: urlObj.searchParams.get('scope') || DEFAULT_OAUTH_SCOPE,
    state: urlObj.searchParams.get('state') || '',
    code_challenge: urlObj.searchParams.get('code_challenge') || '',
    code_challenge_method: urlObj.searchParams.get('code_challenge_method') || '',
    resource: urlObj.searchParams.get('resource') || '',
  };
}

function renderAuthorizeForm(params: Record<string, string>, message = ''): string {
  const hidden = Object.entries(params)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${String(value).replace(/"/g, '&quot;')}">`)
    .join('\n');
  const escapedMessage = message ? `<p class="error">${message}</p>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize OMI MCP</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f7f8; color: #111; }
    main { max-width: 520px; margin: 12vh auto; padding: 28px; background: #fff; border: 1px solid #d8dde3; border-radius: 8px; }
    h1 { font-size: 22px; margin: 0 0 12px; }
    p { line-height: 1.5; color: #444; }
    label { display: block; font-weight: 600; margin: 20px 0 8px; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 11px 12px; border: 1px solid #c6ccd3; border-radius: 6px; font-size: 15px; }
    button { margin-top: 18px; width: 100%; padding: 11px 12px; border: 0; border-radius: 6px; background: #111; color: #fff; font-size: 15px; }
    .error { color: #b42318; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize OMI Personal Knowledge</h1>
    <p>Allow this ChatGPT connector to read your OMI personal knowledge through MCP. The server exposes read-only tools.</p>
    ${escapedMessage}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label for="approval_token">Approval token</label>
      <input id="approval_token" name="approval_token" type="password" autocomplete="one-time-code" autofocus>
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>`;
}

function verifyApprovalToken(token: string): boolean {
  const configured = process.env.MCP_OAUTH_APPROVAL_TOKEN || firstConfiguredToken();
  return !!configured && safeTokenEqual(token, configured);
}

function issueAuthorizationCode(params: Record<string, string>): string {
  const code = randomToken('code');
  db.prepare(`
    INSERT INTO oauth_authorization_codes (
      code, client_id, redirect_uri, code_challenge, scope, resource, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code,
    params.client_id,
    params.redirect_uri,
    params.code_challenge,
    params.scope || DEFAULT_OAUTH_SCOPE,
    params.resource || null,
    isoAfter(AUTHORIZATION_CODE_TTL_MS),
    isoNow(),
  );
  return code;
}

function completeAuthorization(params: Record<string, string>, res: ServerResponse): void {
  if (params.response_type !== 'code') {
    sendRedirect(res, redirectWithOAuthError(params.redirect_uri, params.state, 'unsupported_response_type'));
    return;
  }
  if (!params.client_id || !params.redirect_uri || !params.code_challenge || params.code_challenge_method !== 'S256') {
    sendOAuthError(res, 400, 'invalid_request', 'client_id, redirect_uri, code_challenge and S256 PKCE are required');
    return;
  }

  const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(params.client_id) as any;
  if (!client) {
    sendOAuthError(res, 400, 'invalid_client', 'unknown client_id');
    return;
  }
  if (!validateRedirectUri(client, params.redirect_uri)) {
    sendOAuthError(res, 400, 'invalid_request', 'redirect_uri is not registered for this client');
    return;
  }

  const code = issueAuthorizationCode(params);
  const target = new URL(params.redirect_uri);
  target.searchParams.set('code', code);
  if (params.state) target.searchParams.set('state', params.state);
  sendRedirect(res, target.toString());
}

async function handleOAuthAuthorize(req: IncomingMessage, res: ServerResponse, urlObj: URL): Promise<void> {
  if (req.method === 'GET') {
    const params = authorizationParamsFromUrl(urlObj);
    if (process.env.MCP_OAUTH_AUTO_APPROVE === 'true') {
      completeAuthorization(params, res);
      return;
    }
    sendHtml(res, 200, renderAuthorizeForm(params));
    return;
  }

  if (req.method !== 'POST') {
    sendOAuthError(res, 405, 'invalid_request', 'authorization requires GET or POST');
    return;
  }

  const form = await readFormBody(req);
  const params = Object.fromEntries(form.entries());
  if (!verifyApprovalToken(params.approval_token || '')) {
    delete params.approval_token;
    sendHtml(res, 401, renderAuthorizeForm(params, 'Invalid approval token.'));
    return;
  }
  delete params.approval_token;
  completeAuthorization(params, res);
}

function issueTokens(clientId: string, scope: string | null, resource: string | null) {
  const accessToken = randomToken('atk');
  const refreshToken = randomToken('rtk');
  const now = isoNow();
  const expiresAt = isoAfter(ACCESS_TOKEN_TTL_MS);

  db.prepare(`
    INSERT INTO oauth_tokens (
      access_token_hash, refresh_token_hash, client_id, scope, resource,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenHash(accessToken),
    tokenHash(refreshToken),
    clientId,
    scope || DEFAULT_OAUTH_SCOPE,
    resource,
    expiresAt,
    now,
    now,
  );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: scope || DEFAULT_OAUTH_SCOPE,
  };
}

function clientIdFromTokenRequest(req: IncomingMessage, form: URLSearchParams): string {
  const auth = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const basic = /^Basic\s+(.+)$/i.exec(auth || '');
  if (basic?.[1]) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return decodeURIComponent(colon >= 0 ? decoded.slice(0, colon) : decoded);
  }
  return form.get('client_id') || '';
}

async function handleOAuthToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendOAuthError(res, 405, 'invalid_request', 'token endpoint requires POST');
    return;
  }

  const form = await readFormBody(req);
  const grantType = form.get('grant_type');
  const clientId = clientIdFromTokenRequest(req, form);
  const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as any;
  if (!client) {
    sendOAuthError(res, 401, 'invalid_client', 'unknown client_id');
    return;
  }

  if (grantType === 'authorization_code') {
    const code = form.get('code') || '';
    const redirectUri = form.get('redirect_uri') || '';
    const verifier = form.get('code_verifier') || '';
    const row = db.prepare(`
      SELECT * FROM oauth_authorization_codes WHERE code = ?
    `).get(code) as any;

    if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri || row.consumed_at) {
      sendOAuthError(res, 400, 'invalid_grant', 'invalid authorization code');
      return;
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      sendOAuthError(res, 400, 'invalid_grant', 'authorization code expired');
      return;
    }
    if (!verifier || sha256Base64Url(verifier) !== row.code_challenge) {
      sendOAuthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      return;
    }

    db.prepare('UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code = ?').run(isoNow(), code);
    sendJson(res, 200, issueTokens(clientId, row.scope, row.resource));
    return;
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token') || '';
    const current = db.prepare(`
      SELECT * FROM oauth_tokens WHERE refresh_token_hash = ?
    `).get(tokenHash(refreshToken)) as any;
    if (!current || current.client_id !== clientId || current.revoked_at) {
      sendOAuthError(res, 400, 'invalid_grant', 'invalid refresh token');
      return;
    }

    db.prepare('UPDATE oauth_tokens SET revoked_at = ?, updated_at = ? WHERE refresh_token_hash = ?')
      .run(isoNow(), isoNow(), tokenHash(refreshToken));
    sendJson(res, 200, issueTokens(clientId, current.scope, current.resource));
    return;
  }

  sendOAuthError(res, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

function searchKnowledge(args: {
  query: string;
  from?: string;
  to?: string;
  speaker?: string;
  identity?: string;
  timeZone?: string;
  limit?: number;
}) {
  const limit = clampLimit(args.limit, 10, 50);
  const timeZone = args.timeZone || mcpDefaultTimeZone();
  const detectedRange = !args.from && !args.to ? detectDateRange(args.query, timeZone) : null;
  const searchTerm = detectedRange ? stripDateAndGenericTerms(args.query) : args.query.trim();
  const shouldUseTextFilter = searchTerm.length > 0;
  const q = makeLike(shouldUseTextFilter ? searchTerm : args.query);
  const from = args.from || detectedRange?.from || '0000-01-01T00:00:00.000Z';
  const to = args.to || detectedRange?.to || '9999-12-31T23:59:59.999Z';
  const perBucket = Math.max(1, Math.ceil(limit / 3));

  const memoryTextFilter = shouldUseTextFilter
    ? `AND (
        canonical_text LIKE ?
        OR COALESCE(category, '') LIKE ?
        OR COALESCE(subject_key, '') LIKE ?
      )`
    : '';
  const memoryParams: unknown[] = [to, from];
  if (shouldUseTextFilter) {
    memoryParams.push(q, q, q);
  }
  memoryParams.push(perBucket);

  const memories = db.prepare(`
    SELECT
      'memory' AS type,
      id,
      canonical_text AS text,
      category,
      subject_key,
      confidence,
      first_observed_at AS started_at,
      last_observed_at AS ended_at
    FROM knowledge_memories
    WHERE status = 'active'
      AND COALESCE(first_observed_at, created_at) <= ?
      AND COALESCE(last_observed_at, updated_at, created_at) >= ?
      ${memoryTextFilter}
    ORDER BY COALESCE(last_observed_at, updated_at, created_at) DESC
    LIMIT ?
  `).all(...memoryParams);

  const conversationsWhere = [
    'kc.started_at <= ?',
    'COALESCE(kc.ended_at, kc.updated_at, kc.started_at) >= ?',
  ];
  const conversationsParams: unknown[] = [to, from];
  if (shouldUseTextFilter) {
    conversationsWhere.push(`(
      COALESCE(kc.title, '') LIKE ?
      OR COALESCE(kc.summary, '') LIKE ?
      OR COALESCE(kc.participants_json, '') LIKE ?
      OR COALESCE(kc.topics_json, '') LIKE ?
      OR COALESCE(kc.action_items_json, '') LIKE ?
    )`);
    conversationsParams.push(q, q, q, q, q);
  }

  if (args.speaker) {
    conversationsWhere.push('COALESCE(kc.participants_json, \'\') LIKE ?');
    conversationsParams.push(makeLike(args.speaker));
  }

  const conversations = db.prepare(`
    SELECT
      'conversation' AS type,
      kc.id,
      kc.title,
      kc.summary AS text,
      kc.started_at,
      kc.ended_at,
      kc.participants_json,
      kc.review_status
    FROM knowledge_conversations kc
    WHERE ${conversationsWhere.join(' AND ')}
    ORDER BY kc.started_at DESC
    LIMIT ?
  `).all(...conversationsParams, perBucket);

  const eventsWhere = [
    'ke.started_at <= ?',
    'COALESCE(ke.ended_at, ke.updated_at, ke.started_at) >= ?',
  ];
  const eventsParams: unknown[] = [to, from];
  if (shouldUseTextFilter) {
    eventsWhere.push(`(
      COALESCE(ke.content_text, '') LIKE ?
      OR COALESCE(ke.title, '') LIKE ?
      OR COALESCE(ke.participants_json, '') LIKE ?
      OR COALESCE(ke.metadata_json, '') LIKE ?
    )`);
    eventsParams.push(q, q, q, q);
  }

  if (args.speaker || args.identity) {
    eventsWhere.push(`EXISTS (
      SELECT 1
      FROM conversation_segments cs
      LEFT JOIN speakers s ON s.id = cs.speaker_id
      WHERE ke.source_table = 'conversation_segments'
        AND ke.source_row_id = cs.id
        AND (
          ? IS NULL
          OR COALESCE(s.name, '') LIKE ?
          OR COALESCE(s.display_label, '') LIKE ?
          OR COALESCE(cs.speaker_name, '') LIKE ?
          OR COALESCE(cs.speaker_label, '') LIKE ?
        )
        AND (
          ? IS NULL
          OR COALESCE(s.identity_label, '') LIKE ?
          OR COALESCE(cs.speaker_identity, '') LIKE ?
        )
    )`);
    const speakerQ = args.speaker ? makeLike(args.speaker) : null;
    const identityQ = args.identity ? makeLike(args.identity) : null;
    eventsParams.push(speakerQ, speakerQ, speakerQ, speakerQ, speakerQ, identityQ, identityQ, identityQ);
  }

  const events = db.prepare(`
    SELECT
      'event' AS type,
      ke.id,
      ke.event_type,
      COALESCE(ke.content_text, ke.title, '') AS text,
      ke.started_at,
      ke.ended_at,
      ke.participants_json,
      ke.source_table,
      ke.source_row_id
    FROM knowledge_events ke
    WHERE ${eventsWhere.join(' AND ')}
    ORDER BY ke.started_at DESC
    LIMIT ?
  `).all(...eventsParams, perBucket);

  return {
    query: args.query,
    interpreted_time_range: detectedRange
      ? {
          label: detectedRange.label,
          kind: detectedRange.kind,
          timeZone,
          from,
          to,
        }
      : null,
    text_filter: shouldUseTextFilter ? searchTerm : null,
    results: [...memories, ...conversations, ...events].slice(0, limit),
  };
}

function fetchMemory(id: string) {
  const row = db.prepare(`
    SELECT * FROM knowledge_memories WHERE id = ?
  `).get(id) as any;
  if (!row) return null;
  return {
    ...row,
    source_refs: parseJson(row.source_refs_json),
  };
}

function fetchEvent(id: string) {
  const row = db.prepare(`
    SELECT * FROM knowledge_events WHERE id = ?
  `).get(id) as any;
  if (!row) return null;

  let source: any = null;
  if (row.source_table === 'conversation_segments') {
    source = db.prepare(`
      SELECT cs.*, s.name AS resolved_speaker_name, s.identity_label AS resolved_speaker_identity
      FROM conversation_segments cs
      LEFT JOIN speakers s ON s.id = cs.speaker_id
      WHERE cs.id = ?
    `).get(row.source_row_id);
  }

  return {
    ...row,
    participants: parseJson(row.participants_json),
    metadata: parseJson(row.metadata_json),
    source,
  };
}

function fetchConversation(id: string) {
  const row = db.prepare(`
    SELECT * FROM knowledge_conversations WHERE id = ?
  `).get(id) as any;
  if (!row) return null;

  const events = db.prepare(`
    SELECT ke.id, ke.event_type, ke.started_at, ke.ended_at, ke.content_text, ke.title,
           ke.participants_json, ke.metadata_json, kci.item_order
    FROM knowledge_conversation_items kci
    JOIN knowledge_events ke ON ke.id = kci.event_id
    WHERE kci.conversation_id = ?
    ORDER BY kci.item_order ASC
    LIMIT 200
  `).all(id).map((event: any) => ({
    ...event,
    participants: parseJson(event.participants_json),
    metadata: parseJson(event.metadata_json),
  }));

  return {
    ...row,
    source_refs: parseJson(row.source_refs_json),
    participants: parseJson(row.participants_json),
    topics: parseJson(row.topics_json),
    action_items: parseJson(row.action_items_json),
    events,
  };
}

function fetchKnowledge(args: { id: string; type?: 'memory' | 'conversation' | 'event' }) {
  if (args.type === 'memory') return fetchMemory(args.id);
  if (args.type === 'conversation') return fetchConversation(args.id);
  if (args.type === 'event') return fetchEvent(args.id);

  return fetchMemory(args.id) || fetchConversation(args.id) || fetchEvent(args.id);
}

function listMemories(args: { category?: string; subject?: string; limit?: number }) {
  const where = ['status = \'active\''];
  const params: unknown[] = [];

  if (args.category) {
    where.push('category = ?');
    params.push(args.category);
  }
  if (args.subject) {
    where.push('COALESCE(subject_key, \'\') LIKE ?');
    params.push(makeLike(args.subject));
  }

  const limit = clampLimit(args.limit, 30, 100);
  return db.prepare(`
    SELECT id, canonical_text, category, subject_key, confidence,
           first_observed_at, last_observed_at
    FROM knowledge_memories
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(last_observed_at, updated_at, created_at) DESC
    LIMIT ?
  `).all(...params, limit);
}

function createKnowledgeMcpServer(): any {
  const server = new McpServer({
    name: 'omi-personal-knowledge',
    version: '1.0.0',
  });

  server.registerTool('search', {
    title: 'Search personal knowledge',
    description: 'Search OMI personal knowledge across long-term memories, conversations, and timeline events. Use this first for natural-language questions.',
    inputSchema: {
      query: z.string().min(1).describe('Search query text.'),
      from: z.string().optional().describe('Optional ISO start time.'),
      to: z.string().optional().describe('Optional ISO end time.'),
      speaker: z.string().optional().describe('Optional speaker name or label filter.'),
      identity: z.string().optional().describe('Optional speaker identity/role filter.'),
      timeZone: z.string().optional().describe('Optional IANA timezone for natural date words such as today/yesterday. Defaults to Asia/Shanghai.'),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, async (args: any) => textResult(searchKnowledge(args)));

  server.registerTool('fetch', {
    title: 'Fetch knowledge item',
    description: 'Fetch full details for a memory, conversation, or event returned by search.',
    inputSchema: {
      id: z.string().min(1),
      type: z.enum(['memory', 'conversation', 'event']).optional(),
    },
  }, async (args: any) => {
    const item = fetchKnowledge(args);
    if (!item) return textResult({ error: 'not_found', id: args.id });
    return textResult({ item });
  });

  server.registerTool('list_timeline', {
    title: 'List timeline events',
    description: 'List timeline events with optional time, type, speaker, identity, and confidence filters.',
    inputSchema: {
      from: z.string().optional(),
      to: z.string().optional(),
      type: z.string().optional(),
      speaker: z.string().optional(),
      speaker_id: z.string().optional(),
      identity: z.string().optional(),
      resolution_method: z.string().optional(),
      min_confidence: z.number().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, async (args: any) => textResult({
    results: listKnowledgeTimeline({
      from: args.from,
      to: args.to,
      type: args.type,
      speaker: args.speaker,
      speakerId: args.speaker_id,
      identity: args.identity,
      resolutionMethod: args.resolution_method,
      minConfidence: args.min_confidence,
      limit: args.limit,
    }),
  }));

  server.registerTool('list_conversations', {
    title: 'List conversations',
    description: 'List aggregated conversations with optional time, speaker, identity, and review filters.',
    inputSchema: {
      from: z.string().optional(),
      to: z.string().optional(),
      speaker: z.string().optional(),
      speaker_id: z.string().optional(),
      identity: z.string().optional(),
      has_low_confidence: z.boolean().optional(),
      has_unresolved: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, async (args: any) => textResult({
    results: listKnowledgeConversations({
      from: args.from,
      to: args.to,
      speaker: args.speaker,
      speakerId: args.speaker_id,
      identity: args.identity,
      hasLowConfidence: args.has_low_confidence,
      hasUnresolved: args.has_unresolved,
      limit: args.limit,
    }),
  }));

  server.registerTool('list_memories', {
    title: 'List long-term memories',
    description: 'List active long-term memories, optionally filtered by category or subject.',
    inputSchema: {
      category: z.string().optional(),
      subject: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async (args: any) => textResult({ results: listMemories(args) }));

  server.registerTool('review_speaker_segments', {
    title: 'Review speaker attribution segments',
    description: 'List low-confidence or unresolved speaker segments for attribution review. This is read-only.',
    inputSchema: {
      mode: z.enum(['low-confidence', 'unresolved']),
      from: z.string().optional(),
      to: z.string().optional(),
      speaker: z.string().optional(),
      identity: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, async (args: any) => textResult({
    results: listSpeakerReviewSegments(args.mode, {
      from: args.from,
      to: args.to,
      speaker: args.speaker,
      identity: args.identity,
      limit: args.limit,
    }),
  }));

  return server;
}

async function handleStreamableHttp(req: IncomingMessage, res: ServerResponse, urlObj: URL): Promise<void> {
  if (!authorizeMcpRequest(req, res, urlObj)) return;

  const parsedBody = req.method === 'POST' ? await readJsonBody<unknown>(req) : undefined;
  const sessionId = Array.isArray(req.headers['mcp-session-id'])
    ? req.headers['mcp-session-id'][0]
    : req.headers['mcp-session-id'];

  let transport: any;
  if (sessionId) {
    const existing = transports.get(sessionId);
    if (existing instanceof StreamableHTTPServerTransport) {
      transport = existing;
    } else {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: invalid MCP session' },
        id: null,
      });
      return;
    }
  } else if (req.method === 'POST' && isInitializeRequest(parsedBody)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (initializedSessionId: string) => {
        if (transport) transports.set(initializedSessionId, transport);
      },
    });
    transport.onclose = () => {
      const currentSessionId = transport?.sessionId;
      if (currentSessionId) transports.delete(currentSessionId);
    };
    await createKnowledgeMcpServer().connect(transport);
  } else {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: no valid MCP session' },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, parsedBody);
}

async function handleSse(req: IncomingMessage, res: ServerResponse, urlObj: URL): Promise<void> {
  if (!authorizeMcpRequest(req, res, urlObj)) return;

  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);
  transport.onclose = () => {
    transports.delete(transport.sessionId);
  };
  await createKnowledgeMcpServer().connect(transport);
}

async function handleSseMessage(req: IncomingMessage, res: ServerResponse, urlObj: URL): Promise<void> {
  const sessionId = urlObj.searchParams.get('sessionId');
  if (!sessionId) {
    sendJson(res, 400, { ok: false, error: 'Missing sessionId' });
    return;
  }

  const existing = transports.get(sessionId);
  if (!(existing instanceof SSEServerTransport)) {
    sendJson(res, 404, { ok: false, error: 'MCP session not found' });
    return;
  }

  const parsedBody = await readJsonBody<unknown>(req);
  await existing.handlePostMessage(req, res, parsedBody);
}

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, urlObj: URL): Promise<boolean> {
  if (req.method === 'GET' && urlObj.pathname === '/.well-known/oauth-authorization-server') {
    const baseUrl = publicBaseUrl(req, urlObj);
    sendJson(res, 200, oauthMetadata(baseUrl));
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/.well-known/oauth-protected-resource') {
    const baseUrl = publicBaseUrl(req, urlObj);
    sendJson(res, 200, protectedResourceMetadata(baseUrl, '/mcp'));
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/.well-known/oauth-protected-resource/mcp') {
    const baseUrl = publicBaseUrl(req, urlObj);
    sendJson(res, 200, protectedResourceMetadata(baseUrl, '/mcp'));
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/.well-known/oauth-protected-resource/sse') {
    const baseUrl = publicBaseUrl(req, urlObj);
    sendJson(res, 200, protectedResourceMetadata(baseUrl, '/sse'));
    return true;
  }

  if (urlObj.pathname === '/oauth/register') {
    await handleOAuthRegister(req, res);
    return true;
  }

  if (urlObj.pathname === '/oauth/authorize') {
    await handleOAuthAuthorize(req, res, urlObj);
    return true;
  }

  if (urlObj.pathname === '/oauth/token') {
    await handleOAuthToken(req, res);
    return true;
  }

  if (urlObj.pathname === '/mcp') {
    await handleStreamableHttp(req, res, urlObj);
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/sse') {
    await handleSse(req, res, urlObj);
    return true;
  }

  if (req.method === 'POST' && urlObj.pathname === '/messages') {
    await handleSseMessage(req, res, urlObj);
    return true;
  }

  return false;
}
