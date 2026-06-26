# Phase 2 VAD 测试材料（2026-04-12）

目标：验证“长静音是否被有效筛掉”，并确认不破坏说话段转录质量。

## 核心口径

- `speech_ratio = speech_ms / audio_ms`
- `speech_ratio` 越低，越符合“长时间静音”的真实工作场景
- 本清单全部来自服务器 `/www/app.db` 的已完成会话

## 推荐测试集（优先）

### A. 静音主导（必须测）

| session_id | audio_min | speech_min | speech_ratio | file_path |
|---|---:|---:|---:|---|
| session_1775944698512_mg0w92 | 181.14 | 13.19 | 0.0728 | `/www/audio-uploads/session_1775944698512_mg0w92.wav` |
| session_1775916308197_hlswri | 42.15 | 4.37 | 0.1037 | `/www/audio-uploads/session_1775916308197_hlswri.wav` |
| session_1775819445034_z504ao | 15.80 | 1.75 | 0.1105 | `/www/audio-uploads/session_1775819445034_z504ao.wav` |
| session_1775797195159_ml2272 | 44.22 | 5.63 | 0.1272 | `/www/audio-uploads/session_1775797195159_ml2272.wav` |

### B. 均衡（回归对照）

| session_id | audio_min | speech_min | speech_ratio | file_path |
|---|---:|---:|---:|---|
| session_1775792043830_adtvkj | 40.51 | 10.61 | 0.2619 | `/www/audio-uploads/session_1775792043830_adtvkj.wav` |
| session_1775957370785_slj1tu | 18.20 | 6.41 | 0.3524 | `/www/audio-uploads/session_1775957370785_slj1tu.wav` |

### C. 密集（旧样本对照）

| session_id | audio_min | speech_min | speech_ratio | file_path |
|---|---:|---:|---:|---|
| session_1775794508101_mdrlja | 13.97 | 10.12 | 0.7247 | `/www/audio-uploads/session_1775794508101_mdrlja.wav` |

## 建议回放策略

为了贴近真实场景，不建议只测“持续说话”音频。建议每条样本至少跑两组：

1. `baseline`: `STREAM_VAD_MODE=off`
2. `candidate`: `STREAM_VAD_MODE=active` + 仅开启 `STREAM_SILENCE_FINALIZE_MS`

建议初始阈值：

- `STREAM_SILENCE_FINALIZE_MS=120000`（2 分钟）
- `STREAM_NO_AUDIO_FINALIZE_MS=180000`（3 分钟）
- `STREAM_IDLE_FINALIZE_MS=180000`（3 分钟）

## 回放命令模板

```bash
npx ts-node tests/replay-realtime-from-wav.ts \
  --input /www/audio-uploads/<session_id>.wav \
  --server-url ws://127.0.0.1:8089/stt \
  --api-token token-device-a \
  --chunk-ms 200 \
  --speed 4 \
  --settle-ms 15000 \
  --output /www/preview_results/<session_id>_replay.json
```

## 验收重点

1. `conversations.vad_suppressed_audio_ms / vad_total_audio_ms` 是否在静音主导样本显著上升
2. `recording` 长挂会话是否明显减少
3. 说话段句首/句尾是否被截断（人工抽检）
4. speaker 结果是否明显劣化（与阶段一结果对比）
