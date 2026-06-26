# OMI Cloud 知识管理设计观察

## 1. 目的

这份笔记只做一件事：根据 OMI 官方公开文档，梳理它的云端知识管理是怎么设计的，以及这对我们自己的方案意味着什么。

## 2. 官方云端的核心对象

从官方文档看，OMI Cloud 不是把所有原始数据都直接暴露给使用者，而是把数据分成几个明确层：

- `conversations`
- `memories`
- `action items`
- `folders`
- `daily summaries`

官方 Developer API 直接围绕这些对象提供读写接口，而不是围绕原始音频流本身开放。[Developer API](https://docs.omi.me/doc/developer/api/overview)

## 3. 官方云端的处理流程

### 3.1 Conversation 是中间层

当一段文本或转写被创建为 conversation 后，官方会自动走一整套处理流程：

- discard detection
- structured generation
- action item extraction
- memory extraction
- app integration
- webhooks

也就是说，conversation 不是最终产物，而是进入知识加工管线的入口。[Create Conversation](https://docs.omi.me/api-reference/endpoint/conversations/create)

### 3.2 Memory 是长期知识

官方把 memory 作为长期有效的知识对象，并提供独立的读写 API。[Memories](https://docs.omi.me/doc/developer/api/memories)

这意味着官方的设计思路是：

- 原始会话保留时序上下文
- memory 保存可复用、可长期查询的事实

### 3.3 Prompt 和 Trigger 是知识提炼器

官方提供两类非常关键的扩展机制：

- `Memory Prompts`
- `Memory Triggers`

前者是在 conversation 处理后，把全文交给 prompt 提炼结构化信息；后者是在 memory 创建后触发外部系统同步。[Memory Prompts](https://docs.omi.me/doc/developer/apps/PromptBased) [Memory Triggers](https://docs.omi.me/doc/developer/apps/Introduction)

这说明官方云端不是“只存”，而是“存 + 提炼 + 触发后续动作”。

## 4. 官方云端的检索方式

官方 Developer API 支持直接读取：

- memories
- conversations
- action items
- folders

这说明官方本身已经把“检索”拆成多种对象，而不是一个大而混乱的全文库。[Developer API](https://docs.omi.me/doc/developer/api/overview)

## 5. 官方云端的时间组织方式

官方还有 `Day Summary`：

- 每天最多一次
- 按用户本地时间触发
- 只在当天确实有录音/转写内容时发送

它本质上就是“日级知识聚合”，很适合作为我们自己的日回顾层参考。[Day Summary](https://docs.omi.me/doc/developer/apps/Integrations)

## 6. 官方转写链路

官方转写系统本身也是独立链路：

- WebSocket 实时转写
- 多 provider fallback
- speaker identification
- 进入 conversation processing pipeline

所以官方不是把音频直接丢给摘要模型，而是先做转写和分段，再进入 conversation / memory 管线。[Real-time Transcription](https://docs.omi.me/doc/developer/backend/transcription)

## 7. 后端依赖的信号

官方 backend setup 里明确提到：

- OpenAI
- Deepgram
- Redis
- Pinecone
- Hugging Face

其中 Pinecone 出现在必需服务里，说明官方后端在知识/向量检索侧并不只靠关系库。[Backend Setup](https://docs.omi.me/doc/developer/backend/Backend_Setup)

## 8. 结合源码线索的理解

从官方源码线索看，conversation 处理完成后，会发出类似：

- `memory_processing_started`
- `memory_created`

这意味着它的内部流程是“先处理会话，再异步产出 memory”，而不是先给 memory 再回填会话。[GitHub source](https://github.com/BasedHardware/omi/blob/main/backend/routers/transcribe.py)

## 9. 对我们方案的启发

官方 OMI Cloud 的思路和我们前面讨论的方案是一致的：

1. 原始层保留
2. 会话层归一
3. 记忆层提炼
4. 日总结层聚合
5. 外部集成层负责同步和回调

所以我们的方案不是偏离官方，而是在沿着同一个方向补自己的多模态桌面数据。

## 10. 结论

官方 OMI Cloud 更像一个“会话知识管线”，而不是一个单纯的存储桶。

它的特点是：

- 输入是会话/转写/摘要
- 输出是 memory、action item、day summary
- 检索和同步通过 API 和 webhook 完成
- 向量检索与结构化对象是并行存在的

这对我们来说意味着：

- 关系库保事实
- 向量库做召回
- Dify 或类似工作流做编排
- 原始文件保留做追溯
