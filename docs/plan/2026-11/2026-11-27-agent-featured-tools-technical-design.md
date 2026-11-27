# Agent「特色工具」配置（文生图 / TTS）技术方案

- 状态：已定稿（暂不开发）
- 日期：2026-11-27
- 评审：2026-11-27 确认三条口径——①存量 Agent 回填 `image_generation`；②「图片生成」一个开关同时管 `generate_image` / `edit_image`；③TTS 参考文生图只返回文件，由模型按需调用 `send_file` 交付。
- 二轮评审：2026-11-27 需求与技术方案可行、无阻塞项；实现前修正项与残余风险见 §13。
- 一句话：给 Agent 增加 `featured_tools` 配置，管理后台用多选「图片生成 / 语音合成」控制；`HarnessService.buildContext()` 在会话工具出口按「Agent 配置 + 模型可用性」注入 `generate_image`、`edit_image` 与新增的 `text_to_speech`；未启用或无可用模型时不向模型暴露任何相关工具或引导文案。
- 关联代码（撰写时已核实，均为当前工作区 `main`）：
  - 工具注册：`backend-ts/src/harness/tool/tool-registry.ts:163`（`createDefaultToolRegistry`，进程级单例）、`:194-195`（图片工具构造）、`:277-308`（`getTool` / `getAllTools` / `getToolsByNames`）
  - 会话工具出口：`backend-ts/src/harness/core/harness-service.ts:337`（`buildContext`）、`:345`（读取 Agent）、`:448`（工具初筛）、`:459-461`（MCP / HTTP 入口先剥）、`:523-541`（HTTP 工具按 Agent 回推）、`:542`（`context.tools` 唯一赋值点）
  - LLM 工具 schema：`backend-ts/src/harness/core/prompt-engine.ts:790-800`（`buildToolDefinitions`）；`backend-ts/src/harness/core/agent-loop.ts:856-860`（`isToolAllowed` 以 `context.tools` 为唯一硬门）
  - 图片工具：`backend-ts/src/harness/tool/impl/generate-image-tool.ts:87-122`（落盘 + URL）、`:124-135`（构造依赖）；`edit-image-tool.ts:70-84`
  - 模型：`backend-ts/src/model/model.service.ts:261-267`（`findFirstActiveAudioModel` / `findFirstActiveImageModel`）、`backend-ts/src/model/model.repository.ts:74-79`（`findFirstActiveByType`）
  - TTS 参考链路：`backend-ts/src/weixin/voice-synthesis.service.ts:47-96`（`llmAdapter.chat({ audio: { format: 'wav' } })`）、`backend-ts/src/harness/llm/chat-request.ts:75-87,107-117`（`ChatRequest.audio` / `message.audio`）、`backend-ts/src/usage/llm-call-context.ts:12-26`（`VOICE_SYNTHESIS`）
  - Agent 配置：`backend-ts/src/agent/types.ts:3-33`、`agent.repository.ts:83-145`、`agent.service.ts:75-213`、`agent.routes.ts:154-222,346-410`；`shared/contracts/src/agent.ts:20-52`
  - 管理后台：`admin/src/views/agent/AgentFormDialog.vue:81-102`（HTTP 工具多选范式）、`:718-760`（`loadOptions`）、`:832-856`（提交 payload）；`AgentListView.vue:100-110,370-381`
  - 工具展示：`backend-ts/src/session/util/tool-result-summarizer.ts:99-200,466-494`；`desktop/src/utils/toolDisplay.ts:9-65,79-239`；`desktop/src/utils/toolIcons.ts:25-57`；`admin/src/views/session/utils/toolDisplay.ts:3-40,104-126`；`sdk/embed/src/ui/toolDisplay.ts:29-37,134-155`；`sdk/embed/src/ui/icons.ts:57-72`
  - 无进展检测：`backend-ts/src/harness/core/no-progress-notice.ts:55-64,101-107`
- 关联方案：[图片调用流水](./2026-11-24-image-call-flow-technical-design.md)、[统一发送图片/文件](./2026-11-18-unified-send-media-technical-design.md)、[群聊运行身份](./2026-11-04-group-chat-runtime-identity-technical-design.md)。

## 0. 结论（TL;DR）

1. **不建新表**：`agent` 表新增一列 `featured_tools`（JSON 数组字符串），取值 `image_generation` / `text_to_speech`。语义与 `http_tool_ids`、`skill_names` 一致：`NULL` / `[]` = 未启用。
2. **一个「图片生成」开关同时控制 `generate_image` 与 `edit_image`**：两者共用同一个 `model_type=image` 模型，拆开只会制造「文生图关了、改图还在」的半可用状态。
3. **注入点选在 `HarnessService.buildContext()`**：这是 WS / 桌面 / 微信 / 飞书 / 钉钉 / 定时任务 / OpenAPI / 子 Agent 的唯一会话工具出口，天然拿得到 `agent`；不改全局 `ToolRegistry`，也不改 `ToolDispatcher` 的执行/校验逻辑（仅新增 TTS 的工具名归类）。
4. **运行时双重门**：`agent.featured_tools` 决定「想不想要」，`llm_model` 是否存在启用的对应类型模型决定「能不能用」；两者同时满足才把工具名留在 `context.tools`。模型停用 / 删除后，下一次执行自动隐藏（fail-closed）。
5. **新增 `text_to_speech` 内置工具**：复用 `findFirstActiveAudioModel()` + `LlmAdapter.chat({ audio: { format: 'wav' } })` + `LlmCallContext(VOICE_SYNTHESIS)`，产物落 `uploads/{userId}/tts-{uuid}.wav`，返回 `audio_url` / `audio_path`；不自动发消息，使用指南提示模型按需调用 `send_file`（与 `generate_image → send_image` 同范式）。
6. **存量 Agent 迁移回填 `["image_generation"]`**，保持现网出图能力；新建 Agent 默认两项都不开。TTS 是纯新增，默认关闭。

## 1. 现状与问题

### 1.1 内置工具全量注册，没有 Agent 级开关

`createDefaultToolRegistry()` 在进程启动时把所有内置工具（含 `generate_image`、`edit_image`）一次性注册进单例 `ToolRegistry`（`tool-registry.ts:163-284`）。会话侧只做三件事：

- 按渠道剔除别家通道工具（`harness-service.ts:448` → `filterToolsForSession:725-739`）；
- 按 embed 会话剔除页面工具（`:455-457` → `filterPageTools:748-752`）；
- 按 MCP 模式 / 自定义 HTTP 工具做「先剥后推」（`:459-461`、`:523-541`）。

没有任何内置工具级的 allow/deny；`V024__drop_tool_tables.sql` 的注释就是「All agents automatically have access to all built-in tools」。结果是：**只要模型配置里存在 `model_type=image` 的启用行，所有 Agent 都能出图**；反过来，如果模型被停用，工具仍然出现在工具列表里，直到模型调用时才报「没有可用的文生图模型」。

### 1.2 管理后台已经能配「语音模型」，但 Agent 没有 TTS 工具

- 管理后台模型管理有「文本模型 / 语音模型 / 文生图」三个 tab（`admin/src/views/model/ModelListView.vue:14-18`），`model_type=audio` 的模型可用于连通性试听（`model.service.ts:506-557`）。
- 生产里唯一消费 `audio` 模型的地方是微信语音回复：`WeixinVoiceSynthesisService.synthesizeWav()` 取 `findFirstActiveAudioModel()`，把回复文本合成 WAV，再转 MP3 发到微信（`weixin/voice-synthesis.service.ts:47-96`、`voice-reply.service.ts:20-46`）。
- **Agent 侧没有 `text_to_speech` / `generate_audio` 之类的内置工具**。会话里的模型即便被要求「把这段读出来」，也只能输出文字或自己写脚本调外部 TTS，用不到管理后台配好的语音模型。

### 1.3 文生图工具始终暴露，配置与运行状态脱节

`generate_image` / `edit_image` 在工具清单里常驻，但模型是否可用要到执行时才知道：

- `findFirstActiveImageModel()` 只查 `status=1 AND model_type='image' AND deleted=0 ORDER BY id ASC LIMIT 1`（`model.repository.ts:74-79`）。
- 无模型时工具返回 `没有可用的文生图模型，请先在管理后台配置 model_type=image 的模型`（`generate-image-tool.ts:228`）。
- 管理后台 Agent 表单看不到「这个 Agent 到底有没有出图能力」，只能靠实际对话试。

### 1.4 语音模型的协议陷阱

`ChatRequest.audio` 只有 OpenAI 兼容适配器会序列化（`harness/llm/json.ts:103`）；Anthropic / Responses 适配器的 body 构造没有 `audio`（`anthropic-llm-adapter.ts:615-630`、`responses-llm-adapter.ts:857-890`）。因此 `apiProtocol=anthropic` 或 `openai-responses` 的 audio 模型会「调用成功但没有音频」，微信语音当前也是静默失败。可用性判断必须排除这类配置。

### 1.5 工具展示与无进展检测的强制同步面

按 `AGENTS.md`，新增内置工具必须同步结果摘要、桌面/后台/嵌入端名称与参数预览、无进展归一化，并补成功/失败/缺参回归。否则工具卡片会显示英文原始名，或者每轮相同结果都被判为「有进展」。

## 2. 目标与非目标

### 2.1 目标

1. Agent 新增「特色工具」配置，管理后台可多选「图片生成」「语音合成」，也可全不选。
2. 会话执行时按 Agent 配置注入：`image_generation` → `generate_image` + `edit_image`；`text_to_speech` → `text_to_speech`。
3. 对应模型不可用时**不暴露工具**，而不是暴露后调用报错；模型恢复后下一次执行自动恢复。
4. 新增 `text_to_speech` 内置工具：文本进、WAV 文件出，产物按用户隔离落 `uploads/{userId}`，返回可访问 URL 与本地路径。
5. TTS 调用进入 `llm_call` 调用流水（`scene=voice_synthesis`），归因 user / session / agent。
6. 管理后台表单显示两类模型的可用性；不可用时禁用未勾选项并给出「先去模型管理启用」的提示，已勾选但失效的项保留并提示。
7. 工具展示、结果摘要、无进展归一化、测试全部按既有规范补齐。

### 2.2 非目标

- 不做 per-Agent 模型绑定（不选「用哪个 image/audio 模型」，仍沿用「id 最小的启用行」）；也不做多模型优先级。
- 不做 TTS 的 voice / speed / 采样率 / MP3 参数；v1 固定请求 WAV，格式以上游返回为准。
- 不做 TTS 自动投递：工具只产出文件，是否发到当前会话由模型调用 `send_file` 决定（已确认，本期不提供 `deliver` 参数）。
- 不把 TTS 产物转成微信/钉钉的「语音消息」气泡：`send_file` 按文件发送；微信语音回复仍走既有 `voice_reply` + `voice_synthesis` 链路。
- 不做音频/图片 token 计价；音频模型价格列当前被强制置空，TTS 行大概率 `cost_micros=NULL`，与现状一致。
- 不把 MCP 工具、自定义 HTTP 工具、技能纳入「特色工具」；它们已有各自开关。
- 不做角色级（role）或用户级工具授权；只做 Agent 级。
- 不新增桌面端「Agent 能力」展示页；桌面只同步工具卡片展示。
- 不改微信语音回复的产品行为（仍按用户偏好触发）；仅把音频模型查询的协议过滤修掉（§5.3）。

## 3. 决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 配置落点 | `agent.featured_tools` 新列，JSON 数组字符串 | 显式列可被管理端契约、路由校验、VO 序列化完整覆盖；不复用 `config_json`，避免压缩配置的读改写互相覆盖；不建关联表，当前只有 2 个固定能力，表开销与联表不划算 |
| D2 | 取值 | `image_generation` / `text_to_speech`；`image_generation` 与既有 LLM 场景同名，`text_to_speech` 是工具名（调用流水仍复用 `voice_synthesis` 场景，见 D10） | 运维、调用流水、管理后台看到的是同一套词；契约用联合类型 `AgentFeaturedTool` 落 `@mao/contracts`，前端汉化表用 `Record` 吃穷尽 |
| D3 | 图片粒度 | 一个 `image_generation` 同时管 `generate_image` + `edit_image`（已确认） | 两者共用同一个 image 模型与同一套 API 配置；拆开会出现「能文生图不能改图」的伪配置 |
| D4 | 注入点 | `HarnessService.buildContext()`，在渠道/页面过滤之后、`context.tools = sessionTools` 之前 | 所有入口（WS / 渠道 / 定时 / OpenAPI / 子 Agent）都收敛到这里；`agent` 已加载；不改全局 registry、不改 dispatcher、不引入 per-Agent registry |
| D5 | 可用性口径 | 只要求「存在启用的对应类型模型」；音频额外要求 `api_protocol` 为空或 `openai-compatible` | 与现有图片工具口径一致（不校验 baseUrl/key，配置错误由工具报明确错误）；音频协议必须卡死，否则会「调用成功但无音频」 |
| D6 | 保存时是否硬校验模型 | 不硬校验 | 模型启停是运行态，不是引用完整性；硬校验会让「模型临时停用」阻塞 Agent 改名等无关编辑。管理端置灰 + 运行时 fail-closed 已足够 |
| D7 | 存量默认 | 迁移回填 `["image_generation"]`；新建 Agent 默认 `[]`（关闭）（已确认） | 现网所有 Agent 都能出图，升级即失去能力会造成用户侧回退；TTS 是新增能力，默认关闭 |
| D8 | TTS 工具形态 | 名称 `text_to_speech`，入参只有 `text`，固定请求 WAV，单次最多 2000 字 | 与 `generate_image` 的「一个工具一件事」一致；2000 字约数分钟音频，避免一次工具调用长时间阻塞与超大文件；超长让模型分段 |
| D9 | TTS 交付 | 返回 `audio_url/audio_path`，不自动发消息；description 提示需要交付时调用 `send_file`（已确认） | 与 `generate_image → send_image` 完全同范式；避免把微信/飞书/钉钉发送策略耦合进 TTS 工具 |
| D10 | TTS 记账 | 复用 `LLM_CALL_SCENES.VOICE_SYNTHESIS`，显式 `LlmCallContext.runAsync({ userId, sessionId, agentId })` | `LlmAdapter` 走 `RecordingLlmAdapter` 自动落 `llm_call`；不新增场景，避免三端枚举 / 汉化表 / 测试数组同步。来源区分由 `session_id` 是否为空即可完成 |
| D11 | TTS 执行归属 | `SERVER_ONLY_TOOLS` + `RUNTIME_SCOPED_TOOLS` | 模型凭证与 uploadDir 都在服务端；LOCAL 会话必须由服务端执行；产物按运行身份写入 `uploads/{runtimeUserId}` |
| D12 | 子 Agent | 继承父会话的 Agent 配置与工具集 | 子会话 `agentId` 继承父会话（`subagent-invocation.service.ts:36-56`），`buildSubContext` 先 `buildContext(childSession)` 再二次过滤（`background-subagent-manager.ts:1042-1053`），因此读到同一 Agent 的特色工具配置；不额外禁用 TTS/出图，保持与图片工具现状一致。注意子 Agent 排除 `send_file`，TTS 交付路径见 §5.6 |
| D13 | 生效时机 | 下一次执行生效 | `buildContext` 每次执行重跑；运行中的一轮不会热改工具集，与 HTTP 工具 / MCP 的既有口径一致 |
| D14 | 工具顺序 | 原地过滤，不「先剥后推」 | 保持 registry 注册顺序，减少同一会话工具列表的字节变化；工具集只在配置或模型可用性变化时改变，尽量不打断 prompt 前缀缓存 |
| D15 | 可用性查询失败 | 该能力按不可用处理（fail-closed），仅 warn，不阻断会话 | 工具不可用比「暴露了但必然报错」体验更好；会话本身不应因模型查询失败起不来 |
| D16 | 可用性接口 | 新增 `GET /v1/models/availability`，返回 image/audio 的布尔 + 模型名 | 现有 `/v1/models/active` 只返回 text（`model.service.ts:257-259`）；复用分页列表接口既拿不到稳定语义，也要暴露不必要字段 |

## 4. 数据模型与契约

### 4.1 迁移

新增 `backend-ts/db/migration/V213__agent_featured_tools.sql`（当前最大版本 `V212`）：

```sql
ALTER TABLE `agent`
    ADD COLUMN `featured_tools` VARCHAR(512) NULL
    COMMENT '特色工具（JSON 数组）：image_generation/text_to_speech；NULL/[]=未启用'
    AFTER `git_allowed_domains`;

-- 存量 Agent 保留现有出图能力；TTS 为新增能力，不回填。
UPDATE `agent` SET `featured_tools` = '["image_generation"]' WHERE `featured_tools` IS NULL;
```

说明：

- 用 `VARCHAR(512)` 而非 `JSON`：现有 `mcp_server_ids` / `http_tool_ids` 都是 JSON 数组字符串，读写路径成熟；`skill_names` 的 JSON 列没有带来额外能力。
- 软删行也会被这条 UPDATE 覆盖，但软删 Agent 不执行，无影响。
- 不改 `V001` / 历史迁移，避免 Flyway checksum 风险。
- 回滚兼容：旧代码 `SELECT *` 读 Agent 时忽略新列，注入逻辑也不存在；列保留无副作用，不需要回滚迁移。

### 4.2 类型

`shared/contracts/src/agent.ts`：

```ts
export type AgentFeaturedTool = 'image_generation' | 'text_to_speech';

export interface AgentVO {
  // ...
  /** 特色工具（管理后台多选）；[] = 未启用 */
  featuredTools?: AgentFeaturedTool[];
}
```

`backend-ts/src/agent/types.ts`：

```ts
featuredTools?: string | null; // JSON 数组字符串

/** 路由校验 / 序列化共用；元素合法性由 satisfies 校验，联合穷尽性由下方 Exclude 断言守住。 */
export const AGENT_FEATURED_TOOLS = ['image_generation', 'text_to_speech'] as const satisfies
  readonly AgentFeaturedTool[];
type _AllFeaturedToolsCovered =
  Exclude<AgentFeaturedTool, (typeof AGENT_FEATURED_TOOLS)[number]> extends never ? true : never;
const _featuredToolsCovered: _AllFeaturedToolsCovered = true;
void _featuredToolsCovered;
```

`backend-ts/src/harness/deps.ts` 的 `Agent` 也要加同名字段——`buildContext` 用的是这个窄接口（`:52-70`），不是 `agent/types.ts` 的实体。

### 4.3 序列化语义

| 场景 | 入参 | 落库 | VO |
|---|---|---|---|
| 新建未传 | `undefined` | `NULL` | `[]` |
| 新建传空 | `[]` | `NULL` | `[]` |
| 新建传两项 | `['image_generation','text_to_speech']` | JSON 字符串 | 原样 |
| 更新未传 | `undefined` | 不修改 | — |
| 更新传 null | `null` | 不修改 | — |
| 更新传空 | `[]` | `NULL`（清空） | `[]` |
| 更新传未知值 | `['foo']` | 拒绝，`PARAM_INVALID` | — |

- 去重、保序；最多 2 项。
- `toVO` 解析失败或含未知值：过滤未知值后返回，不让脏数据打崩列表。
- 管理端表单始终提交数组，因此编辑保存不会把「未修改」误清空。

## 5. 后端

### 5.1 Agent 配置读写

按 `http_tool_ids` 的既有路径逐层补：

1. **仓储**（`agent.repository.ts`）：`insert` / `updateById` 的列白名单各加 `featuredTools`；更新用 `?? null`，让显式空数组能清空。
2. **服务**（`agent.service.ts`）：
   - `createAgent` / `updateAgent` 末尾追加 `featuredTools` 位置参数（放在 `gitAllowedDomains` 之后）。追加后 `gitAllowedDomains` 不再是最后一个参数，`agent.routes.spec.ts` 的 `.at(-1)` / `.at(-4)` / `.at(-2)` 位置断言必须同步更新；`.at(7)`（httpToolIds）不受影响。
   - `create`：`featuredTools != null && length > 0` 时 `JSON.stringify`，否则 `null`。
   - `update`：`null/undefined` 不修改；`[]` → `null`；非空 → JSON 字符串。
3. **路由**（`agent.routes.ts`）：
   - `CreateAgentRequest` / `UpdateAgentRequest` 加 `featuredTools?: AgentFeaturedTool[] | null`。
   - 新增 `normalizeFeaturedTools()`：非数组、非字符串项、未知 key → `BusinessException(PARAM_INVALID, ...)`；去重保序；空数组原样返回。
   - POST / PUT 调用服务时传入。
   - `toVO` 增加 `featuredTools` 的 `JSON.parse` + 未知值过滤（参照 `:392-399` 的 `httpToolIds`）。
4. **契约**：`AgentVO.featuredTools` 由 `toVO` 直接对应，admin 表单 payload 字段同名。

不改 `session/types.ts` 的 `AgentRef`：建会话/切 Agent 不需要校验特色工具，运行时按 `session.agentId` 读取即可。

权限与审计：Agent 创建/更新继续走 `agent:write` 与既有 Audit 拦截器；`GET /v1/models/availability` 只要求登录态，不新增权限码，也不产生审计事件。

### 5.2 注入：先剥后按配置放行

新增 `backend-ts/src/harness/tool/featured-tools.ts`：

```ts
import type { AgentFeaturedTool } from '@mao/contracts';

export const FEATURED_TOOL_NAMES = new Set<string>([
  'generate_image', 'edit_image', 'text_to_speech',
]);

const TOOL_NAMES_BY_FEATURE: Record<AgentFeaturedTool, readonly string[]> = {
  image_generation: ['generate_image', 'edit_image'],
  text_to_speech: ['text_to_speech'],
};

export interface FeaturedToolModelLookup {
  findFirstActiveImageModel(): Promise<unknown | null>;
  findFirstActiveAudioModel(): Promise<unknown | null>;
}

/** 安全解析 Agent 列；非法 JSON / 未知值一律当未启用。 */
export function parseFeaturedTools(raw: string | null | undefined): AgentFeaturedTool[] { /* ... */ }

/** 配置 ∩ 模型可用性 → 本会话可保留的工具名。 */
export async function resolveFeaturedToolNames(
  featured: readonly AgentFeaturedTool[],
  lookup: FeaturedToolModelLookup | null,
): Promise<Set<string>> { /* ... */ }
```

`HarnessService`：

- 构造函数末尾追加可选依赖 `featuredToolModels?: FeaturedToolModelLookup | null`（放在 `runtimeIdentityMode` 之后）。
- 在 `buildContext` 的页面工具过滤之后、MCP/HTTP 注入之前（约 `:457`）插入：

```ts
const featured = parseFeaturedTools(agent.featuredTools);
if (featured.length > 0 || this.featuredToolModels != null) {
  const allowed = await this.resolveFeaturedToolsSafely(featured);
  sessionTools = sessionTools.filter(
    (tool) => !FEATURED_TOOL_NAMES.has(tool.getName()) || allowed.has(tool.getName()),
  );
}
```

- `resolveFeaturedToolsSafely`：
  - `featuredToolModels == null` → 返回全部 gated 工具名（精简单测 / 未装配时保持改造前行为，避免存量单测雪崩）。
  - 配置为空 → 返回空集合（全部隐藏，不查模型）。
  - 某个能力的模型查询抛错 → 只丢弃该能力的工具，其他能力继续（逐能力 fail-closed），记 `harnessLog('warn', ...)`，不阻断会话。
  - 只在需要时查：`image_generation` 查一次 image，`text_to_speech` 查一次 audio；两者互不短路。
- 记录一条可 grep 的日志：`[featured-tools] session=... agent=... configured=[...] injected=[...]`，排障时能直接看出「配了但没注入」是模型不可用还是配置没保存。
- **不改 `prompt-engine.ts`**：工具 schema 完全由 `context.tools` 派生（`prompt-engine.ts:790-800`）；工具不在列表，模型既看不到也调不动（`agent-loop.ts:856-860`）。
- **不改 `ToolDispatcher` 的校验逻辑**：dispatcher 本身不校验会话工具集（SERVER_ONLY 分支直接 `getTool`），但生产唯一调用方是 AgentLoop，`context.tools` 已是硬门。这一点在实现时不要「顺手加校验」，会改变既有语义。

装配：`app-harness-engine.ts` 给 `HarnessService` 传 `d.modelService`（`ModelService` 天然满足 `FeaturedToolModelLookup`）。`createDefaultToolRegistry` 不需要感知这个开关——TTS 工具照常全量注册。

注入真值表（生产装配，port 已注入）：

| `featured_tools` | image 模型 | audio 模型 | 本会话 `context.tools` |
|---|---|---|---|
| `NULL` / `[]` | 有 / 无 | 有 / 无 | 无 `generate_image` / `edit_image` / `text_to_speech` |
| `["image_generation"]` | 有 | — | `generate_image` + `edit_image` |
| `["image_generation"]` | 无 | — | 无图片工具 |
| `["text_to_speech"]` | — | 有 | `text_to_speech` |
| `["text_to_speech"]` | — | 无 | 无 TTS |
| 两项都有 | 有 | 有 | 三个工具都在 |
| 两项都有 | 有 | 无 | 只留两个图片工具 |
| 两项都有 | 无 | 有 | 只留 TTS |
| 两项都有 | 无 | 无 | 三个都不在 |

`—` 表示该能力未配置，不查对应模型。

### 5.3 模型可用性

#### 5.3.1 音频协议过滤

`ModelRepository` 新增专用查询 `findFirstActiveAudioModel()`（不再走通用的 `findFirstActiveByType('audio')`）：

```sql
SELECT * FROM llm_model
WHERE status = 1
  AND model_type = 'audio'
  AND (api_protocol IS NULL OR api_protocol = '' OR api_protocol = 'openai-compatible')
  AND deleted = 0
ORDER BY id ASC
LIMIT 1
```

`ModelService.findFirstActiveAudioModel()` 改为调用这个新方法，签名不变，调用方无感。

这样：

- `text_to_speech` 的注入判断与微信语音合成都能跳过「配了 Anthropic/Responses 但根本不会发 audio」的模型；
- 如果存在多个 audio 模型，id 最小但协议不兼容的会被跳过，取下一个可用行；
- 不改 `findFirstActiveByType` 的通用语义，避免影响 image 查询。

#### 5.3.2 可用性接口

`model.routes.ts` 新增（放在 `/v1/models/:id` 之前）：

```ts
app.get('/v1/models/availability', async (request, reply) => {
  // /v1/models 的登录态来自 revealApiKey 内部的 requireUserId；本接口不读 key，必须显式校验。
  requireUserId(request);
  const image = await modelService.findFirstActiveImageModel();
  const audio = await modelService.findFirstActiveAudioModel();
  return sendOk(reply, {
    image: { available: image != null, modelName: image?.name ?? null },
    audio: { available: audio != null, modelName: audio?.name ?? null },
  });
});
```

- 只返回布尔与模型名，不返回 key / baseUrl。
- 必须显式调用 `requireUserId(request)`：不能依赖 `/v1/models` 的登录态（那是 `revealApiKey()` 内部顺带做的），否则该路由可能匿名可读。
- 沿用 `/v1/models` 的 auth 口径（登录即可，不额外要求 `model:read`），因为 Agent 管理员不一定有模型管理权限；模型名本身在模型列表已可见。
- 不新增 `text` 项：Agent 默认模型选择已有 `/v1/models/active`。

### 5.4 新增 `text_to_speech` 工具

文件：`backend-ts/src/harness/tool/impl/text-to-speech-tool.ts`

#### 5.4.1 依赖与构造

```ts
export interface AudioModelLookup {
  findFirstActiveAudioModel(): Promise<LlmModel | null>;
}

export class TextToSpeechTool extends BaseTool {
  constructor(
    private readonly modelLookup: AudioModelLookup,
    private readonly llmAdapter: LlmAdapter,
    private readonly uploadDir: string,
    private readonly getBaseUrl: () => Promise<string> = async () => '',
    private readonly contextPath: string = '/api',
  ) { super(); }
}
```

- 不注入 `LlmAuthResolver`：适配器门面内部已有 resolver（`createLlmAuthResolver`），`ecp` 模型会在 `LlmCallContext` 里按当前用户解析凭证。
- 不新建 recorder：走 `LlmAdapter` 就必然经过 `RecordingLlmAdapter`（`usage/recording-llm-adapter.ts:70-112`）。
- 契约与代码里的 `userId` 指 dispatcher 传入的**运行身份** `runtimeUserId`（群聊里可能是本次发言者），与 `generate_image` 同口径；不是会话归属 `session.userId`。

#### 5.4.2 契约

| 项 | 值 |
|---|---|
| 名称 | `text_to_speech` |
| 中文名 | 语音合成 |
| 入参 | `text: string`（必填，trim 后非空，≤ 2000 字；JSON Schema 同时声明 `maxLength: 2000`） |
| 出参 | `{ audio_url, audio_path, format, size_bytes, model, text_length }` |
| 错误 | `{ error, error_code }`，`error_code` 见下表 |
| 执行位置 | 服务端直连（LOCAL 会话也不下发桌面） |
| 产物 | `{uploadDir}/{userId}/tts-{uuid}.{ext}`；userId 为空（单测）落平坦目录 |
| URL | `{静态 origin}/uploads/{userId}/tts-{uuid}.{ext}`，与 `generate_image` 同口径（`toStaticUploadBase`）；`upload.baseUrl` 未配置时 `audio_url` 回落本地绝对路径 |
| 格式 | 请求 `audio: { format: 'wav' }`；保存扩展名取响应 `format`，经 `[a-z0-9]` 白名单归一，缺省 `wav` |
| `model` | 上游 `model.modelId`（如 `mimo-v2.5-tts`），不是后台显示名 |
| `text_length` | trim 后的字符数（码点），不含首尾空白 |

补充口径：

- **不做 Markdown 清洗**：工具收到的 `text` 原样送上游；朗读文本是否去掉井号/星号由模型在调用前自行处理（微信语音的 `WeixinVoiceTextSanitizer` 是渠道专属逻辑，不往 harness 搬）。
- **不静默截断**：超过 2000 字直接报错，让模型分段调用；避免用户以为整段都读了。
- **常量位置**：`const TTS_MAX_TEXT_CHARS = 2000;` 放在工具文件顶部，后续调整只改一处。

`getDescription()`（唯一会进入模型上下文的使用说明）：

```text
将文字合成为语音（TTS）。基于后台配置的语音模型（model_type=audio）生成音频（默认 WAV），
返回访问 URL 与本地保存路径。适合朗读、配音、语音回复；text 请使用适合朗读的纯文本，
单次最多 2000 字，超长请分段调用。需要把音频直接发给用户时，将 audio_path 的值作为 send_file 的 file 参数传入。
仅当 Agent 启用了「语音合成」特色工具且后台存在可用语音模型时才会出现。
```

> `getToolPrompt()` 在生产链路没有任何消费者（全仓只有单测调用），不要只写在那里；模型真正看到的是 `getDescription()` + `getInputSchema()`（`prompt-engine.ts:790-800`）。

#### 5.4.3 执行流程

```text
1. 解析参数，text trim；空 / 非字符串 → invalid_text
2. 长度 > 2000 → text_too_long（不静默截断）
3. model = await modelLookup.findFirstActiveAudioModel()
   无 → no_model
4. 校验 model.apiProtocol：非空且非 openai-compatible → unsupported_protocol
5. 校验 model.baseUrl / model.modelId 非空 → invalid_model_config
6. cfg = { id, name, provider, apiProtocol, baseUrl, apiKey, modelId,
           clientImpersonation, authType }   // 与 voice-synthesis.service.ts:71-81 同构
7. response = await LlmCallContext.runAsync(
     { scene: VOICE_SYNTHESIS, userId, sessionId, agentId },
     () => llmAdapter.chat({ messages: [{ role: 'assistant', content: text }],
                              audio: { format: 'wav' } }, cfg))
8. audio = response.choices?.[0]?.message?.audio
   无 data / 空串 → empty_audio
9. bytes = Buffer.from(audio.data, 'base64')；空 → empty_audio
10. 落盘 uploads/{userId}/tts-{randomUUID}.{ext}；失败 → write_failed
11. 返回 JSON
```

错误码：

| error_code | 触发条件 | 是否已打上游 |
|---|---|---|
| `invalid_text` | 缺参 / 空串 / 非字符串 | 否 |
| `text_too_long` | > 2000 字 | 否 |
| `no_model` | 无启用的 OpenAI 兼容 audio 模型 | 否 |
| `unsupported_protocol` | audio 模型协议非 OpenAI 兼容 | 否 |
| `invalid_model_config` | baseUrl / modelId 为空 | 否 |
| `tts_failed` | 适配器抛错（message 需脱敏 apiKey） | 是（可能已计费） |
| `empty_audio` | 上游 200 但无音频 | 是 |
| `write_failed` | 落盘失败 | 是（音频已生成） |

参数 / 配置类早退（前 5 类）不打上游，`RecordingLlmAdapter` 不会产生 `llm_call` 行；只有真正调用适配器后才会记账。

错误文案（模型与用户可见，需带排障指引）：

| error_code | error 文案 |
|---|---|
| `invalid_text` | `text 不能为空` |
| `text_too_long` | `text 过长（最多 2000 字），请分段调用` |
| `no_model` | `没有可用的语音模型，请先在管理后台配置 model_type=audio 且协议为 OpenAI 兼容的模型` |
| `unsupported_protocol` | `语音模型协议需为 OpenAI 兼容（当前 ${apiProtocol}），否则 audio 字段不会发送` |
| `invalid_model_config` | `语音模型未配置 base_url / model_id` |
| `tts_failed` | 适配器错误摘要（`apiKey` 已脱敏，禁止原样透出请求头） |
| `empty_audio` | `语音模型未返回音频数据` |
| `write_failed` | `音频落盘失败: ${原因}` |

#### 5.4.4 注册与执行归类

- `DefaultToolRegistryDeps` 增加 `audioModelLookup`、`llmAdapter`，在 `createDefaultToolRegistry` 的图片工具之后构造 `new TextToSpeechTool(...)`。
- `app-harness-engine.ts` 传入 `audioModelLookup: d.modelService`、`llmAdapter: d.llmAdapter`（`HarnessEngineDeps` 已有 `llmAdapter`，`:147`）。
- `tool-dispatcher.ts`：
  - `SERVER_ONLY_TOOLS` 加 `text_to_speech`；
  - `RUNTIME_SCOPED_TOOLS` 加 `text_to_speech`；
  - **不加** `SEND_BYTES_TOOLS`（不读入参文件）。
- `/v1/tools` 会自动多出该工具（`tool.service.ts:8-10` 读 registry），无需手改；这是全局目录，不代表每个 Agent 都有。

### 5.5 调用流水与成本

- TTS 走 `LlmAdapter`，`RecordingLlmAdapter` 在 `LlmCallContext` 存在时自动写 `llm_call`：
  - `scene = voice_synthesis`；
  - `user_id` / `session_id` / `agent_id` 取上下文；
  - 微信语音的 `session_id/agent_id` 仍为 NULL，Agent 工具调用则有值，二者可通过 `session_id` 区分。
- 音频模型价格列在后台被强制置空（`ModelFormDialog.vue:429-437`），所以 TTS 行通常 `cost_micros=NULL`；这是现状，不在本期改。
- 不新增 `LlmCallScene`，因此**不需要**动 contracts / 两端汉化表 / `zz-logicbug-probe` 场景数组。若后续要把「工具 TTS」与「微信语音」分开统计，再新增 `text_to_speech` 场景即可（三处同改）。

### 5.6 子 Agent、渠道、定时任务

| 入口 | 行为 |
|---|---|
| 桌面 WS / 边路 | `buildContext` 过滤，生效 |
| 微信 / 飞书 / 钉钉 | 同 `buildContext`，生效；微信语音回复链路不变 |
| 定时任务 / OpenAPI / 信号触发 | 同 `buildContext`，生效 |
| 后台子 Agent | 子会话 `agentId` 继承父会话，`buildSubContext` 先 `buildContext(childSession)` 再剔除 `ask_user_questions/send_image/send_file` 等（`background-subagent-manager.ts:1042-1053`），TTS/出图保留。**`send_file` 被排除，子 Agent 不能直接交付 TTS 音频**：只回传 `audio_path` 给父会话发送，或把 `text_to_speech` 一并加入子 Agent 排除集（见 §13） |
| 会话内切换 Agent | 下一轮 `buildContext` 读新 Agent，自动切换 |
| 运行中改配置 / 停用模型 | 下一轮生效，当前轮不变 |

## 6. 前端

### 6.1 管理后台 Agent 表单

位置：`admin/src/views/agent/AgentFormDialog.vue`，插在「自定义 HTTP 工具」之后、Git 凭据域之前（`:81-102` 与 `:103` 之间）。

UI 形态（两项固定，不用 el-select）：

```text
特色工具
[x] 图片生成（文生图 / 改图）    当前模型：gpt-image-2.5-flare
[ ] 语音合成（TTS）              ⚠ 暂无可用语音模型，请先在「模型管理」启用
仅当对应类型的模型启用时才注入工具；模型停用后，下一次执行自动隐藏。
```

规则：

- 新增 `featuredTools: AgentFeaturedTool[]` 到表单 state、reset、`agentData` 回显、copy 模式、提交 payload。
- 选项元数据用 `Record<AgentFeaturedTool, { label; modelKey: 'image' | 'audio'; hint }>` 声明（label / 模型类型 / 说明），吃 `AgentFeaturedTool` 的编译期穷尽；不要手写两组 if。
- `loadOptions()` 增加 `api.get('/models/availability')`；结果存 `featuredToolAvailability`，`modelKey` 直接映射 `image` / `audio`。
- 可用性加载失败时不置灰，显示「可用性检测失败，运行时将再次校验」，允许勾选——配置是声明式的，不能因为一次网络失败挡住保存。
- 可用性为 false 且未勾选：checkbox `disabled`，旁边 `el-tag`「无可用模型」。
- 可用性为 false 但已勾选（模型后来被停用）：checkbox **保持可操作**（管理员要能取消），显示 warning tag；不要用 `disabled` 把用户锁死。
- 保存不拦截；后端只校验 key 合法性。
- 复制 Agent 时原样复制 `featuredTools`。

管理后台列表页 `AgentListView.vue`：

- 能力概览 tooltip（`:100-110`）与 `capabilitySummary`（`:370-381`）增加「出图 / 语音」。
- 未启用模型时仍显示配置项，不额外做红色告警（列表页没有可用性数据，避免多打接口）。

### 6.2 工具展示同步（AGENTS.md 强制）

| 位置 | 改动 |
|---|---|
| `backend-ts/src/session/util/tool-result-summarizer.ts` | switch 加 `text_to_speech`；摘要 `语音合成: <text 前 30 字>`，失败接 `failureSuffix`，成功可带 `(N 字节)` |
| `desktop/src/utils/toolDisplay.ts` | `TOOL_DISPLAY_NAMES.text_to_speech = '语音合成'`；参数预览取 `input.text`（`clipByCodePoint` 60） |
| `desktop/src/utils/toolIcons.ts` | `text_to_speech: Microphone`（Element Plus 音频类图标） |
| `admin/src/views/session/utils/toolDisplay.ts` | 名称 + 预览（该文件注释要求与 desktop 两端同步） |
| `sdk/embed/src/ui/toolDisplay.ts` + `icons.ts` | 名称 + 预览 + 一条音频图标 path（改源码后重新构建 `desktop/public/embed/mao-chat*.js`，不手改产物） |
| `backend-ts/src/harness/core/no-progress-notice.ts` | `SEMANTIC_KEYS_BY_TOOL` 加 `text_to_speech: ['format','model']`；URL / 路径 / UUID / 字节数都不进签名（同一 text 重复合成视为无进展；不同 text 由 arguments 区分） |

v1 **不做** TTS 富视图（不新建 `ToolAudioGenView.vue`）：工具卡片显示摘要与参数即可；需要试听时按 D9 调 `send_file`，复用现有 `ChatDeliveryBar` + `MediaPlayer` 音频播放。富视图列后续项。

### 6.3 其他前端

- `desktop/src/stores/agent.ts` 的 `Agent` 接口不展示新字段，**无需改**；`AgentVO` 新增字段是向后兼容的。
- `agent-cli/src/rest/types.ts` 不消费新字段，**无需改**。
- 安卓只走 CLOUD，无 Agent 配置读取，**无需改**。
- `skills/mao-cli/reference/tool.md`：`tool list/get` 读全局 registry，会列出 `text_to_speech`；补一句「是否在某个 Agent 可用取决于该 Agent 的特色工具配置与模型可用性」。

## 7. 兼容与生效

| 场景 | 行为 |
|---|---|
| 升级前已存在的 Agent | 迁移回填 `image_generation`，出图能力不变；TTS 关闭 |
| 升级后新建 Agent | `featured_tools=NULL`，两项都不注入 |
| 管理员关闭图片生成 | 下一轮 `generate_image` / `edit_image` 从 `context.tools` 消失；历史消息里的工具卡片仍按名称正常显示 |
| 图片模型被停用 | 下一轮自动隐藏；重新启用后下一轮恢复 |
| 语音模型被停用 | 同上；微信语音回复也会跳过（`findFirstActiveAudioModel` 返回 null） |
| 运行中的会话 | 当前轮不改；下一轮 `buildContext` 生效 |
| LOCAL 会话 | TTS / 图片均在服务端执行，不受桌面端工具集影响 |
| prompt 前缀缓存 | 工具顺序保持 registry 顺序；只有配置或模型可用性变化时工具集才变，变化频率低 |
| 精简装配 / 单测未注入 `featuredToolModels` | 跳过过滤，gated 工具全部保留——与改造前行为一致 |

## 8. 测试

### 8.1 后端单测

1. `agent.routes.spec.ts`：新建/更新 `featuredTools` 正常往返；未知 key、非数组、非字符串项 → `PARAM_INVALID`；空数组清空；`toVO` 返回数组。
2. `agent.service.spec.ts` / `agent.repository.spec.ts`：JSON 字符串化与 `NULL` 折叠；位置参数追加后现有用例补 `undefined`；`agent.routes.spec.ts` 的 `.at(-1)` / `.at(-4)` / `.at(-2)` 位置断言全部调整（`.at(7)` httpToolIds 不变）。
3. `harness-service.spec.ts`：
   - 配置为空 → `generate_image` / `edit_image` / `text_to_speech` 均不在 `context.tools`；
   - `image_generation` + image 模型可用 → 两个图片工具在、TTS 不在；
   - `text_to_speech` + audio 模型可用 → TTS 在、图片不在；
   - 配了但模型查询返回 null → 对应工具不在；
   - 某个能力的模型查询抛错 → 该能力工具不在、其他能力保留，`buildContext` 仍成功；
   - 未注入 `featuredToolModels` → 三个工具都在（兼容）。
4. `text-to-speech-tool.spec.ts`（仿 `generate-image-tool.spec.ts`）：
   - 成功：fake `LlmAdapter.chat` 返回 base64 WAV；断言落盘 `tts-*.wav`、`audio_url`、`audio_path`、`format/size_bytes`；
   - 按 userId 隔离目录；无 userId 落平坦目录；
   - `text` 空 / 超长 → 早退，adapter 未被调用；
   - 无模型 / 协议不支持 / baseUrl 缺失 → 对应 error_code；
   - 上游无 audio / 空字节 → `empty_audio`；
   - adapter 抛错 → `tts_failed`，错误信息不含 apiKey；
   - `LlmCallContext` 场景为 `voice_synthesis`，user/session/agent 透传（fake adapter 内断言）。
5. `tool-registry.spec.ts`：补齐新 deps 后，`getTool('text_to_speech')` 可取到。
6. `tool-dispatcher.spec.ts`：LOCAL 模式下 `text_to_speech` 走服务端分支。
7. `tool-result-summarizer.spec.ts`：成功 / 失败 / 缺参三种摘要。
8. `no-progress-notice.spec.ts`：同一 text 两次调用、文件名不同但结果被归一为相同；不同 text 视为有进展。
9. `model.repository.spec.ts`：audio 查询跳过 anthropic / openai-responses，选中下一条 openai-compatible 行；同步更新 `model.service.spec.ts` / `zz-logicbug-probe.spec.ts` 的 fake repo（补 `findFirstActiveAudioModel` mock），否则现有 `findFirstActiveAudioModel` 用例会打到 undefined。
10. `model.routes.spec.ts`：`/v1/models/availability` 返回 image/audio 布尔与模型名；补未登录断言（登录即可，不要求 `model:read`）。

### 8.2 前端

- `desktop/src/utils/toolDisplay.test.ts`、`admin/src/views/session/utils/toolDisplay.spec.ts`、`sdk/embed/src/ui/toolDisplay.spec.ts`：`text_to_speech` 名称与参数预览。
- `cd admin && npm run build`、`cd desktop && npm run build`（必须跑 `vue-tsc -b && vite build`，不要用 `npx vue-tsc --noEmit` 假通过）。
- `cd sdk/embed && npm run build && npm test`；产物同步到 `desktop/public/embed/mao-chat.js` 与版本锁定副本并提交（CI embed-sdk 会重建比对 sha256，漏提交直接失败）。
- 管理后台表单人工验收：模型可用时勾选、不可用时置灰、已勾选失效时可取消、保存/回显/复制。

### 8.3 手工验收矩阵

| # | 操作 | 预期 |
|---|---|---|
| 1 | 升级后打开存量 Agent | 「图片生成」已勾选，出图对话正常 |
| 2 | 新建 Agent 不勾选任何特色工具 | `context.tools` 无图片/TTS，模型不知道这些工具存在 |
| 3 | 勾选图片生成，停用所有 image 模型 | 表单显示无可用模型；下一轮图片工具消失 |
| 4 | 启用 image 模型后再开新会话 | 图片工具恢复 |
| 5 | 勾选语音合成，audio 模型为 openai-compatible | TTS 工具出现，调用后 `uploads/{uid}/tts-*.wav` 可播放 |
| 6 | audio 模型改为 anthropic 协议 | 表单显示无可用模型；TTS 工具不注入 |
| 7 | LOCAL 会话调用 TTS | 服务端生成，桌面端不执行模型调用 |
| 8 | 微信语音回复 | 原有行为不变（audio 模型为 openai-compatible 时正常合成） |
| 9 | 子 Agent 在启用了 TTS 的 Agent 下运行 | 子 Agent 工具集包含 TTS（继承）；因 `send_file` 被子 Agent 排除，验证 `audio_path` 回传父会话后由父会话发送（若选择将 TTS 排除，则工具集不含 TTS） |

## 9. 发布物与实现清单

### 9.1 代码清单

实现顺序建议（每步先过编译/测试再进下一步）：

1. 迁移 + 契约 + Agent CRUD（`types → repository → service → routes → admin payload`）→ `cd backend-ts && npm run build && npm test`。
2. `featured-tools.ts` + `HarnessService` 注入 + 可用性接口 → 跑 harness / model 单测。
3. `text_to_speech` 工具 + 注册 + dispatcher 归类 + 展示/无进展同步 → 跑工具与摘要单测。
4. 管理后台表单/列表 → `cd admin && npm run build`；桌面/嵌入展示 → `cd desktop && npm run build`。
5. 按 §8.3 矩阵手工验收；补 changelog 碎片与 mao-cli 文档说明。

**后端**

- [ ] `backend-ts/db/migration/V213__agent_featured_tools.sql`
- [ ] `backend-ts/src/agent/types.ts`、`agent.repository.ts`、`agent.service.ts`、`agent.routes.ts`
- [ ] `shared/contracts/src/agent.ts`（`AgentFeaturedTool` + `AgentVO.featuredTools`）、`shared/contracts/src/index.ts` 导出
- [ ] `backend-ts/src/harness/deps.ts`（`Agent.featuredTools`）
- [ ] `backend-ts/src/harness/tool/featured-tools.ts`（新增）
- [ ] `backend-ts/src/harness/core/harness-service.ts`（构造依赖 + buildContext 过滤）
- [ ] `backend-ts/src/app-harness-engine.ts`（传 `featuredToolModels`、TTS 工具依赖）
- [ ] `backend-ts/src/harness/tool/impl/text-to-speech-tool.ts`（新增）
- [ ] `backend-ts/src/harness/tool/tool-registry.ts`（注册 + deps）
- [ ] `backend-ts/src/harness/tool/tool-dispatcher.ts`（SERVER_ONLY / RUNTIME_SCOPED）
- [ ] `backend-ts/src/model/types.ts`（`LlmModelRepository` 加 `findFirstActiveAudioModel` 声明）、`model.repository.ts`（audio 协议过滤）、`model.service.ts`（`findFirstActiveAudioModel` 改调新方法）、`model.routes.ts`（availability）
- [ ] `backend-ts/src/session/util/tool-result-summarizer.ts`、`harness/core/no-progress-notice.ts`

**管理后台**

- [ ] `admin/src/views/agent/AgentFormDialog.vue`（多选、可用性、回显、payload）
- [ ] `admin/src/views/agent/AgentListView.vue`（能力概览）
- [ ] `admin/src/views/session/utils/toolDisplay.ts`

**桌面 / Web / 嵌入**

- [ ] `desktop/src/utils/toolDisplay.ts`、`toolIcons.ts`
- [ ] `sdk/embed/src/ui/toolDisplay.ts`、`icons.ts`（改源码后重新构建 embed 产物）

### 9.2 changelog 碎片

`changelog/unreleased/2026-11-27-agent-featured-tools.md`：

```markdown
### 后端

- Agent 新增「特色工具」配置：可按 Agent 开启文生图 / 语音合成；未启用或对应模型不可用时不向模型暴露工具。
- 新增 `text_to_speech` 内置工具：基于后台语音模型生成 WAV 音频，产物落用户上传目录。
- 音频模型查询跳过 Anthropic / Responses 协议，避免「调用成功但无音频」的静默失败。

### 管理后台

- Agent 新建 / 编辑增加「特色工具」多选，显示文生图 / 语音模型的可用性与当前模型。
- Agent 列表能力概览增加「出图 / 语音」。

### 前端（桌面 / Web / 安卓）

- 工具卡片支持「语音合成」中文名、参数预览与结果摘要。
```

### 9.3 文档

- 本方案文档。
- `skills/mao-cli/reference/tool.md` 补一句工具可用性取决于 Agent 特色工具配置。
- `skills/mao-cli/reference/agent.md` 补一句：CLI 的 `agent create/update` 不传 `featuredTools`（新建默认关闭，更新不改动），需在管理后台配置。
- `skills/mao-cli/reference/model.md` 可补 `GET /models/availability`（登录即可，返回 image/audio 布尔与模型名）。
- README / DEPLOY 无新增环境变量或部署步骤，不要求改。
- 发版前在 main 跑 `./scripts/changelog-cut.sh`（本任务不跑 `changelog-cut`，只加碎片）。

### 9.4 部署顺序

1. 后端（迁移 + 注入逻辑 + TTS 工具）先上；旧管理后台不传 `featuredTools`，新增列保持回填值，行为不变。
2. 管理后台再上；此时可编辑特色工具。
3. 桌面 / Web 前端随下次常规部署；工具卡片展示是纯前端增量，不影响 TTS 生成。
4. 不改安卓壳，不需要 OTA / `build-apk.sh`。

## 10. 后续项（不在本期）

1. TTS 参数：`voice`、`speed`、`format=mp3`、采样率；需要 audio 模型表增加对应列与后台表单。
2. TTS 富视图：桌面工具卡片内嵌 `<audio>` 播放器（`audio_url`），后台会话回放同步。
3. 自动投递：`deliver: true` 参数或独立 `send_voice` 工具，复用 `send_file` 渠道策略。
4. 每 Agent 绑定具体 image/audio 模型（当前固定 id 最小启用行）。
5. 音频/图片 token 计价与预算口径。
6. 把 `voice_synthesis` 拆成 `voice_synthesis`（微信）与 `text_to_speech`（工具）两个场景。
7. 可用性查询加短 TTL 缓存 / 合并成一条 `GROUP BY model_type` 查询（当前每次执行最多两条轻量 SELECT）。
8. 管理后台模型表单在 `modelType=audio` 时只保留「OpenAI 兼容」协议（当前运行时已兜底跳过其他协议，UI 收敛可进一步减少误配）。

## 11. 风险与注意事项

1. **prompt 前缀缓存**：工具集变化会改变请求字节。过滤保持 registry 顺序，且只在配置 / 模型可用性变化时变；不要在每轮做无意义的重排。
2. **运行时可用性与管理端显示可能短暂不一致**：管理员在另一个 tab 停用模型后，已打开的表单仍显示可用；保存不拦截，下一轮注入时以模型查询为准。这是有意的「声明式配置 + 运行时校验」。
3. **音频文件累积**：TTS 产物与生成图片一样落在 `uploads/{userId}`，当前没有清理策略；大范围使用前需评估磁盘。
4. **ECP 凭证**：`auth_type=ecp` 的 audio 模型可用性只检查行存在，不检查当前用户是否有 ECP Token；工具调用时可能失败，返回适配器错误，不静默回退固定 Key。
5. **2000 字上限**：是产品保护值，不是上游硬限制；如业务需要长文本，调大常量并评估工具超时。
6. **`text_to_speech` 全局可见**：`/v1/tools` 与 mao-cli `tool list` 会列出它，但具体会话是否可用取决于 Agent 配置；文档已注明，避免排障时误判「注册了就该能用」。
7. **未注入 `featuredToolModels` 的精简装配**：会保留全部 gated 工具（兼容旧单测）。生产装配必须传 `d.modelService`，否则特色工具开关不生效；实现时在 `app-harness-engine.ts` 明确传入，不要依赖默认值。
8. **可用性是行级判断**：只校验 `status/type/deleted`（音频再加协议），不校验 `base_url` / `api_key` / 模型连通性。配错凭证的模型仍会在表单显示「可用」，由工具调用时返回明确错误；如需要更严格，后续把可用性抽成统一的 `isUsableModel()` 谓词，同时供注入与工具选择使用。
9. **图片工具与 TTS 的模型选择口径**：都取 `id` 最小的启用行，不支持 Agent 级指定模型；管理员若需换模型，应停用旧行或调整启用集合，避免「后台明明有多个模型却总用第一个」的困惑。
10. **WAV 体积**：2000 字音频可能达到十几 MB；经 `send_file` 发到微信/钉钉时受 20MB 渠道限制，超限会返回发送失败。必要时下调 `TTS_MAX_TEXT_CHARS`，或后续支持 `format=mp3` 后再放宽。
11. **OpenAI 兼容音频协议 ≠ 一定出声**：`json.ts` 只序列化 `audio`，未带 `modalities: ["text","audio"]`；现有微信语音模型可用，但其他要求 modalities/voice 的音频模型可能 200 且 `empty_audio`。可用性判断无法覆盖，需在排障文档/后续项注明。
12. **长文本 TTS 与超时/体积**：2000 字按 44.1kHz 立体声 WAV 可超过 50MB 客户端预览上限（`MEDIA_MAX_BYTES`）和 20MB 微信/钉钉上限；同时 `LlmAdapter` 默认 call timeout 120s 可能不够。建议首版下调至 1000–1500 字或按实际模型采样率评估。
13. **`featuredToolModels` 漏装配的静默降级**：未注入时 `resolveFeaturedToolsSafely` 返回全部 gated 工具，等于特色工具开关失效。生产装配必须传 `d.modelService`；建议在 `app-harness-engine` 启动时对缺失记 warn/断言，勿只依赖默认值。

## 12. 评审结论

### 12.1 已确认（2026-11-27）

| # | 问题 | 定案 |
|---|---|---|
| Q1 | 存量 Agent 是否回填 `image_generation` | **回填**，保持现网出图能力；新建 Agent 默认关闭 |
| Q2 | 「文生图」开关是否同时管 `edit_image` | **管**，一个 `image_generation` 同时控制 `generate_image` + `edit_image` |
| Q3 | TTS 产物是否自动发送 | **不自动发送**，参考文生图只返回文件；模型需要交付时调用 `send_file` |

### 12.2 技术默认（本次未单独评审，按推荐口径执行）

| # | 问题 | 本文采用 | 说明 |
|---|---|---|---|
| Q4 | TTS 场景是否独立 | 复用 `voice_synthesis` | 语义相同且避免三端枚举同步；来源可由 `session_id` 是否为空区分。要拆分时按 AGENTS.md 三处同改 |
| Q5 | 单次文本上限 | 2000 字 | 产品保护值，不是上游硬限制；实现为工具文件顶部常量，后续可调 |

## 13. 二轮评审补充（2026-11-27）

### 13.1 结论

- **需求可行**：Agent 级开关 + 模型可用性双门，解决「配置与运行态脱节」；TTS 复用既有音频模型与 `LlmAdapter` 链路，无新基础设施。
- **技术方案可行**：`buildContext` 是唯一会话工具出口（`context.tools` 唯一赋值点 `harness-service.ts:542`，子代理在其上二次过滤），不改 dispatcher 安全边界即可收口；已核实 `send_file` 支持本人 uploads 绝对路径、`MediaPlayer` 支持 wav（≤50MB）、迁移 V213 与 `agent.git_allowed_domains` 列均可落地。
- **无阻塞项**；按 §13.2 修正后可进入开发。

### 13.2 实现前必须修正

1. **可用性接口鉴权**：见 §5.3.2，必须显式 `requireUserId(request)`；`/v1/models` 的登录态来自 `revealApiKey()` 内部，不能作为本路由的依赖。
2. **代码清单补 `model.service.ts`**：`findFirstActiveAudioModel` 的实现改动不在 §9.1 原清单里；同步补 `model.service.spec.ts` / `zz-logicbug-probe.spec.ts` 的 fake repo（详见 §8.1）。
3. **位置断言**：`createAgent` / `updateAgent` 末尾追加参数会让 `.at(-1)` / `.at(-4)` / `.at(-2)` 全部偏移，不能按「放末尾就不打乱 `.at(n)`」理解（详见 §5.1 / §8.1）。
4. **`AGENT_FEATURED_TOOLS` 穷尽性**：`as const satisfies readonly AgentFeaturedTool[]` 只校验元素合法，不保证联合成员齐全；已补 `Exclude<...> extends never` 断言（见 §4.2）。
5. **TTS 描述参数名**：`send_file` 的入参是 `file`，不是 `audio_path`；已改为「将 audio_path 的值作为 file 参数」（见 §5.4.2）。
6. **子 Agent 交付路径**：`SUBAGENT_EXCLUDED_TOOLS` 含 `send_file`，TTS 在子 Agent 内可生成但不可直接交付；已明确「回传 `audio_path` 给父会话发送」或「把 `text_to_speech` 加入子 Agent 排除集」二选一（见 §5.6 / §8.3 #9）。

### 13.3 可选优化（不阻塞）

- `FEATURED_TOOL_NAMES` 从 `TOOL_NAMES_BY_FEATURE` 派生，避免 Set 与 Record 两处硬编码漂移。
- `parseFeaturedTools` 与 `toVO` 共用同一解析函数，避免两套 `JSON.parse` 语义。
- `getDescription()` 末尾「仅当 Agent 启用了…」在工具可见时恒真，可删以省 token。
- 管理后台增加「刷新可用性」，避免在模型页启用后必须重开 Agent 弹窗。
- `DefaultToolRegistryDeps` 的 `llmAdapter` / `audioModelLookup` 可设为可选（缺失时不注册 TTS），减少精简装配与单测的无关桩；生产装配仍显式传。
- 可用性加载失败时注意区分 `undefined`（未知，允许勾选）与 `false`（不可用，置灰），勿把 404/网络失败当成 `false`。