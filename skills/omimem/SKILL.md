---
name: omimem
description: 查询和管理个人知识层——时间线、聚合会话、长期记忆与自然语言问答；并说明 OMI 桌面同步记忆写入 knowledge_memories、HTTP 管理接口与手动 AI 补充。当用户问到「最近发生了什么」「我跟谁说过什么」「我的记忆」「查对话/事件」「omimem」「knowledge memories」或需要回忆历史对话时使用。
author: snaker
version: 1.1.4
triggers:
  - "我的记忆"
  - "最近发生了什么"
  - "查一下"
  - "我跟谁聊过"
  - "有什么对话"
  - "时间线"
  - "知识库"
  - "回忆一下"
  - "omimem"
  - "knowledge"
  - "memories"
  - "knowledge memories"
  - "conversations today"
  - "what happened"
---

# OmiMem — 个人知识层

基于 OMI 设备、APP 和桌面端采集的多源数据，构建的个人知识系统。默认通过本仓库 CLI（`npm run omimem`）查询；服务端还提供 HTTP 接口与 `/admin` 管理页，供运维与 OpenClaw 等 agent 调用。

## 架构概览

```
OMI APP/设备 (音频) ──┐
OMI 桌面端 (截图/转写/观察) ──┤→ knowledge_events → knowledge_conversations
OMI 桌面同步 (omi_memories) ──┘                              ↓
     (云端总结类 memory 落本地表)                    knowledge_memories
```

- **knowledge_events**: 统一事件流（语音片段、桌面转写、截图、观察等）
- **knowledge_conversations**: 由事件聚合的会话块（可含 AI 生成的标题/摘要等）
- **omi_memories**: 桌面端同步的 OMI 侧 memory 行（含云端总结类内容）
- **knowledge_memories**: 对外使用的长期记忆表；**一层**来自 `omi_memories` 的基线导入（`id` 形如 `kmomi:...`），**二层**可经手动触发的 AI 补充从聚合会话中抽取

## 数据来源与同步

| 来源 | 事件类型 / 表 | 说明 |
|------|----------------|------|
| OMI APP / 设备音频 | `speech_segment` | WebSocket 会话写入后同步进知识事件 |
| OMI 桌面端 | `desktop_transcript` / `screenshot` / `observation` | `POST /api/omi-sync/metadata` 增量写入 |
| OMI 桌面 memory | `omi_memories` | 同上；**当本次 payload 含 memories 批次时**，服务在入库后会 **自动** 将新增/变更同步进 `knowledge_memories`（与 CLI `import:omi-memories` 同源逻辑） |

## 后台任务（重要）

- 定时器仍会 **每 5 分钟** 做 **会话聚合**（`aggregateNewConversations`），用于把新的音频会话等收成 `knowledge_conversations`。
- **不再**在定时器里自动跑「从会话抽 memory 并写入 `knowledge_memories`」；AI 补充仅通过 **手动**（见下文 HTTP 或 `/admin`），且受开关控制。

## 项目路径

| 环境 | 本仓库（含 `package.json`、`.env`）典型路径 |
|------|---------------------------------------------|
| 本机开发 | `~/Claude-Projects/omi-custom-tts/`（示例） |
| 腾讯云部署 | `/www/omi-custom-tts/`（与 `DEPLOY.md` 一致） |

线上 SQLite 数据目录与 `DEPLOY.md` 一致时，多为 **`/www/omi-custom-tts-data/`**，数据库文件 **`/www/omi-custom-tts-data/app.db`**（仍以服务器 `.env` 中 `DATA_ROOT` / `DB_PATH` 为准）。

## OpenClaw / 云端执行 CLI（推荐路径）

`omimem` 已支持 **API 模式（推荐）**：只要有服务地址和 token，即可在任意机器查询知识层，无需本机 `app.db`。

先配置：

```bash
export OMIMEM_BASE_URL="https://your-server.example.com"
export OMIMEM_API_TOKEN="your_knowledge_api_token"
```

然后执行（可在任意 cwd）：

```bash
npm run omimem -- timeline
npm run omimem -- conversations
npm run omimem -- memories
npm run omimem -- stats
```

仅在同机运维/开发时，才建议本地库模式：

```bash
npm run omimem -- timeline --local-db
```

## Quick Reference（CLI）

| 需求 | 命令 |
|------|------|
| 事件时间线 | `npm run omimem -- timeline` |
| 对话列表 / 详情 | `npm run omimem -- conversations` / `npm run omimem -- conversations --id <kc_id>` |
| 长期记忆 / 候选 | `npm run omimem -- memories` / `npm run omimem -- memories --candidates` |
| 统计 / 导出 | `npm run omimem -- stats` / `npm run omimem -- export --day YYYY-MM-DD` |
| 本地库模式（兼容） | 任一命令追加 `--local-db` |
| 自然语言问答 | `npm run omimem -- ask "问题"`（当前仅本地模式） |

### OMI memory 基线导入（与线上一致）

```bash
npm run import:omi-memories
```

### 重建知识层（慎用全量清空 memory）

```bash
npm run rebuild:knowledge
npm run rebuild:conversations
# 保留已有 knowledge_memories 时加 --preserve-existing；无 MiniMax 可加 --no-ai
npm run rebuild:memories -- --preserve-existing --no-ai
npm run rebuild:all-knowledge   # 脚本链；若需保留 OMI 基线请先确认 flags
```

## HTTP API（服务端）

假定服务监听 `PORT`（默认 `28089`），路径前缀：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/knowledge/timeline` | 时间线（`from`/`to`/`limit`/`type`） |
| GET | `/api/knowledge/conversations` | 聚合会话列表（`from`/`to`/`limit`） |
| GET | `/api/knowledge/conversations/:id` | 聚合会话详情（含事件列表） |
| GET | `/api/knowledge/memories` | 长期记忆列表（`category`/`limit`） |
| GET | `/api/knowledge/memories/candidates` | 记忆候选列表（`category`/`limit`） |
| GET | `/api/knowledge/stats` | 事件统计（按 `event_type`） |
| GET | `/api/knowledge/export` | 按天导出事件（`day=YYYY-MM-DD`） |
| GET | `/api/knowledge/memories/status` | `omi_memories` / `knowledge_memories` 数量、AI 开关、最近导入与补充摘要 |
| POST | `/api/knowledge/memories/sync-omi` | 全量将 `omi_memories` 合并进 `knowledge_memories`（body 可含 `sourceKey` 仅同步某源） |
| POST | `/api/knowledge/memories/config` | `{ "aiSupplementEnabled": true \| false }`，默认 **false** |
| POST | `/api/knowledge/memories/ai-supplement` | 手动 AI 补充；需开关为 true；body 可含 `apiKey`（不落库） |

认证：`Authorization: Bearer <token>`，token 来源优先 `KNOWLEDGE_API_TOKENS`，未配置时回退 `ACCESS_TOKENS`。

管理界面：`GET /admin` 顶部有「记忆同步与补充」面板（状态、同步按钮、AI 开关、临时 API Key 输入）。

## AI 配置

- 环境变量：`MINIMAX_API_KEY`（或沿用 OpenClaw 的 `~/.openclaw/agents/main/agent/auth-profiles.json` 中 `minimax-cn:default`，与 `src/services/minimax-client.ts` 一致）
- 模型：默认 `MiniMax-M2.7-highspeed`（`MINIMAX_MODEL` 可覆盖）
- **AI 补充记忆** 仅在用户打开开关并手动触发后执行；无 key 时 `ask` / 补充会失败或跳过

## 数据库

SQLite 路径由运行时决定，**不要**写死旧路径 `data/omi-tts.db`。

- 默认（未设 `DATA_ROOT` / 未设 `DB_PATH`）：**当前工作目录**下 `app.db`（易踩坑，见上文「OpenClaw / 云端执行 CLI」）
- 生产常见：`DATA_ROOT=/www/omi-custom-tts-data`，`DB_PATH=/www/omi-custom-tts-data/app.db`（与 `DEPLOY.md` 示例一致；以实际 `.env` 为准）

关键表：`knowledge_events`、`knowledge_conversations`、`knowledge_conversation_items`、`omi_memories`、`knowledge_memory_candidates`、`knowledge_memories`、`knowledge_runtime_settings`（记忆相关开关与最近任务摘要）

## 版本管理与云端 OpenClaw

- **项目内唯一 Git 稿**：本仓库 **`skills/omimem/SKILL.md`**（不要用 `.cursor/skills` 等重复路径）。
- **与 OpenClaw 分离**：OpenClaw 只认其 workspace 下的独立文件，例如 **`~/.openclaw/workspace/skills/omimem/SKILL.md`**（root 即 `/root/.openclaw/workspace/...`）。**不要**用符号链接把该文件指到项目目录：项目若迁移路径或机器，软链会断，Skill 会整体失效。**项目归项目，Skill 归 Skill**，两边各有一份；逻辑与数据是否可查无关——数据仍在 **`DB_PATH`**，见「OpenClaw / 云端执行 CLI」。
- **更新方式**：在仓库里改好 `skills/omimem/SKILL.md` 并 `git push` 后，在服务器上对 OpenClaw 侧 **复制覆盖**（路径按实际调整）：

```bash
cp /www/omi-custom-tts/skills/omimem/SKILL.md /root/.openclaw/workspace/skills/omimem/SKILL.md
```

若 OpenClaw 以非 root 运行，将目标目录换成该用户 home 下的 `.openclaw/workspace/skills/omimem/`。更新后可视情况重启 OpenClaw agent。以后项目部署目录变更时，只要重新执行一次 **`cp`** 即可，不依赖固定绝对路径的软链。

## 注意事项

- 记忆类别除抽取用的 taxonomy 外，OMI 基线行可能含 `system` / `interesting` / `manual` 等来源类别。
- 事件去重依赖 `dedupe_key`；`omi_memories` 与 `knowledge_memories` 合并依赖规范化文本与 `kmomi:` 主键，重复导入应幂等。
