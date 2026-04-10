import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

interface CliOptions {
  input: string;
  output: string;
  apiKey: string;
  pollMs: number;
  mediaKey: string;
}

interface PyannoteJobResponse {
  jobId: string;
  status: string;
  output?: unknown;
  message?: string;
}

function parseArgs(): CliOptions {
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

  const output = args.get('output') || path.resolve(process.cwd(), 'preview_results', 'pyannote-diarization.json');
  const apiKey = args.get('api-key') || process.env.PYANNOTE_API_KEY || '';
  if (!apiKey) {
    throw new Error('missing pyannote api key: pass --api-key or set PYANNOTE_API_KEY');
  }

  const basename = path.basename(input).replace(/[^a-zA-Z0-9._-]+/g, '_');

  return {
    input: path.resolve(input),
    output: path.resolve(output),
    apiKey,
    pollMs: Number(args.get('poll-ms') || '5000'),
    mediaKey: args.get('media-key') || `omi/${Date.now()}_${basename}`,
  };
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

async function main(): Promise<void> {
  const options = parseArgs();
  const mediaUrl = `media://${options.mediaKey}`;

  console.log(`[Pyannote] input=${options.input}`);
  console.log(`[Pyannote] mediaUrl=${mediaUrl}`);

  const presignedUrl = await createUploadUrl(options.apiKey, mediaUrl);
  console.log('[Pyannote] upload url created');

  await uploadFile(presignedUrl, options.input);
  console.log('[Pyannote] upload completed');

  const created = await submitDiarization(options.apiKey, mediaUrl);
  if (!created.jobId) {
    throw new Error(`submit diarization returned no jobId: ${JSON.stringify(created)}`);
  }
  console.log(`[Pyannote] job created id=${created.jobId}`);

  let job = created;
  while (!['succeeded', 'failed', 'canceled'].includes(job.status)) {
    await sleep(options.pollMs);
    job = await getJob(options.apiKey, created.jobId);
    console.log(`[Pyannote] status=${job.status}`);
  }

  await fsp.mkdir(path.dirname(options.output), { recursive: true });
  await fsp.writeFile(
    options.output,
    JSON.stringify(
      {
        input: options.input,
        mediaUrl,
        job,
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`[Pyannote] wrote output=${options.output}`);

  if (job.status !== 'succeeded') {
    throw new Error(`pyannote job did not succeed: ${JSON.stringify(job)}`);
  }
}

main().catch(err => {
  console.error('[Pyannote] failed:', err);
  process.exit(1);
});
