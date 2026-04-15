---
name: omimem
description: 查询和管理个人知识层——时间线、聚合会话、长期记忆与自然语言问答；并说明 OMI 桌面同步记忆写入 knowledge_memories、HTTP 管理接口与手动 AI 补充。当用户问到「最近发生了什么」「我跟谁说过什么」「我的记忆」「查对话/事件」「omimem」「knowledge memories」或需要回忆历史对话时使用。
author: snaker
version: 1.1.1
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

本仓库根目录（示例）：

```
~/Claude-Projects/omi-custom-tts/
```

执行 CLI 前请 `cd` 到该目录，并保证 `DATA_ROOT` / `DB_PATH` 指向实际运行库（见「数据库」）。

## Quick Reference（CLI）

| 需求 | 命令 |
|------|------|
| 事件时间线 | `npm run omimem -- timeline` |
| 对话列表 / 详情 | `npm run omimem -- conversations` / `npm run omimem -- conversations --id <kc_id>` |
| 长期记忆 | `npm run omimem -- memories` |
| 记忆候选 | `npm run omimem -- memories --candidates` |
| 自然语言问答 | `npm run omimem -- ask "问题"`（需 MiniMax，见「AI」） |
| 统计 / 导出 | `npm run omimem -- stats` / `npm run omimem -- export --day YYYY-MM-DD` |

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
| GET | `/api/knowledge/memories/status` | `omi_memories` / `knowledge_memories` 数量、AI 开关、最近导入与补充摘要 |
| POST | `/api/knowledge/memories/sync-omi` | 全量将 `omi_memories` 合并进 `knowledge_memories`（body 可含 `sourceKey` 仅同步某源） |
| POST | `/api/knowledge/memories/config` | `{ "aiSupplementEnabled": true \| false }`，默认 **false** |
| POST | `/api/knowledge/memories/ai-supplement` | 手动 AI 补充；需开关为 true；body 可含 `apiKey`（不落库） |

管理界面：`GET /admin` 顶部有「记忆同步与补充」面板（状态、同步按钮、AI 开关、临时 API Key 输入）。

## AI 配置

- 环境变量：`MINIMAX_API_KEY`（或沿用 OpenClaw 的 `~/.openclaw/agents/main/agent/auth-profiles.json` 中 `minimax-cn:default`，与 `src/services/minimax-client.ts` 一致）
- 模型：默认 `MiniMax-M2.7-highspeed`（`MINIMAX_MODEL` 可覆盖）
- **AI 补充记忆** 仅在用户打开开关并手动触发后执行；无 key 时 `ask` / 补充会失败或跳过

## 数据库

SQLite 路径由运行时决定，**不要**写死旧路径 `data/omi-tts.db`。

- 默认（未设 `DATA_ROOT`）：仓库根目录下 `app.db`
- 生产常见：`DATA_ROOT=/path/to/omi-custom-tts-data`，数据库为 `$DATA_ROOT/app.db`

关键表：`knowledge_events`、`knowledge_conversations`、`knowledge_conversation_items`、`omi_memories`、`knowledge_memory_candidates`、`knowledge_memories`、`knowledge_runtime_settings`（记忆相关开关与最近任务摘要）

## 版本管理与云端 OpenClaw

- **唯一源码（Git）**：本仓库 **`skills/omimem/SKILL.md`**。不要用 `.cursor/skills`；历史若存在该路径可删除，以本目录为准。
- **运行时（云端）**：OpenClaw 跑在 **云端服务器** 上时，将上述文件同步到该机器 OpenClaw workspace 下，例如：
  - `~/.openclaw/workspace/skills/omimem/SKILL.md`
  - 若应用代码部署在 `/www/omi-custom-tts`，也可用符号链接：  
    `ln -sf /www/omi-custom-tts/skills/omimem/SKILL.md ~/.openclaw/workspace/skills/omimem/SKILL.md`  
    （路径按实际用户与部署目录调整）
- **发布流程**：`git pull` 更新仓库后，再执行一次复制或确认软链仍指向仓库内 `skills/omimem/SKILL.md`，必要时重启 OpenClaw agent。

## 注意事项

- 记忆类别除抽取用的 taxonomy 外，OMI 基线行可能含 `system` / `interesting` / `manual` 等来源类别。
- 事件去重依赖 `dedupe_key`；`omi_memories` 与 `knowledge_memories` 合并依赖规范化文本与 `kmomi:` 主键，重复导入应幂等。
