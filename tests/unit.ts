import assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { validateConnection } from '../src/middleware/auth';
import { SegmentBuilder } from '../src/utils/segment-builder';
import { FinalResultRecorder } from '../src/services/final-result-recorder';
import { finalizeConversation } from '../src/services/conversation-finalizer';
import { AudioFileWriter } from '../src/services/audio-file-writer';
import { assignLocalSpeakerClusters, findBestMatchFromRows } from '../src/services/speaker-mapper';

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

function testSpeakerMatchRequiresThresholdAndMargin(): void {
  const embedding = [1, 0];

  const confidentRows = [
    {
      speaker_id: 'spk-1',
      embedding_json: JSON.stringify([1, 0]),
      speaker_name: 'A',
      speaker_status: 'confirmed',
      identity_label: '同事',
      display_label: 'A',
    },
    {
      speaker_id: 'spk-1',
      embedding_json: JSON.stringify([0.9, 0.1]),
      speaker_name: 'A',
      speaker_status: 'confirmed',
      identity_label: '同事',
      display_label: 'A',
    },
    {
      speaker_id: 'spk-2',
      embedding_json: JSON.stringify([0, 1]),
      speaker_name: 'B',
      speaker_status: 'confirmed',
      identity_label: '同事',
      display_label: 'B',
    },
  ];

  const confident = findBestMatchFromRows(embedding, confidentRows as any, 0.78, 0.06);
  assert.equal(confident?.speaker_id, 'spk-1', 'clear winner should bind to the matching speaker');

  const ambiguousRows = [
    {
      speaker_id: 'spk-1',
      embedding_json: JSON.stringify([1, 0]),
      speaker_name: 'A',
      speaker_status: 'confirmed',
      identity_label: '同事',
      display_label: 'A',
    },
    {
      speaker_id: 'spk-2',
      embedding_json: JSON.stringify([0.998, 0.063]),
      speaker_name: 'B',
      speaker_status: 'confirmed',
      identity_label: '同事',
      display_label: 'B',
    },
  ];

  const ambiguous = findBestMatchFromRows(embedding, ambiguousRows as any, 0.78, 0.06);
  assert.equal(ambiguous, null, 'near-tied matches should defer instead of force-binding');

  const weakRows = [
    {
      speaker_id: 'spk-1',
      embedding_json: JSON.stringify([0.6, 0.8]),
      speaker_name: 'A',
      speaker_status: 'confirmed',
      identity_label: '同事',
      display_label: 'A',
    },
  ];

  const weak = findBestMatchFromRows(embedding, weakRows as any, 0.95, 0.06);
  assert.equal(weak, null, 'scores below threshold should not bind');
}

function testLocalClusterMergesDifferentSonioxLabels(): void {
  const assignments = assignLocalSpeakerClusters(
    [
      { blockIndex: 0, speakerLabel: '1', startMs: 0, endMs: 4000, embedding: [1, 0] },
      { blockIndex: 1, speakerLabel: '3', startMs: 4500, endMs: 7800, embedding: [0.99, 0.01] },
      { blockIndex: 2, speakerLabel: '2', startMs: 8000, endMs: 11000, embedding: [0, 1] },
    ],
    0.72,
    0.04,
    12000,
  );

  const firstCluster = assignments.find(item => item.blockIndex === 0)?.clusterIndex;
  const secondCluster = assignments.find(item => item.blockIndex === 1)?.clusterIndex;
  const thirdCluster = assignments.find(item => item.blockIndex === 2)?.clusterIndex;

  assert.equal(firstCluster, secondCluster, 'similar blocks with different Soniox labels should collapse into one local cluster');
  assert.notEqual(firstCluster, thirdCluster, 'dissimilar speaker should remain in a separate cluster');
}

function testLocalClusterBridgesShortInterjection(): void {
  const assignments = assignLocalSpeakerClusters(
    [
      { blockIndex: 0, speakerLabel: '1', startMs: 0, endMs: 3000, embedding: [1, 0] },
      { blockIndex: 1, speakerLabel: '4', startMs: 3200, endMs: 3600, embedding: null },
      { blockIndex: 2, speakerLabel: '3', startMs: 3800, endMs: 7000, embedding: [0.98, 0.02] },
    ],
    0.72,
    0.04,
    12000,
  );

  const first = assignments.find(item => item.blockIndex === 0);
  const bridge = assignments.find(item => item.blockIndex === 1);
  const third = assignments.find(item => item.blockIndex === 2);

  assert.equal(first?.clusterIndex, third?.clusterIndex, 'same real speaker should still converge even if Soniox label changes');
  assert.equal(bridge?.clusterIndex, first?.clusterIndex, 'short interjection between same-cluster blocks should inherit the surrounding local cluster');
  assert.equal(bridge?.method, 'neighbor_bridge');
}

async function main(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omi-custom-tts-'));

  try {
    await testValidateConnection();
    testSegmentBuilder();
    await testFinalizeConversationHandlesMissingAndDuplicates(tmpDir);
    await testAudioFileWriterStreams(tmpDir);
    testSpeakerMatchRequiresThresholdAndMargin();
    testLocalClusterMergesDifferentSonioxLabels();
    testLocalClusterBridgesShortInterjection();
    console.log('unit tests passed');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
