import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export async function clipAudioSegment(
  inputPath: string,
  outputPath: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const startSec = Math.max(0, startMs) / 1000;
  const durationSec = Math.max(0.3, (endMs - startMs) / 1000);

  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i',
      inputPath,
      '-ss',
      String(startSec),
      '-t',
      String(durationSec),
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      outputPath,
    ]);

    let stderr = '';
    ff.stderr.on('data', d => {
      stderr += d.toString();
    });

    ff.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg clip failed (${code}): ${stderr}`));
      }
    });
  });
}
