import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

interface Options {
  input: string;
  output: string | null;
  windowMs: number;
  rmsThreshold: number;
  peakThreshold: number;
  sampleRate: number;
  channels: number;
}

interface WindowDecision {
  index: number;
  startMs: number;
  endMs: number;
  rms: number;
  peak: number;
  isSpeech: boolean;
}

function parseArgs(): Options {
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
    input: path.resolve(input),
    output: args.get('output') ? path.resolve(args.get('output') as string) : null,
    windowMs: Number(args.get('window-ms') || '200'),
    rmsThreshold: Number(args.get('rms-threshold') || '0.015'),
    peakThreshold: Number(args.get('peak-threshold') || '0.055'),
    sampleRate: Number(args.get('sample-rate') || '16000'),
    channels: Number(args.get('channels') || '1'),
  };
}

function decodeToPcm(inputPath: string, sampleRate: number, channels: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
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
      String(sampleRate),
      '-ac',
      String(channels),
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

function analyzeWindow(buffer: Buffer): { rms: number; peak: number } {
  if (buffer.length < 2) {
    return { rms: 0, peak: 0 };
  }
  const sampleCount = Math.floor(buffer.length / 2);
  let sumSquares = 0;
  let peak = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset) / 32768;
    const abs = Math.abs(sample);
    sumSquares += sample * sample;
    if (abs > peak) {
      peak = abs;
    }
  }
  return {
    rms: Math.sqrt(sumSquares / sampleCount),
    peak,
  };
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const pcm = await decodeToPcm(options.input, options.sampleRate, options.channels);

  const bytesPerMs = (options.sampleRate * options.channels * 2) / 1000;
  const windowBytes = Math.max(2, Math.floor(options.windowMs * bytesPerMs));
  const totalMs = Math.floor(pcm.length / bytesPerMs);

  const windows: WindowDecision[] = [];
  let speechMs = 0;
  let silenceMs = 0;
  let speechRuns = 0;
  let prevSpeech = false;

  for (let offset = 0, index = 0; offset < pcm.length; offset += windowBytes, index += 1) {
    const chunk = pcm.subarray(offset, Math.min(offset + windowBytes, pcm.length));
    const startMs = Math.floor(offset / bytesPerMs);
    const endMs = Math.floor((offset + chunk.length) / bytesPerMs);
    const { rms, peak } = analyzeWindow(chunk);
    const isSpeech = rms >= options.rmsThreshold || peak >= options.peakThreshold;
    if (isSpeech) {
      speechMs += endMs - startMs;
      if (!prevSpeech) {
        speechRuns += 1;
      }
    } else {
      silenceMs += endMs - startMs;
    }
    prevSpeech = isSpeech;
    windows.push({
      index,
      startMs,
      endMs,
      rms: Number(rms.toFixed(6)),
      peak: Number(peak.toFixed(6)),
      isSpeech,
    });
  }

  const summary = {
    input: options.input,
    totalMs,
    speechMs,
    silenceMs,
    speechRatio: Number((speechMs / Math.max(totalMs, 1)).toFixed(4)),
    suppressedRatio: Number((silenceMs / Math.max(totalMs, 1)).toFixed(4)),
    speechRuns,
    windowMs: options.windowMs,
    rmsThreshold: options.rmsThreshold,
    peakThreshold: options.peakThreshold,
  };

  const firstSpeech = windows.find(w => w.isSpeech);
  const firstSpeechAt = firstSpeech ? `${formatMs(firstSpeech.startMs)} (${firstSpeech.startMs}ms)` : 'N/A';

  console.log('[OfflineVAD] summary');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[OfflineVAD] firstSpeechAt=${firstSpeechAt}`);

  if (options.output) {
    await fs.mkdir(path.dirname(options.output), { recursive: true });
    await fs.writeFile(
      options.output,
      JSON.stringify(
        {
          summary,
          windows,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`[OfflineVAD] wrote output=${options.output}`);
  }
}

main().catch(error => {
  console.error('[OfflineVAD] failed:', error);
  process.exit(1);
});
