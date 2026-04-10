import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { validateConnection } from '../src/middleware/auth';
import { SegmentBuilder } from '../src/utils/segment-builder';
import { FinalResultRecorder } from '../src/services/final-result-recorder';
import { finalizeConversation } from '../src/services/conversation-finalizer';
import { AudioFileWriter } from '../src/services/audio-file-writer';

async function testValidateConnection(): Promise<void> {
  process.env.ACCESS_TOKENS = 'token-a,token-b';

  assert.equal(
    validateConnection({ url: '/stt?api_key=token-a' } as any),
    true,
    'expected known token to pass auth',
  );
  assert.equal(
    validateConnection({ url: '/stt?api_key=wrong-token' } as any),
    false,
    'expected unknown token to fail auth',
  );
}

function testSegmentBuilder(): void {
  const builder = new SegmentBuilder();

  builder.setPartial([
    { text: '你好', start_ms: 0, end_ms: 300, is_final: false, speaker: '1' },
    { text: '世界', start_ms: 320, end_ms: 700, is_final: false, speaker: '1' },
  ]);

  const partial = builder.getLastPartial();
  assert.ok(partial, 'expected partial segment to exist');
  assert.equal(partial?.text, '你好世界');

  const finalSeg = builder.consumeFinal([
    { text: '你好', start_ms: 0, end_ms: 300, is_final: true, speaker: '1' },
    { text: '世界', start_ms: 320, end_ms: 700, is_final: true, speaker: '1' },
  ]);
  assert.equal(finalSeg?.text, '你好世界');
  assert.equal(builder.flushPending(), null, 'final emission should clear pending buffer');
}

async function testFinalizeConversationHandlesMissingAndDuplicates(tmpDir: string): Promise<void> {
  const missing = await finalizeConversation({
    sessionId: 'missing',
    rawTranscriptPath: path.join(tmpDir, 'missing.ndjson'),
    outputDir: tmpDir,
    recordingStartedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(missing.segments.length, 0, 'missing raw file should not fail finalization');

  const recorder = new FinalResultRecorder('session-a', tmpDir);
  await recorder.appendResult({
    tokens: [
      { text: '你', start_ms: 0, end_ms: 100, is_final: true, speaker: '1' },
      { text: '好', start_ms: 100, end_ms: 200, is_final: true, speaker: '1' },
    ],
  });
  await recorder.appendResult({
    tokens: [
      { text: '你', start_ms: 0, end_ms: 100, is_final: true, speaker: '1' },
      { text: '好', start_ms: 100, end_ms: 200, is_final: true, speaker: '1' },
    ],
  });

  const finalized = await finalizeConversation({
    sessionId: 'session-a',
    rawTranscriptPath: recorder.filePath,
    outputDir: tmpDir,
    recordingStartedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(finalized.segments.length, 1, 'duplicate final tokens should collapse into one segment');
  assert.equal(finalized.segments[0]?.text, '你好');
}

async function testAudioFileWriterStreams(tmpDir: string): Promise<void> {
  const outPath = path.join(tmpDir, 'sample.wav');
  const writer = new AudioFileWriter(outPath, {
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
  });

  writer.write(Buffer.alloc(320));
  writer.write(Buffer.alloc(160));
  await writer.finish();

  const stat = await fs.stat(outPath);
  assert.equal(stat.size, 44 + 480, 'wav size should equal header plus PCM data');
}

async function main(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omi-custom-tts-'));

  try {
    await testValidateConnection();
    testSegmentBuilder();
    await testFinalizeConversationHandlesMissingAndDuplicates(tmpDir);
    await testAudioFileWriterStreams(tmpDir);
    console.log('unit tests passed');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
