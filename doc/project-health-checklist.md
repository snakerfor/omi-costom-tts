# OMI Custom STT 项目点检清单

> 最近点检时间：2026-04-28  
> 本清单用于核查本地代码、远程服务、OMI 桌面端同步、发言人资料库、记忆生成、实时转录等项目状态。

## 1. 当前点检结论

### 1.1 代码一致性

- 本地工作区：`/Users/snaker/Claude-Projects/omi-custom-tts`
- 本地 `HEAD`：`b064977a62daf3ff09aee2b044e21b854a199134`
- 本地 `origin/master`：`b064977a62daf3ff09aee2b044e21b854a199134`
- 远程服务器目录：`/www/omi-custom-tts`
- 远程服务器 `HEAD`：`b064977a62daf3ff09aee2b044e21b854a199134`
- 结论：本地、GitHub 跟踪分支、服务器代码一致。

未跟踪文件核查记录：

```text
public/admin/pencil-prototype.html
scripts/export-pen-html.js
```

结论：这两个文件是 Pencil 升级稿的临时 HTML 导出工具与导出结果。`public/admin/pencil-prototype.html` 可由已跟踪的 `designs/admin-ui-prototype.pen` 重新生成，且生成结果与当前未跟踪 HTML 完全一致；`scripts/export-pen-html.js` 没有被 `package.json`、应用入口或文档引用。当前后台页面已经吸收升级稿中的“对话记录 / 正式发言人 / 声纹语料管理 / 编辑发言人”工作流，因此这两个未跟踪文件不需要保留。

### 1.2 远程服务

- 健康检查：`curl http://127.0.0.1:28089/healthz` 返回 `{"status":"ok"}`
- PM2 进程：`omi-custom-tts` 在线
- 监听入口：
  - HTTP health/admin/API：`http://127.0.0.1:28089`
  - WebSocket STT：`ws://127.0.0.1:28089/stt`
- 结论：远程服务正常启动并可响应健康检查。

### 1.3 OMI 桌面端同步

远程数据库 `/www/omi-custom-tts-data/app.db` 当前统计：

| 表 | 数量 |
| --- | ---: |
| `omi_import_runs` | 652 |
| `omi_transcription_sessions` | 511 |
| `omi_transcription_segments` | 26676 |
| `omi_memories` | 1316 |

最近导入记录：

```text
source_key=macbook-pro-local-omi
status=completed
started_at=2026-04-28T00:45:32.175Z
finished_at=2026-04-28T00:45:32.175Z
```

最近桌面端转录会话：

```text
source_session_id=521
source_key=macbook-pro-local-omi
status=completed
started_at=2026-04-27 09:00:59.260
segments=64
```

结论：桌面端数据导入链路有最新成功记录；桌面端转录内容最近一次有效会话在 2026-04-27。若预期 2026-04-28 当天应有桌面转录内容，需要继续检查 OMI 桌面端采集端是否仍在推送 `transcription_sessions` 和 `transcription_segments`。

### 1.4 发言人资料库

远程数据库当前统计：

| 项 | 数量 |
| --- | ---: |
| `speakers` confirmed | 1 |
| `speaker_voiceprint_materials` formal | 1 |
| `speaker_voiceprint_features` active | 1 |

结论：发言人资料库结构可用，但资料量很少。当前只能说明“已有 1 个正式发言人及声纹特征”，不能说明多人识别库已经充分覆盖真实使用场景。

### 1.5 记忆生成

远程数据库当前统计：

| 表 | 状态 | 数量 |
| --- | --- | ---: |
| `knowledge_memories` | active | 1316 |
| `knowledge_memory_candidates` | 无记录 | 0 |

结论：OMI memory 已导入并沉淀到 `knowledge_memories`。当前没有待处理的 AI 候选记忆；如果预期实时转录/桌面转录自动产生候选记忆，需要检查 AI memory supplement 开关和 `knowledge_memory_candidates` 生成链路。

### 1.6 实时转录

远程数据库当前统计：

| 表 | 数量 |
| --- | ---: |
| `conversations` | 11871 |
| `conversation_segments` | 40070 |

最近会话中有 `recording` / `completed` 记录，说明 OMI 或客户端仍能连入服务。但最近几个会话 segment 数为 0；最近的 `conversation_segments` 样本时间为 2026-04-25。

结论：WebSocket 服务入口正常，实时会话记录仍在产生；但最近没有确认到新的有效转录片段。需要用 OMI APP 或 `tests/test-client-with-audio.ts` 做一次带音频的端到端测试，确认 Soniox、音频格式、鉴权 token、segment 回传都正常。

## 2. 每次点检 SOP

### 2.1 本地代码与构建

```bash
cd /Users/snaker/Claude-Projects/omi-custom-tts

git status --short --branch
git rev-parse HEAD
git rev-parse origin/master

npm run build
npm run test:unit
```

通过标准：

- `HEAD` 与 `origin/master` 一致，或明确知道本地/远程有待部署改动。
- `npm run build` 成功。
- `npm run test:unit` 输出 `unit tests passed`。
- 未跟踪或未提交文件有明确归属，不把本地草稿误判为线上问题。

### 2.2 服务器代码一致性

```bash
ssh tencent
cd /www/omi-custom-tts

git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
git status --short --branch
```

本地对比：

```bash
cd /Users/snaker/Claude-Projects/omi-custom-tts
git rev-parse HEAD
```

通过标准：

- 本地 `HEAD`、`origin/master`、服务器 `HEAD` 一致。
- 如果服务器处于 detached HEAD，这是部署脚本允许的状态，但必须确认 commit 正确。
- 服务器工作树不应有未解释的本地修改。

### 2.3 远程服务启动状态

```bash
ssh tencent

curl -sS http://127.0.0.1:28089/healthz
ss -tlnp | grep 28089
bash -lc "pm2 status"
bash -lc "pm2 logs omi-custom-tts --lines=100"
```

通过标准：

- healthz 返回 `{"status":"ok"}`。
- 端口 `28089` 正在监听。
- PM2 中 `omi-custom-tts` 为 `online`。
- error log 没有持续出现 Soniox 鉴权失败、SQLite 写入失败、端口占用、未捕获异常。

### 2.4 数据库总览

```bash
ssh tencent
DB=/www/omi-custom-tts-data/app.db

sqlite3 "$DB" ".tables"

sqlite3 "$DB" "
SELECT 'conversations', COUNT(*) FROM conversations
UNION ALL SELECT 'conversation_segments', COUNT(*) FROM conversation_segments
UNION ALL SELECT 'speakers', COUNT(*) FROM speakers
UNION ALL SELECT 'speaker_voiceprint_materials', COUNT(*) FROM speaker_voiceprint_materials
UNION ALL SELECT 'speaker_voiceprint_features', COUNT(*) FROM speaker_voiceprint_features
UNION ALL SELECT 'omi_import_runs', COUNT(*) FROM omi_import_runs
UNION ALL SELECT 'omi_transcription_sessions', COUNT(*) FROM omi_transcription_sessions
UNION ALL SELECT 'omi_transcription_segments', COUNT(*) FROM omi_transcription_segments
UNION ALL SELECT 'omi_memories', COUNT(*) FROM omi_memories
UNION ALL SELECT 'knowledge_events', COUNT(*) FROM knowledge_events
UNION ALL SELECT 'knowledge_conversations', COUNT(*) FROM knowledge_conversations
UNION ALL SELECT 'knowledge_memory_candidates', COUNT(*) FROM knowledge_memory_candidates
UNION ALL SELECT 'knowledge_memories', COUNT(*) FROM knowledge_memories;
"
```

通过标准：

- 核心表存在。
- 计数不应异常归零。
- 和上次点检相比，预期有新增的表应持续增长。

### 2.5 OMI 桌面端同步

```bash
ssh tencent
DB=/www/omi-custom-tts-data/app.db

sqlite3 -header -column "$DB" "
SELECT id, source_key, status, started_at, finished_at
FROM omi_import_runs
ORDER BY started_at DESC
LIMIT 10;
"

sqlite3 -header -column "$DB" "
SELECT
  s.source_session_id,
  s.source_key,
  s.status,
  s.started_at,
  s.finished_at,
  (SELECT COUNT(*)
   FROM omi_transcription_segments seg
   WHERE seg.source_session_id = s.source_session_id
     AND seg.source_key = s.source_key) AS segments
FROM omi_transcription_sessions s
ORDER BY s.started_at DESC
LIMIT 10;
"
```

通过标准：

- `omi_import_runs.status` 最近应为 `completed`。
- `source_key` 应符合预期设备，例如 `macbook-pro-local-omi`。
- 如果桌面端当天有使用，`omi_transcription_sessions` / `omi_transcription_segments` 应有当天数据。
- 如果只有 `omi_import_runs` 增长而 session/segment 不增长，优先检查桌面端采集端是否真的产生 transcription 数据。

### 2.6 发言人资料库与声纹

```bash
ssh tencent
cd /www/omi-custom-tts
DB=/www/omi-custom-tts-data/app.db

sqlite3 -header -column "$DB" "
SELECT status, COUNT(*) AS count
FROM speakers
GROUP BY status
ORDER BY count DESC;

SELECT material_status, COUNT(*) AS count
FROM speaker_voiceprint_materials
GROUP BY material_status
ORDER BY count DESC;

SELECT status, COUNT(*) AS count
FROM speaker_voiceprint_features
GROUP BY status
ORDER BY count DESC;
"

npm run audit:speakers
```

通过标准：

- 预期发言人应存在于 `speakers`。
- 每个需要实时声纹识别的 confirmed speaker 至少应有 formal material 和 active feature。
- `npm run audit:speakers` 不应报告样本音频路径缺失或 embedding 维度异常。
- 如果多人识别不准，先补充高质量声纹素材，再同步讯飞特征。

### 2.7 记忆导入与生成

```bash
ssh tencent
cd /www/omi-custom-tts
DB=/www/omi-custom-tts-data/app.db

sqlite3 -header -column "$DB" "
SELECT status, COUNT(*) AS count
FROM knowledge_memories
GROUP BY status
ORDER BY count DESC;

SELECT status, COUNT(*) AS count
FROM knowledge_memory_candidates
GROUP BY status
ORDER BY count DESC;

SELECT id, category, substr(canonical_text, 1, 80) AS memory, updated_at
FROM knowledge_memories
ORDER BY updated_at DESC
LIMIT 10;
"

npm run import:omi-memories
```

通过标准：

- `knowledge_memories.active` 数量合理，且最近更新时间符合预期。
- `npm run import:omi-memories` 可正常结束。
- 如果 `knowledge_memory_candidates` 长期为 0，需要确认这是设计预期，还是 AI supplement 未启用。
- 如需要重建语义层，可按顺序运行：

```bash
npm run rebuild:knowledge
npm run rebuild:conversations
npm run rebuild:memories
```

### 2.8 实时转录端到端

先看最近会话与片段：

```bash
ssh tencent
DB=/www/omi-custom-tts-data/app.db

sqlite3 -header -column "$DB" "
SELECT
  c.id,
  c.status,
  c.created_at,
  c.ended_at,
  (SELECT COUNT(*) FROM conversation_segments cs WHERE cs.conversation_id = c.id) AS segments
FROM conversations c
ORDER BY c.created_at DESC
LIMIT 10;
"

sqlite3 -header -column "$DB" "
SELECT conversation_id, created_at, speaker_label, speaker_name, substr(text, 1, 80) AS text
FROM conversation_segments
ORDER BY created_at DESC
LIMIT 10;
"
```

再做带音频测试：

```bash
cd /Users/snaker/Claude-Projects/omi-custom-tts
npm run test
```

或者用 OMI APP 实测：

```text
WebSocket URL: wss://<your-domain-or-ip>/stt
params.api_key: <ACCESS_TOKENS 中的有效 token>
params.language: zh
segments_speaker_field: speaker
```

通过标准：

- 服务日志出现新 WebSocket 连接。
- Soniox 链路有 partial/final 输出。
- 客户端收到 `segments[{ text, start, end, speaker }]`。
- `conversations` 新增记录。
- `conversation_segments` 对应会话新增非空文本。
- 会话结束后状态变为 `completed`，且没有持续 `failed`。

### 2.9 管理后台与 API 抽查

```bash
ssh tencent

curl -sS http://127.0.0.1:28089/admin | head
curl -sS http://127.0.0.1:28089/api/speakers/stats
curl -sS "http://127.0.0.1:28089/api/conversations?page=1&pageSize=5"
```

通过标准：

- 管理后台 HTML 可返回。
- speaker stats API 返回 JSON。
- conversations API 返回最近会话列表。

### 2.10 日志排查关键字

```bash
ssh tencent
bash -lc "pm2 logs omi-custom-tts --lines=300 --nostream"
```

重点搜索：

```text
[Server] New connection
[Soniox]
[Finalize]
[knowledge]
[Audio Webhook]
[HTTP] Request failed
xfyun_error
memory extraction failed
SQLITE
Unauthorized
```

判断方式：

- `[Server] New connection` 只说明客户端连入，不代表转录成功。
- `[Soniox]` partial/final 与 `conversation_segments` 新增同时出现，才说明实时转录闭环正常。
- `[Finalize]` 之后应看到正式 segment 入库、speaker mapping、knowledge incremental sync。
- `Unauthorized` 多数是 OMI APP `api_key` 与 `.env ACCESS_TOKENS` 不一致。

## 3. 异常处理速查

### 3.1 healthz 失败

1. `pm2 status`
2. `pm2 logs omi-custom-tts --lines=200`
3. `ss -tlnp | grep 28089`
4. `cd /www/omi-custom-tts && npm run build`
5. `pm2 restart omi-custom-tts`

### 3.2 代码不一致

```bash
cd /www/omi-custom-tts
bash ./scripts/deploy-from-git.sh origin/master
```

部署后重新核对：

```bash
git rev-parse HEAD
curl -sS http://127.0.0.1:28089/healthz
```

### 3.3 桌面同步停止

1. 确认 OMI 桌面端还在运行。
2. 确认桌面端 sync token 与服务端一致。
3. 查 `omi_import_runs` 是否还有新 completed 记录。
4. 查 `omi_transcription_sessions` 是否有新 session。
5. 如果 import run 有增长但 session 没增长，重点查桌面端是否产生 transcription payload。

### 3.4 记忆没有新增

1. 查 `omi_memories` 是否有新增。
2. 运行 `npm run import:omi-memories`。
3. 查 `knowledge_memories.updated_at` 是否变化。
4. 如果依赖 AI 候选记忆，查 `knowledge_memory_candidates` 是否生成。
5. 查日志中的 `memory extraction failed`。

### 3.5 发言人识别不准或无结果

1. 查 `speakers` 是否有目标人。
2. 查目标人是否有 formal material。
3. 查目标人是否有 active feature。
4. 运行 `npm run audit:speakers`。
5. 对目标 speaker 重新 preview/sync 声纹资料。
6. 查实时片段里的 `speaker_label`、`speaker_name`、`speaker_resolution`。

### 3.6 实时转录只有会话没有文本

1. 确认 OMI APP 的 `api_key` 正确。
2. 确认 `SONIOX_API_KEY` 有效且额度正常。
3. 查日志是否有 Soniox error。
4. 用 `npm run test` 做本地音频端到端测试。
5. 查 `conversation_segments` 是否新增。
6. 如果会话很多但 segments 为 0，优先排查音频帧是否进入 Soniox，以及 APP 发送音频格式是否被 SDK 正确识别。

## 4. 建议的例行频率

- 每日：healthz、PM2、最近 import run、最近 conversations/segments。
- 每周：`npm run audit:speakers`、记忆数量与抽样、管理后台 API 抽查。
- 每次部署后：代码一致性、build、unit test、healthz、端到端实时转录。
- 每次调整 OMI APP 配置后：鉴权、WebSocket 连接、segments 回传、speaker 字段解析。
