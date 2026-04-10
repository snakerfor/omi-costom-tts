import * as fs from 'fs/promises';
import * as path from 'path';
import { SonioxResponse, SonioxToken } from '../types';

export interface RawTranscriptEvent {
  ts: string;
  event: 'soniox_result';
  session_id: string;
  result_index: number;
  is_final: boolean;
  tokens: SonioxToken[];
}

export class FinalResultRecorder {
  private resultIndex = 0;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly sessionId: string, private readonly rawDir: string) {}

  get filePath(): string {
    return path.join(this.rawDir, `${this.sessionId}.ndjson`);
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await fs.mkdir(this.rawDir, { recursive: true });
        await fs.appendFile(this.filePath, '', 'utf8');
      })();
    }

    await this.initPromise;
  }

  async appendResult(result: SonioxResponse): Promise<void> {
    await this.init();

    const tokens = Array.isArray(result.tokens) ? result.tokens : [];
    if (!tokens.length) {
      return;
    }

    const event: RawTranscriptEvent = {
      ts: new Date().toISOString(),
      event: 'soniox_result',
      session_id: this.sessionId,
      result_index: this.resultIndex++,
      is_final: tokens.every(t => !!t.is_final),
      tokens,
    };

    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}
