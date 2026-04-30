# OMI Custom STT 部署指南

## 服务器要求

- Ubuntu 20.04+ / Debian 11+
- Node.js 20 LTS
- 1GB+ 内存
- 开放的 28089 端口（或自定义 `PORT`）

## 推荐目录结构

```text
/www/
  omi-custom-tts/        # git 工作树 / 代码目录
  omi-custom-tts-data/   # 运行时数据（数据库、音频、结果文件）
```

## SSH 登录（查阅服务器状态）

本服务部署在腾讯云。日常运维、查 PM2、跟日志、在机器上 `curl` 健康检查、查看 `DATA_ROOT` 下数据等，都需要先登录服务器。

若你在**本机** `~/.ssh/config` 里已配置 `Host tencent`，可直接：

```bash
ssh tencent
```

说明：

- `tencent` 是 SSH 别名；实际 `HostName`、`User`、`IdentityFile`、端口等以你本机 `~/.ssh/config` 为准。未配置时可用 `ssh user@服务器 IP` 代替，或先补全 config 再使用 `ssh tencent`。
- 下文凡写「登录服务器」的步骤，均默认你已能按上述方式连上同一台机器；代码目录、数据目录以服务器上实际路径为准（常见为 `/www/omi-custom-tts` 与 `/www/omi-custom-tts-data`，见上文）。

## 部署步骤

### 1. 首次在服务器上准备目录并拉代码

```bash
ssh tencent

mkdir -p /www/omi-custom-tts
mkdir -p /www/omi-custom-tts-data

git clone --branch master git@github.com:snakerfor/omi-costom-tts.git /www/omi-custom-tts
cd /www/omi-custom-tts
npm install
npm run build
```

### 2. 配置环境变量

```bash
# 创建 .env 文件
cat > .env << 'EOF'
# 必需
SONIOX_API_KEY=your_soniox_api_key_here
ACCESS_TOKENS=token-device-a,token-device-b

# 可选
PORT=28089
DATA_ROOT=/www/omi-custom-tts-data
DB_PATH=/www/omi-custom-tts-data/app.db
SONIOX_LANGUAGE_HINTS=zh,en
SESSION_MAX_DURATION_MS=1800000

# ChatGPT / MCP 连接器只读访问 token；不设置时会回退使用 ACCESS_TOKENS
MCP_ACCESS_TOKENS=token-chatgpt-a

# ChatGPT OAuth 首次授权页面口令；不设置时会回退使用 MCP_ACCESS_TOKENS/ACCESS_TOKENS 中第一个 token
MCP_OAUTH_APPROVAL_TOKEN=one-time-approval-token

# 公网 HTTPS 入口；用于 OAuth discovery 中生成正确 issuer/endpoints
MCP_PUBLIC_BASE_URL=https://your-server.com
EOF
```

说明：

- `DATA_ROOT` 建议显式配置，运行时数据不要和 git 工作树混放
- `DB_PATH` 建议显式配置，避免服务默认写入当前工作目录下的 `app.db`
- 音频、raw/finalized/preview 结果、桌面视频 chunk 默认都会跟随 `DATA_ROOT`
- `SESSION_MAX_DURATION_MS` 默认 1800000，即 30 分钟；到时服务会结束当前会话并关闭连接，客户端重连后生成新的对话
- `MCP_ACCESS_TOKENS` 建议单独配置给 ChatGPT MCP 使用；服务同时支持 `Authorization: Bearer <token>` 和 URL query `?api_key=<token>`
- `MCP_OAUTH_APPROVAL_TOKEN` 用于 ChatGPT OAuth 首次授权时的人工确认；授权完成后 ChatGPT 使用 OAuth access token / refresh token
- `MCP_PUBLIC_BASE_URL` 必须是 ChatGPT 能访问的公网 HTTPS 根地址；否则 OAuth discovery 可能在反向代理后生成错误的 `http://` 地址

### 2.1 现有服务器从旧结构升级

如果你当前服务还跑在旧的 `/www` 根目录，不要只改 `.env` 后直接重启，否则会连到新空目录。

先按下面顺序迁移旧数据：

```bash
# 停服务
pm2 stop omi-custom-tts

# 准备新目录
mkdir -p /www/omi-custom-tts
mkdir -p /www/omi-custom-tts-data

# 迁移运行时数据
mv /www/app.db /www/omi-custom-tts-data/app.db
mv /www/audio-uploads /www/omi-custom-tts-data/audio-uploads
mv /www/raw_results /www/omi-custom-tts-data/raw_results
mv /www/finalized_results /www/omi-custom-tts-data/finalized_results
mv /www/preview_results /www/omi-custom-tts-data/preview_results
mv /www/data/clips /www/omi-custom-tts-data/clips
mv /www/data/omi-videos /www/omi-custom-tts-data/omi-videos
```

然后再把代码迁到 `/www/omi-custom-tts`，并更新 `.env`：

```bash
PORT=28089
DATA_ROOT=/www/omi-custom-tts-data
DB_PATH=/www/omi-custom-tts-data/app.db
OMI_SYNC_VIDEO_ROOT=/www/omi-custom-tts-data/omi-videos
```

说明：

- 老服务器如果不更新 `.env`，仍可能继续监听旧端口或写回旧目录
- 旧结构升级时，必须先搬数据，再切代码目录和 PM2 `cwd`

### 3. 使用 PM2 运行

```bash
# 安装 PM2（如果没有）
npm install -g pm2

# 启动或重载服务
pm2 startOrReload ecosystem.config.js --only omi-custom-tts

# 设置开机自启
pm2 startup
pm2 save

# 查看状态
pm2 status

# 查看日志
pm2 logs omi-custom-tts
```

### 4. 之后的更新发布

```bash
ssh tencent
cd /www/omi-custom-tts

# 拉代码并部署
bash ./scripts/deploy-from-git.sh origin/master
```

也可以部署指定 commit：

```bash
bash ./scripts/deploy-from-git.sh <commit-sha>
```

### 5. 验证部署

```bash
# 检查服务状态
curl http://localhost:28089/healthz

# 输出应为: {"status":"ok"}
```

## 线上巡检（数据与服务状态）

需要确认进程是否存活、接口是否响应、库里是否有持续写入时，先 [`ssh tencent`](#ssh-登录查阅服务器状态)，再按需执行下面命令。  
数据库路径以服务器上 `.env` 的 `DB_PATH` 为准；若未改，一般为 `/www/omi-custom-tts-data/app.db`。

**HTTP 健康检查**

```bash
curl -sS http://127.0.0.1:28089/healthz
# 期望: {"status":"ok"}
```

**端口是否在监听**

```bash
ss -tlnp | grep 28089
# 或: netstat -tlnp | grep 28089
```

**PM2（若直接执行 `pm2` 提示未找到，可用 login shell）**

```bash
bash -lc "pm2 status"
bash -lc "pm2 logs omi-custom-tts --lines=80"
```

**SQLite：行数与抽样（先设 `DB` 与 `.env` 中 `DB_PATH` 一致）**

```bash
DB=/www/omi-custom-tts-data/app.db
sqlite3 "$DB" "SELECT COUNT(*) AS conversations FROM conversations;"
sqlite3 "$DB" "SELECT COUNT(*) AS segments FROM conversation_segments;"
sqlite3 "$DB" "SELECT COUNT(*) AS omi_import_runs FROM omi_import_runs;"
sqlite3 "$DB" "SELECT id, status, created_at, ended_at FROM conversations ORDER BY created_at DESC LIMIT 5;"
sqlite3 "$DB" "SELECT id, source_key, status, started_at, finished_at FROM omi_import_runs ORDER BY started_at DESC LIMIT 5;"
```

**应用日志（路径以 PM2 配置为准，常见如下）**

```bash
tail -n 50 /root/.pm2/logs/omi-custom-tts-out.log
tail -n 50 /root/.pm2/logs/omi-custom-tts-error.log
```

日志中出现 `[Soniox] Partial` / `Final` 表示实时转写链路有流量；`[Finalize]` 表示会话结束后的落盘与后续步骤已执行。若健康检查失败或 `segments` 长期不增长，再结合错误日志与 Soniox 配额排查。

## 常用运维命令

```bash
# 重启服务
pm2 restart omi-custom-tts

# 停止服务
pm2 stop omi-custom-tts

# 查看实时日志
pm2 logs omi-custom-tts --raw

# 查看详细日志
pm2 logs omi-custom-tts --lines=100
```

## OMI APP 配置

在 APP 中配置 Custom STT：

**主配置页**
```
提供商: Custom（实时）
WebSocket URL: wss://your-server.com/stt
```

**高级 → 请求配置**
```json
{
  "request_type": "streaming",
  "url": "wss://your-server.com/stt",
  "params": {
    "language": "zh",
    "api_key": "token-device-a"
  }
}
```

生产环境若直接使用 IP 接入，WebSocket 示例（以你实际地址为准）：

```text
wss://47.116.162.110/stt
```

## ChatGPT MCP 连接器配置

服务内置只读 MCP server，用于让 ChatGPT 查询个人知识层。

可用 endpoint：

```text
https://your-server.com/mcp
https://your-server.com/sse
```

说明：

- `/mcp` 是新版 Streamable HTTP transport。
- `/sse` 是兼容 ChatGPT 自定义连接器界面中常见的 SSE URL。
- 推荐在 ChatGPT 连接器中选择 OAuth。服务提供：
  - `/.well-known/oauth-protected-resource/mcp`
  - `/.well-known/oauth-authorization-server`
  - `/oauth/register`
  - `/oauth/authorize`
  - `/oauth/token`
- OAuth 支持 dynamic client registration、authorization code + PKCE、refresh token。
- 首次连接时浏览器会打开授权页，输入 `MCP_OAUTH_APPROVAL_TOKEN` 完成授权。
- 如果连接器界面支持 Bearer token，也可直接填 `MCP_ACCESS_TOKENS` 中的任一 token。
- 如果界面只能填写 URL，可临时使用 `https://your-server.com/sse?api_key=token-chatgpt-a`，但更推荐 OAuth 或 Bearer token，避免 token 出现在日志或浏览器历史里。

当前 MCP 工具均为只读：

| 工具 | 说明 |
|------|------|
| `search` | 跨长期记忆、聚合会话、时间线事件搜索 |
| `fetch` | 按 id 拉取 memory / conversation / event 详情 |
| `list_timeline` | 按时间、发言人、身份、置信度列出事件 |
| `list_conversations` | 列出聚合会话 |
| `list_memories` | 列出长期记忆 |
| `review_speaker_segments` | 查询低置信或未确认发言人片段 |

## Nginx 反向代理（可选）

如果需要 HTTPS 或域名：

```nginx
server {
    listen 443 ssl;
    server_name your-server.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:28089;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

## 故障排查

```bash
# 1. 检查端口是否监听
ss -tlnp | grep 28089

# 2. 检查进程是否运行
pm2 status

# 3. 查看错误日志
pm2 logs omi-custom-tts --err --lines=50

# 4. 测试 Soniox API key 是否有效
curl -X POST https://api.soniox.com/token-usage \
  -d "api_key=YOUR_API_KEY"
```
