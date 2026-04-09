import * as fs from 'fs';
import * as path from 'path';

export interface WavWriterOptions {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/**
 * Write PCM audio data to a WAV file with proper RIFF header
 */
export class AudioFileWriter {
  private sampleRate: number;
  private channels: number;
  private bitsPerSample: number;
  private buffer: Buffer[] = [];
  private filePath: string;

  constructor(filePath: string, options: WavWriterOptions) {
    this.filePath = filePath;
    this.sampleRate = options.sampleRate;
    this.channels = options.channels;
    this.bitsPerSample = options.bitsPerSample;
  }

  /**
   * Write PCM data to the file
   */
  write(data: Buffer): void {
    this.buffer.push(data);
  }

  /**
   * Finalize and write the WAV file with proper header
   */
  async finish(): Promise<string> {
    const pcmData = Buffer.concat(this.buffer);
    const wavBuffer = this.createWavBuffer(pcmData);

    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write the WAV file
    fs.writeFileSync(this.filePath, wavBuffer);

    return this.filePath;
  }

  /**
   * Create WAV buffer from PCM data
   */
  private createWavBuffer(pcmData: Buffer): Buffer {
    const byteRate = this.sampleRate * this.channels * this.bitsPerSample / 8;
    const blockAlign = this.channels * this.bitsPerSample / 8;
    const dataSize = pcmData.length;
    const fileSize = 36 + dataSize;

    const header = Buffer.alloc(44);

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);

    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);          // Sub-chunk1 size (16 for PCM)
    header.writeUInt16LE(1, 20);           // Audio format (1 = PCM)
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(this.bitsPerSample, 34);

    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmData]);
  }

  /**
   * Get the file path
   */
  getFilePath(): string {
    return this.filePath;
  }
}

/**
 * Helper to convert raw audio bytes to WAV file
 */
export async function pcmToWavFile(
  pcmData: Buffer,
  filePath: string,
  sampleRate: number = 16000,
  channels: number = 1,
  bitsPerSample: number = 16
): Promise<string> {
  const writer = new AudioFileWriter(filePath, { sampleRate, channels, bitsPerSample });
  writer.write(pcmData);
  return writer.finish();
}
