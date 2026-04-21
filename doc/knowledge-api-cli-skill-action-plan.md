# 知识层：API → CLI → Skill 行动方案

本文档汇总「服务端 API + 认证」「独立 CLI」「OpenClaw Skill」分层目标，以及从当前实现迁往该形态的阶段性工作。后续迭代以本文件为清单执行，完成一项勾一项或改 PR 链接。

---

## 1. 背景与目标

### 1.1 我们认同的架构分层

| 层级 | 职责 | 说明 |
|------|------|------|
| **服务端（本仓库部署）** | 数据真相源、业务逻辑、**对外 HTTP API + 鉴权** | 数据留在服务器；不依赖调用方本机存在 SQLite 或项目目录。 |
| **CLI（独立工程形态）** | 将「命令行体验」映射到已发布 API：base URL、凭证、子命令、结构化输出 | 可装任意机器；底层只调 API，**不直接读数据库文件**。 |
| **Skill（可选）** | 面向 OpenClaw 等：说明如何调用 CLI 或（次选）HTTP | Skill 与项目目录解耦；**项目内 Git 稿**与 **OpenClaw workspace 内副本**分开维护，发布时用 `cp` 同步（不用软链）。 |
| **其他 Agent 平台**（Dify、n8n、自研等） | 不认 Skill 时：HTTP 节点调 API，或脚本调用 CLI | 最终都落在同一套 API 契约上。 |

### 1.2 当前主要缺口

- **omimem CLI**（`npm run omimem`）以**本机读 SQLite**（`DB_PATH` / `DATA_ROOT`）为主，强依赖「与数据同机或同路径」，**无法**在任意 OpenClaw 主机上仅拷贝 Skill 就工作。
- **部分 HTTP 路由**已存在（如 `/api/knowledge/memories/status`、对话列表等），但与 **CLI 子命令能力**未必一一对应；且 **GET 类知识/对话 API** 多数未与 **统一 API 鉴权**（如与 STT `ACCESS_TOKENS` 或独立 API Key）对齐。
- **自然语言 `ask`** 依赖 MiniMax：CLI 侧为 `MINIMAX_API_KEY` 或 OpenClaw `auth-profiles`；服务端若提供远程 `ask`，需单独设计（代理调用、计费、限流）。

### 1.3 目标状态（验收口径）

1. 任意环境只要配置 **服务 Base URL + API 凭证**，即可通过 **CLI** 完成与「只读知识层」相关的查询类能力（时间线、会话列表、记忆列表、统计等），**无需**本机 `app.db`。
2. **Skill** 文档只描述：**认证环境变量 / 配置文件 + 调 CLI 或 `curl` 示例**，不依赖「必须在 `/www/omi-custom-tts` 执行」作为唯一路径。
3. **服务端** 对「读知识数据」的接口有 **明确鉴权**；写操作（同步、AI 补充等）权限更严或分角色。

---

## 2. 阶段划分与任务清单

### 阶段 A：API 面与鉴权（服务端，本仓库）

- [x] **A1. 盘点**：CLI/API 对照如下（2026-04-21）：
  | CLI 子命令 | API 路由 | 状态 |
  |---|---|---|
  | `timeline` | `GET /api/knowledge/timeline` | 已对齐 |
  | `conversations` | `GET /api/knowledge/conversations` + `GET /api/knowledge/conversations/:id` | 已对齐 |
  | `memories` | `GET /api/knowledge/memories` | 已对齐 |
  | `memories --candidates` | `GET /api/knowledge/memories/candidates` | 已对齐 |
  | `stats` | `GET /api/knowledge/stats` | 已对齐 |
  | `export` | `GET /api/knowledge/export` | 已对齐 |
  | `ask` | （暂无远程 API） | 保持本地模式/后置到 A5 |
- [x] **A2. 鉴权模型**：已实现 `Authorization: Bearer <token>`，优先 `KNOWLEDGE_API_TOKENS`，未配置时回退 `ACCESS_TOKENS`；`/api/knowledge/*` 路由统一鉴权（2026-04-21）。
- [x] **A3. 实现**：已补 `timeline/conversations/memories/stats/export` 等只读 REST 路由，并统一接入知识路径 token 校验（2026-04-21）。
- [x] **A4. 文档**：已在 `DEPLOY.md` 增补 `KNOWLEDGE_API_TOKENS` 配置说明与鉴权建议（2026-04-21）。
- [ ] **A5. `ask`（可选/后置）**：若需远程自然语言问答，单独 PR：**服务端代理 MiniMax** 或 **仅返回检索上下文由客户端调模型**；需限流与密钥不落日志。

### 阶段 B：CLI 工程形态（可与 A 并行设计）

- [ ] **B1. 形态**：决定 **monorepo 子包**（如 `packages/omimem-cli`）还是 **独立仓库**；`package.json` 的 `bin`、全局命令名（如 `omimem`）。
- [x] **B2. 配置**：CLI 已支持 `OMIMEM_BASE_URL`、`OMIMEM_API_TOKEN`（并支持 `--base-url`、`--api-token` 参数）（2026-04-21）。
- [x] **B3. 实现**：CLI 在配置 base URL 时默认走 HTTP；保留 `--local-db` 本地模式作为兼容过渡（2026-04-21）。
- [ ] **B4. 发布**：README 安装步骤（`npm i -g` / npx）；与 CI 版本号对齐。

### 阶段 C：Skill 与文档

- [x] **C1. 更新 `skills/omimem/SKILL.md`**：已改为 Base URL + Token 优先，`--local-db` 作为兼容模式说明（2026-04-21）。
- [ ] **C2. 发布流程**：保留「项目内改 SKILL → `git push` → 服务器上 **`cp` 到 OpenClaw workspace**」，**不使用软链**（与现有一致）。
- [x] **C3. 示例**：Skill 中已补 API 模式最小命令示例（timeline/conversations/memories/stats）（2026-04-21）。

### 阶段 D：迁移与清理

- [ ] **D1. 在数据所在服务器上**：运维默认使用 **API 模式 CLI**；确认监控与日志不泄露 Token。
- [ ] **D2. 废弃策略**：若本地读库 CLI 仅保留兼容，在文档中标注**弃用时间表**。
- [ ] **D3. 回归**：抽样对比「本地 SQL 结果」与「HTTP API 结果」一致性。

---

## 3. 依赖与风险

- **网络**：CLI 所在机器须能访问服务端 HTTPS；内网需 DNS/证书策略。
- **安全**：Token 泄露等于数据泄露；需轮换能力与最小权限（只读 Token vs 管理 Token）。
- **工作量**：全量对齐 `timeline` 等复杂查询可能比单一 `stats` 接口工作量大，建议按阶段 A 的盘点结果排序。

---

## 4. 非目标（本方案不强制）

- 替换现有 STT WebSocket 鉴权模型（除非与 A2 明确合并）。
- 一次性支持所有云厂商 CLI 范式；先满足「HTTP + Token + JSON」即可。

---

## 5. 文档与版本

- **存放位置**：`doc/knowledge-api-cli-skill-action-plan.md`
- **修订**：随 PR 更新勾选状态与新增子任务；重大架构变更改本文件版本说明与日期。
