# OMI Custom STT 部署指南

## 服务器要求

- Ubuntu 20.04+ / Debian 11+
- Node.js 20 LTS
- 1GB+ 内存
- 开放的 8080 端口（或自定义 PORT）

## 部署步骤

### 1. 上传代码到服务器

```bash
# 在本地打包（排除运行时数据，避免覆盖线上库文件）
./scripts/package-release.sh

# 上传到服务器
scp omi-custom-tts.tar.gz user@your-server:/opt/omi-custom-tts/
```

### 2. 在服务器上解压和安装

```bash
ssh user@your-server

cd /opt/omi-custom-tts
tar -xzvf omi-custom-tts.tar.gz

# 安装依赖
npm install
npm run build
# 构建
npm run build
```

### 3. 配置环境变量

```bash
# 创建 .env 文件
cat > .env << 'EOF'
# 必需
SONIOX_API_KEY=your_soniox_api_key_here
ACCESS_TOKENS=token-device-a,token-device-b

# 可选
PORT=8080
DB_PATH=/www/app.db
SONIOX_LANGUAGE_HINTS=zh,en
EOF
```

说明：

- `DB_PATH` 建议显式配置，避免服务默认写入当前工作目录下的 `app.db`
- 如果历史数据在 `/www/app.db`，线上环境应固定使用该路径，不要依赖默认值

### 4. 使用 PM2 运行

```bash
# 安装 PM2（如果没有）
npm install -g pm2

# 启动服务
pm2 start dist/index.js --name omi-custom-tts

# 设置开机自启
pm2 startup
pm2 save

# 查看状态
pm2 status

# 查看日志
pm2 logs omi-custom-tts
```

### 5. 验证部署

```bash
# 检查服务状态
curl http://localhost:8080/healthz

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
        proxy_pass http://localhost:8080;
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
ss -tlnp | grep 8080

# 2. 检查进程是否运行
pm2 status

# 3. 查看错误日志
pm2 logs omi-custom-tts --err --lines=50

# 4. 测试 Soniox API key 是否有效
curl -X POST https://api.soniox.com/token-usage \
  -d "api_key=YOUR_API_KEY"
```

wss://47.116.162.110/stt
