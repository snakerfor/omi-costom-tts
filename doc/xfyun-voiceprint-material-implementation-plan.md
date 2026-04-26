# 科大讯飞声纹语料管理分步实现计划

本文是 `xfyun-voiceprint-speaker-material-redesign.md` 的实施计划。目标是先用最小 MVP 快速跑通核心闭环，再逐步补齐可靠性和体验。

## 1. 实施原则

先做可用，再做好用，再做稳定。

第一阶段不追求完整预算管理和所有防错能力，重点是把最关键的业务闭环跑通：

1. 能跨会话选择语料。
2. 能把语料放入某个发言人的候选/正式语料池。
3. 能新建发言人。
4. 能生成拼接试听音频。
5. 能用正式语料创建或更新讯飞声纹 feature。
6. 能保留实际发送给讯飞的拼接音频和同步历史。

## 2. 阶段一：最小可用 MVP

### 2.1 目标

阶段一只解决“能不能用”的问题。

完成后，用户应该可以：

- 在会话片段中选择有价值的语料。
- 把选中的片段加入已有发言人的候选或正式语料。
- 新建一个发言人，并把片段加入这个新发言人的语料池。
- 在发言人维度查看候选语料和正式语料。
- 候选转正式，正式移回候选，从语料池移除。
- 生成正式语料的拼接试听音频。
- 确认后保存并更新讯飞声纹库。

### 2.2 必做后端能力

#### 新增当前语料池表

新增 `speaker_voiceprint_materials`。

字段以主方案文档为准：

- `id`
- `speaker_id`
- `segment_id`
- `material_status`: `candidate | formal`
- `source`
- `note`
- `sort_order`
- `created_at`
- `updated_at`

阶段一可以先不做复杂排序。`sort_order` 可以预留，默认按加入时间或 segment start time 拼接。

#### 语料查询

新增按 speaker 查询语料的服务和接口：

```http
GET /api/admin/speakers/:speakerId/voiceprint/materials
```

阶段一返回：

- speaker 基础信息。
- candidate materials。
- formal materials。
- 最近几次 enrollment batches。
- 当前启用的讯飞 feature。

#### 跨会话搜索候选片段

新增基础搜索接口：

```http
GET /api/admin/voiceprint/material-candidates
```

阶段一只需要支持最基础筛选：

- `q`
- `speakerId`
- `startTime`
- `endTime`
- `page`
- `pageSize`

可以先不做复杂的 score 区间、decision 筛选、时长筛选。

#### 加入或移动语料

新增：

```http
POST /api/admin/speakers/:speakerId/voiceprint/materials
```

请求：

```json
{
  "segmentIds": ["seg_1", "seg_2"],
  "materialStatus": "candidate"
}
```

行为：

- 校验 speaker 存在。
- 校验 segment 存在。
- 如果该 speaker 已经有该 segment，则更新状态。
- 如果没有，则插入。

阶段一不强制处理“同一 segment 是否能属于多个 speaker”的复杂约束。为了降低误操作，建议先在服务层阻止同一 segment 加入多个 speaker；如果遇到冲突，返回错误。

#### 移除语料

新增：

```http
DELETE /api/admin/speakers/:speakerId/voiceprint/materials/:segmentId
```

只删除该 speaker 和该 segment 的语料关系。

#### 创建新发言人并加入语料

阶段一需要支持“创建新发言人 + 加入语料”。

可以复用现有 speaker 创建逻辑，也可以新增一个轻量接口：

```http
POST /api/admin/voiceprint/speakers
```

请求：

```json
{
  "speakerName": "张三",
  "identityLabel": "客户",
  "notes": "",
  "segmentIds": ["seg_1"],
  "materialStatus": "candidate"
}
```

行为：

1. 创建 `speakers` 记录。
2. 把传入 segment 加入该 speaker 的语料池。

### 2.3 试听音频

新增：

```http
POST /api/admin/speakers/:speakerId/voiceprint/xfyun/preview
```

阶段一行为：

1. 读取该 speaker 的 formal materials。
2. 从原会话音频裁剪片段。
3. 按时间顺序拼接。
4. 保存到预览目录。
5. 返回音频 URL。

阶段一可以先不做：

- 语料大小预估。
- 4MB 提前预算栏。
- 快照摘要强校验。
- 复杂拼接顺序编辑。

但阶段一仍应保留一个基本保护：如果拼接后实际文件已经超过 `XFYUN_MAX_ENROLLMENT_BYTES`，接口应返回错误，不继续同步。

### 2.4 保存并同步讯飞

新增：

```http
POST /api/admin/speakers/:speakerId/voiceprint/xfyun/sync
```

阶段一行为：

1. 读取该 speaker 的 formal materials。
2. 裁剪并拼接正式同步用 enrollment wav。
3. 如果文件超过 `XFYUN_MAX_ENROLLMENT_BYTES`，返回错误。
4. 创建 `speaker_enrollment_batches(status='pending')`。
5. 如果该 speaker 没有当前启用的 feature，调用 `createFeature`。
6. 如果已有当前启用的 feature，调用 `updateFeature`。
7. 写入或更新 `speaker_voiceprint_features`。
8. 写入 `speaker_enrollment_segments`。
9. 更新 batch 为 `success` 或 `failed`。

阶段一不要求：

- 提前展示预算。
- 自动帮用户选择最优片段。
- 超限时自动裁剪或自动丢弃部分片段。
- 复杂的 feature 版本对比 UI。

### 2.5 阶段一前端最小工作流

前端不需要一次性做完整工作台。

最小工作流可以是：

1. 在发言人详情页展示候选语料和正式语料。
2. 提供“添加语料”入口，打开跨会话搜索。
3. 搜索结果支持试听和勾选。
4. 勾选后加入候选或正式。
5. 候选列表支持“转正式”。
6. 正式列表支持“移回候选”和“移除”。
7. 正式语料区提供“生成试听音频”。
8. 试听后提供“保存并更新讯飞”。

### 2.6 阶段一验收标准

阶段一完成后，需要能验证：

- 可以给已有 speaker 添加候选语料。
- 可以给已有 speaker 添加正式语料。
- 可以创建新 speaker 并添加语料。
- 可以从候选转正式。
- 可以从正式移回候选。
- 可以删除语料关系。
- 可以生成拼接试听音频并播放。
- 可以用正式语料 createFeature。
- 可以用正式语料 updateFeature。
- `speaker_enrollment_batches.audio_path` 保留实际发送给讯飞的音频。
- `speaker_enrollment_segments` 能看到本次同步使用了哪些 segment。

## 3. 阶段二：好用和可控

阶段二解决“用起来是否顺手、是否能提前判断风险”的问题。

建议补齐：

- 正式语料预计时长。
- 正式语料预计大小。
- 4MB 预算栏。
- 超限时禁用保存并更新讯飞。
- 预览音频快照摘要。
- sync 时校验正式语料快照未变化。
- 更完整的跨会话搜索条件：
  - resolution method。
  - 讯飞 top score。
  - speaker 绑定状态。
  - 片段时长。
- 低置信/冲突/无匹配片段快捷加入候选。
- 最近同步批次展示。
- 同步失败错误展示。

## 4. 阶段三：稳定和防污染

阶段三解决“长期使用是否安全”的问题。

建议补齐：

- 语料质量规则：
  - 最小时长。
  - 最大单段时长。
  - 文本为空或过短提示。
  - 可能多人说话片段提示。
- 同一 segment 跨 speaker 冲突处理。
- 预览音频定时清理。
- batch 历史回放和下载。
- 正式语料排序编辑。
- 同步前二次确认。
- 更明确的审计信息：
  - 谁操作。
  - 何时加入候选。
  - 何时转正式。
  - 何时同步讯飞。
- 批量候选转正式。
- 按识别失败样本推荐候选语料。

## 5. 阶段四：高级优化

阶段四可以再考虑更智能的语料选择。

可选能力：

- 根据音频质量自动评分。
- 自动排除静音、噪声、重叠说话片段。
- 自动推荐替换正式语料。
- 对比更新前后的识别效果。
- 多 provider 声纹服务适配。

## 6. 不放进 MVP 的内容

以下能力不要进入阶段一：

- 完整 4MB 预算 UI。
- 自动裁剪正式语料集合。
- 自动挑选最优语料。
- 复杂语料排序。
- 批量跨 speaker 转移。
- 历史审计 UI。
- 多 provider 支持。
- 全库回刷。

阶段一只需要把人工可控闭环跑通。
