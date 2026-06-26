# OMI Cloud vs 我们的知识架构对照

## 1. 目的

这份对照稿只回答一个问题：

**官方 OMI Cloud 已经做了什么，我们自己的方案要补什么，哪些东西应该交给 Dify / 向量层 / 关系库。**

## 2. 总体结论

官方 OMI Cloud 更像一个“会话知识管线”。

我们自己的方案更像一个“多模态个人知识系统”。

两者方向一致，但输入和中间层不同：

- 官方更偏 conversation / memory / summary
- 我们更偏 audio / video / screenshot / OCR / event / summary / memory

## 3. 对照表

| 维度 | OMI Cloud 官方 | 我们的方案 | 含义 |
|---|---|---|---|
| 原始输入 | conversation、转写、记忆相关内容 | 音频、视频 chunk、截图、OCR、窗口标题、观察、转写 | 我们输入更杂，需要先做事件归一 |
| 中间层 | conversation | knowledge_events | 都是“统一加工入口”，但我们的事件更偏多模态 |
| 长期知识 | memory | knowledge_memories | 本质一致，都是跨天可复用事实 |
| 日级聚合 | day summary | 日回顾 / 时间线 / 事件段摘要 | 我们需要更细，因为有桌面多模态 |
| 检索对象 | memories / conversations / action items / folders | events / conversations / memories / 原始证据链 | 我们需要同时照顾事实和回放 |
| 处理方式 | prompt / trigger / backend pipeline | 规则合并 + 摘要提炼 + 向量召回 + 工作流编排 | 我们比官方多一层多模态路由 |
| 向量能力 | 官方后端已涉及 Pinecone 等检索侧组件 | 向量库用于语义召回，不作为事实主库 | 向量只管“找近似”，不管“最终真相” |
| 展示/接口 | API + webhook | Dify 工作流 + CLI + 查询接口 | 我们需要更灵活的应用编排 |

## 4. 我们该复用什么

### 4.1 复用官方思路

可以直接复用的原则：

- 原始层和知识层分离
- conversation / event 负责上下文
- memory 负责长期事实
- day summary 负责日级聚合
- prompt / trigger 负责自动提炼和联动

### 4.2 复用官方结构

可以借鉴的结构：

- `conversation` 作为会话中间层
- `memory` 作为长期知识层
- `day summary` 作为日回顾层
- webhook / trigger 作为外部同步机制

## 5. 我们需要补什么

### 5.1 多模态事件层

官方主要围绕 conversation，而我们还需要：

- screenshot 事件
- OCR 事件
- video chunk 事件
- desktop observation 事件

这些内容要先合并成 `knowledge_events`，否则后面无法统一回顾。

### 5.2 证据回溯链

我们要补一个“从知识回到原始证据”的闭环：

- 事件指向 screenshot / video / audio
- summary 指向 event
- memory 指向 summary / event

这样后期核验才不会丢。

### 5.3 混合检索层

官方偏管线化，我们需要更强的检索组织：

- 关系库做精确过滤
- 向量库做语义召回
- Dify 做问题路由和工作流编排

## 6. Dify 在这里的角色

Dify 不应该当成唯一真相库，它更适合做三件事：

1. 知识库编排
2. 问题路由
3. 结果汇总

也就是说：

- 关系库存事实
- 向量库存可召回文本
- Dify 负责选库、合并、再生成

## 7. 推荐落地方式

最稳的结构是：

1. 原始数据先进入关系库和文件系统
2. 事件层把多模态原始数据归一
3. 汇总层生成摘要和 memory 候选
4. 向量层索引摘要和原子内容
5. Dify 工作流路由查询
6. 最后回表核证据

## 8. 一句话判断

官方 OMI Cloud 是“会话知识管线”，我们要做的是“多模态个人知识系统 + Dify 编排 + 关系库事实底座 + 向量召回层”。

## 9. 官方向量链路拆解

从官方公开信息里，向量链路可以再拆细一点：

- 事实主库：`Firestore`
- 向量索引：`Pinecone`
- 全文检索：`Typesense`
- 查询侧 embedding：`query_embedder`
- 文档侧 embedding：`doc_embedder`
- 当前方向：从旧的 OpenAI 向量迁移到 Gemini embeddings

这意味着官方不是只用一个向量库顶所有问题，而是把“事实存储、全文检索、语义召回”分开做。

### 9.1 具体分工

- `Firestore` 负责存 memory、conversation 等事实对象
- `Pinecone` 负责语义相似召回
- `Typesense` 负责关键词/全文检索
- `query_embedder` 负责把用户问题编码成查询向量
- `doc_embedder` 负责把入库文本编码成文档向量

### 9.2 对我们有什么启发

我们这边也应该拆成类似三层：

- 关系库存事实
- 向量库存语义
- Dify 知识库自身的全文/混合检索做补充

不要把所有能力都压到一个库里。

### 9.3 为什么这样更稳

因为不同问题的最佳检索方式不一样：

- 查精确时间和来源，用关系库最快
- 查“类似的事”，用向量库最好
- 查特定关键词或原文片段，全文索引更直接

所以正确的设计不是“选一个库”，而是“分工后组合”。

## 10. Dify 本身已经支持什么

你提到的点是对的，Dify 知识库本身就提供了：

- 向量检索
- 全文检索
- 混合检索
- 权重调节
- Rerank

所以我们通常不需要自己再单独造一个关键词索引层，除非你有很强的自定义检索需求。

官方文档也明确写了，高质量索引里支持 `Vector Search / Full-Text Search / Hybrid Search`，混合检索就是全文和向量一起做，再按权重或 rerank 选结果。[Dify Retrieval Settings](https://docs.dify.ai/zh/use-dify/knowledge/create-knowledge/setting-indexing-methods)

### 10.1 这意味着什么

- 如果问题是“语义类似什么”，Dify 的向量 / 混合检索就够用
- 如果问题是“精确命中某个词”，Dify 的全文检索也能处理
- 如果问题是“先路由再组合”，Dify 工作流正好擅长

### 10.2 什么时候还要自己做

只有当你想做这些事情时，才值得自己再造检索层：

- 特别复杂的多轮路由
- 多模态事件的专用评分
- 需要强控制的召回排序
- 要把原始证据、摘要、事件做多级重排

也就是说，Dify 已经够用一大半场景，剩下的再按需加。
