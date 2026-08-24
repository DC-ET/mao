# 模型客户端标识（Client Impersonation）配置化 — 技术方案

> 状态：已评审，待实施
> 日期：2026-08-24
> 范围：backend-ts + admin + shared/contracts；不涉及 desktop / android / agent-cli

## 一、需求背景

调用部分上游模型时，需要在 HTTP 请求中携带特定客户端的伪装请求头才能正常访问（如 Codex CLI、Claude Code CLI 的特征头）。当前实现是在两处调用出口根据 **模型 ID 名称硬编码判断**：

- `backend-ts/src/harness/llm/openai-llm-adapter.ts`（主引擎 AgentLoop 等 harness 链路的 LLM 出口）：`modelId` 以 `gpt` 开头注入 Codex 三件套，包含 `claude` 注入 Claude Code 四件套；
- `backend-ts/src/model/llm-chat.client.ts`（管理后台连通性测试等走 `OpenAiChatClient` 的链路）：同样的名称判断逻辑重复一份。

问题：注入行为完全由模型名隐式决定，无法人工控制。例如名为 `my-gpt-proxy` 的自建网关模型会被误判注入；反之改名后的官方模型可能漏注入。

## 二、需求描述

将「注入哪种客户端请求头」做成**基础模型的显式配置项**：

1. 管理后台添加/编辑基础模型时，增加单选项「客户端标识」，三个选项：**Codex / Claude Code / None**，默认 **None**。
2. 所有触发模型调用的出口（harness 主引擎、会话标题、Git 提交信息、微信语音合成、连通性测试等）统一按此配置决定注入哪一套请求头。
3. **彻底删除**现有的按模型名称判断的逻辑，不做任何兜底回落。

### 明确要做

| # | 事项 |
|---|------|
| 1 | `llm_model` 表新增 `client_impersonation` 列（varchar，默认 `'none'`） |
| 2 | 存量数据迁移脚本将该列统一置为 `'none'`（即列默认值，不做按名称回填） |
| 3 | 后端创建/更新模型接口接收并严格校验该字段，非法值返回 `PARAM_INVALID` |
| 4 | 新建共享的请求头注入 helper，`OpenAiLlmAdapter` 与 `OpenAiChatClient` 两处统一调用 |
| 5 | 删除上述两处文件中的名称判断代码块 |
| 6 | 全部 LlmModelConfig 构造点透传新字段（共 4 处转换点，见详细设计） |
| 7 | 管理后台模型表单弹窗增加「客户端标识」单选组（文本/语音/文生图三种类型均显示） |
| 8 | 更新受影响的现有单测，新增配置驱动注入的断言用例 |
| 9 | 根 CHANGELOG.md 记录本次用户可见变更 |

### 明确不做

| # | 事项 |
|---|------|
| 1 | 不做存量数据按旧规则（gpt/claude 关键字）自动回填 |
| 2 | 不在模型列表页新增列展示该字段 |
| 3 | 不支持自定义任意 header 键值对，只有三个固定档位 |
| 4 | 不做按 provider（供应商）自动推断 |
| 5 | 不保留名称判断作为兜底逻辑 |
| 6 | 不改 desktop / android / agent-cli / mao-cli 任何代码 |
| 7 | 不做 LOCAL 模式适配 |

### 决策共识记录

| 决策点 | 结论 |
|--------|------|
| 存量迁移 | 全部置 `none`（接受升级后存量 gpt/claude 模型不再注入头部的行为变化） |
| 适用模型类型 | text / audio / image 三类表单均显示 |
| 连通性测试链路 | 与主链路一并切换为按配置注入 |
| 存储形式 | varchar 字符串，非数字编码 |
| 字段命名 | 列 `client_impersonation`，TS 字段 `clientImpersonation` |
| 枚举字面量 | `'none'` / `'codex'` / `'claude_code'` |
| 后端校验 | 严格白名单校验，非法值 `PARAM_INVALID` |
| 旧逻辑处置 | 两处名称判断彻底删除 |

## 三、技术选型

- **存储**：MySQL 8 + Flyway 版本化迁移（项目既有机制，`backend-ts/db/migration/V081__*.sql`）。取值固定且低基数，varchar(20) 足够，语义自解释、调试直观，与现有 `model_type`（`'text'/'audio'/'image'`）字符串列风格一致。
- **类型契约**：沿用共享包 `@mao/contracts`（前后端单一事实源），新增字符串字面量联合类型 `ClientImpersonation = 'none' | 'codex' | 'claude_code'`。契约包约定允许纯类型导出。
- **注入实现**：Node 原生 http(s) 模块与 fetch 各自在发请求前组装 headers 对象，抽出一个纯函数 helper 供两条链路复用，不引入新依赖。
- **UI**：Element Plus `el-radio-group`，与同表单已有的「模型类型」单选交互保持一致。

## 四、详细设计

### 4.1 数据库（V081）

`backend-ts/db/migration/V081__add_llm_model_client_impersonation.sql`：

```sql
ALTER TABLE `llm_model`
    ADD COLUMN `client_impersonation` VARCHAR(20) NOT NULL DEFAULT 'none'
        COMMENT '客户端标识：none=不注入，codex=Codex CLI 头，claude_code=Claude Code CLI 头';
```

存量行由 `DEFAULT 'none'` 自动填充，无需 UPDATE 语句（对应「全部置为 none」的决策）。

### 4.2 共享契约（shared/contracts）

`src/model.ts` 与 `src/model.d.ts` 同步修改（该包 ts/d.ts 双轨维护）：

```ts
export type ClientImpersonation = 'none' | 'codex' | 'claude_code';

export interface ModelVO {
  // ...existing
  clientImpersonation?: ClientImpersonation;
}
```

`src/index.ts` 导出 `ClientImpersonation` 类型。

### 4.3 后端 — model 域

**`backend-ts/src/model/types.ts`**
- `LlmModel` 增加 `clientImpersonation?: string | null;`（SELECT * 自动带回新列）；
- `LlmModelConfig`（model 域自有版本）增加 `clientImpersonation?: ClientImpersonation;`；
- re-export `ClientImpersonation` 类型。

**`backend-ts/src/model/model.repository.ts`**
- `insert()` 与 `updateById()` 的字段映射对象各增加 `clientImpersonation: model.clientImpersonation ?? 'none'` / `model.clientImpersonation`。

**`backend-ts/src/model/model.service.ts`**
- 文件顶部定义合法值集合：`const CLIENT_IMPERSONATION_VALUES = ['none', 'codex', 'claude_code'] as const;`
- `createModel(...)` 增加 `clientImpersonation` 参数：缺省视为 `'none'`；非空但不在集合内时抛 `BusinessException(ErrorCode.PARAM_INVALID)`（错误信息注明合法取值），风格与现有 `updateStatus` 的 status ∈ {0,1} 校验一致；
- `updateModel(...)` 同样增加参数与校验，`null/undefined` 表示不修改（与现有「留空则不改」惯例一致）；
- `testConnectivity()` 内联构造 `LlmModelConfig` 处补上 `clientImpersonation: model.clientImpersonation as ClientImpersonation`。

**`backend-ts/src/model/model.routes.ts`**
- `CreateModelRequest` 增加 `clientImpersonation?: string;`
- POST `/v1/models`、PUT `/v1/models/:id` 将 `body.clientImpersonation` 传入 service；
- `toVO()` 输出 `clientImpersonation` 字段。

### 4.4 后端 — 请求头注入 helper（新文件）

`backend-ts/src/harness/llm/client-impersonation-headers.ts`：

```ts
import type { ClientImpersonation } from '@mao/contracts';

/** 按客户端标识向请求头注入对应的 CLI 伪装头。profile 为 none/空时不做任何事。 */
export function applyClientImpersonationHeaders(
  headers: Record<string, string>,
  profile: ClientImpersonation | null | undefined,
): void {
  if (profile === 'codex') {
    headers['User-Agent'] = 'codex_cli_rs/0.146.0 (Linux 6.1.0; x86_64) xterm-256color';
    headers.originator = 'codex_cli_rs';
    headers['x-codex-window-id'] = '019e9e6a-e81e-7442-bac0-d3bc42cc1b45';
  } else if (profile === 'claude_code') {
    headers['User-Agent'] = 'claude-cli/999.0.0-restored (external, cli)';
    headers['x-app'] = 'cli';
    headers['X-Claude-Code-Session-Id'] = randomUUID();
    headers['x-client-request-id'] = randomUUID();
  }
}
```

头部内容与现有值逐字节一致（codex 的 window-id 保持固定值，claude 的两个 UUID 每次随机生成）。

### 4.5 后端 — 两处调用出口替换

1. **`backend-ts/src/harness/llm/openai-llm-adapter.ts`** `awaitResponse()`：删除两个 `if (config.modelId...)` 代码块，改为 `applyClientImpersonationHeaders(headers, config.clientImpersonation);`
2. **`backend-ts/src/model/llm-chat.client.ts`** `chat()`：同样删除两个 if 块，改为调用 helper（`config.clientImpersonation` 来自 model 域的 `LlmModelConfig`）。

同时 `backend-ts/src/harness/llm/chat-request.ts` 的 `LlmModelConfig`（harness 版本）增加 `clientImpersonation?: ClientImpersonation;`。

### 4.6 后端 — 配置透传链路

所有构造 `LlmModelConfig` 的位置必须携带新字段，逐一盘点如下（全量，共 5 处）：

| # | 位置 | 改法 |
|---|------|------|
| 1 | `backend-ts/src/harness/deps.ts` `llmModelToConfig()` | 入参类型 `LlmModelRef` 加字段后透传 |
| 2 | `backend-ts/src/session/types.ts` `LlmModelRef` | 接口增加 `clientImpersonation?: string \| null;`（实现方是 `MysqlLlmModelRepository.selectById/selectDefault`，SELECT * 已天然带回） |
| 3 | `backend-ts/src/file/git-commit-message.service.ts` `toConfig()` 及其本地 `LlmModelConfig` 定义 | 加字段透传 |
| 4 | `backend-ts/src/weixin/voice-synthesis.service.ts` 内联 config | 加字段透传 |
| 5 | `backend-ts/src/model/model.service.ts` `testConnectivity()` 内联 config | 见 4.3 |

harness 主引擎（AgentLoop/CompactionService/DangerAssessor）、会话标题生成等均经由 `context.modelConfig = llmModelToConfig(llmModel)`（`core/harness-service.ts:293`）获得配置，改完 #1 即全覆盖，无需单独处理。

### 4.7 管理后台

`admin/src/views/model/ModelFormDialog.vue`：

- 表单「模型标识」项之后新增：

```vue
<el-form-item label="客户端标识">
  <el-radio-group v-model="form.clientImpersonation">
    <el-radio value="none">None</el-radio>
    <el-radio value="codex">Codex</el-radio>
    <el-radio value="claude_code">Claude Code</el-radio>
  </el-radio-group>
  <span style="margin-left: 8px; color: #909399; font-size: 12px;">调用该模型时模拟的客户端请求头</span>
</el-form-item>
```

- `form` 初始值与 `resetForm()` 增加 `clientImpersonation: 'none'`；
- 回显分支增加 `clientImpersonation: props.modelData.clientImpersonation || 'none'`；
- 提交 payload 自然带上（`{ ...form }` 已覆盖）；
- 该控件对三种 modelType 均显示（不加 `v-if="isTextType"`）。

列表页 `ModelListView.vue` 不改。

### 4.8 单元测试

| 文件 | 改动 |
|------|------|
| `backend-ts/src/harness/llm/openai-llm-adapter.spec.ts` | 新增：`clientImpersonation='codex'/'claude_code'/'none'/undefined` 四种情况下通过本地 test server 断言实际收到的请求头（User-Agent、originator、x-codex-window-id / x-app、X-Claude-Code-Session-Id、x-client-request-id / 无伪装头） |
| `backend-ts/src/model/llm-chat.client.spec.ts` | 现有两条按名称断言的用例（第 16 行 codex、34 行 claude）改为按 `config.clientImpersonation` 断言；新增 `none` 不注入的用例 |
| `backend-ts/src/model/model.service.spec.ts` | 新增：create 传非法值抛 PARAM_INVALID；create 缺省落 `'none'`；update 合法值生效、null 不修改 |

## 五、实现步骤（顺序执行）

1. 写 Flyway 迁移 `V081__add_llm_model_client_impersonation.sql`。
2. 更新 `shared/contracts`（model.ts / model.d.ts / index.ts）：`ClientImpersonation` 类型 + `ModelVO.clientImpersonation`。
3. 后端 model 域：types → repository → service（含校验）→ routes。
4. 新建 `client-impersonation-headers.ts` helper；替换 `openai-llm-adapter.ts` 与 `llm-chat.client.ts` 两处逻辑并删除名称判断；`chat-request.ts` 的 harness 版 `LlmModelConfig` 加字段。
5. 透传链路：`LlmModelRef`（session/types.ts）→ `llmModelToConfig`（harness/deps.ts）→ git-commit-message `toConfig` → voice-synthesis 内联 config。
6. admin 表单弹窗改造。
7. 单测更新与新增。
8. 根 `CHANGELOG.md` 顶部新增 `## 0.0.53 (2026-08-24)`，「后端」「管理后台」小节分别记录。
9. 验证：`cd backend-ts && npm run build && npm test`；`cd admin && npm run build`（vue-tsc 严格检查）。

## 六、落地清单

- [ ] `backend-ts/db/migration/V081__add_llm_model_client_impersonation.sql`（新增）
- [ ] `shared/contracts/src/model.ts` / `model.d.ts`（新增类型与 VO 字段）
- [ ] `shared/contracts/src/index.ts`（导出类型）
- [ ] `backend-ts/src/model/types.ts`
- [ ] `backend-ts/src/model/model.repository.ts`
- [ ] `backend-ts/src/model/model.service.ts`
- [ ] `backend-ts/src/model/model.routes.ts`
- [ ] `backend-ts/src/harness/llm/client-impersonation-headers.ts`（新增）
- [ ] `backend-ts/src/harness/llm/chat-request.ts`
- [ ] `backend-ts/src/harness/llm/openai-llm-adapter.ts`
- [ ] `backend-ts/src/model/llm-chat.client.ts`
- [ ] `backend-ts/src/session/types.ts`（LlmModelRef）
- [ ] `backend-ts/src/harness/deps.ts`（llmModelToConfig）
- [ ] `backend-ts/src/file/git-commit-message.service.ts`
- [ ] `backend-ts/src/weixin/voice-synthesis.service.ts`
- [ ] `admin/src/views/model/ModelFormDialog.vue`
- [ ] `backend-ts/src/harness/llm/openai-llm-adapter.spec.ts`
- [ ] `backend-ts/src/model/llm-chat.client.spec.ts`
- [ ] `backend-ts/src/model/model.service.spec.ts`
- [ ] `CHANGELOG.md`

## 七、影响与风险

1. **存量 gpt/claude 模型升级后不再注入伪装头**（决策：全部置 none）。若这些模型的上游依赖伪装头放行，将在升级后出现 403/风控失败。恢复方式：管理员到后台编辑对应模型，将客户端标识改为 Codex 或 Claude Code。此变化属预期行为，随 CHANGELOG 发布说明告知。
2. 头部字面量为既有生产验证值，逐字节保持不变，不引入新的兼容性风险。
3. Flyway 迁移为纯 ADD COLUMN 带默认值，锁表时间可忽略（`llm_model` 为小表）。
