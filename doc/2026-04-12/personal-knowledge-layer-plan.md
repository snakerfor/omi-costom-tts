# 个人知识层详细方案

本文用于承接当前 `omi-custom-tts` 项目的下一阶段建设目标：把已接入的多源数据沉淀成可被 CLI / Skill / Agent 使用的个人知识层。

当前项目已经具备两类数据入口：

- `CV1 / OMI APP` 上行的音频会话数据
- `OMI sync` 上行的桌面端元数据、文本、截图、观察、视频片段引用

目标不是直接把原始表暴露给模型，而是参考 OMI 官方云后台的分层思路，增加一个稳定的语义层，使 OpenClaw 等 agent 可以在可控、可追溯、低噪声的边界上使用这些数据。

---

## 1. 目标定义

这套知识层要解决 4 个问题：

1. 统一多源时间轴
2. 把原始碎片组织成可理解的上下文块
3. 把长期有效信息从上下文中提炼出来
4. 通过稳定接口给 CLI / Skill / Agent 使用

这套系统的目标不是“替代原始数据库”，而是“在原始数据库之上建立一个面向检索和推理的语义层”。

---

## 2. 参考 OMI 官方逻辑后的结论

结合 OMI 官方文档和后台设计，可以抽出 3 个可直接借鉴的原则：

1. 原始采集层和 AI 使用层要分离  
   官方会区分 conversations、memories、chat/tooling，而不是让模型直接面对原始流数据。

2. 会话和记忆要分层  
   conversation 是时序上下文，memory 是长期有效事实。这两者不是同一个东西。

3. 给模型的入口要有稳定边界  
   最终给 agent 的不是底层表，而是经过结构化和筛选后的检索结果，并且要带来源引用。

因此本项目不建议直接让 Skill 读取当前 `conversations / omi_*` 原始表。更合适的是：

`Raw Ingestion Layer -> Knowledge Layer -> CLI -> Skill -> Agent`

---

## 3. 总体架构

建议拆成 4 层：

### 3.1 Raw Ingestion Layer

保留当前已有表和接入逻辑，不作为 agent 的直接输入。

当前已有主要数据：

- 音频会话：
  - `conversations`
  - `audio_files`
  - `conversation_segments`
  - `speakers`
  - `speaker_embeddings`
- 桌面同步：
  - `omi_screenshots`
  - `omi_transcription_sessions`
  - `omi_transcription_segments`
  - `omi_observations`
  - `omi_memories`
  - `omi_video_chunks`

### 3.2 Normalized Event Layer

新增统一事件层，把不同来源按时间归一成同一时间轴上的原子事件。

建议核心表：

- `knowledge_events`

### 3.3 Semantic Knowledge Layer

在统一事件层基础上，聚合出两个核心语义对象：

- `knowledge_conversations`
- `knowledge_memories`

必要时增加两个辅助对象：

- `knowledge_conversation_items`
- `knowledge_memory_candidates`

### 3.4 Access Layer

先做 CLI，再做 Skill。MCP 放到后续。

建议顺序：

1. CLI
2. Skill
3. MCP

---

## 4. 核心设计理念

### 4.1 knowledge_events 不是 transcript 表

`knowledge_events` 是统一时间轴事件流，不只是“说了什么”，还包括：

- 某一段音频转写文本
- 某一时刻的截图
- 某一时刻的 observation
- 某一段视频片段引用
- 某一条桌面转写 segment

也就是说，它记录的是：

`在某个时间点或时间段，系统知道发生了哪些事件`

### 4.2 knowledge_conversations 是上下文块

`knowledge_conversations` 不是简单等于 `conversations` 原表。

它应该表示：

`一段可以被人或模型整体理解的上下文单元`

一个知识层 conversation 可以来自：

- 一场真实音频对话
- 一段工作时段中的多模态活动
- 一个围绕某个主题的连续事件块

### 4.3 knowledge_memories 是长期事实

`knowledge_memories` 只放长期有效、跨天仍然成立的信息，比如：

- 某人的身份关系
- 某个长期项目背景
- 个人偏好
- 工作习惯
- 反复出现的任务模式

不应该放：

- 临时待办
- 一次性聊天片段
- 某天某一小时的状态

---

## 5. AI 与程序的职责边界

这部分必须明确，否则后面系统会失控。

### 5.1 程序负责

- 时间归一
- 来源关联
- 事件去重
- 事件聚合
- 知识对象主键和状态管理
- 数据落库
- 检索接口
- 引用链和追溯关系

### 5.2 AI 负责

- conversation 摘要
- 主题归纳
- action items 提炼
- memory 候选提名
- 多模态上下文语义融合

### 5.3 最终原则

程序建结构，AI 提语义，程序控入库。

具体地说：

- AI 可以生成 `memory_candidates`
- 但不直接写正式 `knowledge_memories`
- 最终由程序做去重、升级、状态迁移

---

## 6. 数据模型设计

下面是建议的新表。

### 6.1 knowledge_events

建议字段：

```sql
CREATE TABLE IF NOT EXISTS knowledge_events (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  source_key TEXT,
  session_ref TEXT,
  conversation_ref TEXT,
  event_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  content_text TEXT,
  title TEXT,
  participants_json TEXT,
  metadata_json TEXT,
  quality_score REAL,
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

字段说明：

- `source_type`
  - `audio_realtime`
  - `desktop_sync`
  - `desktop_video`
- `source_table`
  - 原始来源表
- `source_row_id`
  - 原始主键
- `session_ref`
  - 原始 session 关联
- `conversation_ref`
  - 原始会话关联
- `event_type`
  - `speech_segment`
  - `desktop_transcript`
  - `screenshot`
  - `observation`
  - `video_ref`
  - `memory_import`
- `participants_json`
  - 原始参与者信息
- `metadata_json`
  - 保留来源特有字段
- `quality_score`
  - 用于后续筛选
- `dedupe_key`
  - 用于规避重复同步

建议索引：

```sql
CREATE INDEX IF NOT EXISTS idx_knowledge_events_started_at ON knowledge_events(started_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_events_event_type ON knowledge_events(event_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_events_session_ref ON knowledge_events(session_ref);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_events_dedupe_key ON knowledge_events(dedupe_key);
```

### 6.2 knowledge_conversations

建议字段：

```sql
CREATE TABLE IF NOT EXISTS knowledge_conversations (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  primary_source TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  participants_json TEXT,
  title TEXT,
  summary TEXT,
  topics_json TEXT,
  action_items_json TEXT,
  quality_score REAL,
  review_status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

说明：

- `source_refs_json`
  - 保存事件来源 ID 列表
- `participants_json`
  - 最终聚合后的参与者
- `summary/topics/action_items`
  - 由 AI 生成
- `review_status`
  - `draft`
  - `accepted`
  - `rejected`

### 6.3 knowledge_conversation_items

用于把 conversation 和 event 建立关系。

```sql
CREATE TABLE IF NOT EXISTS knowledge_conversation_items (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  item_order INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
```

### 6.4 knowledge_memory_candidates

AI 提名层，不直接等于正式 memory。

```sql
CREATE TABLE IF NOT EXISTS knowledge_memory_candidates (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  candidate_text TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL,
  evidence_json TEXT,
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

状态建议：

- `pending`
- `accepted`
- `rejected`
- `merged`

### 6.5 knowledge_memories

正式长期知识层。

```sql
CREATE TABLE IF NOT EXISTS knowledge_memories (
  id TEXT PRIMARY KEY,
  canonical_text TEXT NOT NULL,
  category TEXT NOT NULL,
  subject_key TEXT,
  confidence REAL,
  source_refs_json TEXT NOT NULL,
  first_observed_at TEXT,
  last_observed_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 7. 从现有表到 knowledge_events 的映射

先给出一个总览表，避免后续把“电脑端文本”“截图”“操作语义”“视频引用”混在一起。

| 来源类别 | 原始表 | 是否纳入第一阶段 | 映射后的 `event_type` | 说明 |
|---|---|---:|---|---|
| CV1 / APP 音频转写 | `conversation_segments` | 是 | `speech_segment` | 实时音频转写片段，属于音频侧事件 |
| 电脑端文本转写 | `omi_transcription_segments` | 是 | `desktop_transcript` | 电脑端同步上来的文本片段 |
| 电脑端截图 | `omi_screenshots` | 是 | `screenshot` | 包含 `app_name / window_title / ocr_text / video_chunk_path` |
| 电脑端行为观察 | `omi_observations` | 是 | `observation` | 包含 `context_summary / current_activity / task_title` |
| 电脑端视频片段引用 | `omi_video_chunks` | 否，第二阶段 | `video_ref` | 第一阶段先不重处理视频内容，只作为引用事件接入 |
| 已同步 memory | `omi_memories` | 否，第二阶段 | `memory_import` | 后续与正式 `knowledge_memories` 做合并策略 |

### 7.0 为什么第一阶段先只做 4 类

第一阶段先接入以下 4 类：

1. `conversation_segments`
2. `omi_transcription_segments`
3. `omi_screenshots`
4. `omi_observations`

原因：

- 这 4 类已经足够构成一个可查询的统一时间轴
- 它们都能直接映射成文本或轻量事件
- 能较快支撑 `timeline / conversations` 两个 CLI 能力

而 `omi_video_chunks` 虽然重要，但更适合作为第二阶段增强项：

- 第一阶段把视频只当“引用资产”，而不是语义主输入
- 避免一开始就引入视频理解、抽帧、OCR 二次处理的复杂度
- 先把时间轴、conversation 聚合、memory 提取这条主线跑通

### 7.0.1 电脑端信息是否被覆盖

是的，电脑端信息已经被完整纳入设计里，分别对应：

- 电脑端截屏 -> `omi_screenshots`
- 电脑端文本 -> `omi_transcription_segments`
- 电脑端操作语义 -> `omi_observations`
- 电脑端视频片段 -> `omi_video_chunks`

也就是说，`knowledge_events` 并不是只为音频设计，而是明确为“音频 + 桌面多模态时间轴”设计。

### 7.1 音频会话

来源：

- `conversations`
- `conversation_segments`
- `audio_files`

映射：

- 每一条 `conversation_segments` -> 一条 `knowledge_events(event_type='speech_segment')`
- `started_at / ended_at`
  - 用 `absolute_start_time / absolute_end_time`
- `content_text`
  - 用 `text`
- `participants_json`
  - 用 `speaker_label / speaker_id / speaker_name / speaker_identity`
- `conversation_ref`
  - 指向 `conversations.id`
- `session_ref`
  - 指向 `conversations.session_id`

### 7.2 桌面 transcription

来源：

- `omi_transcription_sessions`
- `omi_transcription_segments`

映射：

- 每一条 `omi_transcription_segments` -> 一条 `knowledge_events(event_type='desktop_transcript')`
- 时间从 `omi_transcription_sessions.started_at + segment.start_time/end_time` 推导

### 7.3 截图

来源：

- `omi_screenshots`

映射：

- 每条 screenshot -> 一条 `knowledge_events(event_type='screenshot')`
- `title`
  - `app_name + window_title`
- `content_text`
  - `ocr_text`

### 7.4 observation

来源：

- `omi_observations`

映射：

- 每条 observation -> 一条 `knowledge_events(event_type='observation')`
- `content_text`
  - `context_summary + current_activity + task_title`

### 7.5 视频片段

来源：

- `omi_video_chunks`

映射：

- 默认只建 `video_ref` 类型事件
- 不直接让 agent 消费视频二进制
- `metadata_json`
  - 保存路径、size、sha256

### 7.6 已同步的 memories

来源：

- `omi_memories`

映射：

- 可以直接作为 `knowledge_events(event_type='memory_import')`
- 或在后续阶段与 `knowledge_memories` 合并

---

## 8. conversation 的聚合逻辑

建议采用“程序先聚合，AI 再增强”的二段式。

### 8.1 程序聚合规则

先按时间窗口和来源构建 conversation 草稿：

1. 音频会话优先
   - 同一个 `conversations.id` 下的 speech events 先聚成一个 conversation draft

2. 桌面时段聚合
   - 连续事件在短间隔内归为一个块
   - 例如间隔不超过 `3-5 分钟`

3. 跨来源拼接
   - 如果音频事件与桌面 observation/screenshot 时间重叠明显，则合并到同一个 conversation draft

### 8.2 AI 增强规则

对每个 draft 调用 LLM，生成：

- `title`
- `summary`
- `topics_json`
- `action_items_json`
- `memory_candidates`

AI 输入不直接用原始表，而是用聚合后的事件序列。

---

## 9. memory 的生成逻辑

建议分三步：

### 9.1 候选提名

AI 从 conversation draft 中提取 memory candidates。

要求 AI 输出时必须包含：

- `candidate_text`
- `category`
- `confidence`
- `evidence_spans`
- `why_it_is_long_term`

### 9.2 程序去重

程序根据：

- `category`
- `subject_key`
- 归一化文本
- embedding 相似度（后续）

对 candidates 做去重和合并。

### 9.3 正式入库

只有满足一定条件的 candidate 才能升级为正式 memory，例如：

- 多次出现
- 高置信度
- 有人工确认
- 来源足够稳定

---

## 10. CLI 设计

建议先做独立 CLI，不让 Skill 直接查数据库。

命令建议：

### 10.1 timeline

```bash
omimem timeline --from 2026-04-12T00:00:00Z --to 2026-04-12T23:59:59Z
```

输出：

- 指定时间范围内的统一事件流

### 10.2 conversations

```bash
omimem conversations --from 2026-04-01 --to 2026-04-12 --limit 20
```

输出：

- conversation 列表
- 摘要
- 参与者
- 来源

### 10.3 memories

```bash
omimem memories --category work
```

输出：

- memory 列表
- 来源引用

### 10.4 ask

```bash
omimem ask "我最近在推进什么事情？"
```

流程：

1. CLI 先从 `knowledge_conversations / knowledge_memories` 检索
2. 再把结果整理成标准 prompt
3. 最后调用模型回答

### 10.5 export

```bash
omimem export --day 2026-04-12 --format md
```

用于人工检查和调试。

---

## 11. Skill 与 Agent 接入策略

Skill 不直接读取数据库。

Skill 只调用 CLI，并消费标准 JSON。

原因：

- 隔离数据库结构变化
- 便于测试
- 便于后续切换实现
- 便于跨 agent 复用

建议 Skill 暴露 3 个高频能力：

1. 获取时间线
2. 获取 conversations
3. 获取 memories

OpenClaw 在需要时再组合调用。

---

## 12. 数据质量与追溯要求

这是本项目成败的关键。

### 12.1 所有 AI 结果必须带引用

无论是 conversation summary 还是 memory，都必须可回溯到：

- event id
- source table
- source row id

### 12.2 区分“原始事实”和“AI 推断”

不能混。

例如：

- 原始事实：
  - 某时刻说了某句话
  - 某时刻桌面前台 app 是什么
- AI 推断：
  - 这段对话在讨论报价
  - 这可能是长期工作项目

### 12.3 清理策略

原始表可保留，语义层可重建。

因此知识层生成脚本必须支持：

- 全量重建
- 指定日期重建
- 指定 source 重建

---

## 13. MVP 实施顺序

建议按以下顺序做，避免一次铺太大。

### 阶段 A：事件层

先实现：

- `knowledge_events`
- 从现有表抽取统一事件
- 支持按时间查询

验收：

- 能把音频、桌面文字、截图、observation 放到同一时间轴

### 阶段 B：conversation 层

再实现：

- `knowledge_conversations`
- `knowledge_conversation_items`
- conversation draft 聚合
- conversation summary AI 增强

验收：

- 能按天输出可读的上下文块

### 阶段 C：memory 候选层

再实现：

- `knowledge_memory_candidates`
- LLM 候选提名
- 候选去重

验收：

- 能稳定产出 memory candidates

### 阶段 D：正式 memories + CLI

最后实现：

- `knowledge_memories`
- CLI 的 `timeline / conversations / memories / ask`

验收：

- OpenClaw 可通过 Skill 使用这套知识层

---

## 14. 当前建议的最近执行项

下一轮最值得做的是：

1. 在现有数据库上新增 `knowledge_events`
2. 先只接 4 类输入：
   - `conversation_segments`
   - `omi_transcription_segments`
   - `omi_screenshots`
   - `omi_observations`
3. 写一个离线重建脚本：
   - `scripts/rebuild-knowledge-events.ts`
4. 提供一个只读 CLI 原型：
   - `timeline`
   - `conversations`

这一步做完，后续 conversation summary 和 memory 提炼才有稳定基础。

---

## 15. 一句话结论

最合适当前项目的路线不是“让 Skill 直接查原始表”，而是：

`原始采集层 -> 统一事件层 -> conversation 层 -> memory 层 -> CLI -> Skill -> Agent`

其中：

- 事件层按时间统一多模态数据
- conversation 层保留完整上下文
- memory 层沉淀长期事实
- AI 负责语义提炼
- 程序负责结构、去重、落库、追溯

这是当前最稳、最可扩展、也最贴近 OMI 官方后台思路的方案。
