// Load dotenv first before any other imports
require('dotenv').config();

import * as fs from 'fs';
import * as path from 'path';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import WS, { WebSocketServer } from 'ws';
import { handleAppConnection } from './handlers/app-connection';
import { initDb } from './db';
import {
  confirmSpeakerName,
  getSpeakerDetail,
  getSpeakerStats,
  listAllSpeakers,
  listAnonymousSpeakers,
  listSpeakers,
  updateSpeaker,
} from './services/speaker-service';
import { getConversationDetail, listConversations } from './services/conversation-service';
import { AudioFileWriter } from './services/audio-file-writer';
import { parseNumber, readJsonBody, sendJson } from './utils/http';
import { IDENTITY_OPTIONS } from './constants/identity-options';

const PORT = parseInt(process.env.PORT ?? '8080', 10);

initDb();

if (!(globalThis as any).WebSocket) {
  (globalThis as any).WebSocket = WS;
}

console.log('[Boot] globalThis.WebSocket =', typeof (globalThis as any).WebSocket);
console.log('[Boot] marker = soniox-ws-fix');

const AUDIO_DIR = path.join(process.cwd(), 'audio-uploads');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const ADMIN_DIR = path.join(PUBLIC_DIR, 'admin');
const MEDIA_ROOTS: Record<string, string> = {
  audio: path.join(process.cwd(), 'audio-uploads'),
  clips: path.join(process.cwd(), 'data', 'clips'),
  finalized: path.join(process.cwd(), 'finalized_results'),
  raw: path.join(process.cwd(), 'raw_results'),
};

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

function isSafeChildPath(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toMediaUrl(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  for (const [bucket, root] of Object.entries(MEDIA_ROOTS)) {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolved);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return `/media/${bucket}/${relative.split(path.sep).join('/')}`;
    }
  }
  return null;
}

function contentTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wav':
      return 'audio/wav';
    default:
      return 'application/octet-stream';
  }
}

function serveFile(res: ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }

  res.writeHead(200, { 'Content-Type': contentTypeForFile(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function serveAdminAsset(reqPath: string, res: ServerResponse): boolean {
  const relative = reqPath === '/admin' || reqPath === '/admin/' ? 'index.html' : reqPath.replace(/^\/admin\//, '');
  const target = path.resolve(ADMIN_DIR, relative);
  if (!isSafeChildPath(ADMIN_DIR, target) && target !== path.resolve(ADMIN_DIR, 'index.html')) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return true;
  }
  if (!fs.existsSync(target)) {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return true;
  }
  serveFile(res, target);
  return true;
}

function serveMediaAsset(reqPath: string, res: ServerResponse): boolean {
  const relative = reqPath.replace(/^\/media\//, '');
  const slashIndex = relative.indexOf('/');
  if (slashIndex <= 0) {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return true;
  }
  const bucket = relative.slice(0, slashIndex);
  const filePart = relative.slice(slashIndex + 1);
  const root = MEDIA_ROOTS[bucket];
  if (!root) {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return true;
  }
  const target = path.resolve(root, filePart);
  const relativeToRoot = path.relative(path.resolve(root), target);
  if (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot) && fs.existsSync(target) && fs.statSync(target).isFile()) {
    serveFile(res, target);
    return true;
  }
  sendJson(res, 404, { ok: false, error: 'Not found' });
  return true;
}

function enrichSpeaker(row: any): any {
  return {
    ...row,
    sample_audio_url: toMediaUrl(row.sample_audio_path),
  };
}

function enrichConversation(row: any): any {
  return {
    ...row,
    audio_file_url: toMediaUrl(row.audio_file_path),
    raw_result_url: toMediaUrl(row.raw_result_path),
  };
}

async function handleApiRequest(req: IncomingMessage, res: ServerResponse, urlObj: URL): Promise<boolean> {
  if (req.method === 'GET' && urlObj.pathname === '/api/speakers') {
    const result = listSpeakers({
      q: urlObj.searchParams.get('q') || undefined,
      confirmation: (urlObj.searchParams.get('confirmation') as any) || 'all',
      startTime: urlObj.searchParams.get('start_time') || undefined,
      endTime: urlObj.searchParams.get('end_time') || undefined,
      page: parseNumber(urlObj.searchParams.get('page'), 1),
      pageSize: parseNumber(urlObj.searchParams.get('page_size'), 50),
    });
    sendJson(res, 200, {
      ok: true,
      data: result.data.map(enrichSpeaker),
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
      stats: getSpeakerStats(),
    });
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/speakers/stats') {
    sendJson(res, 200, { ok: true, data: getSpeakerStats() });
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/meta/identity-options') {
    sendJson(res, 200, { ok: true, data: IDENTITY_OPTIONS });
    return true;
  }

  if (req.method === 'GET' && /^\/api\/speakers\/[^/]+$/.test(urlObj.pathname)) {
    const speakerId = urlObj.pathname.split('/')[3];
    const detail = getSpeakerDetail(speakerId);
    sendJson(res, 200, {
      ok: true,
      data: {
        speaker: enrichSpeaker(detail.speaker),
        recentConversations: detail.recentConversations.map(enrichConversation),
        representativeSegments: detail.representativeSegments,
      },
    });
    return true;
  }

  if ((req.method === 'PATCH' || req.method === 'POST') && /^\/api\/speakers\/[^/]+$/.test(urlObj.pathname)) {
    const speakerId = urlObj.pathname.split('/')[3];
    const body = await readJsonBody<{ name?: string | null; identityLabel?: string | null; notes?: string | null }>(req);
    const updated = updateSpeaker(speakerId, body);
    sendJson(res, 200, { ok: true, data: enrichSpeaker(updated) });
    return true;
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/conversations') {
    const result = listConversations({
      speakerName: urlObj.searchParams.get('speaker_name') || undefined,
      identityLabel: urlObj.searchParams.get('identity_label') || undefined,
      keyword: urlObj.searchParams.get('keyword') || undefined,
      startTime: urlObj.searchParams.get('start_time') || undefined,
      endTime: urlObj.searchParams.get('end_time') || undefined,
      status: urlObj.searchParams.get('status') || undefined,
      hasUnconfirmedSpeakers: (urlObj.searchParams.get('has_unconfirmed_speakers') as any) || 'all',
      page: parseNumber(urlObj.searchParams.get('page'), 1),
      pageSize: parseNumber(urlObj.searchParams.get('page_size'), 50),
    });
    sendJson(res, 200, {
      ok: true,
      data: result.data.map(enrichConversation),
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
      },
      identityOptions: IDENTITY_OPTIONS,
    });
    return true;
  }

  if (req.method === 'GET' && /^\/api\/conversations\/[^/]+$/.test(urlObj.pathname)) {
    const conversationId = urlObj.pathname.split('/')[3];
    const detail = getConversationDetail(conversationId);
    sendJson(res, 200, {
      ok: true,
      data: {
        conversation: enrichConversation(detail.conversation),
        speakers: detail.speakers,
        segments: detail.segments,
      },
    });
    return true;
  }

  return false;
}

const server = createServer((req, res) => {
  const handleRequest = async (): Promise<void> => {
    const urlObj = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

    if (urlObj.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'GET' && (urlObj.pathname === '/admin' || urlObj.pathname === '/admin/' || urlObj.pathname.startsWith('/admin/'))) {
      serveAdminAsset(urlObj.pathname, res);
      return;
    }

    if (req.method === 'GET' && urlObj.pathname.startsWith('/media/')) {
      serveMediaAsset(urlObj.pathname, res);
      return;
    }

    if (await handleApiRequest(req, res, urlObj)) {
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/speakers') {
      sendJson(res, 200, { ok: true, data: listAllSpeakers().map(enrichSpeaker) });
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/speakers/anonymous') {
      sendJson(res, 200, { ok: true, data: listAnonymousSpeakers().map(enrichSpeaker) });
      return;
    }

    if (req.method === 'POST' && /^\/speakers\/[^/]+\/confirm$/.test(urlObj.pathname)) {
      const speakerId = urlObj.pathname.split('/')[2];
      const body = await readJsonBody<{ realName?: string }>(req);
      const result = confirmSpeakerName(speakerId, body.realName || '');
      sendJson(res, 200, { ok: true, data: result });
      return;
    }

    if (req.method === 'POST' && urlObj.pathname.startsWith('/api/audio')) {
      const sampleRate = urlObj.searchParams.get('sample_rate') || '16000';
      const uid = urlObj.searchParams.get('uid') || 'anonymous';
      const duration = urlObj.searchParams.get('duration') || 'unknown';

      console.log(`[Audio Webhook] Received audio chunk for uid: ${uid}, sample_rate: ${sampleRate}, duration: ${duration}`);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `audio_${uid}_${timestamp}.wav`;
      const filepath = path.join(AUDIO_DIR, filename);
      const wavWriter = new AudioFileWriter(filepath, {
        sampleRate: parseInt(sampleRate, 10),
        channels: 1,
        bitsPerSample: 16,
      });
      let bytesReceived = 0;

      req.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesReceived += buffer.length;
        wavWriter.write(buffer);
      });

      req.on('end', async () => {
        try {
          await wavWriter.finish();
          console.log(`[Audio Webhook] Saved WAV ${bytesReceived} bytes -> ${filename}`);
          sendJson(res, 200, { status: 'success', bytes_received: bytesReceived, filename });
        } catch (err) {
          console.error('[Audio Webhook] Failed to save audio file:', err);
          sendJson(res, 500, { error: 'Failed to save audio' });
        }
      });

      req.on('error', (err) => {
        console.error('[Audio Webhook] Request stream error:', err);
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  };

  handleRequest().catch((err) => {
    console.error('[HTTP] Request failed:', err);
    sendJson(res, 500, { ok: false, error: String((err as Error).message ?? err) });
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  console.log('[Server] New connection from:', req.socket.remoteAddress);
  handleAppConnection(ws, req);
});

wss.on('error', (err) => {
  console.error('[Server] WebSocket server error:', err);
});

server.listen(PORT, () => {
  console.log(`[Server] OMI Custom STT server running on port ${PORT}`);
  console.log(`[Server] WebSocket endpoint: ws://localhost:${PORT}/stt`);
  console.log(`[Server] Health check: http://localhost:${PORT}/healthz`);
  console.log(`[Server] Admin UI: http://localhost:${PORT}/admin`);
});

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
