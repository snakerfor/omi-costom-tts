# Admin 表单与数据流梳理

这份文档的目标，是帮助你快速理解这个项目后台里“每个表单是干什么的、给哪些字段赋值、和哪些接口/数据表相连、数据是怎么适配到页面上的”。

当前结论以代码为准，主要参考：

- `public/admin/index.html`
- `public/admin/app.js`
- `src/index.ts`
- `src/services/speaker-service.ts`
- `src/db.ts`

注意：

- 本地 `data/app.db` 和 `data/omi-tts.db` 在当前工作区里都是空文件，不能代表实际运行数据。
- 本文里后半部分的“表数据数量”和“样例数据”已经改成基于服务器线上库 `/www/omi-custom-tts-data/app.db` 的真实抽样。
- 框架理解仍然优先看 `src/db.ts` 的表结构定义，以及 `src/index.ts` 的接口定义。

## 1. 后台整体框架

后台页面分成 3 个模块：

1. `对话记录`：看会话、看 transcript、勾选片段、把片段加入候选语料。
2. `正式发言人`：看 speaker 列表、编辑 speaker 基础信息、管理 formal/candidate 语料、同步讯飞。
3. `系统工具`：记忆同步和 AI 补充。

前端总状态在 `public/admin/app.js` 的 `state` 里统一维护，核心字段有：

- `speakers`：发言人列表数据
- `selectedSpeakerDetail`：当前发言人详情
- `conversations`：会话列表数据
- `selectedConversationDetail`：当前会话详情
- `selectedSegmentIds`：当前勾选的 transcript 片段
- `materialSpeakerMode`：加入候选语料时，是“已有发言人”还是“新建发言人”

这说明页面不是“每个表单自己维护一套数据”，而是：

1. 先请求接口拿数据
2. 写进 `state`
3. 再把 `state` 渲染到表单和列表
4. 用户提交后再调接口
5. 接口成功后重新加载列表和详情

## 2. 页面里的主要“表单/操作区”

严格说，这个后台既有传统表单，也有“筛选区”“操作面板”“列表驱动型表单”。

可以按 5 类理解：

1. 会话筛选表单
2. Transcript 片段选择区
3. 加入候选语料表单
4. 发言人筛选表单
5. 发言人编辑表单
6. 发言人语料管理区

---

## 3. 表单 1：会话筛选表单

位置：

- `public/admin/index.html`
- `#conv-keyword`
- `#conv-speaker-filter`
- `#conv-identity-label`
- `#conv-status`
- `#conv-has-segments`
- `#conv-start`
- `#conv-end`

作用：

- 查询“对话记录列表”

字段 -> 接口参数映射：

- `conv-keyword` -> `keyword`
- `conv-speaker-filter` -> `speaker_name`
- `conv-identity-label` -> `identity_label`
- `conv-status` -> `status`
- `conv-has-segments` -> `has_segments`
- `conv-start` -> `start_time`
- `conv-end` -> `end_time`
- `conv-page-size` -> `page_size`

提交接口：

- `GET /api/conversations`

前端赋值逻辑：

- 用户改筛选条件后，`loadConversations(true)` 执行
- 组装 `URLSearchParams`
- 发请求到 `/api/conversations?...`
- 返回结果写入：
  - `state.conversations`
  - `state.conversationPagination`

后端适配逻辑：

- 入口在 `src/index.ts`
- 调用 `listConversations(...)`
- 返回：
  - `data`
  - `pagination`
  - `identityOptions`

页面展示用途：

- 左侧“对话记录列表”就是这个接口返回的数据

---

## 4. 表单 2：Transcript 片段选择区

位置：

- `#conversation-segments`

作用：

- 显示当前会话的 transcript
- 勾选片段，给后面的“加入候选语料”使用

数据来源：

- `GET /api/conversations/:id`

返回结构：

- `conversation`
- `speakers`
- `segments`

赋值逻辑：

- `loadConversationDetail(conversationId)`
- 请求 `/api/conversations/:id`
- 返回结果写入 `state.selectedConversationDetail`
- 再调用：
  - `renderConversationSpeakerSummary`
  - `renderConversationSpeakerFilter`
  - `renderConversationDetailBadges`
  - `renderConversationTranscript`

片段勾选逻辑：

- 每条 transcript 行有 checkbox
- 勾选后把 `segment.id` 放进 `state.selectedSegmentIds`
- 这个集合不会立刻写库，只是前端暂存

它的作用不是直接改数据，而是为后面两个动作准备入参：

1. 加入候选语料
2. 旧版 enrollment 流程

---

## 5. 表单 3：加入候选语料表单

位置：

- 右侧抽屉 `加入候选语料`

两种模式：

1. `已有发言人`
2. `新建发言人`

### 5.1 已有发言人模式

字段：

- `#conversation-material-target`

作用：

- 把当前勾选的 segments 加到某个已存在 speaker 的 `candidate` 语料里

赋值来源：

- `loadConfirmedSpeakerOptions()`
- 请求 `GET /api/speakers?confirmation=confirmed&page=1&page_size=200`
- 返回的 speaker 列表写入下拉框

提交接口：

- `POST /api/admin/speakers/:speakerId/voiceprint/materials`

提交 body：

```json
{
  "segmentIds": ["seg_001", "seg_002"],
  "materialStatus": "candidate",
  "source": "conversation_selection"
}
```

### 5.2 新建发言人模式

字段：

- `#conversation-material-new-name`
- `#conversation-material-new-identity`
- `#conversation-material-new-note`

作用：

- 先新建一个 speaker
- 再把当前勾选的 segments 作为这个 speaker 的候选语料

提交接口：

- `POST /api/admin/voiceprint/speakers`

提交 body 结构：

```json
{
  "segmentIds": ["seg_001", "seg_002"],
  "materialStatus": "candidate",
  "speakerId": null,
  "speakerName": "张三",
  "identityLabel": "同事",
  "notes": "来自 2026-06-20 上午会议"
}
```

### 5.3 这个表单真正改了什么数据

这类操作的核心目标，是把 transcript 片段和 speaker 建立关系，并进入语料管理流程。

相关表重点看：

- `speakers`
- `conversation_segments`
- 以及代码里 voiceprint material 相关逻辑依赖的扩展表

可以把它理解为：

1. 选中的 `conversation_segments.id` 是原始输入
2. 提交后，这些 segment 会被挂到一个 speaker 名下
3. 状态先作为 `candidate`，还不是最终用于讯飞的正式语料

操作完成后前端会刷新：

- 当前会话详情
- 会话列表
- 发言人列表
- 已确认发言人下拉选项

---

## 6. 表单 4：发言人筛选表单

位置：

- `#speaker-q`
- `#speaker-confirmation`
- `#speaker-page-size`

作用：

- 查询右侧“正式发言人”列表

提交接口：

- `GET /api/speakers`

字段 -> 参数映射：

- `speaker-q` -> `q`
- `speaker-confirmation` -> `confirmation`
- `speaker-page-size` -> `page_size`

赋值逻辑：

- `loadSpeakers(true|false)`
- 结果写入：
  - `state.speakers`
  - `state.speakerPagination`

后端适配逻辑：

- `src/index.ts` 中 `/api/speakers`
- 调 `listSpeakers(filters)`
- 再附带：
  - `pagination`
  - `stats`

---

## 7. 表单 5：发言人编辑表单

位置：

- `#speaker-form`

字段：

- `#speaker-form-name`
- `#speaker-form-identity`
- `#speaker-form-notes`

作用：

- 编辑某个 speaker 的基础信息

### 7.1 表单如何回填

当点击“编辑基础信息”后：

- `loadSpeakerDetail(speakerId)` 先请求详情
- `renderSpeakerDetail(detail)` 负责给表单赋值

对应赋值代码逻辑：

- `speaker-form-name = detail.speaker.name || ''`
- `speaker-form-identity = detail.speaker.identity_label || ''`
- `speaker-form-notes = detail.speaker.notes || ''`

这就是你说的“表单对数据赋值的作用”的最典型例子：

1. 后端返回 `detail.speaker`
2. 前端把 `detail.speaker` 的字段映射到 input/select/textarea
3. 用户修改后再提交回后端

### 7.2 提交时改哪些字段

提交接口：

- `PATCH /api/speakers/:speakerId`

提交 body：

```json
{
  "name": "李四",
  "identityLabel": "同事",
  "notes": "经人工确认"
}
```

后端处理在 `updateSpeaker(...)`，主要更新表：

- `speakers`

主要字段：

- `name`
- `status`
- `display_label`
- `identity_label`
- `identity_status`
- `notes`
- `updated_at`

并且会联动一些“确认状态”语义：

- `name` 有值时，`status` 会变成 `confirmed`
- `identityLabel` 有值时，`identity_status` 会变成 `confirmed`

所以这个表单不是只改显示文案，它实际上会改变 speaker 的业务状态。

---

## 8. 表单 6：发言人语料管理区

位置：

- 正式发言人详情页
- `正式语料`
- `候选语料`

这块不是传统表单，但它是“数据调整表单”的一种：

- 可以把某条语料从 `candidate` 提升为 `formal`
- 可以从 `formal` 降回 `candidate`
- 可以移除语料
- 可以试听
- 可以最终“保存并更新讯飞”

### 8.1 数据来源

接口：

- `GET /api/admin/speakers/:speakerId/voiceprint/materials`

返回结构：

- `speaker`
- `activeFeature`
- `enrollmentBatches`
- `formalMaterials`
- `candidateMaterials`

前端会先把它们整理成 `speakerMaterialDraft`，再分别渲染到：

- `#speaker-formal-materials`
- `#speaker-candidate-materials`

### 8.2 单条语料状态切换

接口：

- `POST /api/admin/speakers/:speakerId/voiceprint/materials`

提交 body 示例：

```json
{
  "segmentIds": ["seg_003"],
  "materialStatus": "formal",
  "source": "manual_promote",
  "note": null
}
```

或者切到候选：

```json
{
  "segmentIds": ["seg_003"],
  "materialStatus": "candidate",
  "source": "manual_demote",
  "note": null
}
```

删除接口：

- `DELETE /api/admin/speakers/:speakerId/voiceprint/materials/:segmentId`

### 8.3 最终保存并更新讯飞

按钮：

- `#speaker-material-save`

接口：

- `POST /api/admin/speakers/:speakerId/voiceprint/xfyun/sync`

作用：

- 读取当前 speaker 的 `formal` 语料
- 生成试听/拼接音频
- 同步到讯飞声纹

所以这里的关键业务规则是：

- `candidate` 只是候选
- `formal` 才参与下次讯飞更新

---

## 9. 数据表之间的大致关系

虽然项目表很多，但理解表单流程，先抓 3 张核心表就够了。

### 9.1 `conversations`

一条会话一行。

典型字段：

- `id`
- `session_id`
- `status`
- `first_audio_frame_at`
- `ended_at`
- `audio_file_path`
- `error_message`

作用：

- 对话记录列表的主表
- 会话详情的头部信息来源

### 9.2 `conversation_segments`

一条 transcript 片段一行。

典型字段：

- `id`
- `conversation_id`
- `start_ms`
- `end_ms`
- `absolute_start_time`
- `absolute_end_time`
- `original_speaker_label`
- `speaker_label`
- `speaker_id`
- `speaker_name`
- `speaker_identity`
- `text`
- `confidence`
- `resolution_method`

作用：

- transcript 列表主数据
- 勾选片段的原始数据来源
- 和 speaker 建立关系的关键表

### 9.3 `speakers`

一条发言人一行。

典型字段：

- `id`
- `name`
- `status`
- `display_label`
- `identity_label`
- `identity_status`
- `notes`
- `first_seen_at`
- `last_seen_at`

作用：

- 正式发言人列表主表
- 发言人编辑表单主表

---

## 10. 前端“数据适配”是怎么做的

你提到“数据适配”，这个项目里主要体现在 4 层。

### 10.1 接口返回数据 -> 前端状态

例如：

- `/api/conversations` -> `state.conversations`
- `/api/conversations/:id` -> `state.selectedConversationDetail`
- `/api/speakers` -> `state.speakers`
- `/api/admin/speakers/:id/voiceprint/materials` -> `state.selectedSpeakerDetail`

### 10.2 前端状态 -> 表单回填

例如 `renderSpeakerDetail(detail)`：

- `detail.speaker.name` -> `#speaker-form-name`
- `detail.speaker.identity_label` -> `#speaker-form-identity`
- `detail.speaker.notes` -> `#speaker-form-notes`

### 10.3 前端状态 -> 列表展示文案

例如：

- `formatDate(...)`
- `formatSegmentSeconds(...)`
- `segmentStatusMeta(...)`
- `conversationStatusMeta(...)`

这层的作用是把数据库原始值，适配成用户看得懂的界面文案。

### 10.4 表单输入 -> 接口 body

例如发言人编辑表单提交：

```json
{
  "name": "...",
  "identityLabel": "...",
  "notes": "..."
}
```

例如加入候选语料：

```json
{
  "segmentIds": ["..."],
  "speakerId": "...",
  "materialStatus": "candidate"
}
```

这层的作用是把页面控件的值，重新适配成后端能处理的 JSON 结构。

---

## 11. 服务器线上库当前表数量

数据来源：

- 服务器：`tencent`
- 数据库：`/www/omi-custom-tts-data/app.db`
- 抽样时间：`2026-06-25`

当前查到的核心表数量如下：

| 表名 | 当前行数 |
| --- | ---: |
| `conversations` | 15098 |
| `conversation_segments` | 73959 |
| `speakers` | 16 |
| `audio_files` | 14531 |
| `segment_voiceprint_matches` | 23501 |
| `speaker_voiceprint_materials` | 70 |
| `speaker_voiceprint_features` | 15 |
| `speaker_enrollment_batches` | 24 |
| `speaker_enrollment_segments` | 99 |
| `knowledge_events` | 325819 |
| `knowledge_conversations` | 6390 |
| `knowledge_memories` | 1899 |
| `omi_import_runs` | 956 |

如果你后面要继续顺着表单看数据，最值得先盯住的还是这几张：

- `conversations`
- `conversation_segments`
- `speakers`
- `speaker_voiceprint_materials`
- `segment_voiceprint_matches`

## 12. 来自服务器数据库的真实样例数据

下面这些不是演示伪造数据，而是直接从服务器数据库抽出来的真实记录。

### 12.1 `conversations` 真实样例

查询方式：

- 按 `created_at desc limit 1`

结果：

```json
{
  "id": "conv_mqta0jn3_wuluhu1k",
  "session_id": "session_1782378291567_l3ens0",
  "uid": "token_5bf4f653147ea83a",
  "status": "recording",
  "first_audio_frame_at": "2026-06-25T09:05:00.405Z",
  "ended_at": null,
  "audio_file_path": "/www/omi-custom-tts-data/audio-uploads/session_1782378291567_l3ens0.wav",
  "error_message": null,
  "created_at": "2026-06-25T09:04:51.567Z",
  "updated_at": "2026-06-25T09:05:00.405Z"
}
```

这条数据说明：

- 当前最新会话还在 `recording`
- 音频已经落到 `/www/omi-custom-tts-data/audio-uploads/`
- `ended_at` 为空，表示还没结束

### 12.2 `conversation_segments` 真实样例

查询方式：

- 按 `created_at desc limit 1`

结果：

```json
{
  "id": "stt_unavailable_mqt9novt",
  "conversation_id": "conv_mqt9no1r_qeuwzfh4",
  "start_ms": 0,
  "end_ms": 191700,
  "absolute_start_time": "2026-06-25T08:55:11.514Z",
  "absolute_end_time": "2026-06-25T08:58:23.214Z",
  "original_speaker_label": null,
  "speaker_label": null,
  "speaker_id": null,
  "speaker_name": null,
  "speaker_identity": null,
  "text": "【实时转录不可用：Soniox API 当前不可用】",
  "confidence": null,
  "resolution_method": "stt_unavailable",
  "created_at": "2026-06-25T09:04:35.795Z",
  "updated_at": "2026-06-25T09:04:35.795Z"
}
```

这条数据说明：

- `conversation_segments` 不一定全是正常识别文本
- 当实时转录失败时，也会写一条系统性占位片段
- 这类片段的 `resolution_method` 会体现异常来源

### 12.3 `speakers` 真实样例

查询方式：

- 按 `updated_at desc limit 1`

结果：

```json
{
  "id": "spk_mp0yjtji_53j94mfc",
  "name": "Klaus",
  "status": "confirmed",
  "display_label": "Klaus",
  "identity_label": "同事",
  "identity_status": "confirmed",
  "notes": "项目经理和产品经理",
  "first_seen_at": "2026-05-11T08:46:40.206Z",
  "last_seen_at": "2026-05-11T08:46:40.206Z",
  "sample_text": null,
  "sample_segment_id": null,
  "sample_audio_path": null,
  "created_at": "2026-05-11T08:46:40.206Z",
  "updated_at": "2026-05-11T08:46:40.206Z"
}
```

这条数据说明：

- `speakers` 表里当前是小规模、人工维护过的正式发言人集合
- `identity_label`、`identity_status`、`notes` 这几个字段，就是编辑表单直接维护的核心字段

### 12.4 “加入候选语料”后的理解

如果把 `seg_001` 加到 `spk_zhangsan` 的候选语料里，可以这样理解：

1. 片段源头仍然是 `conversation_segments`
2. 这个片段被纳入 `speaker` 的 voiceprint material 管理
3. 但只有进入 `formal` 后，才参与最终讯飞同步

---

## 13. 你现在应该怎么理解这套后台

最简单的理解顺序是：

1. 先看 `conversations`
2. 再看 `conversation_segments`
3. 再看 `speakers`
4. 然后把“选片段 -> 加候选 -> 调整 formal -> 同步讯飞”连起来

也就是这条主线：

`会话列表` -> `会话详情` -> `勾选片段` -> `加入某个 speaker` -> `进入候选语料` -> `提升为正式语料` -> `同步讯飞`

---

## 14. 当前最值得重点看的代码位置

如果你后面要继续深入，建议按这个顺序看：

1. `public/admin/index.html`
   先知道页面上到底有哪些表单和按钮
2. `public/admin/app.js`
   看每个按钮、表单提交、回填赋值、状态更新
3. `src/index.ts`
   看这些表单分别打到了哪些接口
4. `src/services/speaker-service.ts`
   看 speaker 列表、speaker 详情、speaker 更新怎么查库
5. `src/db.ts`
   看核心表结构

---

## 15. 一句总结

这套后台的本质不是“传统录入型表单系统”，而是一个围绕 `conversation_segments` 和 `speakers` 做人工校对、语料归集、状态切换、再同步声纹平台的工作台。

如果你只抓住两件事，就已经抓住主干了：

1. 每个表单本质上都在操作 `会话 / 片段 / 发言人` 三类数据
2. 最重要的数据流是：`片段被选择` -> `归属到 speaker` -> `从 candidate 变 formal` -> `触发同步`
