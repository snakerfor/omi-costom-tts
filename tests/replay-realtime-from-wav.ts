import WebSocket from 'ws';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

interface ReplayOptions {
  input: string;
  serverUrl: string;
  apiToken: string;
  language: string;
  chunkMs: number;
  speed: number;
  settleMs: number;
  outputPath: string | null;
}

interface ReceivedEnvelope {
  ts: string;
  raw: string;
}

function parseArgs(): ReplayOptions {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (key?.startsWith('--') && value) {
      args.set(key.slice(2), value);
    }
  }

  const input = args.get('input');
  if (!input) {
    throw new Error('missing required arg --input');
  }

  return {
    input,
    serverUrl: args.get('server-url') || process.env.TEST_SERVER_URL || 'ws://localhost:8080/stt',
    apiToken: args.get('api-token') || process.env.TEST_API_TOKEN || 'token-device-a',
    language: args.get('language') || 'zh',
    chunkMs: Number(args.get('chunk-ms') || '200'),
    speed: Number(args.get('speed') || '4'),
    settleMs: Number(args.get('settle-ms') || '15000'),
    outputPath: args.get('output') || null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function decodeToPcmBuffer(inputPath: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-v',
      'error',
      '-i',
      inputPath,
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    let stderr = '';

    ffmpeg.stdout.on('data', chunk => {
      chunks.push(Buffer.from(chunk));
    });

    ffmpeg.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    ffmpeg.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg decode failed (${code}): ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs();
  const inputPath = path.resolve(options.input);
  const url = new URL(options.serverUrl);
  url.searchParams.set('api_key', options.apiToken);
  url.searchParams.set('language', options.language);
  const expectedUid = `token_${createHash('sha1').update(options.apiToken).digest('hex').slice(0, 16)}`;

  console.log(`[Replay] input=${inputPath}`);
  console.log(`[Replay] server=${url.toString()}`);
  console.log(`[Replay] chunkMs=${options.chunkMs} speed=${options.speed} settleMs=${options.settleMs}`);
  console.log(`[Replay] expectedUid=${expectedUid}`);

  const pcm = await decodeToPcmBuffer(inputPath);
  const bytesPerMs = 16000 * 2 / 1000;
  const chunkBytes = Math.max(640, Math.floor(options.chunkMs * bytesPerMs));
  const audioDurationMs = Math.floor(pcm.length / bytesPerMs);
  const startedAt = new Date().toISOString();

  console.log(`[Replay] decodedPcmBytes=${pcm.length} audioDurationMs=${audioDurationMs}`);
  console.log(`[Replay] startedAt=${startedAt}`);

  const received: ReceivedEnvelope[] = [];

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    let finished = false;
    let settleTimer: NodeJS.Timeout | null = null;

    const fail = (err: Error): void => {
      if (finished) return;
      finished = true;
      if (settleTimer) clearTimeout(settleTimer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(err);
    };

    ws.on('open', async () => {
      try {
        console.log('[Replay] websocket connected');
        for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
          const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
          ws.send(chunk);
          const delayMs = Math.max(1, Math.round(options.chunkMs / Math.max(options.speed, 0.1)));
          await sleep(delayMs);
        }

        console.log('[Replay] audio finished, sending CloseStream');
        ws.send(JSON.stringify({ type: 'CloseStream' }));
        settleTimer = setTimeout(() => {
          if (finished) return;
          finished = true;
          console.log('[Replay] settle timeout reached, closing websocket locally');
          try {
            ws.close();
          } catch {
            // ignore
          }
          resolve();
        }, options.settleMs);
      } catch (err) {
        fail(err as Error);
      }
    });

    ws.on('message', data => {
      const raw = data.toString();
      received.push({ ts: new Date().toISOString(), raw });
      console.log(`[Replay] recv=${raw}`);
    });

    ws.on('close', code => {
      if (finished) return;
      finished = true;
      if (settleTimer) clearTimeout(settleTimer);
      console.log(`[Replay] websocket closed code=${code}`);
      resolve();
    });

    ws.on('error', err => {
      fail(err);
    });
  });

  if (options.outputPath) {
    const resolvedOutput = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.writeFile(
      resolvedOutput,
      JSON.stringify(
        {
          inputPath,
          startedAt,
          expectedUid,
          serverUrl: url.toString(),
          chunkMs: options.chunkMs,
          speed: options.speed,
          received,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`[Replay] wrote output=${resolvedOutput}`);
  }

  console.log(
    JSON.stringify(
      {
        inputPath,
        startedAt,
        expectedUid,
        audioDurationMs,
        receivedMessageCount: received.length,
      },
      null,
      2,
    ),
  );
}

main().catch(err => {
  console.error('[Replay] failed:', err);
  process.exit(1);
});
