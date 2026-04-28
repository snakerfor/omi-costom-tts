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
import { alignByOverlap, smoothBoundaryRows } from '../src/services/speaker-alignment';
import { StreamVadGate } from '../src/services/stream-vad-gate';

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

  const startupNoise = builder.consumeFinal([
    { text: 'But', start_ms: 0, end_ms: 0, confidence: 0.054, is_final: true },
    { text: '.', start_ms: 0, end_ms: 0, confidence: 0.893, is_final: true },
  ]);
  assert.equal(startupNoise, null, 'zero-duration startup But hallucination should be ignored');
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

  const noiseRecorder = new FinalResultRecorder('session-noise', tmpDir);
  await noiseRecorder.appendResult({
    tokens: [
      { text: 'But', start_ms: 0, end_ms: 0, confidence: 0.054, is_final: true },
      { text: '.', start_ms: 0, end_ms: 0, confidence: 0.893, is_final: true },
    ],
  });
  await noiseRecorder.appendFinalSegment({
    id: 'seg-noise',
    text: 'But.',
    start: 0,
    end: 0,
  }, '2026-01-01T00:00:00.000Z', 'seg-noise');
  const finalizedNoise = await finalizeConversation({
    sessionId: 'session-noise',
    rawTranscriptPath: noiseRecorder.filePath,
    outputDir: tmpDir,
    recordingStartedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(finalizedNoise.segments.length, 0, 'recorded startup But noise should not be finalized');

  const segmentRecorder = new FinalResultRecorder('session-b', tmpDir);
  await segmentRecorder.appendFinalSegment({
    id: 'seg-recorded-1',
    text: '我是党蟒',
    start: 1.2,
    end: 2.4,
    speaker: '党蟒',
    speaker_label: 'SPEAKER_01',
    speaker_id: 'spk-1',
    speaker_name: '党蟒',
    speaker_identity: '家人',
    speaker_confidence: 88,
    speaker_resolution: 'xfyun_segment_hit',
  }, '2026-01-01T00:00:00.000Z', 'seg-recorded-1');

  const finalizedFromSegments = await finalizeConversation({
    sessionId: 'session-b',
    rawTranscriptPath: segmentRecorder.filePath,
    outputDir: tmpDir,
    recordingStartedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(finalizedFromSegments.segments.length, 1, 'recorded final segments should be used during finalization');
  assert.equal(finalizedFromSegments.segments[0]?.speaker_id, 'spk-1');
  assert.equal(finalizedFromSegments.segments[0]?.speaker_name, '党蟒');
  assert.equal(finalizedFromSegments.segments[0]?.resolution_method, 'xfyun_segment_hit');
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
  assert.equal(confident.selected?.speaker_id, 'spk-1', 'clear winner should bind to the matching speaker');

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
  assert.equal(ambiguous.selected, null, 'near-tied matches should defer instead of force-binding');
  assert.equal(ambiguous.reason, 'conflict', 'near-tied matches should explain the conflict');

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
  assert.equal(weak.selected, null, 'scores below threshold should not bind');
  assert.equal(weak.reason, 'low_confidence', 'weak matches should explain low confidence');
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

function testSpeakerAlignmentUsesPyannoteOverlap(): void {
  const rows = alignByOverlap(
    [
      {
        id: 'seg-1',
        start_ms: 0,
        end_ms: 2000,
        absolute_start_time: '2026-01-01T00:00:00.000Z',
        absolute_end_time: '2026-01-01T00:00:02.000Z',
        speaker_label: '1',
        text: '你好。',
      },
      {
        id: 'seg-2',
        start_ms: 2000,
        end_ms: 4000,
        absolute_start_time: '2026-01-01T00:00:02.000Z',
        absolute_end_time: '2026-01-01T00:00:04.000Z',
        speaker_label: '2',
        text: '世界。',
      },
    ],
    [
      { speaker: 'SPEAKER_00', start_ms: 0, end_ms: 1900 },
      { speaker: 'SPEAKER_01', start_ms: 2000, end_ms: 4000 },
    ],
  );

  assert.equal(rows[0]?.aligned_speaker, 'SPEAKER_00');
  assert.equal(rows[1]?.aligned_speaker, 'SPEAKER_01');
}

function testSpeakerAlignmentSmoothsBoundaryInterjection(): void {
  const smoothed = smoothBoundaryRows([
    {
      id: 'seg-1',
      start_ms: 0,
      end_ms: 3000,
      duration_ms: 3000,
      original_speaker_label: '1',
      aligned_speaker: 'SPEAKER_00',
      overlap_ratio: 0.98,
      text: '前面这一段是稳定的长句。',
    },
    {
      id: 'seg-2',
      start_ms: 3000,
      end_ms: 3600,
      duration_ms: 600,
      original_speaker_label: '2',
      aligned_speaker: 'SPEAKER_01',
      overlap_ratio: 0.2,
      text: '对。',
    },
    {
      id: 'seg-3',
      start_ms: 3600,
      end_ms: 6200,
      duration_ms: 2600,
      original_speaker_label: '1',
      aligned_speaker: 'SPEAKER_00',
      overlap_ratio: 0.97,
      text: '后面这一段也是稳定长句。',
    },
  ]);

  assert.equal(smoothed[1]?.aligned_speaker, 'SPEAKER_00', 'short weak boundary segment should follow surrounding speaker');
}

function pcmChunk(sample: number, samples: number): Buffer {
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

function testStreamVadGateShadowModeStats(): void {
  const gate = new StreamVadGate({
    mode: 'shadow',
    preRollMs: 200,
    hangoverMs: 400,
    rmsThreshold: 0.01,
    peakThreshold: 0.03,
  });

  gate.processChunk(pcmChunk(0, 3200));
  gate.processChunk(pcmChunk(4000, 3200));
  gate.processChunk(pcmChunk(0, 3200));

  const stats = gate.getStatsSnapshot();
  assert.equal(stats.mode, 'shadow');
  assert.ok(stats.totalAudioMs > 0, 'shadow mode should accumulate audio time');
  assert.ok(stats.detectedSpeechMs > 0, 'shadow mode should detect speech');
  assert.ok(stats.suppressedAudioMs >= 0, 'shadow mode should estimate suppressible silence');
}

function testStreamVadGateActiveModePreservesPreroll(): void {
  const gate = new StreamVadGate({
    mode: 'active',
    preRollMs: 200,
    hangoverMs: 200,
    rmsThreshold: 0.01,
    peakThreshold: 0.03,
  });

  const silence = pcmChunk(0, 1600);
  const speech = pcmChunk(5000, 1600);

  const first = gate.processChunk(silence);
  assert.equal(first.sendBuffers.length, 0, 'leading silence should be gated in active mode');

  const second = gate.processChunk(speech);
  assert.equal(second.resumeBeforeSend, true, 'speech start should request resume');
  assert.equal(second.sendBuffers.length, 2, 'speech start should flush pre-roll plus current chunk');

  const third = gate.processChunk(silence);
  assert.equal(third.sendBuffers.length, 1, 'hangover should keep a trailing chunk');

  const fourth = gate.processChunk(silence);
  assert.equal(fourth.pauseAfterSend, true, 'ending hangover should request pause');
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
    testSpeakerAlignmentUsesPyannoteOverlap();
    testSpeakerAlignmentSmoothsBoundaryInterjection();
    testStreamVadGateShadowModeStats();
    testStreamVadGateActiveModePreservesPreroll();
    console.log('unit tests passed');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
