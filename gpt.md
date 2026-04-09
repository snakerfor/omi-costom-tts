```markdown
# 发言人识别与匿名 Speaker 管理系统 v347

基于 **Soniox 异步转写 + Node.js + 本地 Python Embedding**

---

## 目录

- [项目目标](#项目目标)
- [核心设计](#核心设计)
- [系统架构](#系统架构)
- [Soniox 原始 JSON 与适配层](#soniox-原始-json-与适配层)
- [业务流程](#业务流程)
- [数据库设计](#数据库设计)
- [项目目录结构](#项目目录结构)
- [Node.js 代码清单](#nodejs-代码清单)
- [Python 代码清单](#python-代码清单)
- [运行方式](#运行方式)
- [后台接口](#后台接口)
- [开发顺序建议](#开发顺序建议)
- [说明与注意事项](#说明与注意事项)

---

## 项目目标

本系统用于处理持续新增的长音频 `WAV` 文件，实现以下能力：

1. 监控目录中的新录音文件
2. 调用 **Soniox 异步接口**完成：
   - 语音转文字
   - speaker diarization
3. 保存 Soniox 原始 JSON 结果
4. 将原始 JSON 适配为系统内部统一结构
5. 聚合为结构化对话片段 `segments`
6. 对每个 speaker 执行 identity mapping
7. 如果没有已知 speaker，也能自动建立匿名 speaker 档案
8. 后续再次遇到相同声音时，复用已有匿名 speaker
9. 用户可以通过后台对匿名 speaker 填写真实姓名
10. 一旦填写真实姓名，自动回填所有历史对话片段中的 `speaker_name`

---

## 核心设计

### 1. Soniox 只负责前半段

Soniox 负责：

- 异步语音转文字
- speaker diarization

也就是回答：

- 说了什么
- 谁在什么时候说话

Soniox 的 `speaker` 是会话内标签，不是真实姓名。

---

### 2. 本地系统负责 speaker identity mapping

本地系统在 Soniox 返回结果后再做：

- 片段聚合
- 音频裁剪
- embedding 提取
- speaker 匹配
- 匿名 speaker 创建与复用

---

### 3. 匿名 speaker 是正式对象

系统允许一开始没有任何已知 speaker。  
因此第一次处理音频时：

- 匹配不到已有 speaker 很正常
- 系统会自动创建匿名 speaker
- 保存其 embedding、文本样本、示例音频

后续如果再次遇到同一声音，应复用该匿名 speaker，而不是重新创建。

---

### 4. 人工确认是“补名字”，不是新建 speaker

当用户在后台给匿名 speaker 填写真实姓名后：

- 更新已有 `speaker`
- 更新所有历史 `conversation_segments`
- 回填 `speaker_name`

---

### 5. 时间字段双存

每个 segment 同时保存：

- 相对时间：
  - `start_ms`
  - `end_ms`
- 绝对时间：
  - `absolute_start_time`
  - `absolute_end_time`

---

## 系统架构

```text
[目录 data/inbox/*.wav]
        │
        ▼
[Node.js 扫描器]
        │
        ▼
[audio_files: pending]
        │
        ▼
[Soniox Async]
  - 异步转写
  - diarization
        │
        ▼
[保存 raw JSON]
        │
        ▼
[sonioxAdapter.js]
  - 原始 JSON -> words[]
        │
        ▼
[segmenter.js]
  - words[] -> segments[]
        │
        ▼
[conversation_segments 入库]
        │
        ▼
[speakerMapper.js]
  - 按 speaker_label 聚合
  - 裁片
  - Node.js 调 Python
  - 提 embedding
  - 匹配已有 speaker
  - 匹配不到则创建匿名 speaker
        │
        ▼
[后台 API]
  - 查询匿名 speaker
  - 确认姓名
  - 回填历史 segments
```

---

## Soniox 原始 JSON 与适配层

### 为什么要有适配层

适配层不是因为 Soniox 不稳定，而是因为：

- Soniox 返回的是第三方原始格式
- 你的业务系统应该使用内部统一格式
- 后续如果字段结构变化，只修改一处即可

---

### Soniox 原始 JSON 示例

> 以下为示意结构，实际以 Soniox 真正返回为准。

```json
{
  "job_id": "job_123456",
  "status": "completed",
  "language": "zh",
  "words": [
    { "text": "我", "start_ms": 0, "end_ms": 120, "speaker": "1" },
    { "text": "觉得", "start_ms": 130, "end_ms": 320, "speaker": "1" },
    { "text": "可以", "start_ms": 340, "end_ms": 500, "speaker": "1" },
    { "text": "。", "start_ms": 510, "end_ms": 530, "speaker": "1" },
    { "text": "那", "start_ms": 1200, "end_ms": 1300, "speaker": "2" },
    { "text": "就", "start_ms": 1320, "end_ms": 1400, "speaker": "2" },
    { "text": "这样", "start_ms": 1420, "end_ms": 1650, "speaker": "2" }
  ]
}
```

---

### 适配后的内部 words 结构

```json
[
  { "text": "我", "start_ms": 0, "end_ms": 120, "speaker": "1" },
  { "text": "觉得", "start_ms": 130, "end_ms": 320, "speaker": "1" },
  { "text": "可以", "start_ms": 340, "end_ms": 500, "speaker": "1" },
  { "text": "。", "start_ms": 510, "end_ms": 530, "speaker": "1" },
  { "text": "那", "start_ms": 1200, "end_ms": 1300, "speaker": "2" },
  { "text": "就", "start_ms": 1320, "end_ms": 1400, "speaker": "2" },
  { "text": "这样", "start_ms": 1420, "end_ms": 1650, "speaker": "2" }
]
```

---

### 聚合后的 segments 示例

```json
[
  {
    "id": "seg_001",
    "start_ms": 0,
    "end_ms": 530,
    "speaker_label": "1",
    "text": "我觉得可以。"
  },
  {
    "id": "seg_002",
    "start_ms": 1200,
    "end_ms": 1650,
    "speaker_label": "2",
    "text": "那就这样"
  }
]
```

---

## 业务流程

### 1. 扫描新文件

系统定时扫描 `data/inbox/` 目录：

- 找到新 `wav`
- 判断文件是否稳定
- 计算 hash 去重
- 写入 `audio_files`
- 状态设为 `pending`

---

### 2. Soniox 异步任务

对于 `pending` 文件：

1. 获取音频时长
2. 推导录音开始/结束时间
3. 调用 Soniox Async
4. 保存任务信息到 `transcription_jobs`
5. 轮询直到任务完成
6. 保存原始 JSON 到 `raw_results/`

---

### 3. JSON 适配与分段

任务完成后：

1. 读取 Soniox 原始 JSON
2. 使用 `sonioxAdapter.js` 提取统一 `words`
3. 使用 `segmenter.js` 聚合为 `segments`

---

### 4. Segment 入库

每个 segment 保存：

- `start_ms`
- `end_ms`
- `absolute_start_time`
- `absolute_end_time`
- `speaker_label`
- `text`

此时：

- `speaker_id = null`
- `speaker_name = null`

---

### 5. Speaker Identity Mapping

系统对当前录音中的每个 `speaker_label`：

1. 聚合所有对应 segment
2. 选候选片段
3. 从原始 WAV 裁片
4. 提 embedding
5. 与历史 speaker 库匹配

---

### 6. 匹配成功

如果匹配到已有 speaker：

- 复用 `speaker_id`
- 更新当前录音相关 segment
- 若该 speaker 已有姓名，则 `speaker_name` 直接写入

---

### 7. 匹配失败

如果匹配不到已有 speaker：

- 创建匿名 speaker
- 保存 embedding
- 保存 `sample_text`
- 保存 `sample_audio_path`
- 当前录音相关 segment 绑定该匿名 speaker

---

### 8. 人工确认匿名 speaker

后台显示匿名 speaker 列表：

- `display_label`
- `sample_text`
- `sample_audio_path`

用户确认后：

- 更新 `speakers`
- 更新所有历史 `conversation_segments`
- 回填 `speaker_name`

---

## 数据库设计

### `audio_files`

```sql
CREATE TABLE IF NOT EXISTS audio_files (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  duration_ms INTEGER,
  recording_start_time TEXT,
  recording_end_time TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error_message TEXT
);
```

### `transcription_jobs`

```sql
CREATE TABLE IF NOT EXISTS transcription_jobs (
  id TEXT PRIMARY KEY,
  audio_file_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  remote_job_id TEXT,
  status TEXT NOT NULL,
  raw_result_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `conversation_segments`

```sql
CREATE TABLE IF NOT EXISTS conversation_segments (
  id TEXT PRIMARY KEY,
  audio_file_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  absolute_start_time TEXT,
  absolute_end_time TEXT,
  speaker_label TEXT,
  speaker_id TEXT,
  speaker_name TEXT,
  text TEXT NOT NULL,
  confidence REAL,
  resolution_method TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `speakers`

```sql
CREATE TABLE IF NOT EXISTS speakers (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL,
  display_label TEXT,
  sample_text TEXT,
  sample_segment_id TEXT,
  sample_audio_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `speaker_embeddings`

```sql
CREATE TABLE IF NOT EXISTS speaker_embeddings (
  id TEXT PRIMARY KEY,
  speaker_id TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  sample_rate INTEGER,
  duration_ms INTEGER,
  source_audio_file_id TEXT,
  source_segment_id TEXT,
  source TEXT,
  created_at TEXT NOT NULL
);
```

---

## 项目目录结构

```text
project/
├── src/
│   ├── app.js
│   ├── server.js
│   ├── config.js
│   ├── db.js
│   ├── utils.js
│   ├── scanner.js
│   ├── sonioxClient.js
│   ├── sonioxAdapter.js
│   ├── audioMeta.js
│   ├── timeResolver.js
│   ├── segmenter.js
│   ├── audioClipper.js
│   ├── pythonEmbedding.js
│   ├── speakerMapper.js
│   ├── speakerService.js
│   ├── pipeline.js
│   └── routes/
│       └── speakers.js
├── scripts/
│   ├── extract_embedding.py
│   └── enroll_speaker.js
├── data/
│   ├── inbox/
│   ├── clips/
│   ├── archive/
│   └── failed/
├── raw_results/
├── package.json
├── .env
└── app.db
```

---

## Node.js 代码清单

### `package.json`

```json
{
  "name": "audio-speaker-pipeline",
  "version": "1.0.0",
  "main": "src/app.js",
  "scripts": {
    "start": "node src/app.js",
    "api": "node src/server.js",
    "enroll": "node scripts/enroll_speaker.js"
  },
  "dependencies": {
    "axios": "^1.7.2",
    "better-sqlite3": "^11.1.2",
    "body-parser": "^1.20.2",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "fluent-ffmpeg": "^2.1.3",
    "form-data": "^4.0.0",
    "fs-extra": "^11.2.0",
    "uuid": "^10.0.0"
  }
}
```

### `.env`

```env
INBOX_DIR=./data/inbox
CLIPS_DIR=./data/clips
RAW_RESULTS_DIR=./raw_results
SCAN_INTERVAL_MS=30000

SONIOX_API_KEY=your_soniox_api_key
SONIOX_BASE_URL=https://api.soniox.com
```

### `src/config.js`

```javascript
require('dotenv').config();

module.exports = {
  inboxDir: process.env.INBOX_DIR || './data/inbox',
  clipsDir: process.env.CLIPS_DIR || './data/clips',
  rawResultsDir: process.env.RAW_RESULTS_DIR || './raw_results',
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS || 30000),

  sonioxApiKey: process.env.SONIOX_API_KEY,
  sonioxBaseUrl: process.env.SONIOX_BASE_URL || 'https://api.soniox.com',
};
```

### `src/db.js`

```javascript
const Database = require('better-sqlite3');

const db = new Database('app.db');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audio_files (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      duration_ms INTEGER,
      recording_start_time TEXT,
      recording_end_time TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS transcription_jobs (
      id TEXT PRIMARY KEY,
      audio_file_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      remote_job_id TEXT,
      status TEXT NOT NULL,
      raw_result_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_segments (
      id TEXT PRIMARY KEY,
      audio_file_id TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      absolute_start_time TEXT,
      absolute_end_time TEXT,
      speaker_label TEXT,
      speaker_id TEXT,
      speaker_name TEXT,
      text TEXT NOT NULL,
      confidence REAL,
      resolution_method TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS speakers (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL,
      display_label TEXT,
      sample_text TEXT,
      sample_segment_id TEXT,
      sample_audio_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS speaker_embeddings (
      id TEXT PRIMARY KEY,
      speaker_id TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      sample_rate INTEGER,
      duration_ms INTEGER,
      source_audio_file_id TEXT,
      source_segment_id TEXT,
      source TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

module.exports = { db, initDb };
```

### `src/utils.js`

```javascript
const fs = require('fs');
const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function isFileStable(filePath, waitMs = 1000) {
  const size1 = fs.statSync(filePath).size;
  await new Promise(r => setTimeout(r, waitMs));
  const size2 = fs.statSync(filePath).size;
  return size1 === size2;
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = {
  nowIso,
  sha256File,
  isFileStable,
  cosineSimilarity,
};
```

### `src/scanner.js`

```javascript
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const { sha256File, isFileStable, nowIso } = require('./utils');
const config = require('./config');

async function scanNewFiles() {
  const files = fs.readdirSync(config.inboxDir)
    .filter(name => name.toLowerCase().endsWith('.wav'));

  for (const fileName of files) {
    const filePath = path.join(config.inboxDir, fileName);

    const stable = await isFileStable(filePath, 1000);
    if (!stable) continue;

    const fileHash = await sha256File(filePath);

    const exists = db.prepare(`
      SELECT id FROM audio_files
      WHERE file_path = ? OR file_hash = ?
    `).get(filePath, fileHash);

    if (exists) continue;

    const id = `aud_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = nowIso();

    db.prepare(`
      INSERT INTO audio_files (id, file_path, file_name, file_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, filePath, fileName, fileHash, 'pending', now, now);

    console.log(`[scanner] new wav detected: ${filePath}`);
  }
}

module.exports = { scanNewFiles };
```

### `src/sonioxClient.js`

```javascript
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');

class SonioxClient {
  constructor() {
    this.client = axios.create({
      baseURL: config.sonioxBaseUrl,
      headers: {
        Authorization: `Bearer ${config.sonioxApiKey}`,
      },
      timeout: 300000,
    });
  }

  async submitAsyncTranscription(filePath) {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('model', 'stt-async-v4');
    form.append('enable_speaker_diarization', 'true');

    const resp = await this.client.post('/transcribe/async', form, {
      headers: form.getHeaders(),
    });

    return resp.data.id;
  }

  async getJob(jobId) {
    const resp = await this.client.get(`/transcribe/async/${jobId}`);
    return resp.data;
  }

  async waitForCompletion(jobId, intervalMs = 10000, timeoutMs = 3600000) {
    const started = Date.now();

    while (true) {
      const result = await this.getJob(jobId);
      if (result.status === 'completed') return result;
      if (result.status === 'failed') {
        throw new Error(`Soniox job failed: ${JSON.stringify(result)}`);
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Soniox timeout: ${jobId}`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
}

module.exports = { SonioxClient };
```

### `src/sonioxAdapter.js`

```javascript
function extractWordsFromSonioxResult(result) {
  const rawWords = result?.words || [];

  return rawWords
    .map(w => ({
      text: (w.text || '').trim(),
      start_ms: Number(w.start_ms || 0),
      end_ms: Number(w.end_ms || 0),
      speaker: w.speaker != null ? String(w.speaker) : null,
    }))
    .filter(w => w.text);
}

module.exports = {
  extractWordsFromSonioxResult,
};
```

### `src/audioMeta.js`

```javascript
const ffmpeg = require('fluent-ffmpeg');

function getAudioDurationMs(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const durationSec = metadata?.format?.duration;
      if (!durationSec) return reject(new Error('Cannot get audio duration'));
      resolve(Math.round(durationSec * 1000));
    });
  });
}

module.exports = { getAudioDurationMs };
```

### `src/timeResolver.js`

```javascript
function resolveRecordingTime(fileStat, durationMs) {
  const recordingEnd = new Date(fileStat.mtime);
  const recordingStart = new Date(recordingEnd.getTime() - durationMs);

  return {
    recordingStart,
    recordingEnd,
  };
}

function segmentOffsetToAbsolute(recordingStart, startMs, endMs) {
  return {
    absoluteStartTime: new Date(recordingStart.getTime() + startMs).toISOString(),
    absoluteEndTime: new Date(recordingStart.getTime() + endMs).toISOString(),
  };
}

module.exports = {
  resolveRecordingTime,
  segmentOffsetToAbsolute,
};
```

### `src/segmenter.js`

```javascript
const { v4: uuidv4 } = require('uuid');

const MAX_GAP_MS = 1200;

function buildSegmentsFromWords(words) {
  if (!Array.isArray(words) || words.length === 0) {
    return [];
  }

  const segments = [];
  let current = null;

  for (const w of words) {
    const text = (w.text || '').trim();
    const startMs = Number(w.start_ms || 0);
    const endMs = Number(w.end_ms || startMs);
    const speaker = w.speaker != null ? String(w.speaker) : null;

    if (!text) continue;

    if (!current) {
      current = {
        id: `seg_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
        start_ms: startMs,
        end_ms: endMs,
        speaker_label: speaker,
        text_parts: [text],
      };
      continue;
    }

    const gap = startMs - current.end_ms;
    const sameSpeaker = current.speaker_label === speaker;
    const prevText = current.text_parts[current.text_parts.length - 1] || '';

    const shouldSplit =
      !sameSpeaker ||
      gap > MAX_GAP_MS ||
      /[。！？.!?]$/.test(prevText);

    if (shouldSplit) {
      segments.push({
        id: current.id,
        start_ms: current.start_ms,
        end_ms: current.end_ms,
        speaker_label: current.speaker_label,
        text: current.text_parts.join('').trim(),
      });

      current = {
        id: `seg_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
        start_ms: startMs,
        end_ms: endMs,
        speaker_label: speaker,
        text_parts: [text],
      };
    } else {
      current.end_ms = endMs;
      current.text_parts.push(text);
    }
  }

  if (current) {
    segments.push({
      id: current.id,
      start_ms: current.start_ms,
      end_ms: current.end_ms,
      speaker_label: current.speaker_label,
      text: current.text_parts.join('').trim(),
    });
  }

  return segments;
}

module.exports = {
  buildSegmentsFromWords,
};
```

### `src/audioClipper.js`

```javascript
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');

async function clipAudioSegment(inputPath, outputPath, startMs, endMs) {
  await fs.ensureDir(path.dirname(outputPath));

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startMs / 1000)
      .setDuration((endMs - startMs) / 1000)
      .audioChannels(1)
      .audioFrequency(16000)
      .format('wav')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

module.exports = { clipAudioSegment };
```

### `src/pythonEmbedding.js`

```javascript
const { spawn } = require('child_process');

function extractEmbeddingWithPython(audioPaths) {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', ['scripts/extract_embedding.py', ...audioPaths]);

    let stdout = '';
    let stderr = '';

    py.stdout.on('data', data => {
      stdout += data.toString();
    });

    py.stderr.on('data', data => {
      stderr += data.toString();
    });

    py.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`Python failed: ${stderr}`));
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result.embedding);
      } catch (e) {
        reject(new Error(`Invalid python output: ${stdout}`));
      }
    });
  });
}

module.exports = { extractEmbeddingWithPython };
```

### `src/speakerMapper.js`

```javascript
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const { clipAudioSegment } = require('./audioClipper');
const { extractEmbeddingWithPython } = require('./pythonEmbedding');
const { nowIso, cosineSimilarity } = require('./utils');

function pickCandidateSegments(segments, maxCount = 3) {
  return segments
    .map(seg => ({
      ...seg,
      duration: seg.end_ms - seg.start_ms,
      textLen: (seg.text || '').length,
      score: (seg.end_ms - seg.start_ms) + ((seg.text || '').length * 100),
    }))
    .filter(seg => seg.duration >= 1500 && seg.textLen >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCount);
}

function chooseRepresentativeSegment(segments) {
  if (!segments.length) return null;

  return segments
    .map(seg => ({
      ...seg,
      duration: seg.end_ms - seg.start_ms,
      textLen: (seg.text || '').length,
      score: (seg.end_ms - seg.start_ms) + ((seg.text || '').length * 100),
    }))
    .sort((a, b) => b.score - a.score)[0];
}

function findBestMatchingSpeaker(embedding, threshold = 0.75, margin = 0.05) {
  const rows = db.prepare(`
    SELECT
      se.embedding_json,
      s.id AS speaker_id,
      s.name AS speaker_name,
      s.status AS speaker_status,
      s.display_label
    FROM speaker_embeddings se
    JOIN speakers s ON s.id = se.speaker_id
  `).all();

  if (!rows.length) return null;

  const candidates = rows.map(row => {
    const known = JSON.parse(row.embedding_json);
    return {
      speaker_id: row.speaker_id,
      speaker_name: row.speaker_name,
      speaker_status: row.speaker_status,
      display_label: row.display_label,
      similarity: cosineSimilarity(embedding, known),
    };
  }).sort((a, b) => b.similarity - a.similarity);

  const best = candidates[0];
  const second = candidates[1];

  if (best.similarity < threshold) return null;
  if (second && (best.similarity - second.similarity) < margin) return null;

  return best;
}

function getNextAnonymousDisplayLabel() {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM speakers WHERE status = 'anonymous'
  `).get();

  const index = (row?.cnt || 0) + 1;
  return `未命名发言人${index}`;
}

function createAnonymousSpeaker({
  embedding,
  sampleText,
  sampleSegmentId,
  sampleAudioPath,
  sourceAudioFileId,
  sourceSegmentId,
}) {
  const speakerId = `spk_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const embeddingId = `emb_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const now = nowIso();
  const displayLabel = getNextAnonymousDisplayLabel();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO speakers (
        id, name, status, display_label, sample_text, sample_segment_id, sample_audio_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      speakerId,
      null,
      'anonymous',
      displayLabel,
      sampleText || null,
      sampleSegmentId || null,
      sampleAudioPath || null,
      now,
      now
    );

    db.prepare(`
      INSERT INTO speaker_embeddings (
        id, speaker_id, embedding_json, sample_rate, duration_ms,
        source_audio_file_id, source_segment_id, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      embeddingId,
      speakerId,
      JSON.stringify(embedding),
      16000,
      null,
      sourceAudioFileId || null,
      sourceSegmentId || null,
      'auto_discovered',
      now
    );
  });

  tx();

  return {
    speaker_id: speakerId,
    speaker_name: null,
    speaker_status: 'anonymous',
    display_label: displayLabel,
  };
}

async function runSpeakerIdentityMapping(audioFileId, filePath, clipsDir) {
  const segments = db.prepare(`
    SELECT * FROM conversation_segments
    WHERE audio_file_id = ?
    ORDER BY start_ms ASC
  `).all(audioFileId);

  const grouped = {};
  for (const seg of segments) {
    const label = seg.speaker_label || 'unknown';
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(seg);
  }

  for (const speakerLabel of Object.keys(grouped)) {
    const allSegments = grouped[speakerLabel];
    const candidates = pickCandidateSegments(allSegments, 3);
    if (!candidates.length) continue;

    const representative = chooseRepresentativeSegment(candidates);
    const clipPaths = [];

    for (let i = 0; i < candidates.length; i++) {
      const seg = candidates[i];
      const clipPath = path.join(clipsDir, `${audioFileId}_${speakerLabel}_${i}.wav`);
      await clipAudioSegment(filePath, clipPath, seg.start_ms, seg.end_ms);
      clipPaths.push(clipPath);
    }

    const embedding = await extractEmbeddingWithPython(clipPaths);
    if (!embedding || !embedding.length) continue;

    let matched = findBestMatchingSpeaker(embedding);

    if (!matched) {
      matched = createAnonymousSpeaker({
        embedding,
        sampleText: representative?.text || null,
        sampleSegmentId: representative?.id || null,
        sampleAudioPath: clipPaths[0] || null,
        sourceAudioFileId: audioFileId,
        sourceSegmentId: representative?.id || null,
      });

      console.log(`[speaker-mapper] created anonymous speaker: ${matched.display_label}`);
    } else {
      console.log(
        `[speaker-mapper] matched speaker_label=${speakerLabel} -> ${
          matched.speaker_name || matched.display_label
        } (${matched.similarity?.toFixed?.(3) || 'n/a'})`
      );
    }

    const displayName = matched.speaker_name || null;

    db.prepare(`
      UPDATE conversation_segments
      SET speaker_id = ?, speaker_name = ?, confidence = ?, resolution_method = ?, updated_at = ?
      WHERE audio_file_id = ? AND speaker_label = ?
    `).run(
      matched.speaker_id,
      displayName,
      matched.similarity || null,
      matched.speaker_status === 'confirmed' ? 'embedding_match' : 'anonymous_match',
      nowIso(),
      audioFileId,
      speakerLabel
    );
  }
}

module.exports = {
  runSpeakerIdentityMapping,
};
```

### `src/speakerService.js`

```javascript
const { db } = require('./db');

function confirmSpeakerName(speakerId, realName) {
  if (!speakerId) {
    throw new Error('speakerId is required');
  }

  if (!realName || !realName.trim()) {
    throw new Error('realName is required');
  }

  const now = new Date().toISOString();

  const speaker = db.prepare(`
    SELECT * FROM speakers WHERE id = ?
  `).get(speakerId);

  if (!speaker) {
    throw new Error(`speaker not found: ${speakerId}`);
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE speakers
      SET name = ?, status = 'confirmed', display_label = ?, updated_at = ?
      WHERE id = ?
    `).run(realName.trim(), realName.trim(), now, speakerId);

    db.prepare(`
      UPDATE conversation_segments
      SET speaker_name = ?, resolution_method = 'manual_confirm', updated_at = ?
      WHERE speaker_id = ?
    `).run(realName.trim(), now, speakerId);
  });

  tx();

  return {
    success: true,
    speakerId,
    realName: realName.trim(),
  };
}

function listAnonymousSpeakers() {
  return db.prepare(`
    SELECT
      s.id,
      s.display_label,
      s.sample_text,
      s.sample_segment_id,
      s.sample_audio_path,
      s.created_at,
      s.updated_at,
      COUNT(DISTINCT cs.audio_file_id) AS conversation_count,
      COUNT(cs.id) AS segment_count
    FROM speakers s
    LEFT JOIN conversation_segments cs ON cs.speaker_id = s.id
    WHERE s.status = 'anonymous'
    GROUP BY s.id, s.display_label, s.sample_text, s.sample_segment_id, s.sample_audio_path, s.created_at, s.updated_at
    ORDER BY s.created_at DESC
  `).all();
}

function listAllSpeakers() {
  return db.prepare(`
    SELECT
      s.id,
      s.name,
      s.status,
      s.display_label,
      s.sample_text,
      s.sample_segment_id,
      s.sample_audio_path,
      s.created_at,
      s.updated_at,
      COUNT(DISTINCT cs.audio_file_id) AS conversation_count,
      COUNT(cs.id) AS segment_count
    FROM speakers s
    LEFT JOIN conversation_segments cs ON cs.speaker_id = s.id
    GROUP BY s.id, s.name, s.status, s.display_label, s.sample_text, s.sample_segment_id, s.sample_audio_path, s.created_at, s.updated_at
    ORDER BY s.created_at DESC
  `).all();
}

module.exports = {
  confirmSpeakerName,
  listAnonymousSpeakers,
  listAllSpeakers,
};
```

### `src/routes/speakers.js`

```javascript
const express = require('express');
const router = express.Router();
const {
  confirmSpeakerName,
  listAnonymousSpeakers,
  listAllSpeakers,
} = require('../speakerService');

router.get('/', (req, res) => {
  try {
    const rows = listAllSpeakers();
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/anonymous', (req, res) => {
  try {
    const rows = listAnonymousSpeakers();
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:speakerId/confirm', (req, res) => {
  try {
    const { speakerId } = req.params;
    const { realName } = req.body;

    const result = confirmSpeakerName(speakerId, realName);

    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
```

### `src/server.js`

```javascript
const express = require('express');
const bodyParser = require('body-parser');
const { initDb } = require('./db');
const speakerRoutes = require('./routes/speakers');

initDb();

const app = express();
app.use(bodyParser.json());

app.use('/speakers', speakerRoutes);

app.listen(3000, () => {
  console.log('API server started on http://localhost:3000');
});
```

### `src/pipeline.js`

```javascript
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const { SonioxClient } = require('./sonioxClient');
const { extractWordsFromSonioxResult } = require('./sonioxAdapter');
const { buildSegmentsFromWords } = require('./segmenter');
const { getAudioDurationMs } = require('./audioMeta');
const { resolveRecordingTime, segmentOffsetToAbsolute } = require('./timeResolver');
const { runSpeakerIdentityMapping } = require('./speakerMapper');
const { nowIso } = require('./utils');

async function processPendingFiles(rawResultsDir, clipsDir) {
  const rows = db.prepare(`
    SELECT * FROM audio_files
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `).all();

  if (!rows.length) return;

  const soniox = new SonioxClient();

  for (const row of rows) {
    try {
      db.prepare(`
        UPDATE audio_files SET status = ?, updated_at = ? WHERE id = ?
      `).run('submitted', nowIso(), row.id);

      const durationMs = await getAudioDurationMs(row.file_path);
      const stat = fs.statSync(row.file_path);
      const { recordingStart, recordingEnd } = resolveRecordingTime(stat, durationMs);

      db.prepare(`
        UPDATE audio_files
        SET duration_ms = ?, recording_start_time = ?, recording_end_time = ?, updated_at = ?
        WHERE id = ?
      `).run(
        durationMs,
        recordingStart.toISOString(),
        recordingEnd.toISOString(),
        nowIso(),
        row.id
      );

      const remoteJobId = await soniox.submitAsyncTranscription(row.file_path);

      db.prepare(`
        INSERT INTO transcription_jobs
        (id, audio_file_id, provider, remote_job_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `job_${uuidv4().replace(/-/g, '').slice(0, 16)}`,
        row.id,
        'soniox',
        remoteJobId,
        'processing',
        nowIso(),
        nowIso()
      );

      const result = await soniox.waitForCompletion(remoteJobId);

      const rawPath = path.join(rawResultsDir, `${row.id}.json`);
      fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf8');

      const words = extractWordsFromSonioxResult(result);
      const segments = buildSegmentsFromWords(words);

      const insertSeg = db.prepare(`
        INSERT INTO conversation_segments
        (id, audio_file_id, start_ms, end_ms, absolute_start_time, absolute_end_time,
         speaker_label, speaker_id, speaker_name, text, confidence, resolution_method, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const tx = db.transaction((segments) => {
        for (const seg of segments) {
          const abs = segmentOffsetToAbsolute(recordingStart, seg.start_ms, seg.end_ms);

          insertSeg.run(
            seg.id,
            row.id,
            seg.start_ms,
            seg.end_ms,
            abs.absoluteStartTime,
            abs.absoluteEndTime,
            seg.speaker_label,
            null,
            null,
            seg.text,
            null,
            'soniox_diarization',
            nowIso(),
            nowIso()
          );
        }
      });

      tx(segments);

      await runSpeakerIdentityMapping(row.id, row.file_path, clipsDir);

      db.prepare(`
        UPDATE transcription_jobs
        SET status = ?, raw_result_path = ?, updated_at = ?
        WHERE audio_file_id = ? AND remote_job_id = ?
      `).run('completed', rawPath, nowIso(), row.id, remoteJobId);

      db.prepare(`
        UPDATE audio_files
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).run('completed', nowIso(), row.id);

      console.log(`[pipeline] completed ${row.file_name}, words=${words.length}, segments=${segments.length}`);
    } catch (err) {
      db.prepare(`
        UPDATE audio_files
        SET status = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `).run('failed', String(err.message || err), nowIso(), row.id);

      console.error(`[pipeline] failed ${row.file_name}`, err);
    }
  }
}

module.exports = { processPendingFiles };
```

### `src/app.js`

```javascript
const fs = require('fs-extra');
const config = require('./config');
const { initDb } = require('./db');
const { scanNewFiles } = require('./scanner');
const { processPendingFiles } = require('./pipeline');

async function ensureDirs() {
  await fs.ensureDir(config.inboxDir);
  await fs.ensureDir(config.clipsDir);
  await fs.ensureDir(config.rawResultsDir);
}

async function main() {
  initDb();
  await ensureDirs();

  console.log('[app] worker started');

  while (true) {
    try {
      await scanNewFiles();
      await processPendingFiles(config.rawResultsDir, config.clipsDir);
    } catch (err) {
      console.error('[app] loop error', err);
    }

    await new Promise(r => setTimeout(r, config.scanIntervalMs));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

### `scripts/enroll_speaker.js`

```javascript
const { v4: uuidv4 } = require('uuid');
const { db, initDb } = require('../src/db');
const { extractEmbeddingWithPython } = require('../src/pythonEmbedding');

async function main() {
  initDb();

  const name = process.argv[2];
  const audioPaths = process.argv.slice(3);

  if (!name || !audioPaths.length) {
    console.error('Usage: node scripts/enroll_speaker.js "张三" sample1.wav sample2.wav');
    process.exit(1);
  }

  const embedding = await extractEmbeddingWithPython(audioPaths);
  const now = new Date().toISOString();
  const speakerId = `spk_${uuidv4().replace(/-/g, '').slice(0, 12)}`;

  db.prepare(`
    INSERT INTO speakers
    (id, name, status, display_label, sample_text, sample_segment_id, sample_audio_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    speakerId,
    name,
    'confirmed',
    name,
    null,
    null,
    null,
    now,
    now
  );

  db.prepare(`
    INSERT INTO speaker_embeddings
    (id, speaker_id, embedding_json, sample_rate, duration_ms, source_audio_file_id, source_segment_id, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `emb_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
    speakerId,
    JSON.stringify(embedding),
    16000,
    null,
    null,
    null,
    'manual_enrollment',
    now
  );

  console.log(`speaker enrolled: ${name} -> ${speakerId}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

---

## Python 代码清单

### `scripts/extract_embedding.py`

```python
import sys
import json
import torch
import torchaudio
from speechbrain.inference.speaker import EncoderClassifier

classifier = EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir="pretrained_models/spkrec-ecapa-voxceleb",
)

def load_audio_16k_mono(path: str):
    waveform, sample_rate = torchaudio.load(path)
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)
    if sample_rate != 16000:
        waveform = torchaudio.functional.resample(waveform, sample_rate, 16000)
    return waveform

def main():
    audio_paths = sys.argv[1:]
    embs = []

    for p in audio_paths:
        wav = load_audio_16k_mono(p)
        with torch.no_grad():
            emb = classifier.encode_batch(wav).squeeze().cpu()
        embs.append(emb)

    if not embs:
        print(json.dumps({"embedding": []}))
        return

    agg = torch.stack(embs, dim=0).mean(dim=0)
    print(json.dumps({"embedding": agg.tolist()}))

if __name__ == "__main__":
    main()
```

---

## 运行方式

### 1. 安装 Node.js 依赖

```bash
npm install
```

### 2. 安装系统依赖

需要安装：

```bash
ffmpeg
```

### 3. 安装 Python 依赖

```bash
pip install torch torchaudio speechbrain
```

### 4. 启动 worker

```bash
npm run start
```

### 5. 启动后台 API

```bash
npm run api
```

### 6. 手工录入已知 speaker

```bash
node scripts/enroll_speaker.js "张三" ./samples/zhangsan1.wav ./samples/zhangsan2.wav
```

---

## 后台接口

### 获取全部 speaker

```http
GET /speakers
```

### 获取匿名 speaker

```http
GET /speakers/anonymous
```

### 确认匿名 speaker

```http
POST /speakers/:speakerId/confirm
Content-Type: application/json
```

请求体：

```json
{
  "realName": "张三"
}
```

---

## 开发顺序建议

### Phase 1
先跑通：

- Soniox async
- raw JSON 保存
- `sonioxAdapter.js`
- `segmenter.js`
- `conversation_segments` 入库

### Phase 2
再跑通：

- `speakerMapper.js`
- 匿名 speaker 自动创建
- embedding 匹配

### Phase 3
最后做：

- 后台 API
- 匿名 speaker 列表
- 人工确认
- 历史回填

---

## 说明与注意事项

### 1. Soniox 返回结构
当前 `sonioxAdapter.js` 默认假设 Soniox 结果中有 `result.words`。  
接入真实数据后，请先拿一份真实 Soniox async JSON 样本进行校对。

### 2. 绝对时间推导
当前方案使用：

$$
recording\_start = file\_mtime - duration\_ms
$$

如果你的业务侧能提供更准确的录音开始时间，应优先使用业务时间。

### 3. Speaker embedding
当前 Python 方案使用 `SpeechBrain + ECAPA`。  
这部分通常为免费开源，但正式商用前请自行核对最终模型和依赖的 license。

### 4. 匿名 speaker 的意义
匿名 speaker 是正式持久化对象，不是临时占位符。  
后续相同声音应优先匹配到已有匿名 speaker。

### 5. 人工确认后的回填
一旦匿名 speaker 被确认姓名，系统必须同步更新所有引用该 `speaker_id` 的历史 `conversation_segments`。

---

## 最终说明

本 README 对应 **v347 完整开发版方案**，已经包含：

- Soniox 原始 JSON 设计
- 适配层设计
- Node.js 主链路代码
- Python embedding 脚本
- 匿名 speaker 自动创建
- 人工确认与历史回填

可以直接作为开发依据。
```