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

## 部署步骤

### 1. 首次在服务器上准备目录并拉代码

```bash
ssh user@your-server

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
EOF
```

说明：

- `DATA_ROOT` 建议显式配置，运行时数据不要和 git 工作树混放
- `DB_PATH` 建议显式配置，避免服务默认写入当前工作目录下的 `app.db`
- 音频、raw/finalized/preview 结果、桌面视频 chunk 默认都会跟随 `DATA_ROOT`

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
ssh user@your-server
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

wss://47.116.162.110/stt
