# 科大讯飞声纹识别流程与声纹语料管理重设计

本文基于当前后端代码实现和后续讨论整理，目标是把现有偏“会话维度”的声纹管理，调整为“发言人维度”的长期声纹语料管理。

## 1. 设计目标

声纹语料管理的核心对象应该是“发言人”，不是“某一次会话”。

系统长期运行后，会同时存在两类发言人：

- 已确认发言人：已经有本地 speaker，可能已经注册过讯飞声纹特征。
- 新发言人：暂时没有讯飞声纹特征，但可以通过人工跨会话收集语料后注册。

一个重要发言人可能出现在很多会话中。人工管理语料时，应该能够跨会话搜索、试听、筛选、选择片段，并把这些片段沉淀到该发言人的语料库中。

## 2. 当前流程的主要问题

当前后端已经具备讯飞调用、音频裁剪、音频拼接、特征创建和特征更新能力，但语料管理流程偏向按 conversation 处理：

1. 针对某个会话扫描未识别片段。
2. 按会话内 speaker label 分组。
3. 人工选择片段。
4. 直接创建或更新讯飞 feature。

这个流程的问题是：

- 会话内 speaker label 不是稳定身份，跨会话后更不可靠。
- 单个会话内的归类结果不适合作为长期声纹语料管理依据。
- 选择片段后直接同步讯飞，缺少语料池沉淀和调整空间。
- 讯飞单次注册/更新音频最大约 4MB，当前逻辑更像技术性截断，不适合人工精细管理。

因此，后续应把语料管理从“会话未识别片段处理”改成“某个 speaker 的候选/正式语料库维护”。

## 3. 新的核心概念

### 3.1 发言人

发言人仍使用本地 `speakers` 表作为身份主表。

讯飞返回的是 `featureId`，不能直接当作发言人身份使用。后端必须继续通过本地 `speaker_voiceprint_features` 表，把讯飞 `featureId` 映射到本地 `speaker_id`。

### 3.2 候选语料

候选语料是“可能适合某个发言人，但暂时不进入讯飞正式声纹特征”的片段。

候选语料来源可以包括：

- 人工跨会话搜索后手动加入。
- 某段实际属于该发言人，但讯飞没有识别出来。
- 某段实际属于该发言人，但讯飞识别为低置信、冲突或无匹配。
- 某段声音质量好、说话方式有代表性，适合作为后续替换正式语料的备选。

候选语料不自动更新讯飞。

### 3.3 正式语料

正式语料是当前真正用于生成或更新讯飞声纹 feature 的片段集合。

正式语料有容量约束。后端应在同步讯飞前计算拼接后的音频大小，确保不超过 `XFYUN_MAX_ENROLLMENT_BYTES`，默认 4MB。

正式语料不是无限追加，而是人工维护的一组精选片段。

### 3.4 只有两类语料状态

语料状态只保留两类：

- `candidate`：候选语料
- `formal`：正式语料

如果某个片段不适合某个发言人，直接不要加入该发言人的语料库即可；如果已经加入，则从候选或正式中移除。

## 4. 目标业务流程

### 4.1 创建或选择发言人

用户先确定要管理的发言人：

- 选择已有 speaker。
- 或创建新 speaker，填写姓名、身份标签、备注等基础信息。

新 speaker 创建后，不要求立即注册讯飞。可以先积累候选语料。

### 4.2 跨会话选择语料

用户围绕某个 speaker 跨会话查找片段。

可用筛选条件包括：

- 会话时间范围。
- 文本关键词。
- 原始 speaker label。
- 当前 speaker 绑定状态。
- 声纹识别结果：无匹配、低置信、冲突、命中某个 speaker。
- 分数区间。
- 片段时长。

用户试听片段后，可以把片段加入该 speaker 的候选语料或正式语料。

### 4.3 管理候选语料

候选语料用于长期积累和观察。

用户可以：

- 从跨会话搜索结果加入候选。
- 从正式语料移回候选。
- 从候选提升为正式。
- 从候选移除。

候选语料变化只影响本地数据库，不调用讯飞。

### 4.4 管理正式语料

正式语料用于下一次同步讯飞。

用户可以：

- 从候选提升片段到正式。
- 直接从搜索结果加入正式。
- 把正式片段移回候选。
- 从正式语料中移除。

后端需要展示正式语料的预计拼接大小和预计时长，让用户在同步讯飞前知道是否超过限制。

如果正式语料超过 4MB，不能静默丢弃片段。应返回超限信息，让用户手动调整正式语料集合。

### 4.5 同步讯飞声纹库

同步讯飞必须是显式操作。

用户确认某个 speaker 的正式语料集合后，可以先点击“生成试听音频”或“试听同步音频”。后端根据当前正式语料集合生成一份临时拼接 wav，返回音频 URL，让用户试听。

试听音频是预览产物，不写入同步批次表。只有用户最终点击“保存并同步讯飞”时，才生成正式的同步批次记录。

预览流程：

1. 读取该 speaker 的所有正式语料。
2. 按片段时间或人工排序生成音频列表。
3. 从原会话音频中裁剪片段。
4. 拼接成一份 preview wav。
5. 校验音频大小不超过 4MB。
6. 保存到预览目录。
7. 返回音频 URL、大小、时长、片段数，供用户试听。

保存并同步流程：

1. 用户试听后确认当前正式语料集合没问题。
2. 后端创建 `speaker_enrollment_batches`，状态为 `pending`。
3. 后端生成本次正式同步要发送给讯飞的 enrollment wav。
4. 如果该 speaker 没有 active 讯飞 feature，调用 `createFeature`。
5. 如果已有 active 讯飞 feature，调用 `updateFeature`。
6. 更新 `speaker_voiceprint_features`。
7. 写入 `speaker_enrollment_segments`，记录本次正式同步使用的片段明细。
8. 更新 `speaker_enrollment_batches`，写入 `audio_path`、`duration_ms`、`audio_size_bytes`、`feature_id`、`status`。

同步成功后，讯飞声纹库才真正更新。

关键约束：

- 预览音频只是试听用的临时文件，不代表已经同步讯飞。
- 只有点击“保存并同步讯飞”后，才写入 `speaker_enrollment_batches`。
- 保存时写入 `speaker_enrollment_batches.audio_path` 的文件，就是本次实际发送给讯飞的拼接音频。
- 如果正式语料发生变化，已有预览音频应视为过期，需要重新生成试听音频。
- 后端应保证预览音频和正式同步音频基于同一份正式语料快照、同一套排序和同一套裁剪参数生成。
- 预览接口应返回正式语料快照摘要；同步接口收到摘要后，应校验当前正式语料没有变化。若已变化，应拒绝同步并要求重新生成试听音频。
- 如果后续实现选择复用预览 wav 作为正式同步音频，必须先校验快照摘要一致，并把该文件复制或移动到正式 enrollment 路径后，再写入 `speaker_enrollment_batches.audio_path`。

## 5. 目标识别流程

### 5.1 实时识别

实时识别流程可以继续沿用当前后端逻辑：

1. 实时音频经过 VAD 后送给转写服务。
2. final segment 产生后，从发送音频 ring buffer 中取出该片段 PCM。
3. 调用讯飞 `searchFea`，topK=2。
4. 根据分数阈值和 top1/top2 差值判断是否自动命中。
5. 通过 `speaker_voiceprint_features` 把 `featureId` 映射成本地 speaker。
6. 映射成功才写入 `speaker_id`、`speaker_name`、`speaker_identity`。
7. 映射失败则不能自动绑定 speaker。

实时识别只负责“尽可能识别当前片段”，不负责语料入库。

### 5.2 离线扫描

离线扫描也可以继续保留，但定位应调整为“发现候选线索”，而不是“围绕当前会话完成声纹注册”。

离线扫描流程：

1. 对会话片段裁剪音频。
2. 调用讯飞 `searchFea`。
3. 写入 `segment_voiceprint_matches`。
4. 对高置信命中且本地 feature 映射成功的片段，可以继续自动绑定 speaker。
5. 对低置信、冲突、无匹配、映射失败的片段，只作为候选线索展示。

离线扫描不应直接推动新 speaker 注册，也不应把会话内 speaker label 当作可靠身份。

## 6. 建议的数据模型调整

建议新增一张 speaker 语料表，用来持久化候选/正式语料关系。

```sql
CREATE TABLE speaker_voiceprint_materials (
  id TEXT PRIMARY KEY,
  speaker_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  material_status TEXT NOT NULL, -- candidate | formal
  source TEXT,
  note TEXT,
  sort_order INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(speaker_id, segment_id)
);
```

建议索引：

```sql
CREATE INDEX idx_speaker_voiceprint_materials_speaker_id
  ON speaker_voiceprint_materials(speaker_id);

CREATE INDEX idx_speaker_voiceprint_materials_status
  ON speaker_voiceprint_materials(material_status);

CREATE INDEX idx_speaker_voiceprint_materials_segment_id
  ON speaker_voiceprint_materials(segment_id);
```

说明：

- `speaker_id` 表示该片段被纳入哪个发言人的语料库。
- `segment_id` 指向 `conversation_segments`。
- `material_status` 只允许 `candidate` 或 `formal`。
- `source` 可记录来源，例如 `manual_search`、`xfyun_low_confidence`、`xfyun_conflict`、`xfyun_no_match`、`xfyun_hit_candidate`。
- `note` 可记录人工备注。
- `sort_order` 用于正式语料拼接顺序。

这张表是当前状态表，不是同步历史表：

- 只保存当前某个 speaker 的候选/正式语料集合。
- 必须保存 `speaker_id`，用于关联本地 `speakers.id`。
- 不保存讯飞 `feature_id`。
- 不保存同步状态。
- 不保存发送给讯飞的音频路径。
- 用户调整候选/正式语料时，这张表可以被更新或删除。

现有 `speaker_enrollment_batches` 和 `speaker_enrollment_segments` 继续用于记录每次正式同步讯飞的批次和片段明细。

同步历史的边界：

- `speaker_enrollment_batches` 记录某一次实际同步讯飞的结果，包括 `speaker_id`、`feature_id`、`audio_path`、状态、音频大小和时长。
- `speaker_enrollment_segments` 记录某一次同步实际使用了哪些 segment。
- batch 记录是历史快照，不跟随当前候选/正式语料变化而修改。
- 如果要追溯某条语料是否真正进入过讯飞，应通过 `speaker_enrollment_segments -> speaker_enrollment_batches.feature_id` 查询，而不是从当前语料表反推。

不建议新增一张和 `speaker_enrollment_batches` 字段高度相似的同步草稿表。试听音频属于临时预览产物，可以只保存文件，不写业务表；真正同步成功或失败时，仍统一写入现有批次表。这样可以避免两张表之间出现状态、音频路径、feature id、批次关系不一致的问题。

建议约定预览音频文件路径，例如：

```text
data/clips/voiceprint/previews/:speakerId/:previewId.wav
```

预览文件可以由定时清理或下次生成时覆盖，不参与长期业务状态管理。

## 7. 建议 API

### 7.1 查询某个 speaker 的语料库

```http
GET /api/admin/speakers/:speakerId/voiceprint/materials
```

返回：

- speaker 基础信息。
- candidate materials。
- formal materials。
- formal 预计总时长。
- formal 预计拼接大小。
- 当前 active 讯飞 feature 信息。
- 最近同步批次。

### 7.2 跨会话搜索可选语料

```http
GET /api/admin/voiceprint/material-candidates
```

查询参数：

- `speakerId`
- `q`
- `startTime`
- `endTime`
- `decision`
- `minScore`
- `maxScore`
- `minDurationMs`
- `maxDurationMs`
- `speakerBound`
- `page`
- `pageSize`

该接口只负责搜索片段，不改变语料状态。

### 7.3 加入或移动语料

```http
POST /api/admin/speakers/:speakerId/voiceprint/materials
```

请求体：

```json
{
  "segmentIds": ["seg_1", "seg_2"],
  "materialStatus": "candidate"
}
```

`materialStatus` 只能是 `candidate` 或 `formal`。

如果某个 segment 已经存在于该 speaker 的语料库，则更新状态。

### 7.4 从语料库移除

```http
DELETE /api/admin/speakers/:speakerId/voiceprint/materials/:segmentId
```

只删除该 speaker 与该 segment 的语料关系。

### 7.5 生成试听音频

```http
POST /api/admin/speakers/:speakerId/voiceprint/xfyun/preview
```

流程：

1. 后端读取该 speaker 的 formal materials。
2. 裁剪并拼接音频。
3. 校验 4MB 限制。
4. 保存拼接后的 preview wav 文件。
5. 返回音频 URL、时长、大小、片段数、正式语料快照摘要。

如果超限，返回错误和当前预计大小，不自动丢弃任何正式语料。

### 7.6 保存并同步讯飞

```http
POST /api/admin/speakers/:speakerId/voiceprint/xfyun/sync
```

流程：

1. 后端读取该 speaker 的 formal materials。
2. 校验请求中的正式语料快照摘要仍然匹配当前 formal materials。
3. 生成本次正式同步用的 enrollment wav。
4. 写入 `speaker_enrollment_batches(status='pending')`。
5. 调用 `createFeature` 或 `updateFeature`。
6. 写入 `speaker_enrollment_segments`。
7. 更新 `speaker_enrollment_batches` 为 `success` 或 `failed`。

注意：保存时写入 `speaker_enrollment_batches.audio_path` 的 enrollment wav 必须保留，作为后续追溯“当时到底发送给讯飞哪份音频”的依据。

## 8. 与现有后端能力的关系

可以复用：

- `xfyun-client.ts` 中的讯飞调用。
- `audio-prep.ts` 中的裁剪和拼接能力。
- `speaker_voiceprint_features` 的 feature 映射。
- `segment_voiceprint_matches` 的识别结果流水。
- `speaker_enrollment_batches` 和 `speaker_enrollment_segments` 的同步批次记录。

需要调整：

- 不再把 conversation pending segments 作为声纹语料管理主入口。
- 不再依赖会话内 speaker label 作为长期归类依据。
- 不再选择片段后立即更新讯飞。
- 新增 speaker 维度的候选/正式语料持久化表。
- 增加同步前试听音频生成能力，但试听音频不写长期业务表。
- 同步讯飞改成基于 speaker 的 formal materials 显式触发。

## 9. 推荐实施顺序

1. 新增 `speaker_voiceprint_materials` 表。
2. 新增 speaker 维度语料查询接口。
3. 新增跨会话片段搜索接口。
4. 新增加入候选、加入正式、候选转正式、正式转候选、移除接口。
5. 新增 preview：生成可试听的临时拼接音频。
6. 新增 sync：保存并同步讯飞，正式记录写入现有 `speaker_enrollment_batches`。
7. 改造讯飞同步逻辑：从 formal materials 读取片段，而不是直接从单个 conversation 的请求体读取。
8. 保留现有 scan/backfill，但把它定位为候选线索来源。
9. 后续再逐步弱化或移除 conversation 维度的 enroll-from-segments 流程。
