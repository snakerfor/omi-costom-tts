# 发言人声音识别与自动匹配系统

## 项目概述

### 目标

通过声音特征提取和匹配技术，实现对会议录音中发言人的自动识别，无需每次手动标注。

### 核心价值

| 当前状态 | 目标状态 |
|---------|---------|
| 每次对话都要手动标注发言人 | 首次标注后自动识别 |
| SPEAKER_01、SPEAKER_02... | 显示真实姓名（如"张三"）|
| 无法区分不同会议中的同一人 | 跨会议自动识别同一发言人 |

---

## 技术方案

### 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                        OMI APP (CV1)                       │
│                   WebSocket RAW PCM 音频流                    │
└─────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      Soniox STT 服务                        │
│              返回: text, speaker, start, end               │
│              ⚠️ speaker ID 仅限会话内有效                     │
└─────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    音频缓冲器                                │
│              累积 5-10 秒音频后触发特征提取                    │
└─────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   声音特征提取引擎                            │
│                  (pyannote / SpeechBrain)                    │
│               提取 voice embedding 向量                       │
└─────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    特征匹配引擎                               │
│              (Cosine Similarity 余弦相似度)                    │
│                    相似度阈值: 0.8                            │
└─────────────────────────┬───────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                             ▼
┌─────────────────────────┐    ┌─────────────────────────┐
│       匹配成功            │    │        无法匹配          │
│   显示已知发言人姓名       │    │    发现新发言人          │
│   "张三说: ..."         │    │ 提示用户输入姓名          │
└─────────────────────────┘    └─────────────────────────┘
```

---

### 技术选型

| 组件 | 技术方案 | 说明 |
|------|---------|------|
| 声音特征提取 | **pyannote-audio** | 开源，专门做 speaker diarization |
| 特征向量维度 | 512/1024 维 | pyannote 默认输出 |
| 匹配算法 | **Cosine Similarity** | 余弦相似度，速度快 |
| 匹配阈值 | **0.8** | 平衡准确率和召回率 |
| 特征存储 | **SQLite + JSON** | 简单够用 |
| 运行环境 | **Python 3.8+** | pyannote 需要 |

---

### 数据库设计

```sql
-- 发言人表
CREATE TABLE speakers (
    id TEXT PRIMARY KEY,              -- 唯一标识 (UUID)
    name TEXT NOT NULL,               -- 姓名
    embedding_path TEXT,              -- 特征向量文件路径
    embedding_hash TEXT,              -- 特征向量哈希（快速比对）
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    match_count INTEGER DEFAULT 0     -- 成功匹配次数
);

-- 对话记录表
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    speakers_json TEXT,              -- 参与者 JSON
    transcript_json TEXT,            -- 转录结果 JSON
    audio_path TEXT                  -- 音频文件路径
);

-- 匹配历史表
CREATE TABLE match_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    soniox_speaker_id TEXT,          -- Soniox 的 SPEAKER_01 等
    matched_speaker_id TEXT,         -- 匹配到的发言人 ID
    similarity_score REAL,           -- 相似度分数
    matched_at TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (matched_speaker_id) REFERENCES speakers(id)
);
```

---

## 工作流程

### 首次对话（新增发言人）

```
1. 对话开始
         │
         ▼
2. Soniox 返回: {"text": "你好", "speaker": "SPEAKER_01", "start": 0, "end": 1}
         │
         ▼
3. 音频缓冲器累积 5-10 秒
         │
         ▼
4. 提取 SPEAKER_01 的声音特征向量
         │
         ▼
5. 查询数据库 - 是否有匹配? (Cosine Similarity >= 0.8)
         │
    ┌────┴────┐
    │ 匹配成功  │  无法匹配
    ▼         ▼
6. 直接使用   7. 标记为"未知发言人 A"
   已知姓名         │
   "张三说"         ▼
                   8. 对话结束后，汇总所有未知发言人
                              │
                              ▼
                   9. 推送提醒用户: "发现 X 位新发言人，请标注姓名"
                              │
                              ▼
                   10. 用户输入姓名（如"李四"）
                              │
                              ▼
                   11. 保存: 新发言人 + 声音特征 + "李四"
```

### 后续对话（自动识别）

```
1. Soniox 返回: {"speaker": "SPEAKER_01", ...}
         │
         ▼
2. 提取声音特征，匹配数据库
         │
    ┌────┴────┐
    │ 匹配成功  │  无法匹配
    ▼         ▼
3. 显示      4. 同首次对话流程
   "张三说"   发现新发言人
```

---

## 实现步骤

### Phase 1: 基础功能（2天）

| 任务 | 内容 |
|------|------|
| 1.1 | 安装 pyannote-audio 及其依赖 |
| 1.2 | 创建声音特征提取模块 |
| 1.3 | 创建 SQLite 数据库及表结构 |
| 1.4 | 实现 Cosine Similarity 匹配算法 |
| 1.5 | 对话结束时提取并存储特征 |
| 1.6 | 测试特征存储和匹配 |

### Phase 2: 实时处理（2天）

| 任务 | 内容 |
|------|------|
| 2.1 | 实现音频缓冲器 |
| 2.2 | 实时声音特征提取 |
| 2.3 | 实时匹配引擎集成 |
| 2.4 | WebSocket 结果推送 |
| 2.5 | 新发言人提醒机制 |

### Phase 3: 用户界面（1天）

| 任务 | 内容 |
|------|------|
| 3.1 | 新发言人标注接口 |
| 3.2 | 已知发言人管理界面 |
| 3.3 | 匹配历史查看 |
| 3.4 | 手动纠正功能 |

### Phase 4: 优化（1天）

| 任务 | 内容 |
|------|------|
| 4.1 | 提高匹配准确率 |
| 4.2 | 支持多人同时对话 |
| 4.3 | 历史数据累积分析 |

---

## 技术细节

### 声音特征提取

```python
# 使用 pyannote 提取 voice embedding
from pyannote.audio import Model
import torch

# 加载预训练模型
model = Model.from_pretrained("pyannote/embedding")

# 提取特征
def extract_embedding(audio_chunk: bytes) -> list[float]:
    # audio_chunk: RAW PCM 16bit 16kHz mono
    # 转换为模型输入格式
    waveform = torch.from_numpy(pcm_to_numpy(audio_chunk))
    # 提取 embedding
    with torch.no_grad():
        embedding = model(waveform.unsqueeze(0))
    return embedding.squeeze().numpy().tolist()
```

### 特征匹配

```python
import numpy as np
from scipy.spatial.distance import cosine

def match_speaker(new_embedding: list[float], threshold: float = 0.8) -> tuple[str | None, float]:
    """
    返回: (speaker_name or None, similarity_score)
    """
    new_vec = np.array(new_embedding)
    
    for speaker in get_all_speakers():
        stored_vec = np.load(speaker['embedding_path'])
        # 使用 1 - cosine_distance 作为相似度
        similarity = 1 - cosine(new_vec, stored_vec)
        
        if similarity >= threshold:
            return speaker['name'], similarity
    
    return None, 0.0
```

### 音频缓冲器

```python
import asyncio
from collections import deque

class AudioBuffer:
    def __init__(self, min_duration_seconds: int = 5):
        self.buffer = deque()
        self.min_samples = min_duration_seconds * 16000  # 16kHz
    
    def add(self, pcm_chunk: bytes):
        self.buffer.append(pcm_chunk)
    
    def is_ready(self) -> bool:
        total_samples = sum(len(chunk) // 2 for chunk in self.buffer)  # 16bit = 2 bytes
        return total_samples >= self.min_samples
    
    def get_audio(self) -> bytes:
        return b''.join(self.buffer)
    
    def clear(self):
        self.buffer.clear()
```

---

## 注意事项

### ⚠️ 技术限制

| 问题 | 影响 | 解决方案 |
|------|------|---------|
| 音频太短 | 特征提取不准 | 缓冲 5-10 秒再提取 |
| Soniox speaker ID | 仅会话内有效 | 用声音特征匹配，不依赖 Soniox ID |
| 同一人不同设备 | 可能有差异 | 持续学习，更新特征 |
| 环境噪音 | 影响匹配 | 添加降噪预处理 |

### 性能指标

| 指标 | 目标值 |
|------|--------|
| 特征提取延迟 | < 500ms |
| 匹配响应时间 | < 100ms |
| 匹配准确率 | > 85% |
| 支持同时发言人数 | 最多 8 人 |

---

## 数据安全

| 项目 | 说明 |
|------|------|
| 声音特征存储 | 本地 SQLite，不上传云端 |
| 音频文件 | 存储在服务器本地 |
| 用户数据 | 仅限本地处理，无第三方访问 |

---

## 预估开发时间

| Phase | 内容 | 时间 |
|-------|------|------|
| Phase 1 | 基础功能 | 2 天 |
| Phase 2 | 实时处理 | 2 天 |
| Phase 3 | 用户界面 | 1 天 |
| Phase 4 | 优化 | 1 天 |
| **总计** | | **6 天** |

---

## 下一步行动

1. ✅ 方案确认
2. ⬜ 用户审批方案
3. ⬜ Phase 1 开发
4. ⬜ 测试验证
5. ⬜ 后续 Phase

---

*文档版本: v1.0*
*创建日期: 2026-04-09*
