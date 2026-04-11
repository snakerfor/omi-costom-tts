import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export interface PyannoteTurn {
  speaker: string;
  start_ms: number;
  end_ms: number;
}

interface PyannoteJobResponse {
  jobId?: string;
  status: string;
  output?: {
    diarization?: Array<{
      speaker?: string;
      start?: number;
      end?: number;
    }>;
  };
  message?: string;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

async function expectOk(response: Response, label: string): Promise<any> {
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }

  return parsed;
}

async function createUploadUrl(apiKey: string, mediaUrl: string): Promise<string> {
  const response = await fetch('https://api.pyannote.ai/v1/media/input', {
    method: 'POST',
    headers: {
      ...authHeaders(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: mediaUrl }),
  });

  const data = await expectOk(response, 'create upload url');
  if (!data?.url) {
    throw new Error('create upload url returned no presigned url');
  }
  return String(data.url);
}

async function uploadFile(presignedUrl: string, inputPath: string): Promise<void> {
  const stat = await fsp.stat(inputPath);

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(inputPath);
    fetch(presignedUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(stat.size),
        'Content-Type': 'audio/wav',
      },
      body: stream as any,
      duplex: 'half' as any,
    })
      .then(async response => {
        if (!response.ok) {
          const text = await response.text();
          reject(new Error(`upload file failed (${response.status}): ${text}`));
          return;
        }
        resolve();
      })
      .catch(reject);
  });
}

async function submitDiarization(apiKey: string, mediaUrl: string): Promise<PyannoteJobResponse> {
  const response = await fetch('https://api.pyannote.ai/v1/diarize', {
    method: 'POST',
    headers: {
      ...authHeaders(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: mediaUrl }),
  });

  return await expectOk(response, 'submit diarization');
}

async function getJob(apiKey: string, jobId: string): Promise<PyannoteJobResponse> {
  const response = await fetch(`https://api.pyannote.ai/v1/jobs/${jobId}`, {
    headers: authHeaders(apiKey),
  });

  return await expectOk(response, 'get job');
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export function pyannoteEnabled(): boolean {
  return !!process.env.PYANNOTE_API_KEY;
}

export interface RunPyannoteDiarizationOptions {
  audioPath: string;
  sessionId: string;
  outputPath?: string;
  mediaKey?: string;
  pollMs?: number;
}

export interface RunPyannoteDiarizationResult {
  turns: PyannoteTurn[];
  outputPath: string | null;
  rawJob: PyannoteJobResponse;
}

export async function runPyannoteDiarization(
  options: RunPyannoteDiarizationOptions,
): Promise<RunPyannoteDiarizationResult> {
  const apiKey = process.env.PYANNOTE_API_KEY || '';
  if (!apiKey) {
    throw new Error('PYANNOTE_API_KEY is required');
  }

  const inputPath = path.resolve(options.audioPath);
  const basename = path.basename(inputPath).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const mediaUrl = `media://${options.mediaKey || `omi/${options.sessionId}_${Date.now()}_${basename}`}`;

  const presignedUrl = await createUploadUrl(apiKey, mediaUrl);
  await uploadFile(presignedUrl, inputPath);

  const created = await submitDiarization(apiKey, mediaUrl);
  if (!created.jobId) {
    throw new Error(`submit diarization returned no jobId: ${JSON.stringify(created)}`);
  }

  let job = created;
  const pollMs = options.pollMs ?? 5000;
  while (!['succeeded', 'failed', 'canceled'].includes(job.status)) {
    await sleep(pollMs);
    job = await getJob(apiKey, created.jobId);
  }

  if (options.outputPath) {
    await fsp.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fsp.writeFile(
      options.outputPath,
      JSON.stringify(
        {
          input: inputPath,
          mediaUrl,
          job,
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  if (job.status !== 'succeeded') {
    throw new Error(`pyannote job did not succeed: ${JSON.stringify(job)}`);
  }

  const turns = (job.output?.diarization || [])
    .map(turn => ({
      speaker: String(turn.speaker || '').trim(),
      start_ms: Math.round(Number(turn.start || 0) * 1000),
      end_ms: Math.round(Number(turn.end || 0) * 1000),
    }))
    .filter(turn => !!turn.speaker && turn.end_ms > turn.start_ms);

  return {
    turns,
    outputPath: options.outputPath || null,
    rawJob: job,
  };
}
