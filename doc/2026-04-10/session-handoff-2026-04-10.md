# 2026-04-10 会话交接摘要

本文用于保存本轮讨论的关键结论，供下次继续开发时快速恢复上下文。

## 本轮已完成的代码与验证

- 增加了以下测试/辅助脚本：
  - `tests/replay-realtime-from-wav.ts`
  - `tests/run-pyannote-diarization.ts`
  - `tests/align-soniox-with-pyannote.ts`
  - `scripts/render-alignment-html.ts`
  - `scripts/rebuild-async-conversation.ts`
- 服务端增加了 `/preview/*` 静态路由，可直接展示对齐结果 HTML 页面

## 已验证的重要事实

### 1. 当前主问题不是中文转录，而是 speaker 归属稳定性

- Soniox realtime 文本主链路可继续保留
- 当前更大的问题是 diarization / speaker mapping
- 主要现象：
  - 不同真实人会被并到同一个 speaker
  - 同一真实人会在整场对话中被拆成多个 speaker
  - 切换说话人时，前一两句容易“黏连”到上一个人

### 2. `Soniox text + pyannote diarization` 比当前本地 speaker-mapper 更有希望

- 已使用同一份音频做过 pyannote diarization 测试
- 已做过 Soniox segment 与 pyannote turn 的时间重叠对齐
- 对齐后的 speaker 数更接近真实人数，稳定性优于当前本地手写 cluster 方案
- 但仍存在边界句、短句、低重叠句子的错误归属，说明还需要时序平滑和边界策略

### 3. 当前代码已经有样本裁剪和 embedding 存储框架，但还不是成熟的 voice identity 体系

- 已存在：
  - `speaker_embeddings` 表
  - 样本 clip 裁剪
  - embedding 提取与 speaker 匹配流程
- 但当前体系仍不够稳，原因包括：
  - diarization 不稳定会污染样本
  - 需要确认服务器是否产出真实 embedding，而不是 fallback 向量
  - 还没有完整的 speaker profile/enrollment 策略

### 4. 静音/VAD 目前不在本服务端实现

- 当前 WebSocket 服务收到 PCM 后会直接送给 Soniox realtime
- 目前没有 RMS/VAD/silence gating 逻辑
- 因此当前链路里，静音音频会进入实时 STT

### 5. 从已有真实会话样本看，静音占比很高

- 真实 session 的 WAV 总时长与 session 持续时长基本接近
- 说明当前不是“只在说话时录音/上传”
- 服务器上抽样结果显示，真实会话中的有效文字覆盖时长远低于音频总时长
- 静音优化是值得做的，但优先级仍排在 speaker 稳定性之后

## 当前推荐方案

### 阶段一

- 保留 Soniox realtime 文本主链路
- 引入 pyannote 作为 diarization / speaker 纠偏层
- 增加时间重叠对齐 + 时序平滑 + 边界短句策略

### 阶段二

- 在云端 WebSocket 服务侧做轻量 VAD / silence gating
- 控制是否把 chunk 继续发送到 Soniox
- 保留完整 WAV 归档，不破坏会话时间轴

### 阶段三

- 在前两阶段稳定后，再做 speaker identity / voice profile
- 引入更严格的 enrollment 样本和 profile 维护规则

## 成本结论

按官方公开价格的粗估：

- 只用 Soniox realtime：约 `$0.12/小时`
- Soniox realtime + pyannote diarization：约 `$0.26 ~ $0.28/小时`
- 再加 pyannote identification：约 `$0.44 ~ $0.50/小时`

当前最值得先验证的成本档位是：

- `Soniox realtime + pyannote diarization`

## 下次继续时建议的做法

下次进入项目时，优先让我阅读以下文件：

1. `doc/omi-speaker-identity-integration.md`
2. `doc/three-phase-execution-plan.md`
3. `doc/session-handoff-2026-04-10.md`

然后再说明一句：

- “继续按 2026-04-10 的 speaker 稳定性主线推进”

这样可以最快恢复上下文。
