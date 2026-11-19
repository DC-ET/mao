# LLM 模型双凭证方式（固定 API Key / 当前用户 ECP Token）技术方案

- 日期：2026-11-19
- 状态：已评审通过；决策 D-1~D-6 已确认（2026-11-19，见 §8.2），待开发（本文档不含实现）
- 需求方：杨佳毅
- 关联代码：`backend-ts`（模型管理 + LLM 调用链 + ECP 登录）、`admin`（模型管理页面）、`shared/contracts`

## 一、需求与目标

### 1.1 背景

管理后台「模型管理 → 编辑模型 → 接入配置」中，`API Key` 当前为必填项（`admin/src/views/model/ModelFormDialog.vue`，创建时前端强校验；`llm_model.api_key` 列为 `NOT NULL`）。

公司内部已有完整的 ECP 登录体系：用户完成 ECP 飞书登录后，Mao 会保存其 ECP `sessionToken`（加密），并已在多处使用（注入 CLOUD shell 供内部 CLI 使用、飞书通道准入校验等）。经实测（2026-11-19），用户的 ECP Token 可以直接作为 `Authorization: Bearer` 调用内部 LLM 网关（如 `https://sub2api.acg.team/v1`）。

因此存在以下需求场景：**模型配置不再绑定一个共享的 API Key，而是让每次 LLM 调用使用「当前触发用户自己」的 ECP Token**（个人计费/个人授权），从而：

- 免去管理员分发给多人的共享 Key（泄漏面收窄）；
- 用量天然归属到实际使用者；
- 配合内部网关的账号级策略（如 `codex_cli_only` + 客户端标识头，模型配置已有 `客户端标识` 字段可组合使用）。

### 1.2 需求定义（来自用户原文）

> 目前是必须要配置一个 API Key，改成有两个选择（单选）：
> 1、默认跟现在一样，填一个明确的 API Key。
> 2、使用当前用户的 ECP Token，不需要填 API Key。（仅在系统配置中"启用 ECP 飞书登录"开关打开时可选）

交互定义：

| 凭证方式 | 语义 | API Key 字段 |
|---|---|---|
| 固定 API Key（默认，存量行为） | 所有调用都使用模型配置里的 Key | 必填（现有规则不变） |
| 当前用户的 ECP Token | 每次调用时实时解析「本次调用的触发用户」的 ECP 登录凭证并作为 Bearer 发出 | 不填（隐藏/禁用），不参与调用 |

约束：ECP 选项仅在系统配置「启用 ECP 飞书登录」打开时可选（`auth.ecp.config` 的 `enabled && appCode && baseUrl`，判定口径与 `EcpAuthService.isEnabled()` 一致）。

### 1.3 范围

**做**：

- 模型配置新增「凭证方式」单选，双轨存储与调用；
- 后端 LLM 调用链（所有出口）支持按 `authType` 解析凭证；
- 管理端表单、列表、连通性测试的配套改造；
- 就绪度判定、agent-cli 模型列表等受影响面的兼容处理。

**不做（本方案不覆盖）**：

- 不做后端「自动帮用户注册 ECP 会话」——用户必须先完成一次 ECP 飞书登录（现有入口）；
- 不改 ECP 登录/续期机制本身；
- 不引入第三种凭证方式（如 OAuth 动态换票、按 Agent 级别指定等），留作后续演进；
- 不做按模型粒度的「哪些用户可用」白名单（不在本期需求内）。

## 二、现状调研结论

> 以下均为当前 `main`（截至 `8933c371`）的实际代码结论，文件路径可逐一核对。

### 2.1 模型配置链路全景

```
admin 前端 ModelFormDialog.vue（表单/校验）
  → POST/PUT /v1/models（model.routes.ts，权限 model:write）
  → ModelService.createModel/updateModel（model.service.ts，字段归一）
  → llm_model 表（db/migration/V001 建表，后续 V066/V083/V091... 增列）
  → 会话执行装配：harness-service.ts buildContext()
      llmModelToConfig(llmModel)（harness/deps.ts:324）
  → AgentExecutionContext.modelConfig → 各 LLM 出口发请求
```

关键点：

1. **后端没有 apiKey 非空校验**，只有前端必填 + 数据库 `NOT NULL` 兜底（`V001__init_schema.sql` 第 64 行：`api_key VARCHAR(512) NOT NULL COMMENT '加密存储的 API Key'`——注释写"加密存储"但实际明文存储、读写均无加解密，管理端读出时按权限决定掩码或明文，见 `model.routes.ts` 的 `maskApiKey`/`revealApiKey`）。
2. **模型配置对象 `LlmModelConfig` 有两处定义**：`harness/llm/chat-request.ts`（主链路用）与 `model/types.ts`（轻量 client 用），字段集基本同构，新增字段需两处同步。
3. 装配点 `llmModelToConfig` 是唯一的 `LlmModel → LlmModelConfig` 转换入口（除语音合成自行拼装外，见 2.2 第 6 条）。

### 2.2 apiKey 的消费点（共 7 个出口）

| # | 文件 | 说明 |
|---|---|---|
| 1 | `harness/llm/openai-llm-adapter.ts`（`awaitResponse`，约 405 行） | 主链路 OpenAI 兼容 `/chat/completions`，`Authorization: Bearer` |
| 2 | `harness/llm/responses-llm-adapter.ts`（约 532 行） | 主链路 `/responses`，`Authorization: Bearer` |
| 3 | `harness/llm/anthropic-llm-adapter.ts`（约 493 行） | 主链路 `/messages`，`x-api-key` + `Authorization` 双发 |
| 4 | `model/llm-chat.client.ts` | 非流式轻量调用（连通性测试等） |
| 5 | `model/responses-chat.client.ts` | 同上（Responses 协议） |
| 6 | `model/anthropic-chat.client.ts` | 同上（Anthropic 协议） |
| 7 | `harness/tool/image-api-client.ts`（`buildAuthorizationHeader`） | 图片生成；唯一容忍 `Bearer ` 前缀的入口 |

另有一处独立拼装：`weixin/voice-synthesis.service.ts` 的 `synthesizeWav()` 自行构造 `LlmModelConfig` 字面量（约 60-75 行），不经 `llmModelToConfig`。

### 2.3 ECP 现有能力（可复用，无需新造轮子）

1. **票据存储**：`user_ecp_session` 表（`auth/ecp-session.repository.ts`），字段 `user_id / session_token_enc / expires_at / renew_status(ACTIVE|RENEWING|FAILED)`；AES-GCM 加密（`encryptToken/decryptToken`）。
2. **可用性判定**：现有 `isUsableEcpSession()` / `hasUsableEcpSession()`（同文件）——综合 `renewStatus`、`expiresAt`、解密结果三个条件，可直接复用。
3. **按用户取明文 token**：`auth/ecp-credentials-injector.ts` 的 `injectForUser(userId)` 已实现「查行 → 校验 → 解密 → 返回明文」（附带写 CLOUD HOME 布局的副作用，本需求不需要写文件的那一半，可抽出纯取数逻辑复用）。
4. **自动续期**：`auth/ecp-renew.scheduler.ts`（60s 一跳，到期前 30 分钟批量 renew），保证票据长期有效。
5. **开关与配置**：`auth.ecp.config`（`auth/ecp.config.ts`），`EcpAuthService.isEnabled()` 给出权威判定。

### 2.4 LLM 调用的用户上下文（可行性关键）

所有 LLM 调用都包在 `LlmCallContext`（`usage/llm-call-context.ts`，AsyncLocalStorage）内，携带 `scene / userId / sessionId / agentId`。实际调用点核对：

| 场景 | userId 现状 | 结论 |
|---|---|---|
| agent 主链路（`agent-loop.ts:393`） | `executionUserId ?? session.userId`（群聊=发言者） | ✅ 已具备 |
| 会话压缩（`session-compaction-orchestrator.ts:70`） | 同主链路 | ✅ |
| 会话标题（`session-title.service.ts:180`） | `session.userId` | ✅ |
| 提交信息（`git-commit-message.service.ts:169`） | `session.userId` | ✅ |
| 飞书摘要（`group-context-summarizer.ts:53`） | 入参 userId | ✅ |
| 危险评估/替我审批（`tool-dispatcher.ts:622/651`） | 入参 userId | ✅ |
| 记忆抽取（`memory-extraction.service.ts:413`） | `input.userId` | ✅（实现时核对调用侧均非 null） |
| 连通性测试（`model.service.ts:327/354`） | **null** | ❌ 需传"发起测试的管理员" |
| 微信语音合成（`voice-synthesis.service.ts:60`） | **null** | ❌ 需传"微信绑定账号的用户"（调用链 `voice-reply.service.ts` 已知 account→userId） |
| 图片生成（generate-image-tool） | 在 agent 工具上下文内 | ✅（实现时核对） |

**结论：大部分场景天然具备身份；只有 2 处需要补传 userId。**

### 2.5 其他受影响面

1. **就绪度判定**：`model.repository.ts` 的 `countEnabledWithApiKey()` 以 `api_key IS NOT NULL AND <> ''` 计数（readiness "实例是否可对话"），ECP 模式下该口径需要放宽，否则「只有 ECP 模型」的实例会被误判为未就绪。
2. **agent-cli**：`GET /v1/models/active` 返回模型列表，CLI 侧已用 `stripModelSecrets` 丢弃 apiKey（`agent-cli/src/util/redact.ts`）——ECP 模式下 apiKey 返回空串即可，无破坏。
3. **管理端权限**：`/v1/system-settings` 需要 `settings:read` 权限；而模型表单编辑需要 `model:write`。两个权限集不一定重合，**前端不能直接调系统配置接口来判断 ECP 开关**，需要一个轻量、低权限的"ECP 可用性"查询接口（见 3.3）。
4. **迁移机制**：flyway（`db/flyway.ts`，启动自动执行；当前最新版本号 `V197`）。
5. **前端掩码回填逻辑**：`ModelFormDialog.vue` 通过 `isMaskedApiKey()`（`****` 前缀）区分掩码与明文，编辑时掩码不回填、"留空=不修改"。新字段要与其协同，避免破坏该保护。

## 三、方案设计

### 3.1 总体思路

一句话：**在模型配置上新增 `authType`（`api_key` / `ecp`）字段；`api_key` 模式完全维持现状；`ecp` 模式下，在任何 LLM 出口「发请求前」实时解析当前调用用户的 ECP token 作为 Bearer（绝不回退到配置里的 Key）。**

```
模型配置层： authType='ecp'  ──┐（apiKey 字段不参与）
                              ▼
调用层（7 个出口）：  resolveLlmApiKey(config)
                        ├── authType != 'ecp' → 返回 config.apiKey（现状）
                        └── authType == 'ecp' → EcpTokenProvider.getUsableToken(userId)
                                                  ├─ userId ← LlmCallContext（AsyncLocalStorage）
                                                  ├─ 查 user_ecp_session + 解密 + 可用性判定
                                                  └─ 无票/过期/失败 → 抛错（引导登录）或场景化降级
```

设计原则：

1. **解析放在调用层、不是配置层**。`llmModelToConfig` 在会话启动时执行一次，而 ECP 票是"随时间变化"的（可续期、可失效、跟发言者切换），必须在每次请求时解析；同时调用层已有 `LlmCallContext`，天然拿到 userId。
2. **绝不静默回退**。`ecp` 模式解析失败时，不允许改用模型上的 `api_key`（否则会出现"以为用个人票，实际烧共享 Key"的隐性错误）；失败即报错/降级，错误文案引导用户完成 ECP 登录。
3. **单点抽象**。7 个出口共用同一个解析函数（含短 TTL 缓存），不各自实现。
4. **存量零变化**。`auth_type` 默认 `'api_key'`，旧模型、旧前端（不认识新字段时仍按 api_key 提交）、旧数据行为完全一致。

### 3.2 数据模型与类型

**迁移（新增 `V198__llm_model_auth_type.sql`）**：

```sql
-- 模型凭证方式双轨（技术方案 2026-11-19）
-- api_key=模型固定 API Key（存量默认）；ecp=调用时使用当前用户的 ECP Token。
-- api_key 列保持 NOT NULL：ecp 模式写入空串占位，不作语义使用。
ALTER TABLE `llm_model`
    ADD COLUMN `auth_type` VARCHAR(16) NOT NULL DEFAULT 'api_key'
        COMMENT '凭证方式：api_key=模型固定 API Key；ecp=当前用户 ECP Token';
```

**类型定义**（`shared/contracts/src/model.ts`，与 `ClientImpersonation` 并列）：

```ts
/** 模型凭证方式：api_key=模型固定密钥；ecp=调用时使用当前用户的 ECP Token。 */
export type ModelAuthType = 'api_key' | 'ecp';
export const MODEL_AUTH_TYPES = ['api_key', 'ecp'] as const;
```

**实体与配置对象**（4 处同步新增 `authType` 字段）：

| 位置 | 用途 |
|---|---|
| `shared/contracts/src/model.ts` → `ModelVO.authType` | 管理端接口回显 |
| `model/types.ts` → `LlmModel.authType` | 仓储实体 |
| `model/types.ts` → `LlmModelConfig.authType` | 轻量 client 配置 |
| `harness/llm/chat-request.ts` → `LlmModelConfig.authType` | 主链路适配器配置 |

### 3.3 后端 API 与校验

**请求体**（`model.routes.ts`：`CreateModelRequest` / `UpdateModelRequest` 共用同一接口类型）：

```ts
interface CreateModelRequest {
  // ...既有字段
  authType?: string;   // 'api_key' | 'ecp'，缺省视为 'api_key'
}
```

**Service 层**（`model.service.ts`）：

- 新增归一函数 `normalizeAuthType(value): ModelAuthType | null`（未知值 → null；'ecp'/'api_key' 之外一律拒绝或回落，实现时与 `normalizeClientImpersonation` 同风格）。
- `createModel` / `updateModel` 增加 `authType` 参数：
  - `authType='ecp'` 时校验 ECP 开关已启用（注入 `getEcpConfig` 或 `isEnabled`），否则抛 `BusinessException(PARAM_INVALID, 'ECP 飞书登录未启用，无法选择该凭证方式')`；
  - `authType='ecp'` 时 **忽略/允许缺省 `apiKey`**（新建传空串 `''`，满足 NOT NULL）；
  - `authType='api_key'` 时维持既有行为（含"编辑留空=不修改原 Key"）。
- `updateModel` 中 `authType` 使用"非空才更新"语义（与现有 `if (apiKey != null)` 风格一致）。

**决策 D-2（已确认，2026-11-19）：切换 `api_key → ecp` 时，库里的旧 API Key 保留、不清空。**

- 理由：切回 `api_key` 无需重填；旧 Key 本就在库，不新增暴露面；运行时严格按 `authType` 分流（本方案硬规则），不会误用。
- UI 明示：表单提示"原 API Key 保留在库中，切回该方式即可继续使用"。

**VO 输出**（`toVO`）：

- 新增 `authType` 字段（回落 `'api_key'`，兼容旧行）。
- `authType='ecp'` 时 `apiKey` 输出 `''`（无意义内容不回传，也避免管理员误以为仍在用的 Key 被判为掩码）。

**ECP 可用性查询（新接口，供前端表单判断 ECP 选项是否可选）**：

```ts
// GET /v1/models/ecp-availability  （登录即可，参照 /v1/system-settings/menu-visibility 先例；
// 只暴露布尔，不透出 appCode 等配置内容）
{ enabled: true }   // = config.enabled && hasText(appCode) && hasText(baseUrl)
```

> 为什么不用 `/v1/system-settings`：需要 `settings:read`，而模型编辑者只保证有 `model:write`，权限不对齐。

### 3.4 凭证解析层（核心，新增 2 个模块）

**① `backend-ts/src/auth/ecp-token-provider.ts`（新）——纯取数 + 缓存**

```ts
export interface EcpTokenProvider {
  /** 取该用户当前可用的 ECP 明文 token；无票/过期/续期失败/解密失败一律返回 null（不抛）。 */
  getUsableToken(userId: number): Promise<string | null>;
}

export function createEcpTokenProvider(
  sessions: MysqlEcpSessionRepository,
  opts: { ttlMs?: number } = {},
): EcpTokenProvider
```

- 复用既有 `isUsableEcpSession(row, decrypt, now)` 判定（含 `renewStatus==='FAILED'` 短路、`expiresAt` 过期、解密封装）；
- **60s TTL 正缓存**（`Map<userId, { token, expiresAtMs }>`，仅缓存成功结果）：
  - 一轮对话可能触发多次 LLM 调用（主调用 / 压缩 / 审批），避免重复查库解密；
  - 无效结果不缓存（用户刚完成登录应立即生效）；票在 60s 内被吊销的延迟可接受（内部工具场景）；
  - 缓存实现保持惰性淘汰（复用定时清理或 size 上限，实现时与 harness 既有缓存风格对齐）。

**② `backend-ts/src/harness/llm/llm-auth.ts`（新）——出口统一入口**

```ts
export interface LlmAuthResolver {
  /** 依据 config.authType 解析本次请求真正使用的 API Key/Bearer；失败抛业务异常。 */
  resolveApiKey(config: LlmModelConfig): Promise<string>;
}

export function createLlmAuthResolver(ecpTokens: EcpTokenProvider): LlmAuthResolver {
  return {
    async resolveApiKey(config) {
      if (config.authType !== 'ecp') return config.apiKey ?? '';   // 现状路径
      const userId = LlmCallContext.get()?.userId ?? null;
      if (userId == null) {
        throw new BusinessException(ErrorCode.MODEL_AUTH_ECP_UNAVAILABLE,
          '该模型使用「当前用户 ECP Token」，当前调用没有用户上下文');
      }
      const token = await ecpTokens.getUsableToken(userId);
      if (token == null) {
        throw new BusinessException(ErrorCode.MODEL_AUTH_ECP_UNAVAILABLE,
          '该模型使用「当前用户 ECP Token」，请先完成 ECP 飞书登录后再试');
      }
      return token;
    },
  };
}
```

- 选 `harness/llm/` 的理由：`model/*.client.ts` 已在跨目录 import 该目录（`client-impersonation-headers.ts` 先例），符合现有边界。
- 错误码：新增 `MODEL_AUTH_ECP_UNAVAILABLE`（`common/error-code.ts`，取 3xxx 段下一个未占用编号，实现时核对）；文案保持"引导用户完成 ECP 飞书登录"的核心信息。
- 7 个出口调用范式（改为先解析、后拼头）：

```ts
const apiKey = await this.authResolver.resolveApiKey(config);
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
applyClientImpersonationHeaders(headers, config.clientImpersonation);
```

**装配点**（均在既有装配文件中补依赖，构造参数可选以降低测试成本）：

| 装配处 | 对象 |
|---|---|
| `app-llm-engine.ts:68/76/87` | `OpenAiLlmAdapter` / `AnthropicLlmAdapter` / `ResponsesLlmAdapter` 构造注入 `authResolver` |
| `create-app.ts:400-430` | `OpenAiChatClient` / `AnthropicChatClient` / `ResponsesChatClient`（含 `RecordingLlmChatClient` 包装）注入 `authResolver` |
| `create-app.ts`（ModelService 构造） | `ModelService` 注入 `ecpTokens`（供测试连通性与只读查询） |
| generate-image-tool 装配处 | `imageApiClient` 注入 `authResolver`（图片出口） |
| 默认值 | 构造参数缺省时使用"static-only"实现（只读 config.apiKey；ecp 模式抛错），防止装配遗漏静默走错路径 |

### 3.5 各出口改造清单

| # | 文件 | 改法 | 测试点 |
|---|---|---|---|
| 1 | `harness/llm/openai-llm-adapter.ts` | `awaitResponse` 内改为 `await resolveApiKey(config)` 后再拼 `Authorization` | ecp 时头为 ECP token；api_key 时与现状逐字节一致 |
| 2 | `harness/llm/responses-llm-adapter.ts` | 同上 | 同上 |
| 3 | `harness/llm/anthropic-llm-adapter.ts` | 同上（注意 `x-api-key` 与 `Authorization` 双发均使用解析结果） | 双头同值 |
| 4-6 | `model/llm-chat.client.ts` / `responses-chat.client.ts` / `anthropic-chat.client.ts` | `chat()` 内解析 | 各自 spec 补一条 ecp 用例 |
| 7 | `harness/tool/image-api-client.ts` | `ImageApiConfig` 增加 `authType`；发请求前解析（替换 `buildAuthorizationHeader(apiKey)` 的入参来源） | ecp 时使用 token；保留 `Bearer ` 前缀容错 |

改造后所有出口保持一致的不变式：**`authType==='ecp'` 时发出的凭证只可能是「解析出的用户 token」，不可能是 `config.apiKey`**。

### 3.6 两处缺口修复（补传 userId）

1. **连通性测试**（`model.service.ts#testConnectivity`）：
   - `model.routes.ts` 的 `POST /v1/models/:id/test` 传入 `requireUserId(request)`；
   - `testConnectivity(id, actorUserId)` 内 `LlmCallContext.runAsync({ scene: CONNECTIVITY_TEST, userId: actorUserId, ... })`；
   - 管理员未完成 ECP 登录时 → 结果对象返回 `{ connectivity:false, error:'该模型使用当前用户 ECP Token；当前管理员未完成 ECP 飞书登录，请先登录后再测试' }`（沿用现有 `ModelTestResult.error` 通道，前端已渲染）。
2. **微信语音合成**（`weixin/voice-synthesis.service.ts`）：
   - `synthesizeWav(text, userId)` 增加入参；`voice-reply.service.ts` 从 `accountRepository.findByAccountId(accountId).userId` 透传；
   - 进 `LlmCallContext.runAsync` 时带该 userId；
   - ECP 模式解析失败时维持现有"语音回复跳过"路径（`return null` + warn 日志），不影响文字回复。

其余场景（compaction / title / commit message / 飞书摘要 / 危险评估 / 替我审批 / 记忆抽取 / 图片生成）已具备 userId，无需改造，仅需在测试中覆盖。

### 3.7 错误处理与用户引导

分两类展示面：

| 场景 | 行为 |
|---|---|
| 会话内主链路（agent 流式调用） | 抛 `MODEL_AUTH_ECP_UNAVAILABLE` → 会话错误消息展示文案；用户完成 ECP 飞书登录后重试同一任务即可 |
| 轻量调用（标题/提交信息/摘要/审批/语音） | 同上抛错，由各自既有容错/降级路径处理（例如标题生成失败静默、语音跳过、审批默认转人工——不阻断主流程） |
| 管理端连通性测试 | 返回可读错误（见 3.6） |
| ECP 开关被管理员关闭后 | 已配置的 ecp 模型调用报错，文案含"ECP 飞书登录未启用"；**不自动回退 API Key**（决策 D-3，已确认） |

错误文案统一建议（实现时定稿）：

> 该模型配置为「使用当前用户的 ECP Token」，请先完成 ECP 飞书登录（可在桌面端登录页/飞书通道引导中完成）后再试。

### 3.8 管理端前端（admin）

**`ModelFormDialog.vue`（接入配置 tab）**：

```
客户端标识   ( ) None  (•) Codex  ( ) Claude Code
API 协议     [OpenAI（Responses） ▾]
...
凭证方式     (•) 固定 API Key        ( ) 当前用户的 ECP Token   ← 新增（截图红框处上方）
  —— 开关未启用时 ECP 选项 disabled，附提示：
     「需先在系统配置中启用 ECP 飞书登录」
API Key      [****************]      ← 仅「固定 API Key」模式显示；ECP 模式隐藏
  —— ECP 模式简述（灰色小字）：
     「调用时使用触发本次任务的实际用户（会话归属/发言者）的 ECP 登录凭证；
       用户未完成 ECP 飞书登录时将无法调用该模型」
```

交互细节：

- 弹窗打开（create/edit/copy 三模式）时请求 `GET /v1/models/ecp-availability`；`enabled=false` 时 ECP 单选禁用 + tooltip；`enabled` 变化不需要实时轮询（打开时取一次）。
- 校验规则动态化：`apiKey` 的 required 仅当 `authType==='api_key'`；`authType='ecp'` 时跳过。
- 编辑回显：`authType` 来自 VO（缺省 `api_key`）；ECP 模式不触发现有 `isMaskedApiKey` 回填逻辑（该字段隐藏），**保留"切回 api_key 时若输入框为空则不修改原 Key"的既有语义**。
- 提交 payload：ECP 模式不发送 `apiKey`（编辑）/发送空串（新建）；`authType` 始终发送。
- copy 模式携带 `authType`。

**`ModelListView.vue`**：

- 名称列在既有徽标（默认/视觉/启停/协议）旁增加 `ECP` 小标签（`el-tag`，title 提示"使用当前用户 ECP Token"）；
- 「测试」按钮行为不变（后端已按 3.6 处理）；
- 可选：筛选栏不加（本期不做）。

### 3.9 安全设计

1. **Token 生命周期**：ECP token 仅在服务端内存中使用（解析 → 拼头 → 发出），不落库（库中是加密的 `session_token_enc`）、不回传前端、不落日志。
2. **日志红线**：解析失败日志只打 `userId/modelId/失败类别（no_session|expired|renew_failed|decrypt_failed）`，严禁拼接 token；沿用既有 `redactSecret` 思路做兜底（图片 client 已有先例）。
3. **权限模型不变**：配置 `authType` 需要 `model:write`（与现在能配 apiKey 同一权限）；调用侧不新增权限——**任何能触发 LLM 的用户都会消耗自己（发言者）的 ECP 凭证**，这符合"个人授权"语义，但要在表单文案中说明。
4. **管理端可见性**：ECP 模式下 VO 的 `apiKey` 输出空串；即便有 reveal 权限也不返回（无内容可返）。
5. **审计**：切换/保存 `authType` 走既有模型更新接口与审计面（如需追责可查管理操作日志与 `updated_at`）。

### 3.10 可观测性

- 结构化日志：`llm auth: mode=ecp user=<uid> model=<id> hit=<cache|db>`（debug 级）；失败单独 warn。
- 与用量体系兼容：`llm_call` 记账逻辑不感知凭证方式，无需变化；若后续要按"凭证方式"统计成本，可加维度（非本期）。

## 四、影响面评估

### 4.1 文件级清单

**数据库**

- 新增 `backend-ts/db/migration/V198__llm_model_auth_type.sql`（加列，默认 `api_key`）。

**契约层**

- `shared/contracts/src/model.ts`：`ModelAuthType`、`ModelVO.authType`。

**后端（backend-ts）**

| 文件 | 改动 |
|---|---|
| `model/types.ts` | `LlmModel.authType`、`LlmModelConfig.authType` |
| `harness/llm/chat-request.ts` | `LlmModelConfig.authType` |
| `harness/deps.ts` | `llmModelToConfig()` 透传 `authType` |
| `model/model.routes.ts` | 请求体 `authType`；`toVO` 输出；新接口 `GET /v1/models/ecp-availability`；test 路由传 actor userId |
| `model/model.service.ts` | `normalizeAuthType`、create/update 校验（ECP 开关）、`testConnectivity(id, actorUserId)` |
| `model/model.repository.ts` | `countEnabledWithApiKey` 口径放宽（ecp 计入） |
| `auth/ecp-token-provider.ts` | **新增**：纯取数 + 60s 缓存 |
| `harness/llm/llm-auth.ts` | **新增**：`resolveApiKey(config)` 统一入口 |
| `harness/llm/openai-llm-adapter.ts` / `responses-llm-adapter.ts` / `anthropic-llm-adapter.ts` | 注入 resolver，改拼头 |
| `model/llm-chat.client.ts` / `responses-chat.client.ts` / `anthropic-chat.client.ts` | 同上 |
| `harness/tool/image-api-client.ts` + `impl/generate-image-tool.ts` | `ImageApiConfig.authType`、解析注入 |
| `weixin/voice-synthesis.service.ts` + `voice-reply.service.ts` | 透传 userId |
| `app-llm-engine.ts` / `create-app.ts` | 装配 EcpTokenProvider / LlmAuthResolver |
| `common/error-code.ts` | 新增 `MODEL_AUTH_ECP_UNAVAILABLE` |
| `settings/readiness.service.ts` | 注释口径同步（实现无改） |

**前端（admin）**

- `admin/src/views/model/ModelFormDialog.vue`：凭证方式单选、动态校验、availability 查询、回显/提交规则。
- `admin/src/views/model/ModelListView.vue`：`ECP` 标签。

**文档**

- `CHANGELOG.md` 顶部新增一条（用户可见变更）。
- `skills/mao-cli/` 中管理后台/模型配置相关章节（如涉及模型配置说明，同步一句"凭证方式"）。
- 本方案文档。

### 4.2 用户可见的行为变化

1. 编辑模型时多一个"凭证方式"单选；默认仍是固定 API Key，**未切换的模型行为零变化**。
2. ECP 模式模型的调用失败信息新增明确引导（需先完成 ECP 飞书登录）。
3. 模型列表多一个 `ECP` 标签。
4. 连通性测试在 ECP 模式下使用"点击测试的管理员自己"的凭证。

### 4.3 明确不受影响

- 会话/Agent 的模型选择链、压缩、审批、标题等逻辑；
- 用量与成本统计（`llm_call`）；
- agent-cli 的模型列表（CLI 侧已丢弃 apiKey）；
- 其他渠道（飞书/微信/钉钉）的消息链路（只复用同一套 LLM 出口）；
- 模型删除/停用/默认模型等既有规则。

## 五、兼容性、迁移与回滚

| 维度 | 策略 |
|---|---|
| 迁移 | flyway 启动自动执行；`ADD COLUMN ... DEFAULT 'api_key'` 对存量行零影响、可重复部署安全 |
| 旧前端 | 新版后端 + 旧版 admin：请求不带 `authType` → 按 `api_key` 处理（与现状一致）；VO 多字段被忽略 |
| 新前端 + 旧后端 | 不在支持范围（部署脚本前后端一起发布）；若发生，`authType` 字段被后端忽略，模型仍按 api_key 工作（不会 500） |
| 数据兼容 | `api_key` 列保持 `NOT NULL`，ecp 模式写空串；不存在的 `auth_type` 行由读取层兜底为 `api_key` |
| 回滚 | 回滚代码即可（列保留无害）；已配置为 ecp 的模型在旧代码下会按 api_key 走空 Key → 调用失败但可解释；建议回滚时同步把 ECP 模型切回 api_key（或接受短期不可用） |
| 灰度 | 无独立开关；先在测试环境配置一个 ECP 模型（sub2api 网关）验证，再在生产给单个模型切换 |

## 六、测试计划

**单元测试（backend-ts）**

1. `ecp-token-provider.spec.ts`：有效票返回 token；`FAILED`/过期/解密失败/无行 → null；60s 内二次读取不再查库（mock 计数）；无效结果不缓存。
2. `llm-auth.spec.ts`：`authType!=='ecp'` 返回 `config.apiKey`；ecp + 有 userId + 有票 → token；无 LlmCallContext → 抛 `MODEL_AUTH_ECP_UNAVAILABLE`；无票 → 抛错且**不使用** `config.apiKey`（用"错误 Key + ecp"断言头部仍是 token）。
3. 三个 adapter + 三个 chat client：各加一条"ecp 模式请求头使用 token"的用例（现有 `client-impersonation-headers` 测试风格）。
4. `model.service.spec.ts`：create/update 的 `authType` 归一与开关校验；`testConnectivity` 传 actorUserId 后 LlmCallContext 内可见。
5. `model.routes.spec.ts`（如无则补最小用例）：`toVO` 在 ecp 模式下 `apiKey=''`；`ecp-availability` 返回布尔。

**前端测试**

- `ModelFormDialog` 相关（若有组件测试工程）：ECP 模式下 apiKey 规则不触发必填；开关关闭时选项禁用；提交 payload 不含 apiKey。
- 手工清单：
  1. 开关关闭 → 打开编辑弹窗，ECP 选项禁用并有提示；
  2. 开关打开 → 可选中；保存后列表出现 `ECP` 标签；重开回显正确；
  3. 切回 api_key：原 Key 按决策 D-2 仍保留在库中、可直接继续使用；
  4. 复制模型：`authType` 一并复制。

**端到端（关键验收）**

1. 在测试环境配置 `https://sub2api.acg.team/v1` + `openai-responses` + 客户端标识 `Codex` + 凭证方式 ECP；
2. 用**已完成 ECP 飞书登录**的用户开会话 → 正常回复（服务端日志 `mode=ecp hit=db|cache`；网关侧应看到该用户 token 的调用）；
3. 用**未登录 ECP** 的用户/会话 → 报错文案正确，且网关无任何调用记录（证明未回退 Key）；
4. 管理员点"测试"：自己已登录 ECP → 成功；未登录 → 明确错误；
5. 回归：任一 `api_key` 模型对话、测试、图片生成、语音合成全部正常；
6. 续期验证：把 `expires_at` 改到 30 分钟内，等待 scheduler 续期后再次调用成功。

## 七、发布与工作量

**发布**：按本仓库既有流程（工作区改 → push `origin/main` → `/data && bash deploy-mao.sh`，前后端一起构建、后端蓝绿重启）。迁移随启动自动执行。

**工作量估算（不含评审/联调等待）**

| 项 | 估时 |
|---|---|
| 迁移 + 契约 + 实体/VO/配置对象 | 0.3 人日 |
| `ecp-token-provider` + `llm-auth` + 单测 | 0.5 人日 |
| 7 个出口改造 + 装配 + 单测 | 0.7 人日 |
| 两处 userId 缺口（测试/语音） | 0.2 人日 |
| 管理端表单 + 列表 + 测试 | 0.5 人日 |
| 联调与验收（sub2api 实测、无票路径） | 0.3 人日 |
| **合计** | **约 2.5 人日** |

## 八、风险与决策结论

### 8.1 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | ECP Token 只适用于"接受 ECP 凭证的内部网关" | 配到官方公有 API（如 api.openai.com）会必然失败 | 表单文案明确适用范围（内部网关）；管理员配置时自行判断 |
| R2 | 用户未完成 ECP 飞书登录 → 任务失败 | 体验割裂（先报错才去登录） | 错误文案直接给登录入口指引；后续可做"会话前置检查"（见 D-6） |
| R3 | ECP 票续期失败（`renewStatus=FAILED`） | 该用户所有 ecp 模型不可用，直到重新登录 | 复用现有续期告警/日志；错误文案含"请重新完成 ECP 飞书登录" |
| R4 | 群聊/多用户会话中"发言者"切换 | 每次调用用当前发言者的票（语义正确，但成本归属会随发言者变化） | 文案说明；必要时后续加"固定为会话归属者"的模型级选项 |
| R5 | 后台任务（定时任务/信号哨兵）使用 owner 的票 | owner 票失效 → 任务失败 | 错误可读；owner 重新登录后自愈 |
| R6 | 60s 缓存导致票吊销延迟 | 最长 60s 内仍可用 | 可接受；如需更严格可设 10s 或关闭缓存 |
| R7 | 语音/图片等后台场景无用户上下文 | 无法使用 ecp 模型 | 明确策略：语音传入绑定用户；图片走 agent 上下文；其他后台场景若缺身份则报错 |

### 8.2 已确认决策（2026-11-19 确认，全部按建议执行）

| 编号 | 决策项 | 确认结论 |
|---|---|---|
| D-1 | 字段命名 | `authType`（值 `api_key` / `ecp`），与 `apiProtocol` / `clientImpersonation` 同语感 |
| D-2 | 切到 ecp 时旧 apiKey 是否清空 | **保留不清空**（切回免重填；运行时严格按类型分流） |
| D-3 | ECP 开关关闭后，ecp 模型调用是否回退 apiKey | **不回退**，直接报错 |
| D-4 | 连通性测试用什么身份 | 发起测试的管理员本人 |
| D-5 | 语音/图片是否支持 ecp 模型 | 语音传入绑定用户；图片走 agent 上下文；均无身份时报错/跳过 |
| D-6 | 「会话开始前检查当前用户 ECP 票可用」的主动提示 | **二期做**（本期不做，避免首轮必败体验留给后续优化） |

## 九、结论

**可行。** 核心能力（ECP 票据存储/解密/续期、调用上下文的 userId）在现有代码中已具备，改造集中在"模型配置增加一个维度 + 7 个出口换凭证来源"，存量行为默认不变，风险可控。决策项 D-1~D-6 已于 2026-11-19 全部确认（见 §8.2），本方案据此进入待开发状态（本期不含实现）。主要注意点：

1. ECP 凭证只适用于接受 ECP Bearer 的内部网关，不是通用替代品；
2. 绝不能静默回退到固定 Key（本方案的硬规则）；
3. 用户未完成 ECP 登录时的错误引导是体验关键；
4. 需要补齐 2 处缺失的 userId 上下文（管理端测试、微信语音）。

## 十、实施修订（2026-11-19）

实现与代码评审期间发现的差异，已按下列修订落地（代码以实际提交为准）：

1. **出口清单修正**：§2.2 的 7 个出口之外，`feishu/group-context-summarizer.ts`（飞书群摘要）与 `file/git-commit-message.service.ts`（提交信息）各自字面量构造模型配置，实现时已补齐 `authType` 透传（`LlmModelRef` 与本地接口同步扩字段）；否则这两条链路会在 ecp 模型上静默回退到旧固定 Key，违反 D-3。
2. **图片工具改为显式传入 userId**：`generate_image` / `edit_image` 的工具执行不在 `LlmCallContext` 作用域内（agent-loop 的 ALS 只包住 LLM 流式调用本身），因此 `LlmAuthResolver.resolveApiKey` 增加可选第二参 `explicitUserId`，两个图片工具传入自身入参 userId（这是 D-5「图片走 agent 上下文」的实际落地方式）。
3. **创建接口空值护栏（api_key NOT NULL 闭环）**：ecp 创建请求可省略 `apiKey`——路由层 `?? ''` + 服务层 `?? ''` 双重兜底，前端创建时显式提交空串（编辑仍「留空=不修改」）。
4. **开关关闭后的编辑放行**：`updateModel` 仅在「从非 ecp 切到 ecp」时校验开关；开关关闭后仍允许编辑已是 ecp 模型的其它字段，或切回 `api_key`（前端提示同步）。
5. **`stream()` 凭证解析失败的传播保持 adapter 既有错误契约**（统一经 `callback.onError` 传出，不额外 `throw`）：agent-loop 与 compaction 两个消费者均在 `onError` 内 rethrow 使异常继续传播；重试循环内的同类早退也走回调。若追加 `throw` 会与「adapter 错误一律经回调」的契约不一致，故不采纳该建议。
6. **图片产物 URL 下载**：ecp 模式下，同源的图片结果下载会携带用户 ECP token（跨源不带，`isSameOrigin` 门控）。语义上该 token 流向的是生成图片的同一网关，判定为可接受；如后续出现第三方托管图片域，需要重新评估。


