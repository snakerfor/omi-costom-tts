import * as fs from 'fs/promises';
import * as path from 'path';
import { Segment, SonioxResponse, SonioxToken } from '../types';

export interface RawTranscriptEvent {
  ts: string;
  event: 'soniox_result' | 'final_segment';
  session_id: string;
  result_index?: number;
  segment_index?: number;
  is_final?: boolean;
  tokens?: SonioxToken[];
  segment?: {
    id: string;
    start_ms: number;
    end_ms: number;
    absolute_start_time: string;
    absolute_end_time: string;
    speaker_label: string | null;
    text: string;
    speaker_id: string | null;
    speaker_name: string | null;
    speaker_identity: string | null;
    confidence: number | null;
    resolution_method: string | null;
    error_message: string | null;
  };
}

export class FinalResultRecorder {
  private resultIndex = 0;
  private segmentIndex = 0;
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

    const tokens = Array.isArray(result.tokens)
      ? result.tokens.filter(t => !!t?.is_final && !!(t.text || '').trim())
      : [];
    if (!tokens.length) {
      return;
    }

    const event: RawTranscriptEvent = {
      ts: new Date().toISOString(),
      event: 'soniox_result',
      session_id: this.sessionId,
      result_index: this.resultIndex++,
      is_final: true,
      tokens,
    };

    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async appendFinalSegment(
    segment: Segment,
    recordingStartedAt: string,
    segmentId: string,
  ): Promise<void> {
    await this.init();

    const startMs = Math.max(0, Math.round(Number(segment.start || 0) * 1000));
    const endMs = Math.max(startMs, Math.round(Number(segment.end || 0) * 1000));
    const text = String(segment.text || '').trim();
    if (!text) {
      return;
    }

    const baseTime = new Date(recordingStartedAt).getTime();
    const absoluteStartTime = new Date(baseTime + startMs).toISOString();
    const absoluteEndTime = new Date(baseTime + endMs).toISOString();

    const event: RawTranscriptEvent = {
      ts: new Date().toISOString(),
      event: 'final_segment',
      session_id: this.sessionId,
      segment_index: this.segmentIndex++,
      segment: {
        id: segmentId,
        start_ms: startMs,
        end_ms: endMs,
        absolute_start_time: absoluteStartTime,
        absolute_end_time: absoluteEndTime,
        speaker_label: segment.speaker_label || segment.speaker || null,
        text,
        speaker_id: segment.speaker_id || null,
        speaker_name: segment.speaker_name || null,
        speaker_identity: segment.speaker_identity || null,
        confidence: Number.isFinite(segment.speaker_confidence as number) ? Number(segment.speaker_confidence) : null,
        resolution_method: segment.speaker_resolution || null,
        error_message: segment.speaker_error || null,
      },
    };

    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}
