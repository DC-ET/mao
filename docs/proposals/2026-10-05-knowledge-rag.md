# 提案：知识库（RAG）—— 让 Agent 有"料"可查

- 状态：**已否决**（2026-10-05 复审：明确不做，不再提案）。本文仅存档，勿再评审。
- 日期：2026-10-05
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

Agent 目前能"查"的只有三类来源：

- **工作区文件**：read_file / grep_search，整文件读取，用户得知道文件在哪。
- **公网**：web_search / open_web_page。
- **长期记忆**：`memory_item` 纯文本行，按 updated_at 时序注入（USER 8 条 + PROJECT 12 条），容量 200 条，去重靠 SHA-1 精确哈希（`docs/plan/2026-10-02-long-term-memory-technical-design.md`）。

用户沉淀的私有语料——项目文档、规范、wiki 导出、会议纪要、飞书云文档——只能整篇塞进会话或写进技能，语料一旦超出上下文就查不了。全库 embedding/vector/rag 关键词扫描零命中，LlmAdapter 也没有 embeddings 端点适配。

## 2. 为什么重启这个方向

上一批把知识库/RAG 归入"已评估、暂不做"，理由是工程量大、与技能/工作区文件重叠。现在两个前提变了：

1. **重叠比当时估计的小**。技能是"操作指南"（教 Agent 怎么做），工作区文件是"整文件给 Agent 看"，知识库解决的是"语料多到塞不进上下文时的语义检索"——三者互补而非替代。
2. **下游场景已经就位**。定时任务（无人值守查资料）、飞书/钉钉/微信渠道（群里问业务问题）、Agent 资产化（技能可随 bundle 搬走，但语料搬不走——知识库是资产化之后的下一个自然资产层）。

## 3. 目标 / 非目标

**目标**

1. 用户/团队可建知识库，上传文档（P1：MD/TXT/PDF），自动切分、向量化、可检索。
2. 新增内置工具 `knowledge_search`，Agent 在会话与定时任务中按需检索，回答带出处。
3. LlmAdapter 支持 embeddings 协议，模型配置复用现有 `model` 域。

**非目标**

- 不动长期记忆的存储结构（memory embedding 化是记忆方案里被推迟的独立提案）。
- 不做全文搜索引擎、不做复杂重排（P1 纯向量余弦，不够再说）。
- 不做 OCR/扫描件解析（PDF 只走文本层，无文本层的文件明确拒绝）。

## 4. 技术方案

### 4.1 数据模型（迁移号顺延，当前已到 V132）

```sql
knowledge_base  (id, name, description, owner_user_id, visibility ENUM('PRIVATE','TEAM'), created_at, updated_at)
knowledge_doc   (id, base_id, name, source ENUM('UPLOAD','URL','FEISHU'), size, status ENUM('PENDING','READY','FAILED'), error, created_by, created_at, updated_at)
knowledge_chunk (id, doc_id, seq, content TEXT, embedding JSON, token_count, created_at)
```

### 4.2 向量存储：先用 MySQL 硬扛，留升级接口

- embedding 以 JSON 数组存 `knowledge_chunk.embedding`，检索时服务层载入做余弦暴力扫描。
- 自托管个人/团队规模（单库 ≤ 10 万 chunk）下，Node 单线程扫描 1024 维 × 10 万条约 100~300ms，可接受。
- 检索层抽 `VectorStore` 接口（`search(baseId, vector, topK)`），未来可无痛换 hnswlib / Qdrant；不引入新存储中间件，符合自托管形态。

### 4.3 Embedding 适配

- `LlmModelConfig.modelType` 增加 `embedding`；`llm-adapter-facade` 增加 embeddings 调用路径。OpenAI 兼容 `/v1/embeddings` 覆盖面已足够，P1 不做独立协议。
- 批量接口 + 维度校验：同一库内维度必须一致，模型切换导致维度不符时拒绝检索并提示重建。

### 4.4 摄取管线

- P1 来源：桌面设置页知识库管理上传（复用 chat-file-upload 的上传通道与大小限制，见 `docs/plan/2026-08-20-chat-file-upload-technical-design.md`）。
- 切分：按标题层级优先 + 长度兜底（目标 500~800 token、重叠 10%），实现为纯函数可单测。
- 向量化异步执行：定时扫 `PENDING`（复用 schedule 域扫描器模式），失败可重试、状态在管理页可见。

### 4.5 检索工具与注入

- 内置工具 `knowledge_search(query, base_ids?, top_k?)` 注册进 `createDefaultToolRegistry`。
- **按 AGENTS.md 规范同步**：`session/util/tool-result-summarizer.ts` 补结果摘要、`desktop/src/utils/toolDisplay.ts` 补中文名称与参数预览、补成功/失败/缺参回归测试。
- 返回结构：chunks 数组，每条带 `docName + seq + score + content`；ToolCallCard 展示出处文档名，P2 支持点击跳转文档详情。
- 采用**工具按需检索**而非自动注入 top-k：避免每轮都烧 token 与上下文污染；Agent 通过 agent 配置或系统提示获知可用库清单。

### 4.6 权限与 admin

- 权限码沿用 `@RequirePermission` 风格新增 `knowledge:read / knowledge:write`；TEAM 库全员可读、owner 与管理员可写。
- admin 新增知识库视图（库/文档/摄取状态/失败原因）；审计沿用现有拦截器覆盖。

## 5. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | embedding 适配 + 三张表 + 上传/切分/向量化/检索 API + `knowledge_search` 工具 + 桌面知识库管理页 | 大 |
| P2 | TEAM 库与权限 + 飞书文档导入（复用 feishu/doc-reader.ts）+ URL 摄取 + 出处跳转 UI | 中 |
| P3 | 混合检索（关键词 + 向量）、memory_item 语义去重复用 embedding 能力、用量统计 | 中 |

## 6. 风险与开放问题

- **embedding 模型可用性**：自托管用户未必配了 embedding 端点。缓解：模型管理中该类型标注"可选"，未配置时知识库功能置灰并给出配置指引；`knowledge_search` 在无配置时返回明确错误信息。
- **换模型导致向量不兼容**：维度不一致时拒绝检索并提示重建，P1 不做自动重嵌。
- **MySQL 暴力扫描天花板**：VectorStore 接口已预留；触发条件写死在文档里（10 万 chunk 或 P95 > 1s）再引入专用向量存储，P1 不做。
- **PDF 解析质量**：文本层缺失明确报错；解析库选型（pdf-parse 类）实施时定。
- **开放问题**：库与 Agent 的绑定关系——只靠工具参数传 `base_ids`（用户每次说"查 xx 库"），还是在 agent.configJson 加 defaultBaseIds 并随 bundle 分发？倾向后者放 P2（bundle 格式顺势升 v2）。

## 7. 测试要点

- 切分纯函数单测：标题层级、长度兜底、重叠。
- 摄取状态机：PENDING → READY/FAILED、重试幂等、失败原因落库。
- 检索：top-k、分数排序、跨库、维度不一致报错。
- 工具回归：`knowledge_search` 成功/失败/缺参 + summarizer + toolDisplay 同步（AGENTS.md 规范）。
- 权限：PRIVATE 库跨用户不可见；`knowledge:write` 校验。
