# OMI Custom STT Provider - Soniox 集成方案（v2）

## 项目目标

构建一个 Node.js WebSocket 服务，部署在 Ubuntu 服务器上，作为 OMI APP 和 Soniox 之间的桥梁，实现自定义实时转录。

---

## OMI APP 实际配置界面说明

> 以下内容来自 APP 截图的实际观察，优先级高于文档推断。

### 主配置页

APP 的 Custom STT 设置只有一个核心字段：**WebSocket URL**，**没有独立的 API Key 输入框**。

```
提供商: Custom（实时）
WebSocket URL: wss://your-stt-api.com/live
```

高级选项展开后有两个子配置入口：**请求配置** 和 **响应模式**。

---

### 请求配置（`request_type` / `url` / `params`）

APP 内置的请求配置模板：

```json
{
  "request_type": "streaming",
  "url": "wss://your-stt-api.com/stream",
  "params": {
    "language": "en"
  }
}
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| `request_type` | 固定为 `"streaming"`，表示实时 WebSocket 流模式 |
| `url` | 实际连接的 WebSocket 地址 |
| `params` | 会以 **query string** 形式拼接到 URL 末尾 |

**鉴权注入方式：**

由于 APP 没有单独的 API Key 输入框，token 只能通过 `params` 传入：

```json
{
  "request_type": "streaming",
  "url": "wss://your-server.com/stt",
  "params": {
    "language": "zh",
    "api_key": "your-secret-token"
  }
}
```

APP 实际发起的连接：

```
wss://your-server.com/stt?language=zh&api_key=your-secret-token
```

服务端从 query string 读取 `api_key` 校验，**这是目前唯一可行的鉴权注入方式**。

> ⚠️ 待验证：需抓包确认 APP 实际将 `params` 拼入 query string 的行为。

---

### 响应模式（`segments_path` / `segments_*_field` 等）

APP 默认响应解析配置：

```json
{
  "segments_path": "segments",
  "segments_text_field": "text",
  "segments_start_field": "start",
  "segments_end_field": "end",
  "segments_speaker_field": null,
  "text_path": "text",
  "default_segment_duration": 5.0
}
```

**逐字段说明：**

| 字段 | 默认值 | 含义 |
|------|--------|------|
| `segments_path` | `"segments"` | 响应 JSON 中 segments 数组的 key 名 |
| `segments_text_field` | `"text"` | 每个 segment 中文本内容的字段名 |
| `segments_start_field` | `"start"` | 开始时间戳字段名（单位：秒） |
| `segments_end_field` | `"end"` | 结束时间戳字段名（单位：秒） |
| `segments_speaker_field` | `null` | 说话人字段名，**默认 null（不解析说话人）** |
| `text_path` | `"text"` | 非 segments 模式下纯文本字段路径 |
| `default_segment_duration` | `5.0` | 缺少时间戳时 APP 默认每段持续 5 秒 |

**对服务设计的影响：**

1. **响应字段名必须与默认值完全一致** — `segments`、`text`、`start`、`end`，不可更改
2. **说话人默认不解析** — `segments_speaker_field` 为 `null`，我们返回的 `speaker` 字段 APP 默认忽略；用户如需说话人功能，需在响应模式里将此字段改为 `"speaker"`
3. **时间戳建议始终提供** — 不提供时 APP 用 5 秒默认值填充，精确时间戳对记忆功能质量有影响
4. **`is_final` APP 不感知** — 响应模式配置里没有此字段，APP 不区分临时/最终结果，由 APP 自行决定何时发 `suggested_transcript`

---

## 架构总览

### 现有流程（Deepgram）
```
设备/APP → OMI Backend (/v4/listen) → Deepgram → 转录结果
                ↓
              Pusher → OpenAI → Memory
```

### Custom STT 模式流程
```
APP 填写请求配置 params: { api_key, language }
    │
    ▼
APP 连接: wss://your-server.com/stt?api_key=xxx&language=zh
    │
    ▼
你的服务 ──query string 鉴权──▶ 通过/拒绝
    │通过
    ▼
建立 Soniox 会话 (audio_format: "auto", model: "stt-rt-v4")
    │
    ▼
APP 发送二进制音频帧 ──透传──▶ Soniox（无需本地解码）
    │
    ▼ Soniox 返回 tokens
SegmentBuilder 组装 → { "segments": [{text, start, end, speaker}] } → APP
    │
    ▼
APP 发 suggested_transcript → OMI Backend
```

### 服务职责

1. **鉴权** — 从 URL query string 读取 `api_key` 并校验
2. **音频透传** — 将 APP 音频帧直接转发给 Soniox（依赖 `audio_format: "auto"`）
3. **Segment 组装** — Soniox tokens → segments，字段名与 APP 默认配置严格对齐
4. **会话管理** — 长会话自动重建 Soniox 连接（290 分钟轮换）
5. **返回结果** — `{ "segments": [...] }` 发回 APP

---

## 服务返回格式

与 APP 默认响应模式配置严格对齐：

```json
{
  "segments": [
    {
      "text": "你好，今天天气怎么样",
      "start": 0.6,
      "end": 2.3,
      "speaker": "SPEAKER_01"
    },
    {
      "text": "今天晴天，很不错",
      "start": 2.8,
      "end": 4.1,
      "speaker": "SPEAKER_02"
    }
  ]
}
```

**强制约束：**
- 顶层 key 必须为 `segments`（对应 `segments_path`）
- 每个 segment 必须包含 `text`、`start`、`end`（对应 `segments_*_field`）
- 不能包含 `type` 字段，或将其设为 `"Results"`（OMI 文档明确要求）
- 90 秒无数据连接会被 APP 断开（OMI 文档要求）

---

## 核心实现

### 鉴权中间件

```typescript
// src/middleware/auth.ts
import { IncomingMessage } from 'http';

const VALID_TOKENS = new Set(
  (process.env.ACCESS_TOKENS ?? '').split(',').map(t => t.trim()).filter(Boolean)
);

export function validateConnection(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '', 'wss://localhost');
  const token = url.searchParams.get('api_key');
  return !!(token && VALID_TOKENS.has(token));
}
```

### Soniox 会话配置

使用 `@soniox/node` 官方 SDK，`audio_format: "auto"` 省掉本地解码：

```typescript
// src/services/soniox-session.ts
import { SonioxNodeClient } from '@soniox/node';

const client = new SonioxNodeClient({ apiKey: process.env.SONIOX_API_KEY });

const SESSION_ROTATE_MS = 290 * 60 * 1000; // 290 分钟，5 小时上限留余量

export function createSession() {
  return client.realtime.stt({
    model: 'stt-rt-v4',
    audio_format: 'auto',          // 自动检测，兼容 APP 发送的任意格式
    enable_speaker_diarization: true,
    language_hints: (process.env.SONIOX_LANGUAGE_HINTS ?? 'zh,en').split(','),
  });
}
```

SDK 内置了 keepalive、pause/resume 和会话事件，无需手写心跳逻辑。

### Segment 组装器

```typescript
// src/utils/segment-builder.ts
import { SonioxToken, Segment } from '../types';

const SILENCE_GAP_MS  = parseInt(process.env.SEGMENT_SILENCE_GAP_MS  ?? '500');
const MAX_DURATION_MS = parseInt(process.env.SEGMENT_MAX_DURATION_MS ?? '15000');

export class SegmentBuilder {
  private buffer: SonioxToken[] = [];
  private timeOffsetMs = 0;

  setTimeOffset(ms: number) { this.timeOffsetMs = ms; }

  push(token: SonioxToken): Segment | null {
    const prev = this.buffer.at(-1);
    const shouldFlush = this.buffer.length > 0 && (
      token.speaker !== prev?.speaker ||
      token.start_ms - (prev?.end_ms ?? 0) > SILENCE_GAP_MS ||
      token.end_ms - (this.buffer[0]?.start_ms ?? 0) > MAX_DURATION_MS ||
      prev?.is_final
    );

    if (shouldFlush) {
      const seg = this.flush();
      this.buffer = [token];
      return seg;
    }
    this.buffer.push(token);
    return null;
  }

  flush(): Segment | null {
    if (!this.buffer.length) return null;
    const text = this.buffer.map(t => t.text).join('').trim();
    if (!text) { this.buffer = []; return null; }

    const seg: Segment = {
      text,
      start: (this.buffer[0].start_ms + this.timeOffsetMs) / 1000,
      end:   (this.buffer.at(-1)!.end_ms + this.timeOffsetMs) / 1000,
      speaker: `SPEAKER_${String(this.buffer[0].speaker ?? '0').padStart(2, '0')}`,
    };
    this.buffer = [];
    return seg;
  }
}
```

### 连接处理器（核心逻辑）

```typescript
// src/handlers/app-connection.ts
import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import { validateConnection } from '../middleware/auth';
import { createSession } from '../services/soniox-session';
import { SegmentBuilder } from '../utils/segment-builder';
import logger from '../utils/logger';

export async function handleAppConnection(ws: WebSocket, req: IncomingMessage) {
  // 1. 鉴权
  if (!validateConnection(req)) {
    ws.close(4401, 'Unauthorized');
    return;
  }

  const builder = new SegmentBuilder();
  const session = createSession();

  // 2. 监听 Soniox 转录结果
  session.on('result', (result) => {
    for (const token of result.tokens) {
      const seg = builder.push(token);
      if (seg) {
        ws.send(JSON.stringify({ segments: [seg] }));
      }
    }
  });

  session.on('error', (err) => {
    logger.error({ err }, 'Soniox session error');
    ws.close(1011, 'STT error');
  });

  await session.connect();

  // 3. 接收 APP 音频/控制消息
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // 音频帧直接透传给 Soniox（audio_format: "auto" 自动处理）
      session.sendAudio(data as Buffer);
    } else {
      // 文本消息：检查 CloseStream 信号
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'CloseStream') {
          const seg = builder.flush();
          if (seg) ws.send(JSON.stringify({ segments: [seg] }));
          session.finish();
        }
      } catch { /* 非 JSON，忽略 */ }
    }
  });

  // 4. APP 断开时清理
  ws.on('close', () => {
    session.close();
    logger.info('APP connection closed');
  });
}
```

---

## 项目结构

```
omi-custom-tts/
├── src/
│   ├── index.ts                 # 入口：WebSocket 服务器
│   ├── middleware/
│   │   └── auth.ts              # query string api_key 校验
│   ├── services/
│   │   └── soniox-session.ts   # Soniox 会话工厂
│   ├── handlers/
│   │   └── app-connection.ts    # APP 连接处理器
│   ├── utils/
│   │   ├── segment-builder.ts   # Token → Segment 组装
│   │   └── logger.ts            # 日志工具
│   └── types/
│       └── index.ts             # 类型定义
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 开发计划

### 阶段 1：项目初始化（Node.js 直接部署）

- [ ] 初始化 Node.js + TypeScript 项目
- [ ] 安装依赖：`ws`、`@soniox/node`、`dotenv`
- [ ] 配置 tsconfig

### 阶段 2：核心服务（最小可用版本）

- [ ] 鉴权中间件（query string api_key 校验）
- [ ] Soniox 会话连接（`@soniox/node` SDK）
- [ ] APP 连接处理器（音频透传 + segments 返回）
- [ ] `CloseStream` 处理

### 阶段 3：服务器部署（直接跑通）

- [ ] 服务器安装 Node.js 20
- [ ] 代码 scp 到服务器
- [ ] 配置环境变量（`SONIOX_API_KEY`、`ACCESS_TOKENS`）
- [ ] 直接运行 `node dist/index.js` 或 `ts-node src/index.ts`
- [ ] 验证服务启动

### 阶段 4：进程管理与日志

- [ ] PM2 进程管理（后台运行、自动重启）
- [ ] 基础日志输出
- [ ] `/healthz` HTTP 探活端点

### 阶段 5：联调验证

- [ ] APP 配置 Custom STT
- [ ] 验证转录流程
- [ ] 验证 90 秒超时行为

---

> **Docker 部署是后期可选阶段**，初期直接 Node.js 部署更简单。

---

## 本地测试方案

### 测试音频准备

测试音频可以用两种方式：

**方式 1：录制真实音频**
- 用手机或其他设备录一段语音
- 保存为 WAV 或 MP3 格式

**方式 2：使用测试脚本自动生成**
- 用 Node.js 生成测试 PCM 音频
- 或使用静音数据进行基础连接测试

### 完整测试客户端（带音频）

```typescript
// tests/test-client-with-audio.ts
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

// 读取音频文件
const audioFile = path.join(__dirname, 'test-audio.wav');
const audioBuffer = fs.readFileSync(audioFile);

const ws = new WebSocket('ws://localhost:8080/stt?api_key=my-token&language=zh');

ws.on('open', () => {
  console.log('Connected, sending audio...');
  // 发送音频数据（二进制）
  ws.send(audioBuffer);
  // 发送结束信号
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'CloseStream' }));
  }, 1000);
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
});

ws.on('close', () => {
  console.log('Connection closed');
});
```

### 简化测试：PCM 静音数据

如果暂时没有音频文件，可以用静音数据测试连接是否工作：

```typescript
// tests/test-with-silence.ts
import WebSocket from 'ws';

// 生成 1 秒静音 PCM (16kHz, 16bit, mono)
// 16kHz * 1秒 * 2字节 = 32000 字节
const silenceBuffer = Buffer.alloc(32000, 0);

const ws = new WebSocket('ws://localhost:8080/stt?api_key=my-token&language=zh');

ws.on('open', () => {
  console.log('Connected, sending 1s silence...');
  ws.send(silenceBuffer);
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'CloseStream' }));
  }, 1000);
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
});
```

### 使用 wscat 测试

```bash
# 安装
npm install -g wscat

# 连接
wscat -c "ws://localhost:8080/stt?api_key=my-token&language=zh"

# 发送二进制音频（需要先准备好音频文件）
# 或者发送结束信号
# 按 Ctrl+C 发送 CloseStream: {"type":"CloseStream"}
```

### 测试步骤

1. **准备测试音频**
   - 录制一段语音保存为 WAV/MP3
   - 或使用上面的静音测试脚本

2. **启动服务**
   ```bash
   ts-node src/index.ts
   ```

3. **运行测试客户端**
   ```bash
   TEST_AUDIO_FILE=/Users/snaker/Claude-Projects/omi-custom-tts/tests/test.m4a npm test
   ts-node tests/test-client-with-audio.ts
   ```

4. **观察结果**
   - 服务端应显示收到音频
   - 客户端应收到 segments 响应

### 验证清单

- [ ] 服务启动无报错
- [ ] 鉴权失败时返回 4401
- [ ] 收到音频后返回 segments 格式正确
- [ ] `{"type": "CloseStream"}` 正确处理
- [ ] Soniox 转录结果正确返回

---

## 环境变量

```env
# === 必需 ===
SONIOX_API_KEY=your_soniox_api_key
ACCESS_TOKENS=token-device-a,token-device-b

# === 可选 ===
PORT=8080
NODE_ENV=production
SONIOX_LANGUAGE_HINTS=zh,en
```

---

## Dockerfile (后期可选)

```dockerfile
FROM node:20-slim

# 无需 libopus，audio_format: "auto" 由 Soniox 服务端处理格式识别
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/

EXPOSE 8080
CMD ["node", "dist/index.js"]
```

> 初期直接 `node dist/index.js` 运行，无需 Docker。

---

## 类型定义

```typescript
// src/types/index.ts

export interface SonioxToken {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  is_final: boolean;
  speaker?: string;          // "1", "2", ... 启用 diarization 时存在
}

export interface SonioxResponse {
  tokens: SonioxToken[];
  final_audio_proc_ms?: number;
  finished?: boolean;
}

// 字段名与 APP 默认响应模式配置严格对齐
export interface Segment {
  text: string;              // segments_text_field: "text"
  start: number;             // segments_start_field: "start"（秒）
  end: number;               // segments_end_field: "end"（秒）
  speaker?: string;          // segments_speaker_field 默认 null，保留供用户开启
}

// 服务返回给 APP 的响应体
export interface AppResponse {
  segments: Segment[];       // segments_path: "segments"
}

// APP 发给服务的控制消息
export interface AppMessage {
  type: 'CloseStream';
}
```

---

## APP 用户配置指引

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
    "api_key": "your-secret-token"
  }
}
```

**高级 → 响应模式（需要说话人识别时修改此项）**
```json
{
  "segments_path": "segments",
  "segments_text_field": "text",
  "segments_start_field": "start",
  "segments_end_field": "end",
  "segments_speaker_field": "speaker",
  "text_path": "text",
  "default_segment_duration": 5.0
}
```

> `segments_speaker_field` 默认为 `null`，改为 `"speaker"` 后 APP 才会读取并展示说话人信息。

---

## 已确认 / 待确认事项

| 事项 | 状态 | 来源 | 说明 |
|------|------|------|------|
| APP 配置界面字段 | ✅ 已确认 | APP 截图 | 仅 WebSocket URL + 请求配置 + 响应模式，无独立 API Key 框 |
| 鉴权注入方式 | ✅ 已明确 | APP 截图 | 通过请求配置 `params.api_key` → query string |
| 响应字段名映射 | ✅ 已确认 | APP 截图 | `segments/text/start/end`，speaker 默认 null |
| 结束信号格式 | ✅ 已确认 | OMI 文档 | `{"type": "CloseStream"}` |
| 90 秒超时 | ✅ 已确认 | OMI 文档 | 无数据 90 秒后 APP 断开连接 |
| Soniox 模型名 | ✅ 已修正 | Soniox 文档 | `stt-rt-v4`（当前最新活跃版本） |
| Soniox 会话上限 | ✅ 已修正 | Soniox 文档 | 5 小时，290min 主动轮换 |
| `audio_format: "auto"` 可用性 | ⚠️ 待验证 | Soniox 文档 | 需用真实 OMI 音频帧实测 |
| `params` → query string 拼接 | ⚠️ 待验证 | APP 截图推断 | 需抓包确认实际行为 |

---

## 参考资料

- [OMI Custom STT 文档](https://docs.omi.me/doc/developer/backend/transcription)
- [OMI Real-Time Audio Streaming](https://docs.omi.me/doc/developer/apps/AudioStreaming)
- [Soniox WebSocket API](https://soniox.com/docs/stt/api-reference/websocket-api)
- [Soniox Models & Changelog](https://soniox.com/docs/stt/models)
- [Soniox Node SDK 实时转录](https://soniox.com/docs/stt/SDKs/node-SDK/realtime-transcription)
- [Soniox Proxy Stream 指南](https://soniox.com/docs/stt/guides/proxy-stream)


const WS = require('ws');

if (!globalThis.WebSocket) {
  globalThis.WebSocket = WS;
}

console.log('[Boot] globalThis.WebSocket =', typeof globalThis.WebSocket);
console.log('[Boot] marker = soniox-ws-fix');