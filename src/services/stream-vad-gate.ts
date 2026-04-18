export type VadMode = 'off' | 'shadow' | 'active';

export interface StreamVadGateOptions {
  mode?: string;
  sampleRate?: number;
  channels?: number;
  bytesPerSample?: number;
  rmsThreshold?: number;
  peakThreshold?: number;
  preRollMs?: number;
  hangoverMs?: number;
}

export interface VadChunkDecision {
  sendBuffers: Buffer[];
  isSpeech: boolean;
  resumeBeforeSend: boolean;
  pauseAfterSend: boolean;
}

export interface VadStatsSnapshot {
  mode: VadMode;
  totalAudioMs: number;
  detectedSpeechMs: number;
  detectedSilenceMs: number;
  sentAudioMs: number;
  suppressedAudioMs: number;
  potentialSuppressedAudioMs: number;
  stateTransitions: number;
  currentlyInSpeech: boolean;
}

interface BufferedChunk {
  data: Buffer;
  durationMs: number;
}

function clampPositiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function normalizeMode(mode: string | undefined): VadMode {
  if (mode === 'active' || mode === 'shadow' || mode === 'off') {
    return mode;
  }
  return 'shadow';
}

function chunkDurationMs(data: Buffer, sampleRate: number, channels: number, bytesPerSample: number): number {
  const frameBytes = channels * bytesPerSample;
  if (frameBytes <= 0 || sampleRate <= 0 || data.length === 0) {
    return 0;
  }
  return Math.round((data.length / frameBytes / sampleRate) * 1000);
}

function analyzePcmS16Le(data: Buffer): { rms: number; peak: number } {
  if (data.length < 2) {
    return { rms: 0, peak: 0 };
  }

  const sampleCount = Math.floor(data.length / 2);
  let sumSquares = 0;
  let peak = 0;

  for (let offset = 0; offset + 1 < data.length; offset += 2) {
    const sample = data.readInt16LE(offset) / 32768;
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

export class StreamVadGate {
  private readonly mode: VadMode;
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly bytesPerSample: number;
  private readonly rmsThreshold: number;
  private readonly peakThreshold: number;
  private readonly preRollMs: number;
  private readonly hangoverMs: number;

  private preRollBuffers: BufferedChunk[] = [];
  private preRollBufferedMs = 0;
  private inSpeech = false;
  private hangoverRemainingMs = 0;

  private totalAudioMs = 0;
  private detectedSpeechMs = 0;
  private detectedSilenceMs = 0;
  private sentAudioMs = 0;
  private activeEquivalentSentMs = 0;
  private stateTransitions = 0;

  constructor(options: StreamVadGateOptions = {}) {
    this.mode = normalizeMode(options.mode);
    this.sampleRate = clampPositiveInt(options.sampleRate ?? 16000, 16000);
    this.channels = clampPositiveInt(options.channels ?? 1, 1);
    this.bytesPerSample = clampPositiveInt(options.bytesPerSample ?? 2, 2);
    this.rmsThreshold = Number.isFinite(options.rmsThreshold) ? Number(options.rmsThreshold) : 0.015;
    this.peakThreshold = Number.isFinite(options.peakThreshold) ? Number(options.peakThreshold) : 0.055;
    this.preRollMs = clampPositiveInt(options.preRollMs ?? 300, 300);
    this.hangoverMs = clampPositiveInt(options.hangoverMs ?? 2200, 2200);
  }

  getMode(): VadMode {
    return this.mode;
  }

  wantsStreamPaused(): boolean {
    return this.mode === 'active' && !this.inSpeech;
  }

  processChunk(data: Buffer): VadChunkDecision {
    const durationMs = chunkDurationMs(data, this.sampleRate, this.channels, this.bytesPerSample);
    const metrics = analyzePcmS16Le(data);
    const isSpeech = metrics.rms >= this.rmsThreshold || metrics.peak >= this.peakThreshold;
    const decision: VadChunkDecision = {
      sendBuffers: [],
      isSpeech,
      resumeBeforeSend: false,
      pauseAfterSend: false,
    };
    let activeEquivalentBuffers: Buffer[] = [];

    this.totalAudioMs += durationMs;
    if (isSpeech) {
      this.detectedSpeechMs += durationMs;
    } else {
      this.detectedSilenceMs += durationMs;
    }

    if (this.mode === 'off') {
      decision.sendBuffers = [data];
      this.sentAudioMs += durationMs;
      this.activeEquivalentSentMs += durationMs;
      return decision;
    }

    this.pushPreRoll(data, durationMs);

    if (isSpeech) {
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.stateTransitions += 1;
        if (this.mode === 'active') {
          decision.resumeBeforeSend = true;
        }
        const flushed = this.flushPreRoll();
        decision.sendBuffers = flushed;
        activeEquivalentBuffers = flushed;
      } else {
        decision.sendBuffers = [data];
        activeEquivalentBuffers = [data];
      }
      this.hangoverRemainingMs = this.hangoverMs;
    } else if (this.inSpeech) {
      decision.sendBuffers = [data];
      activeEquivalentBuffers = [data];
      this.hangoverRemainingMs = Math.max(0, this.hangoverRemainingMs - durationMs);
      if (this.hangoverRemainingMs === 0) {
        this.inSpeech = false;
        this.stateTransitions += 1;
        if (this.mode === 'active') {
          decision.pauseAfterSend = true;
        }
      }
    } else if (this.mode === 'shadow') {
      decision.sendBuffers = [data];
    }

    const sentMs = decision.sendBuffers.reduce((sum, buffer) => (
      sum + chunkDurationMs(buffer, this.sampleRate, this.channels, this.bytesPerSample)
    ), 0);
    const activeEquivalentMs = activeEquivalentBuffers.reduce((sum, buffer) => (
      sum + chunkDurationMs(buffer, this.sampleRate, this.channels, this.bytesPerSample)
    ), 0);
    this.sentAudioMs += sentMs;
    this.activeEquivalentSentMs += activeEquivalentMs;

    return decision;
  }

  getStatsSnapshot(): VadStatsSnapshot {
    const potentialSuppressedAudioMs = this.mode === 'off'
      ? 0
      : Math.max(0, this.totalAudioMs - this.activeEquivalentSentMs);
    const actualSuppressedAudioMs = this.mode === 'active'
      ? Math.max(0, this.totalAudioMs - this.sentAudioMs)
      : 0;

    return {
      mode: this.mode,
      totalAudioMs: this.totalAudioMs,
      detectedSpeechMs: this.detectedSpeechMs,
      detectedSilenceMs: this.detectedSilenceMs,
      sentAudioMs: this.sentAudioMs,
      suppressedAudioMs: actualSuppressedAudioMs,
      potentialSuppressedAudioMs,
      stateTransitions: this.stateTransitions,
      currentlyInSpeech: this.inSpeech,
    };
  }

  private pushPreRoll(data: Buffer, durationMs: number): void {
    this.preRollBuffers.push({ data, durationMs });
    this.preRollBufferedMs += durationMs;

    while (this.preRollBufferedMs > this.preRollMs && this.preRollBuffers.length > 1) {
      const removed = this.preRollBuffers.shift();
      this.preRollBufferedMs -= removed?.durationMs || 0;
    }
  }

  private flushPreRoll(): Buffer[] {
    const out = this.preRollBuffers.map(item => item.data);
    this.preRollBuffers = [];
    this.preRollBufferedMs = 0;
    return out;
  }
}
