# OMI Custom TTS 项目 Speaker Identity 集成方案

## 1. 文档目标

本文基于 `gpt.md` 的总体思路，并结合当前仓库 `omi-custom-tts` 的实际代码结构，给出一份**可直接落地到现有实时 Soniox 网关项目**的集成方案。

目标不是新起一个离线转写项目，而是在当前已有能力上扩展出：

- 会话级归档
- Final token 持久化
- 正式 transcript / segment 入库
- 匿名 speaker 自动创建与复用
- 人工确认姓名与历史回填

---

## 2. 当前项目现状评估

当前仓库已经具备以下基础能力：

### 2.1 已有能力

1. **OMI WebSocket 接入层**
   - 文件：`src/index.ts`
   - 文件：`src/handlers/app-connection.ts`
   - 能力：接收 OMI APP 实时音频流，建立 Soniox 会话，回传 `segments`。

2. **Soniox Realtime STT 接入**
   - 文件：`src/services/soniox-session.ts`
   - 能力：接入 Soniox `stt-rt-v4`，启用 diarization。

3. **实时 Segment 构建**
   - 文件：`src/utils/segment-builder.ts`
   - 能力：基于 Soniox token 为 APP 组装 `segments[{ text, start, end, speaker }]`。

4. **原始音频归档能力**
   - 文件：`src/services/audio-file-writer.ts`
   - 能力：实时写入 PCM，并在结束时生成 WAV。

### 2.2 当前缺口

当前仓库尚不具备以下核心模块：

- conversation/session 持久化模型
- raw transcript 持久化层
- transcript finalize 流程
- conversation_segments 正式入库
- speaker identity mapping
- speaker / embedding 数据库
- 匿名 speaker 管理 API

---

## 3. 与 `gpt.md` 的映射关系

`gpt.md` 更偏向“目录扫描 + 离线 WAV + Soniox Async”的处理模式。

当前项目则是“OMI APP 实时音频 + Soniox Realtime + WebSocket 回传”的模式。

因此本项目不建议照搬 `gpt.md` 中的：

- `scanner.js`
- `audio_files: pending -> submitted -> completed`
- Soniox async job polling 主链路

而应保留其业务思想，并改造成适配实时场景的结构。

### 3.1 保留的核心思想

以下思想保持不变：

1. Soniox 只负责：
   - 语音转文字
   - diarization

2. 本地系统负责：
   - segment 聚合
   - speaker identity mapping
   - 匿名 speaker 创建与复用
   - 人工确认姓名与历史回填

3. 时间字段双存：
   - 相对时间：`start_ms` / `end_ms`
   - 绝对时间：`absolute_start_time` / `absolute_end_time`

### 3.2 需要改造的部分

实时场景下，主对象应从“离线文件”改为“会话 conversation”。

因此本项目采用：

```text
WebSocket session -> conversation -> raw transcript -> finalized segments
```

而不是：

```text
inbox wav -> async transcription job -> raw json -> segments
```

---

## 4. 核心设计结论

### 4.1 不在实时阶段写正式 segment 表

实时阶段的职责是：

- 服务 APP 实时展示
- 保存事实层数据

不建议在实时阶段把 APP 返回用的 segment 直接写入正式数据库，因为：

- 它是展示层产物
- 可能受到 partial/final 逻辑影响
- 其边界不一定适合作为最终归档事实

### 4.2 正式入库发生在 finalize 阶段

在以下事件触发时统一归档：

- 收到 `CloseStream`
- WebSocket 正常关闭
- 异常断开后的兜底 finalize

归档时：

1. 完成 WAV 文件落盘
2. 关闭 raw transcript 文件
3. 读取 final token 原始记录
4. 构建正式 transcript / segments
5. 写入数据库
6. 触发 speaker identity mapping

### 4.3 不再二次调用 Soniox 做整段转写

本方案默认：

- 实时阶段已经通过 Soniox realtime 拿到 final token
- finalize 阶段直接复用这些 final token

因此第一阶段**不再把整段 WAV 重新送给 Soniox 做第二遍转写**。

这样可以：

- 避免重复计费
- 降低链路复杂度
- 最大限度复用当前项目已有逻辑

---

## 5. Final Token 持久化策略

### 5.1 结论

**不建议把整场 session 的 final token 全量只保存在内存中。**

原因：

- session 可能持续 1 小时甚至更长
- 进程崩溃会导致数据全部丢失
- 内存态不适合做可追溯归档

### 5.2 推荐方案：NDJSON 增量落盘

每个 session 建一个 raw transcript 文件：

```text
data/raw-results/{sessionId}.ndjson
```

每收到一个 Soniox final result 批次，就追加一行 JSON。

### 5.3 为什么不保存 APP 的 segment

APP segment 是面向前端展示的组装结果，不建议作为长期事实层保存对象。

建议保留的事实层是：

1. WAV 原始音频
2. Soniox final token 事件流

---

## 6. 时间模型设计

### 6.1 只保存 final token 是否足够

**足够，前提是 final token 自带：**

- `text`
- `start_ms`
- `end_ms`
- `speaker`
- `is_final`

当前项目 `src/types/index.ts` 已按此结构定义。

### 6.2 相对时间来源

segment 的相对时间来自 token 聚合：

- `segment.start_ms = firstToken.start_ms`
- `segment.end_ms = lastToken.end_ms`

### 6.3 绝对时间来源

绝对时间不从 Soniox 直接获取，而是基于 conversation 起点推导。

### 6.4 conversation 起点基准

推荐记录两个时间：

- `websocket_connected_at`
- `first_audio_frame_at`

其中：

**`first_audio_frame_at` 作为音频时间轴 0 点**。

### 6.5 绝对时间计算公式

```text
absolute_start_time = first_audio_frame_at + start_ms
absolute_end_time   = first_audio_frame_at + end_ms
```

### 6.6 为什么不能用文件时间倒推

`gpt.md` 的离线场景使用：

```text
recording_start = file_mtime - duration
```

但当前项目是实时会话场景，拥有更准确的 session 起点，因此不建议继续用文件时间倒推。

---

## 7. 目标架构

```text
OMI APP
  │ WebSocket PCM
  ▼
app-connection.ts
  ├─ 鉴权
  ├─ 转发 Soniox realtime
  ├─ 回传 APP segments
  ├─ AudioFileWriter -> 保存 WAV
  └─ FinalResultRecorder -> 追加写 raw transcript NDJSON

CloseStream / ws.close
  ▼
ConversationFinalizer
  ├─ 完成 WAV
  ├─ 关闭 raw transcript
  ├─ 读取 NDJSON
  ├─ final tokens -> words
  ├─ words -> segments
  ├─ 计算 absolute time
  ├─ conversations / audio_files / conversation_segments 入库
  └─ 触发 SpeakerIdentityService

SpeakerIdentityService
  ├─ 按 speaker_label 聚合
  ├─ 从 WAV 裁片
  ├─ 调 Python 提 embedding
  ├─ 匹配 speakers
  ├─ 匹配失败则创建匿名 speaker
  └─ 更新 conversation_segments.speaker_id / speaker_name

Admin API
  ├─ GET /speakers
  ├─ GET /speakers/anonymous
  └─ POST /speakers/:speakerId/confirm
```

---

## 8. 数据分层设计

### 8.1 事实层

#### 音频事实层
- `data/audio-uploads/{sessionId}.wav`

#### 文本事实层
- `data/raw-results/{sessionId}.ndjson`

这一层保留最接近原始输入/输出的材料，便于：

- 崩溃恢复
- 排查 Soniox 行为
- 后续重建 segment
- 重新执行 speaker mapping

### 8.2 业务层

业务层持久化到 SQLite：

- `conversations`
- `audio_files`
- `conversation_segments`
- `speakers`
- `speaker_embeddings`

---

## 9. 数据库设计（适配当前实时架构）

### 9.1 `conversations`

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  uid TEXT,
  language TEXT,
  status TEXT NOT NULL,
  websocket_connected_at TEXT,
  first_audio_frame_at TEXT,
  ended_at TEXT,
  raw_result_path TEXT,
  audio_file_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_message TEXT
);
```

### 9.2 `audio_files`

```sql
CREATE TABLE IF NOT EXISTS audio_files (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  duration_ms INTEGER,
  sample_rate INTEGER,
  channels INTEGER,
  bits_per_sample INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 9.3 `conversation_segments`

```sql
CREATE TABLE IF NOT EXISTS conversation_segments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  audio_file_id TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  absolute_start_time TEXT,
  absolute_end_time TEXT,
  speaker_label TEXT,
  speaker_id TEXT,
  speaker_name TEXT,
  text TEXT NOT NULL,
  confidence REAL,
  resolution_method TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 9.4 `speakers`

```sql
CREATE TABLE IF NOT EXISTS speakers (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL,
  display_label TEXT,
  sample_text TEXT,
  sample_segment_id TEXT,
  sample_audio_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 9.5 `speaker_embeddings`

```sql
CREATE TABLE IF NOT EXISTS speaker_embeddings (
  id TEXT PRIMARY KEY,
  speaker_id TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  sample_rate INTEGER,
  duration_ms INTEGER,
  source_conversation_id TEXT,
  source_segment_id TEXT,
  source TEXT,
  created_at TEXT NOT NULL
);
```

---

## 10. Raw Transcript 文件格式

### 10.1 文件路径

```text
data/raw-results/{sessionId}.ndjson
```

### 10.2 每行结构

建议每个 Soniox final result 批次写一行，而不是每个 token 一行：

```json
{
  "ts": "2026-04-09T22:10:05.456Z",
  "event": "soniox_final_result",
  "result_index": 12,
  "tokens": [
    {
      "text": "你好",
      "start_ms": 1200,
      "end_ms": 1600,
      "speaker": "1",
      "confidence": 0.98,
      "is_final": true
    },
    {
      "text": "啊",
      "start_ms": 1610,
      "end_ms": 1700,
      "speaker": "1",
      "confidence": 0.95,
      "is_final": true
    }
  ]
}
```

### 10.3 最低保留字段

每个 final token 至少保留：

- `text`
- `start_ms`
- `end_ms`
- `speaker`
- `is_final`
- `confidence`（建议保留）

---

## 11. Finalize 流程设计

### 11.1 触发时机

优先级：

1. `CloseStream`
2. Soniox `finish()` 后尾包收完
3. `ws.close` 兜底

### 11.2 关键原则

- finalize 必须是 `finalizeOnce()`，避免重复执行
- transcript 入库和 speaker mapping 解耦
- speaker mapping 可以异步执行

### 11.3 流程步骤

```text
收到 CloseStream
  │
  ├─ finish WAV writer
  ├─ 通知 Soniox finish
  ├─ 等待尾部 final token
  ├─ 关闭 raw transcript writer
  ├─ 读取 raw transcript NDJSON
  ├─ 提取 final tokens
  ├─ final tokens -> internal words
  ├─ words -> finalized segments
  ├─ 计算 absolute times
  ├─ 写入 conversations/audio_files/conversation_segments
  └─ 异步触发 speaker identity mapping
```

---

## 12. Segment 聚合规则

### 12.1 目标

将 final token 组装为业务层稳定 `segment`。

### 12.2 分段建议规则

当满足任意条件时切分：

- `speaker` 变化
- token gap 超过阈值（例如 500~1200ms）
- 达到最大段时长
- 前一个 token 以句末标点结束

### 12.3 结果字段

每个 segment 生成：

- `text`
- `start_ms`
- `end_ms`
- `speaker_label`
- `absolute_start_time`
- `absolute_end_time`

---

## 13. Speaker Identity Mapping 设计

### 13.1 处理时机

在 transcript finalize 成功后执行。

### 13.2 流程

1. 读取当前 conversation 的 `conversation_segments`
2. 按 `speaker_label` 聚合
3. 选取候选 segment（优先时长更长、文本更多）
4. 从完整 WAV 中裁出 1~3 个样本片段
5. 调 Python embedding 提取脚本
6. 与历史 `speaker_embeddings` 进行 cosine similarity 比较
7. 匹配成功则绑定已有 speaker
8. 匹配失败则创建匿名 speaker

### 13.3 匿名 speaker 设计原则

匿名 speaker 是正式持久化对象，不是临时变量。

因此：

- 第一次遇到可创建匿名 speaker
- 后续同一声音应优先匹配到已有匿名 speaker
- 用户填写姓名后更新同一个 `speaker_id`

---

## 14. API 设计

建议新增 admin API：

### 14.1 `GET /speakers`
返回全部 speaker。

### 14.2 `GET /speakers/anonymous`
返回待确认匿名 speaker 列表。

### 14.3 `POST /speakers/:speakerId/confirm`
将匿名 speaker 更新为真实姓名，并同步回填历史 segments。

请求体：

```json
{
  "realName": "张三"
}
```

---

## 15. 目录结构改造建议

```text
src/
├── index.ts
├── handlers/
│   └── app-connection.ts
├── middleware/
│   └── auth.ts
├── services/
│   ├── soniox-session.ts
│   ├── audio-file-writer.ts
│   ├── final-result-recorder.ts
│   ├── conversation-finalizer.ts
│   ├── audio-clipper.ts
│   ├── python-embedding.ts
│   └── speaker-service.ts
├── db/
│   ├── index.ts
│   ├── schema.ts
│   ├── conversations.repo.ts
│   ├── audio-files.repo.ts
│   ├── segments.repo.ts
│   ├── speakers.repo.ts
│   └── embeddings.repo.ts
├── routes/
│   └── speakers.ts
├── utils/
│   ├── segment-builder.ts
│   ├── persistent-segment-builder.ts
│   ├── similarity.ts
│   ├── time-resolver.ts
│   └── ids.ts
└── types/
    └── index.ts

scripts/
├── extract_embedding.py
└── enroll_speaker.ts

data/
├── audio-uploads/
├── raw-results/
└── clips/
```

---

## 16. 分阶段实施计划

### Phase 1：归档闭环

目标：把“实时会话 -> 正式入库”跑通。

实施项：

1. 增加 SQLite 初始化与 schema
2. 增加 `conversations` / `audio_files` / `conversation_segments`
3. 增加 `final-result-recorder.ts`
4. 在 `app-connection.ts` 中记录：
   - session_id
   - first_audio_frame_at
   - raw transcript ndjson
5. 增加 `conversation-finalizer.ts`
6. finalize 时正式入库

验收标准：

- 每场会话结束后，数据库中有 conversation 记录
- 有 WAV 文件路径
- 有 raw transcript 文件路径
- 有正式 `conversation_segments`

### Phase 2：speaker identity mapping

目标：自动创建/复用匿名 speaker。

实施项：

1. 建 `speakers` / `speaker_embeddings`
2. 增加 `audio-clipper.ts`
3. 增加 `python-embedding.ts`
4. 增加 `extract_embedding.py`
5. 实现 `speaker identity service`

验收标准：

- 相同声音跨会话能复用同一匿名 speaker

### Phase 3：人工确认与回填

目标：完成后台 speaker 管理。

实施项：

1. 增加 `GET /speakers`
2. 增加 `GET /speakers/anonymous`
3. 增加 `POST /speakers/:speakerId/confirm`
4. 更新所有历史 `conversation_segments.speaker_name`

验收标准：

- 后台可将匿名 speaker 改为真实姓名
- 历史 segments 自动回填

---

## 17. 风险与验证点

### 17.1 Soniox final token 完整性

需要实测确认：

- final token 是否覆盖整场会话
- `finish()` 后是否还有尾包
- 是否会出现时间重叠或遗漏

### 17.2 时间基准准确性

需要确认：

- 以 `first_audio_frame_at` 作为 0 点是否最稳定
- 是否存在首帧之前的连接空窗影响

### 17.3 实时 builder 与持久化 builder 分工

当前 `src/utils/segment-builder.ts` 更适合回 APP。

建议新增持久化专用 builder，避免混用导致：

- 展示逻辑和归档逻辑耦合
- partial/final 边界干扰最终 transcript

### 17.4 finalize 幂等

必须设计：

- `finalizeOnce()`
- conversation 状态机

以防重复归档。

---

## 18. 最终结论

对于当前 `omi-custom-tts` 项目，最合适的集成方案不是重做一个异步离线转写系统，而是：

1. 保留现有 Soniox realtime + OMI WebSocket 链路
2. 继续实时返回 APP 所需 segments
3. 实时保存：
   - WAV
   - Soniox final token NDJSON
4. 在 session finalize 时统一生成正式 transcript
5. 再基于完整 WAV + finalized segments 执行 speaker identity mapping
6. 通过后台 API 管理匿名 speaker 与真实姓名回填

该方案既继承了 `gpt.md` 的核心业务设计，又与当前项目的实时网关定位完全兼容。