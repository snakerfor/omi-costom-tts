import { spawn } from 'child_process';

export async function extractEmbeddingWithPython(audioPaths: string[]): Promise<number[]> {
  if (!audioPaths.length) {
    return [];
  }

  return await new Promise<number[]>((resolve, reject) => {
    const py = spawn('python3', ['scripts/extract_embedding.py', ...audioPaths]);

    let stdout = '';
    let stderr = '';

    py.stdout.on('data', data => {
      stdout += data.toString();
    });

    py.stderr.on('data', data => {
      stderr += data.toString();
    });

    py.on('close', code => {
      if (code !== 0) {
        reject(new Error(`python embedding failed (${code}): ${stderr || stdout}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        if (parsed?.error) {
          reject(new Error(String(parsed.error)));
          return;
        }
        const embedding = Array.isArray(parsed?.embedding) ? parsed.embedding.map((v: unknown) => Number(v)) : [];
        resolve(embedding);
      } catch (err) {
        reject(new Error(`invalid python output: ${stdout || String(err)}`));
      }
    });
  });
}
