# 会话标题大模型生成技术方案

## 1. 文档信息

- 状态：已确认，待实现
- 日期：2026-08-18
- 影响端：TypeScript 后端、桌面/Web/安卓共用前端
- 不影响端：管理后台、Android 原生壳、Electron 壳

## 2. 需求背景

当前系统使用用户首次发送消息的文本前缀作为会话标题。该方式不能识别消息的核心意图，长消息、带控制标记的消息和包含大量上下文的消息容易形成冗长、辨识度低的标题，不利于用户在任务列表中快速定位会话。

本次升级由大模型理解用户首次发送的有效文本，概括出简洁的主题短语作为会话标题。标题生成属于辅助流程，不得阻塞或影响 Agent 主任务执行。

## 3. 现状分析

### 3.1 当前主会话链路

1. 前端创建会话时不传标题，后端使用“未命名会话”作为默认值。
2. 用户首次发送消息前，`desktop/src/composables/useChat.ts` 调用 `desktop/src/utils/sessionTitle.ts`，在前端清理部分控制标记并截取前 50 个字符。
3. 前端立即更新本地 Store，并异步 PATCH `/v1/sessions/:id` 持久化标题。
4. 消息经 WebSocket 到达后端，`backend-ts/src/session/session.service.ts` 的 `saveMessage()` 在标题仍为占位值时，再次使用 `TitleGenerator` 截取文本前缀。

现状存在前后端双重生成、异步 PATCH 与后端保存竞争、不同消息入口规则不一致的问题。

### 3.2 当前边路任务链路

`backend-ts/src/session/ws/streaming-ws-handler.ts` 在创建 `SIDE_TASK` 会话前同步调用 `generateTitleFromUserMessage()`；该方法当前仍使用 `TitleGenerator` 截取消息前缀。创建完成后通过 `side_session_created` 事件把标题发送给前端。

### 3.3 可复用能力

- `OpenAiLlmAdapter.chat()`：现有 OpenAI 兼容非流式模型调用能力。
- `HarnessService.resolveModel()`：按会话模型 ID 解析模型，缺省时回退系统默认模型。
- `llmModelToConfig()`：将模型实体转换为 LLM 调用配置。
- `agentExecutor`：提交不阻塞 WebSocket 消息处理的后台任务。
- `StreamingWsRegistry` 与 `wsEvent()`：向当前用户的多个客户端实时推送会话变化。
- `TitleGenerator.preprocessForTitle()`：处理 Skill 和快捷指令标记的已有基础能力。

## 4. 需求描述

### 4.1 要做的内容

1. 主会话和边路任务首次收到有效用户文本后，由后端异步调用大模型生成标题。
2. 标题生成使用当前会话选择的模型；会话未指定模型时使用系统默认模型。
3. 模型根据预处理后的首次用户文本理解和概括任务意图。
4. 提示词要求标题为 15 个字符以内的简洁主题短语，保留关键动作和对象。
5. 标题语言跟随用户首次有效文本的主要语言。
6. 后端清理模型输出中的包装格式，再持久化到会话表。
7. 标题生成完成后通过 WebSocket 实时同步到前端会话列表、当前会话及边路任务列表。
8. 模型调用失败时使用现有文本前缀规则生成兜底标题，不重试，不影响 Agent 执行。
9. 异步结果不得覆盖用户在生成期间手动设置的标题。
10. 首条消息只有图片时不调用标题模型，标题固定为“图片消息”。
11. 移除前端主会话和边路任务的本地标题推导及标题 PATCH，消除双重生成。
12. 增加覆盖标题生成、竞态保护、失败兜底和实时同步的测试。
13. 实现时在根目录 `CHANGELOG.md` 当前版本的“后端”和“前端（桌面 / Web / 安卓）”小节记录用户可见变化。

### 4.2 明确不做的内容

1. 不对模型输出执行 15 字符硬截断；15 字以内仅由提示词约束。
2. 不为标题生成新增独立模型配置，或在管理后台增加标题模型设置。
3. 不对历史会话批量生成或重算标题，不新增数据迁移脚本。
4. 不修改 `SUBAGENT` 子代理标题；子代理继续使用调用方提供的任务标题。
5. 不为微信固定会话按每条消息重新生成标题。
6. 不把纯图片发送给视觉模型生成标题。
7. 不在标题失败后自动重试，不引入消息队列、定时补偿或持久化任务表。
8. 不把标题模型调用写入 `llm_usage` 用量表，只记录服务日志。
9. 不修改用户手动重命名能力。
10. 不修改管理后台、Electron 壳、Android 原生壳和数据库结构。

## 5. 验收标准

1. 新主会话发送首条文本后，Agent 正常立即开始执行，标题稍后自动从“未命名会话”更新为模型概括结果。
2. 新边路任务创建后先正常进入执行流程，标题稍后从“任务”更新为模型概括结果。
3. 示例消息“请帮我排查登录接口为什么偶发超时”生成类似“排查登录接口超时”的主题短语，不直接截取原消息前缀。
4. 中文输入生成中文标题，英文输入生成英文标题，中英混合输入按主要语义语言生成标题。
5. 最终标题不包含引号、Markdown 标记、“标题：”前缀、换行解释或句末的句号、问号、感叹号。
6. 模型不遵循长度要求时，系统保留清洗后的模型结果，不做 15 字符硬截断。
7. 模型不可用、超时、返回空内容或清洗后为空时，会话使用预处理文本的现有前缀规则作为标题，Agent 执行不受影响。
8. 用户在模型返回前手动重命名后，模型结果和失败兜底结果均不得覆盖手动标题。
9. 首条消息只有图片时，标题为“图片消息”，不产生标题模型调用。
10. 同一用户同时登录多个客户端时，各客户端都能通过 WebSocket 收到新标题。
11. 历史会话标题保持不变。

## 6. 技术选型

### 6.1 后端统一生成

标题生成的唯一权威放在后端。所有客户端共享同一套模型选择、输入预处理、输出清洗、失败兜底和并发保护规则。前端只负责展示持久化标题和处理实时更新事件。

不保留前后端同时生成的方案，避免两次模型调用和迟到结果互相覆盖。

### 6.2 非流式 LLM 调用

使用现有 `OpenAiLlmAdapter.chat()` 发起短文本非流式调用，参数建议如下：

- `stream: false`
- `tools: []`
- `temperature: 0.2`
- `reasoning: { effort: 'none' }`

标题结果很短，不需要流式传输；低温度和关闭推理可降低输出波动及额外延迟。

### 6.3 会话模型解析

使用 `session.modelId` 解析当前模型；为空时回退系统默认模型。复用现有模型实体和 `llmModelToConfig()`，不新增配置项。

如果无法解析出可用模型，直接进入前缀兜底逻辑。

### 6.4 异步执行

首条用户消息成功落库后，将标题生成提交给现有 `agentExecutor`。消息保存和 Agent 执行不等待标题生成结果。

标题后台任务只负责：读取并确认会话状态、预处理文本、调用模型、清洗或兜底、条件写入标题、发送更新事件、记录日志。任务异常必须在内部捕获，不能转化为主会话错误事件。

### 6.5 WebSocket 实时更新

新增统一事件：

```json
{
  "type": "session_title_updated",
  "sessionId": 123,
  "data": {
    "title": "排查登录接口超时",
    "parentSessionId": null,
    "sessionType": "NORMAL"
  }
}
```

`SIDE_TASK` 事件携带 `parentSessionId` 和 `sessionType: "SIDE_TASK"`。前端据此更新：

- 主会话实体及任务列表；
- 当前会话标题；
- 边路任务缓存；
- 已打开的边路任务 Tab。

不复用只包含 `phase` 语义的 `session_list_update`，保持事件职责清晰。

## 7. 详细设计

### 7.1 新增标题生成服务

在 `backend-ts/src/session/` 下新增职责单一的 `SessionTitleService`，由依赖装配层注入以下能力：

- LLM Adapter；
- 模型查询或 `HarnessService.resolveModel()` 等价能力；
- `SessionRepository`；
- 用户快捷指令查询能力；
- `StreamingWsRegistry`；
- 后台执行器。

核心接口建议：

```ts
scheduleForFirstUserMessage(sessionId: number, content: unknown): void
generateAndApply(sessionId: number, rawText: string): Promise<void>
```

`scheduleForFirstUserMessage()` 只做快速资格判断和后台任务提交。`generateAndApply()` 完成具体生成流程。

标题 LLM 调用不放入 `SessionService.saveMessage()` 的同步等待路径，也不把 LLM、模型和 WS 依赖持续堆叠进现有 `SessionService`。

### 7.2 首条消息判定

只有同时满足以下条件时才调度标题生成：

1. 会话类型为 `NORMAL` 或 `SIDE_TASK`；
2. 本次保存角色为 `USER`；
3. 会话当前标题为对应系统占位值：主会话“未命名会话”，边路任务“任务”或空标题；
4. 本次消息是该会话首条用户消息；
5. 提取出的有效文本非空。

“首条用户消息”必须由数据库查询确认，不能只依赖标题占位值。建议在 `MessageRepository` 增加按会话统计/判断首条用户消息的方法，或利用刚插入消息 ID 查询该会话是否存在更早的 `USER` 消息。

该判断可以避免用户把历史会话手动改回“未命名会话”后，下一条消息再次触发自动生成。

### 7.3 输入预处理

处理顺序如下：

1. 从字符串或多模态内容中提取文本；
2. 去除首尾空白；
3. 展开 `#{快捷指令}#` 为当前用户可用的指令正文；
4. 移除 `${skill}$` 控制标记；
5. 移除 `@{文件路径}@` 文件引用标记；
6. 再次合并空白并去除首尾空白。

纯 Skill 消息不能只剩空文本。应将 Skill 名转换为自然语义输入，例如 `/skillName`，再交给模型概括。

如果预处理后文本为空但消息含图片，直接使用“图片消息”；如果文本和图片均为空，不调度标题生成。

### 7.4 提示词

系统提示词必须明确限定输出格式，不要求 JSON，避免额外解析复杂度：

```text
你是会话标题生成器。根据用户首次消息提炼一个简洁、明确的主题短语。
要求：
1. 目标长度不超过15个字符；
2. 保留核心动作和对象，删除寒暄、语气词和背景赘述；
3. 跟随用户消息的主要语言；
4. 不使用“关于”“用户想要”“请求”等空泛前缀；
5. 不使用句号、问号、感叹号；
6. 只输出标题，不要引号、标签、Markdown 或解释。
```

用户消息以独立 `user` 消息传入。不得将用户文本拼接进 system prompt，避免用户内容改变系统指令边界。

### 7.5 输出清洗

后端按以下顺序清洗模型输出：

1. 标准化换行并 `trim()`；
2. 只取第一个非空行；
3. 去除 Markdown 标题、列表等行首标记；
4. 去除“标题：”“Title:”前缀；
5. 去除成对的中英文引号、反引号；
6. 去除末尾句号、问号、感叹号及对应英文符号；
7. 再次 `trim()`。

不执行字符数截断。清洗后为空时进入失败兜底。

### 7.6 失败与超时

标题调用使用独立的短超时，建议 10 秒。超时后取消当前非流式请求并立即兜底，不复用 Agent 主调用可能较长的整体等待时间。

以下情况统一进入兜底：

- 无可用模型；
- LLM 请求异常或超时；
- 模型没有返回文本；
- 清洗后为空。

兜底使用现有 `TitleGenerator.generate(preprocessedText)` 前缀规则。纯图片仍固定为“图片消息”。兜底不自动重试。

服务日志至少包含 `sessionId`、`modelId`、结果类型（`generated` 或 `fallback`）、失败原因和耗时；不得记录模型 API Key。按已确认决策，不调用 `LlmUsageService.record()`。

### 7.7 并发与覆盖保护

异步任务开始时读取会话，写回前再次读取或执行带条件的数据库更新。

推荐在 `SessionRepository` 增加条件更新：

```sql
UPDATE session
SET title = ?, updated_at = ?
WHERE id = ?
  AND title IN ('未命名会话', '任务', '')
```

实际占位值应按会话类型校验，不能让主会话的模型结果误写到已被用户重命名的会话。条件更新影响行数为 0 时视为用户已改名或会话状态已变化，丢弃结果且不发送 WS 标题事件。

同一会话只允许调度一次标题任务。首条用户消息的数据库判定与条件写回共同提供幂等保护，不新增持久化状态字段。

### 7.8 主会话改造

调整主会话消息保存链路：

1. `SessionService.saveMessage()` 保留消息持久化和 `updated_at` 更新。
2. 删除其中同步调用 `TitleGenerator.generate()` 并写标题的旧逻辑。
3. WebSocket 主消息入口在首条用户消息保存成功后调用标题服务的调度方法。
4. 立即继续现有 `prepareMessage()` 和 Agent 执行流程。
5. 标题完成后由标题服务条件写回并发送 `session_title_updated`。

队列插入或自动消费形成首条用户消息时，也必须经过相同的标题调度入口，不能只覆盖普通发送路径。

### 7.9 边路任务改造

调整 `handleCreateSideSession()`：

1. 创建 `SIDE_TASK` 时先使用占位标题“任务”。
2. 立即持久化边路会话并保存首条用户消息。
3. `side_session_created` 先携带占位标题，使前端可立即创建 Tab 并进入执行。
4. 保存消息后异步调度标题生成。
5. 标题完成后发送统一 `session_title_updated`，更新边路列表和 Tab。

删除创建边路任务前同步调用 `generateTitleFromUserMessage()` 的逻辑，保证边路任务启动不被标题生成阻塞。

### 7.10 前端改造

1. 删除 `useChat.ts` 两处首次发送前调用 `deriveSessionTitle()`、更新 Store 和 PATCH 标题的逻辑。
2. 检查 `TaskView.vue`、`SideChatPanel.vue` 等边路任务入口，删除仅用于自动标题的 `deriveSessionTitle()` 调用；用户手动重命名仍继续调用现有 PATCH API。
3. 若 `desktop/src/utils/sessionTitle.ts` 不再有其他有效调用，则删除该文件；若仍服务非会话标题场景，则仅移除会话自动命名职责。
4. `useStreamWS.ts` 增加 `session_title_updated` 分支：
   - `NORMAL` 调用 `sessionStore.updateSession(sessionId, { title })`；
   - `SIDE_TASK` 更新 Side Task 缓存与对应 Tab；
   - 当前会话依赖 Store 的计算属性自动刷新。
5. 不展示标题生成失败提示，不增加加载动画或 Toast；失败已由后端兜底为可用标题。

## 8. 实现步骤

1. 在后端新增 `SessionTitleService`，实现模型解析、非流式调用、提示词、输出清洗、10 秒超时、日志和前缀兜底。
2. 扩展 `TitleGenerator.preprocessForTitle()`，统一移除文件引用标记并保留纯 Skill 的语义输入。
3. 在消息仓储增加首条用户消息判定能力，在会话仓储增加占位标题条件更新能力。
4. 从 `SessionService.saveMessage()` 删除旧的同步前缀标题写入逻辑。
5. 在主会话普通发送、队列插入和自动消费路径接入异步标题调度。
6. 将边路任务改为先用“任务”占位创建，再异步生成标题。
7. 在依赖装配中注入 LLM Adapter、模型解析、仓储、WS Registry 和后台执行器。
8. 后端生成完成后发送 `session_title_updated` 事件。
9. 前端移除本地自动标题生成和 PATCH，增加 WS 标题事件处理。
10. 补充后端单元测试、WebSocket Handler 测试和前端 Store/事件测试。
11. 运行后端构建与单测、桌面端构建，并按需要执行现有 Playwright 会话流程测试。
12. 更新根 `CHANGELOG.md` 当前版本的后端和共用前端小节。

## 9. 测试方案

### 9.1 标题服务单元测试

- 中文长消息生成简洁中文主题短语。
- 英文消息保留英文标题。
- 模型结果带引号、`#`、`标题：`、换行解释时正确清洗。
- 模型输出超过 15 字符时不截断。
- 模型返回空文本时使用前缀兜底。
- 模型异常、超时、无默认模型时使用前缀兜底。
- 纯图片不调用 LLM，返回“图片消息”。
- Skill、快捷指令、文件引用经过预处理后再调用模型。
- 日志不包含 API Key，不写入 `llm_usage`。

### 9.2 仓储与并发测试

- 标题仍为主会话占位值时条件更新成功。
- 标题仍为边路占位值时条件更新成功。
- 用户已手动改名时条件更新影响行数为 0。
- 条件更新失败时不发送 `session_title_updated`。
- 非首条用户消息不调度标题任务。
- 同一首条消息重复处理不会覆盖已生成或手动设置的标题。

### 9.3 WebSocket 测试

- 主会话保存首条消息后立即进入 Agent 执行，不等待标题 Promise。
- 标题成功后向用户发送正确的 `session_title_updated`。
- 边路任务先发送带占位标题的 `side_session_created`，随后发送标题更新事件。
- 队列消息成为首条用户消息时也触发标题生成。
- 标题模型失败不会发送主会话 `error` 事件。

### 9.4 前端测试

- `session_title_updated` 更新主会话 Store 和列表标题。
- 边路标题事件更新 Side Task 缓存和已打开 Tab。
- 首次发送消息不再调用标题 PATCH API。
- 用户手动重命名仍正常调用 PATCH 并更新 Store。
- 纯图片会话最终显示“图片消息”。

### 9.5 验证命令

```bash
cd backend-ts && npm run build
cd backend-ts && npm test
cd desktop && npm run build
npm test
```

根目录 Playwright 测试按现有环境可用性执行；CI 固定覆盖后端构建与单测、桌面端构建。

## 10. 风险与控制

### 10.1 模型不遵守 15 字要求

已确认不做长度硬截断，因此不能技术性保证最终标题绝对不超过 15 个字符。通过低温度、明确提示词和单一输出格式提高遵循率；验收时按“目标长度约束”判断，不按数据库硬约束判断。

### 10.2 标题调用增加模型请求

每个符合条件的新主会话和边路任务增加一次短模型调用。通过非流式、无工具、低温度、关闭推理和短超时控制成本与延迟。按已确认决策，该调用只写日志，不计入 `llm_usage`。

### 10.3 异步写回覆盖手动标题

通过数据库条件更新控制写回，不采用“先读取再无条件更新”的方式。只有标题仍是系统占位值时才能落库。

### 10.4 服务重启导致标题任务丢失

本次不引入持久化任务或重试机制。进程在异步任务执行期间退出时，该会话可能保留占位标题；这是“不自动重试、不补算历史会话”决策下接受的边界。

### 10.5 多实例重复调度

WebSocket 首条消息只由接收实例处理；即使发生重复调度，首条消息判定与条件更新可保证最多一个结果成功写入。后写任务因占位条件不成立而放弃。

## 11. 落地清单

### 后端

- [ ] 新增 `SessionTitleService`。
- [ ] 定义并固化标题系统提示词。
- [ ] 实现输入预处理和输出格式清洗。
- [ ] 实现 10 秒超时、异常捕获、服务日志和前缀兜底。
- [ ] 复用会话模型和系统默认模型解析。
- [ ] 增加首条用户消息判定查询。
- [ ] 增加占位标题条件更新 SQL。
- [ ] 删除 `saveMessage()` 中旧的同步前缀标题写入。
- [ ] 主会话普通发送路径接入异步调度。
- [ ] 队列插入与自动消费路径接入异步调度。
- [ ] 边路任务改为占位创建后异步调度。
- [ ] 新增 `session_title_updated` WebSocket 事件。
- [ ] 确保标题调用不写 `llm_usage`。
- [ ] 补充标题服务、仓储竞态和 WS 测试。

### 前端

- [ ] 删除主会话首次发送时的本地标题推导和 PATCH。
- [ ] 删除边路任务自动标题的前端推导逻辑。
- [ ] 清理不再使用的 `deriveSessionTitle` 引用或文件。
- [ ] 处理 `session_title_updated` 事件。
- [ ] 更新主会话 Store、边路任务缓存和边路 Tab。
- [ ] 保留用户手动重命名 PATCH 链路。
- [ ] 补充 Store 和 WS 事件测试。

### 发布与验证

- [ ] 更新根 `CHANGELOG.md` 的“后端”条目。
- [ ] 更新根 `CHANGELOG.md` 的“前端（桌面 / Web / 安卓）”条目。
- [ ] 后端 TypeScript 构建通过。
- [ ] 后端单元测试通过。
- [ ] 桌面端构建通过。
- [ ] 现有会话 Playwright 流程无回归。
- [ ] 手工验证主会话、边路任务、纯图片、失败兜底和手动改名竞态。

## 12. 预计修改文件

实现阶段预计涉及以下现有入口，最终以代码依赖收敛结果为准：

- `backend-ts/src/create-app.ts`
- `backend-ts/src/session/session.service.ts`
- `backend-ts/src/session/session.repository.ts`
- `backend-ts/src/session/util/title-generator.ts`
- `backend-ts/src/session/ws/streaming-ws-handler.ts`
- `backend-ts/src/session/ws/streaming-ws-handler.spec.ts`
- `backend-ts/src/session/util/session-utils.spec.ts`
- `desktop/src/composables/useChat.ts`
- `desktop/src/composables/useStreamWS.ts`
- `desktop/src/views/task/TaskView.vue`
- `desktop/src/components/chat/SideChatPanel.vue`
- `desktop/src/stores/session.ts`
- `desktop/src/utils/sessionTitle.ts`（无剩余调用时删除）
- `CHANGELOG.md`

预计新增后端标题服务及对应单元测试文件；不新增数据库迁移、前端页面或配置文件。
