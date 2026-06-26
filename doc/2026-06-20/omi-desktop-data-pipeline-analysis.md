# OMI Desktop 数据链路分析

## 1. 目标

把 OMI Desktop 相关数据分成三层看清楚：

1. 官方桌面端本身保存了什么
2. 你自己的云端服务器同步了什么
3. 这些同步数据后续应该怎么做挖掘

## 2. 官方桌面端做了什么

根据 OMI 官方仓库，Desktop 会同时处理屏幕、对话和实时转写，目标是生成总结、行动项和可检索记忆。[README](https://github.com/BasedHardware/omi/blob/main/README.md)

从官方 issue 和代码线索看，桌面端的屏幕帧会进入两条路径：

1. Rewind 路径：做截图/OCR/索引，供回顾和搜索使用
2. Proactive assistants 路径：在 Rewind 过滤之前，同一帧还可能被送去做记忆/任务等主动分析

这意味着官方桌面端并不只是“录屏文件”：

- 会有屏幕帧
- 会有 OCR/索引文本
- 会有记忆/任务类派生内容
- 会有实时对话转写

相关线索：

- Omi Desktop 会 “captures your screen and conversations” 并实时转写。[README](https://github.com/BasedHardware/omi/blob/main/README.md)
- Rewind 的排除规则只作用在 Rewind 索引链路，未必阻止主动助手使用同一帧。[Issue #7098](https://github.com/BasedHardware/omi/issues/7098)

## 3. 你这边的云端同步保留了什么

你当前项目里，云端同步是另一条清晰的链路。

### 3.1 同步接口

`/api/omi-sync/metadata` 接收这些实体：

- `screenshots`
- `transcription_sessions`
- `transcription_segments`
- `observations`
- `memories`

`/api/omi-sync/video` 只负责上传视频 chunk 二进制。

代码位置：

- [`src/index.ts`](/Users/snaker/Claude-Projects/omi-custom-tts/src/index.ts)
- [`src/services/omi-sync-service.ts`](/Users/snaker/Claude-Projects/omi-custom-tts/src/services/omi-sync-service.ts)

### 3.2 数据库里落了什么

云端数据库里已经有这些表：

- `omi_screenshots`
- `omi_observations`
- `omi_video_chunks`
- `omi_transcription_sessions`
- `omi_transcription_segments`
- `omi_memories`

其中 `omi_screenshots` 的字段里直接包括：

- `ocr_text`
- `window_title`
- `image_path`
- `video_chunk_path`
- `frame_offset`

这说明 OCR 文本是可以直接通过同步接口落库的，不是事后才推断出来的。

### 3.3 音频链路

你自己的音频原始资料来自 `audio-uploads/*.wav`，这条链路是实时音频会话 + Soniox 转写。

这部分和桌面同步链路是分开的：

- 音频转写会进入 `conversation_segments`
- 桌面同步文本会进入 `omi_transcription_segments`
- OCR 会进入 `omi_screenshots.ocr_text`

## 4. 6 月 18 日的数据核对结论

我对 `2026-06-18` 的云端数据做了按目录和按数据库的交叉核对，结论如下：

- `audio-uploads` 当天有 `74` 个 wav
- `omi-videos/macbook-pro-local-omi/2026-06-18` 下有 `193` 个视频 chunk
- `omi_screenshots` 当天有 `3699` 条
- 其中 `327` 条有 OCR 文本，`3372` 条为空
- 这天的 screenshot 都能对应到真实存在的 `video_chunk_path`
- 没发现视频 chunk 路径在磁盘上缺失

这说明：

- 视频和截图的映射链条是完整的
- OCR 空白大多是“这帧没有可读文字”，不是明显的数据丢失
- 只靠 OCR 不能完整理解页面状态，必须结合 `app_name / window_title / frame_offset / video_chunk_path`

## 5. OCR 为什么会空白

空白 OCR 通常有几种原因：

1. 页面本身没有文字，只有图标或纯布局
2. 字太小、太糊、对比太低
3. 当前画面是播放器、设置页、留白页、工具栏页
4. OCR 能跑，但这帧没有识别出可靠字符

所以 OCR 是“文字提取器”，不是“页面理解器”。

如果你的目标是知道“当前页面在做什么”，更稳的做法是：

- 先看 `app_name + window_title`
- 再看 `ocr_text`
- 最后按 `video_chunk_path + frame_offset` 回看画面

## 6. 后续怎么做数据挖掘

建议把数据挖掘分成四层：

1. 事实层
   - 某天有多少音频、多少视频 chunk、多少截图、多少 OCR 文本
2. 行为层
   - 这些截图对应哪些应用、哪些窗口、哪些时间段
3. 语义层
   - 当前在写代码、查资料、看邮件、开会、整理、娱乐还是休息
4. 规律层
   - 哪些时段最专注、哪些应用切换最多、哪些任务反复出现

推荐的最小可行处理流程：

1. 先按天聚合 `audio-uploads / omi-videos / omi_screenshots`
2. 再把 `ocr_text` 为空和非空分开统计
3. 对非空 OCR 做主题聚类
4. 对空白截图用 `app_name + window_title` 和视频帧回看补语义
5. 最后产出日记式时间线和日总结

## 7. 建议的结论口径

以后这类数据可以统一分成三类：

- 原始音频：来自可穿戴/客户端上传的 wav
- 桌面视频：来自 OMI Desktop 的视频 chunk
- 截图语义：来自 OCR / 窗口标题 / 观察摘要

其中，OCR 只负责文字，不负责完整语义；完整语义应当由截图、窗口标题和视频帧共同推断。

## 8. 合并 / 切分规则

这里不要先把数据“硬切碎”，而是先把 `video chunk + screenshot` 当作最小候选单元，再判断哪些单元应该合并成同一个事件。

### 8.1 先用什么做底座

优先顺序建议是：

1. `video chunk`
2. `screenshot`
3. `window_title`
4. `ocr_text`
5. `audio` 的连续性

也就是说，视频切块是底座，事件边界是后处理出来的。

### 8.2 什么时候倾向于合并

满足越多条，就越应该合并到同一个事件里：

- `window_title` 没变
- `app_name` 没变
- `ocr_text` 的核心关键词没变
- 视频画面主体没有明显变化
- 音频还在连续进行，没有明显停顿
- 中间只是滚动、点击、输入、局部刷新

### 8.3 什么时候倾向于切开

出现这些变化，通常应该切成新事件：

- 应用切换了
- 窗口标题明显变了
- OCR 主标题或主要内容变了
- 从浏览切到编辑、从编辑切到开会、从工作切到娱乐
- 音频出现明显停顿后又重新开始
- 画面从同一任务切到完全不同的任务

### 8.4 一个实用的边界分数

可以给每个相邻片段打分：

- `window_title` 变化：+3
- `app_name` 变化：+3
- OCR 主关键词变化：+2
- 画面主体明显变化：+2
- 音频中断或换人说话：+2
- 仅仅时间过去，但上下文没变：+0

建议用法：

- 分数 `0-2`：优先合并
- 分数 `3-4`：看业务目标决定，默认保守合并
- 分数 `5+`：切开

### 8.5 为什么不要只按时间切

只按时间切会把连续任务切碎，比如：

- 同一个文档写了 20 分钟
- 同一个网页查资料 30 分钟
- 同一段会议/思考过程跨过多个视频 chunk

这种情况下，时间到了不代表事件结束。  
所以时间只能做辅助信号，不能做唯一规则。

### 8.6 推荐的最终策略

推荐用“先粗后细，再回拼”的方式：

1. 先按视频 chunk 建候选片段
2. 再结合窗口标题、OCR、音频连续性打边界分数
3. 低分片段自动合并
4. 高分片段切开
5. 最后把过碎的小片段回拼成更稳定的事件段

这样更适合后续做：

- 每日回顾
- 工作流分析
- 任务复盘
- 生活规律提炼
