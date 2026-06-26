# OMI 数据库表结构审计

## 1. 目的

这份文档把当前数据库里的表按“作用、命名、字段完整性、是否适合当前设计”做一次系统核对，方便后续统一理解和扩展。

## 2. 总体判断

当前数据库已经形成了比较清晰的分层：

- 原始采集层
- 语音说话人层
- OMI 桌面同步层
- 统一知识层
- 认证与系统层

整体命名大体可用，但有几类表名在语义上还可以更进一步明确。

## 3. 原始音频层

### 3.1 `conversations`

作用：

- 表示一次实时音频会话
- 存 VAD、连接时间、状态、结果文件路径

字段重点：

- `session_id`
- `status`
- `first_audio_frame_at`
- `ended_at`
- `audio_file_path`
- `raw_result_path`
- `vad_*`

命名评价：

- 现在能用
- 但它更像 `audio_conversations` 或 `realtime_conversations`
- 因为“conversation”容易和知识层的 conversation 混淆

建议：

- 如果长期要区分知识层，最好后续加前缀语义，至少在文档中固定把它理解成“实时音频会话”

### 3.2 `audio_files`

作用：

- 存每个会话对应的音频文件元数据

字段重点：

- `conversation_id`
- `file_path`
- `file_name`
- `duration_ms`
- `sample_rate`
- `channels`
- `bits_per_sample`

命名评价：

- 合适
- 语义清楚

### 3.3 `conversation_segments`

作用：

- 存音频会话切分后的转写片段
- 是音频时间轴的最小文本单元

字段重点：

- `start_ms`
- `end_ms`
- `absolute_start_time`
- `absolute_end_time`
- `speaker_label`
- `speaker_id`
- `speaker_name`
- `speaker_identity`
- `text`
- `confidence`
- `resolution_method`

命名评价：

- 合适
- 语义清楚

## 4. 说话人识别层

### 4.1 `speakers`

作用：

- 说话人主档
- 记录身份、状态、样例文本、样例音频等

字段重点：

- `name`
- `display_label`
- `identity_label`
- `identity_status`
- `notes`
- `sample_text`
- `sample_segment_id`
- `sample_audio_path`

命名评价：

- 合适

### 4.2 `speaker_embeddings`

作用：

- 存说话人的向量特征

字段重点：

- `speaker_id`
- `embedding_json`
- `sample_rate`
- `duration_ms`
- `source_audio_file_id`
- `source_segment_id`

命名评价：

- 合适

### 4.3 `speaker_embeddings_archive`

作用：

- 存历史归档向量

命名评价：

- 合适

### 4.4 `speaker_candidates`

作用：

- 存说话人候选识别记录

字段重点：

- `conversation_id`
- `session_id`
- `speaker_label`
- `local_speaker_key`
- `raw_label_summary`
- `raw_embedding_json`
- `best_match_speaker_id`
- `best_score`
- `decision_reason`
- `confirmed_speaker_id`

命名评价：

- 基本可用
- 但如果要更精确，可以改成 `speaker_identification_candidates`

### 4.5 `speaker_candidate_segments`

作用：

- 候选与片段的关联表

命名评价：

- 合适

### 4.6 `speaker_candidate_clips`

作用：

- 候选音频样本片段

命名评价：

- 合适

### 4.7 `segment_voiceprint_matches`

作用：

- 片段与声纹匹配结果

命名评价：

- 合适

### 4.8 `speaker_voiceprint_features`

作用：

- 声纹特征索引

命名评价：

- 合适

### 4.9 `speaker_voiceprint_materials`

作用：

- 声纹训练/采样材料

命名评价：

- 可用
- 但“materials”略泛
- 如果以后要更精确，可以考虑 `speaker_enrollment_materials`

### 4.10 `speaker_enrollment_batches`

作用：

- 说话人注册批次

命名评价：

- 合适

### 4.11 `speaker_enrollment_segments`

作用：

- 注册批次与片段的关联

命名评价：

- 合适

## 5. OMI 桌面同步层

### 5.1 `omi_sync_sources`

作用：

- 同步源管理
- 记录 source_key 和 last_seen_at

命名评价：

- 合适

### 5.2 `omi_sync_checkpoints`

作用：

- 同步游标
- 记录每类实体上次收到的 ID

命名评价：

- 合适

### 5.3 `omi_video_chunks`

作用：

- 桌面视频 chunk 元数据
- 存储路径、sha256、上传状态等

字段重点：

- `source_key`
- `video_chunk_path`
- `sha256`
- `size_bytes`
- `storage_path`
- `upload_status`

命名评价：

- 合适

### 5.4 `omi_screenshots`

作用：

- 截图主表
- 存 app、窗口标题、OCR、视频 chunk 关联、frame_offset

字段重点：

- `ts`
- `app_name`
- `window_title`
- `ocr_text`
- `video_chunk_path`
- `frame_offset`
- `raw_payload_json`

命名评价：

- 合适
- 这是当前桌面数据里最关键的一张表

### 5.5 `omi_transcription_sessions`

作用：

- 桌面转写会话

字段重点：

- `started_at`
- `finished_at`
- `source`
- `language`
- `status`
- `title`
- `overview`

命名评价：

- 合适

### 5.6 `omi_transcription_segments`

作用：

- 桌面转写片段

字段重点：

- `source_session_id`
- `speaker`
- `speaker_label`
- `text`
- `start_time`
- `end_time`
- `segment_order`

命名评价：

- 合适

### 5.7 `omi_observations`

作用：

- 桌面行为观察
- 存 context_summary、current_activity、task_title

命名评价：

- 合适

### 5.8 `omi_memories`

作用：

- OMI 同步过来的记忆对象

字段重点：

- `backend_id`
- `content`
- `category`
- `source_app`
- `confidence`

命名评价：

- 合适

### 5.9 `omi_import_runs`

作用：

- 同步导入任务批次记录

命名评价：

- 合适

## 6. 统一知识层

### 6.1 `knowledge_events`

作用：

- 统一事件层
- 把音频、截图、观察、桌面转写等统一成一条时间轴事件

字段重点：

- `source_type`
- `source_table`
- `source_row_id`
- `event_type`
- `started_at`
- `ended_at`
- `content_text`
- `title`
- `participants_json`
- `metadata_json`
- `quality_score`
- `dedupe_key`

命名评价：

- 非常合适
- 这张表和我们当前设计高度匹配

### 6.2 `knowledge_conversations`

作用：

- 聚合后的上下文块
- 可以来自音频会话、桌面事件段或混合事件段

字段重点：

- `primary_source`
- `source_refs_json`
- `participants_json`
- `title`
- `summary`
- `topics_json`
- `action_items_json`

命名评价：

- 可用
- 但语义上偏“会话”，对桌面事件也能承载，只是文档里要统一说明它是“上下文块”

### 6.3 `knowledge_conversation_items`

作用：

- conversation 和 event 的中间关联表

命名评价：

- 合适

### 6.4 `knowledge_memory_candidates`

作用：

- memory 的候选提名池

命名评价：

- 合适

### 6.5 `knowledge_memories`

作用：

- 长期记忆主表

命名评价：

- 合适

### 6.6 `knowledge_runtime_settings`

作用：

- 运行参数配置

命名评价：

- 合适

## 7. 认证与系统层

### 7.1 `oauth_clients`
### 7.2 `oauth_authorization_codes`
### 7.3 `oauth_tokens`

作用：

- OAuth 认证和授权

命名评价：

- 合适

## 8. 当前命名的总体建议

### 8.1 不太需要改名的

- `audio_files`
- `conversation_segments`
- `speakers`
- `speaker_embeddings`
- `omi_screenshots`
- `omi_transcription_sessions`
- `omi_transcription_segments`
- `omi_observations`
- `omi_memories`
- `knowledge_events`
- `knowledge_conversations`
- `knowledge_memory_candidates`
- `knowledge_memories`

### 8.2 可以考虑更精确的

- `conversations` -> 可以理解为 `audio_conversations`
- `speaker_candidates` -> 可以更明确成 `speaker_identification_candidates`
- `speaker_voiceprint_materials` -> 可更明确成 `speaker_enrollment_materials`

但这些都不是必须改，当前命名已经能工作。

## 9. 字段层面的总体判断

### 9.1 已经比较完整的

- 音频会话
- 转写片段
- 截图 + OCR + 窗口标题
- 观察摘要
- 统一事件层
- 汇总层

### 9.2 未来可能补的

- 事件-资产关联表
- 向量索引表
- 事件版本表
- 纠错审计表

## 10. 结论

当前数据库命名整体是可用的，分层也基本正确。  
真正最需要统一的是“文档语义”：

- `conversations` 要明确解释成音频会话
- `knowledge_conversations` 要明确解释成知识上下文块
- `knowledge_events` 是统一事实底座

如果后面要进一步优化，优先补的是：

1. 事件与原始资产的关联
2. 向量索引层
3. 纠错和版本管理层
