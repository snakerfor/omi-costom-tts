// Load dotenv first before any other imports
require('dotenv').config();

import WS from 'ws';

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { handleAppConnection } from './handlers/app-connection';
import { initDb } from './db';
import {
  confirmSpeakerName,
  listAllSpeakers,
  listAnonymousSpeakers,
} from './services/speaker-service';

const PORT = parseInt(process.env.PORT ?? '8080', 10);

initDb();

if (!(globalThis as any).WebSocket) {
  (globalThis as any).WebSocket = WS;
}

console.log('[Boot] globalThis.WebSocket =', typeof (globalThis as any).WebSocket);
console.log('[Boot] marker = soniox-ws-fix');

// Create HTTP server
import * as fs from 'fs';
import * as path from 'path';
import { pcmToWavFile } from './services/audio-file-writer';

// Ensure audio uploads directory exists
const AUDIO_DIR = path.join(process.cwd(), 'audio-uploads');
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

const server = createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/speakers') {
    try {
      const rows = listAllSpeakers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: rows }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/speakers/anonymous') {
    try {
      const rows = listAnonymousSpeakers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: rows }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }));
    }
    return;
  }

  if (req.method === 'POST' && req.url && /^\/speakers\/[^/]+\/confirm$/.test(req.url)) {
    const speakerId = req.url.split('/')[2];
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const bodyRaw = Buffer.concat(chunks).toString('utf8') || '{}';
        const body = JSON.parse(bodyRaw) as { realName?: string };
        const result = confirmSpeakerName(speakerId, body.realName || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String((err as Error).message ?? err) }));
      }
    });
    return;
  }

  // Audio Streaming Webhook endpoint (from OMI app)
  // URL: POST /api/audio?sample_rate=16000&uid=user_id
  if (req.method === 'POST' && req.url && req.url.startsWith('/api/audio')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const sampleRate = urlObj.searchParams.get('sample_rate') || '16000';
    const uid = urlObj.searchParams.get('uid') || 'anonymous';
    const duration = urlObj.searchParams.get('duration') || 'unknown';
    
    console.log(`[Audio Webhook] Received audio chunk for uid: ${uid}, sample_rate: ${sampleRate}, duration: ${duration}`);
    
    const chunks: Buffer[] = [];
    
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    req.on('end', async () => {
      const audioBuffer = Buffer.concat(chunks);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `audio_${uid}_${timestamp}.wav`;
      const filepath = path.join(AUDIO_DIR, filename);

      // Convert PCM to WAV and save
      try {
        await pcmToWavFile(
          audioBuffer,
          filepath,
          parseInt(sampleRate, 10),
          1,  // mono
          16  // 16-bit
        );
        console.log(`[Audio Webhook] Saved WAV ${audioBuffer.length} bytes -> ${filename}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', bytes_received: audioBuffer.length, filename }));
      } catch (err) {
        console.error(`[Audio Webhook] Failed to save audio file:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to save audio' }));
      }
    });
    
    return;
  }

  res.writeHead(404);
  res.end();
});

// Create WebSocket server
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
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
