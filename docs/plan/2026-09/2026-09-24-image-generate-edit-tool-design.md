# 技术方案：图片生成 / 图片编辑工具改造（generate_image + edit_image）

> 状态：待评审（先方案、不动代码）
> 日期：2026-09-24
> 范围：backend-ts（`harness/tool/`、`session/util/tool-result-summarizer.ts`）；desktop / admin 展示同步；无 DB 迁移
> 协议依据：`/private/tmp/image-generation-api.md`（2026-09-24 实测打通）；参考实现 `/private/tmp/probe-sub2api-images.mjs`
> 配置约束：模型 `baseUrl` / `apiKey` / `model` 仍走管理后台 `llm_model`（`model_type=image`），不在工具内写死

## 一、背景与现状

### 1.1 现有能力

| 模块 | 文件 | 现状 |
|------|------|------|
| 文生图工具 | `backend-ts/src/harness/tool/impl/generate-image-tool.ts` | 仅有 `generate_image`：JSON POST `{baseUrl}/images/generations`，解析 `data[].b64_json` 落盘 `uploadDir`，返回 `image_url` / `image_path` |
| 模型配置 | `llm_model`（`V066__add_image_model_type.sql`） | `model_type=image`；`model.service.ts` → `findFirstActiveImageModel()` |
| 注册 / 分发 | `tool-registry.ts`、`tool-dispatcher.ts` | `generate_image` 注册为服务端专属工具（`SERVER_ONLY_TOOLS`），LOCAL 模式也由服务端执行 |
| 结果摘要 | `session/util/tool-result-summarizer.ts` | `summarizeGenerateImage`：`生成图片: prompt (N 张)` |
| 前端展示 | `desktop/src/utils/toolDisplay.ts`、`desktop/.../ToolCallGroup.vue`、`admin/.../ToolCallGroup.vue` | 中文名「生成图片」+ Picture 图标 |

### 1.2 与目标协议的差距

对照《图片生成 / 编辑 API 对接说明》，当前实现**协议不完整、能力不全**：

| # | 差距 | 现状 | 协议要求 |
|---|------|------|----------|
| G1 | **无改图能力** | 仅文生图 | 另需 `edit_image` → `POST {baseUrl}/images/edits`（multipart） |
| G2 | 请求字段不标准 | 发送 `response_format: 'b64_json'`（协议未定义）；无 `quality` | 文生图仅 `model/prompt/n/size/quality`；**不要**发 `background`/`output_format`/`output_compression`/`image`/`mask`/`response_format` |
| G3 | `n` / `size` 取值偏窄 | `n` 钳制 1–4；size 仅三种固定值 | `n` 1–10 默认 1；`size` 支持 `auto` + `1024x1024` / `1536x1024` / `1024x1536` |
| G4 | 无 `quality` | — | `auto` / `high` / `medium` / `low`，默认 `auto` |
| G5 | 模型别名未归一 | 直接透传 `model.modelId` | 客户端归一 `flare`→`gpt-image-2.5-flare`、`sunburst`→`gpt-image-2.5-sunburst`；出站用完整名；用户点名不静默换模 |
| G6 | 不支持调用级模型覆盖 | 恒用配置模型 | 工具可传 `model` 覆盖当次；缺省仍用后台配置 |
| G7 | 头不完整 | 无 `Accept-Encoding: identity`；`Bearer` 未判重 | 必带 `Accept-Encoding: identity`；`apiKey` 已以 `Bearer ` 开头则不再加 |
| G8 | 超时过短 | 180s | 默认 **10 分钟** |
| G9 | 无重试 | 失败即失败 | 仅对 `429/502/503/504` 或 `error.code == rate_limit_exceeded` 按 250ms / 1s / 2.5s 各重试一次；参数/鉴权错误不重试 |
| G10 | 响应字段利用不足 | 只取 `b64_json`/`url` | 还需 `usage`、`revised_prompt`、响应内 `model`/`size`/`generation_id`；`url` 可能相对 `baseUrl`，需下载字节 |
| G11 | 异步任务未识别 | 未处理 | `data[0]` 为 `task_id`（无图）→ **报错，不轮询** |
| G12 | 落盘扩展名写死 `.png` | 恒 `gen-*.png` | 按 `output_format` / 响应实际字节判定扩展名，默认 `.png` |
| G13 | 错误契约粗糙 | `Image API {code}: text.slice(200)` | 回传 HTTP 状态 + `error.code`/`error.type` + `error.message`；非 JSON 附状态码与正文前几百字符并标明；超时/连接失败单独报 |
| G14 | 图片 URL 未下载 | `item.url` 时 `image_path=null`、不落盘 | `b64_json` 或 `url` 至少其一；`url` 需 GET 下载后落盘交调用方 |
| G15 | 基址拼接不统一 | 自行 `replace(/\/$/,'') + path` | 先去 `baseUrl` 尾部 `/`，再接 `/images/generations` 或 `/images/edits` |

### 1.3 保留不变

- 配置来源：管理后台 `llm_model`（`model_type = 'image'`）提供 `base_url` / `api_key` / `model_id`，工具不写死、不做本地配置探测或登录引导。
- `clientImpersonation`（codex / claude_code）继续按模型配置注入，与主对话链路一致（历史上已修复中转网关拒图问题）。
- `generate_image` / `edit_image` 均为**服务端专属工具**（与现 `generate_image` 相同），CLOUD / LOCAL 行为一致。
- 产物落盘 `uploadDir` 并返回可展示 URL（`getUploadBaseUrl`），**不把 base64 塞进对话**。

## 二、目标与边界

### 2.1 目标

| 编号 | 目标 |
|------|------|
| R1 | 重构 `generate_image`：对齐文生图协议（字段、头、超时、重试、响应、错误） |
| R2 | 新增 `edit_image`：本地图片（可多张）+ 可选蒙版的改图，multipart/form-data |
| R3 | 抽出共享 HTTP 客户端，两工具共用鉴权 / 归一化 / 重试 / 落盘 / 错误契约 |
| R4 | 配置仍完全由后台 `model_type=image` 模型驱动；支持调用级 `model` 覆盖（别名归一） |
| R5 | 返回结构含路径、访问 URL、响应 `model`/`size`/`usage`、`revised_prompt`（若有） |
| R6 | 同步补齐摘要、桌面 / 管理后台中文名与图标、注册与分发列表、回归测试 |

### 2.2 不做

| 编号 | 范围外 | 理由 |
|------|--------|------|
| N1 | 轮询异步 `task_id` 任务 | 协议明确不轮询，直接报错 |
| N2 | 改图接受 http(s) 图片 URL | 协议只收本地文件字节 |
| N3 | 工具内写死 baseUrl / key / 模型名；本地配置文件、登录引导 | 配置约束 + 协议「工具行为」 |
| N4 | 文生图携带 `background`/`output_format`/`output_compression`/`image`/`mask`/`response_format` | 协议禁止 |
| N5 | 失败后静默换用另一模型再交图 | 协议要求用户点名则只用该模型 |
| N6 | 新增管理后台配置页 / DB 字段 | 复用 `llm_model` + `model_type=image` |
| N7 | LOCAL Electron 侧实现改图 | 与文生图相同，恒服务端执行 |
| N8 | 蒙版生成 UI、批量改图工作流 | 工具只透传本地 `mask` 文件 |
| N9 | 非 OpenAI Images 形状的私有协议适配层 | 当前上游即 OpenAI 兼容 Images API |

## 三、工具契约设计

按协议「实现两个工具即可」：**两个独立工具**，不合并为带 mode 的单工具（schema 更清晰，提示词可分别优化，摘要 / 展示可区分）。

### 3.1 `generate_image`（升级）

**请求**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 非空，画面描述 |
| `n` | integer | 否 | 1–10，默认 1（放宽现有 1–4） |
| `size` | string | 否 | `auto` \| `1024x1024` \| `1536x1024` \| `1024x1536`，默认 `auto` |
| `quality` | string | 否 | `auto` \| `high` \| `medium` \| `low`，默认 `auto` |
| `model` | string | 否 | 覆盖后台配置模型；支持别名；缺省用 `findFirstActiveImageModel().modelId` |

**HTTP**

```http
POST {baseUrl}/images/generations
Authorization: Bearer <apiKey>
Content-Type: application/json
Accept-Encoding: identity
```

Body 仅含：`model`（归一后完整名）、`prompt`、`n`、`size`、`quality`。不发送 N4 所列字段。

**返回（成功）**

```json
{
  "images": [
    {
      "image_url": "https://…/uploads/gen-<uuid>.png",
      "image_path": "/opt/mao-data/uploads/gen-<uuid>.png",
      "size_bytes": 123456,
      "source": "b64_json"
    }
  ],
  "model": "gpt-image-2.5-flare",
  "size": "1024x1024",
  "prompt": "<入参 prompt>",
  "revised_prompt": "<有则返回>",
  "usage": { "input_tokens": 26, "output_tokens": 515, "total_tokens": 541 }
}
```

- `model` / `size` **以响应为准**，不回写请求值。
- `data[]` 非空数组且每项有 `b64_json` 或 `url`；否则失败。仅有 `task_id` → 失败（「上游返回异步任务，本工具不轮询」）。
- `url` 可能是相对 `baseUrl` 的路径 → 解析后 GET 下载（同样带 `Accept-Encoding: identity`），落盘后 `source: "url"`。

### 3.2 `edit_image`（新增）

**请求**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 非空，描述要怎么改 |
| `image_paths` | string \| string[] | 是 | **本地**图片路径（工作区相对 / 绝对，经 PathSandbox）；至少 1 张；多张在 multipart 中重复字段名 `image`，不拼数组 |
| `mask_path` | string | 否 | 一张蒙版本地路径；有则只改蒙版区域 |
| `n` | integer | 否 | 正整数，默认 1 |
| `size` | string | 否 | `auto` 或 `宽x高`，默认 `auto` |
| `quality` | string | 否 | 同文生图 |
| `background` | string | 否 | `auto` \| `opaque`，默认 `auto` |
| `output_format` | string | 否 | `png` \| `jpeg`，默认 `png` |
| `output_compression` | integer | 否 | 0–100，**仅** `output_format=jpeg` 时发送 |
| `model` | string | 否 | 同文生图 |

**HTTP**

```http
POST {baseUrl}/images/edits
Authorization: Bearer <apiKey>
Accept-Encoding: identity
Content-Type: multipart/form-data; boundary=…   ← 由客户端连同 boundary 生成
```

表单字段：

- text：`model`、`prompt`、`n`、`size`、`quality`、`background`、`output_format`；（条件）`output_compression`
- file：`image` × N（字段名固定 `image`）、（可选）`mask`
- MIME 映射：`.png`→`image/png`，`.jpg`/`.jpeg`→`image/jpeg`，`.webp`→`image/webp`，其余→`application/octet-stream`；文件名用原 basename
- 入参校验：路径经 `PathSandbox.resolve`；存在且可读；魔数校验（复用 `ImageFileSupport`）；单文件上限 **20MB**（超出报错，不发请求）；不接受 URL 字符串

**返回**：与 `generate_image` 同构（含 `usage` / `revised_prompt` / 响应 `model`/`size`）。

### 3.3 错误契约（两工具统一）

| 场景 | 返回 |
|------|------|
| 参数校验失败 | `{"error":"prompt 不能为空"}` 等，不发起 HTTP |
| 无可用图片模型 | `{"error":"没有可用的文生图模型，请先在管理后台配置 model_type=image 的模型"}` |
| 上游非 2xx / 业务错误 | `{"error":"<message>","error_code":"<code|type>","http_status":429}` |
| 正文非 JSON | `{"error":"Image API <status>（非 JSON）: <正文前 500 字符>"}` |
| 超时 | `{"error":"图片接口超时（>10 分钟）","error_code":"timeout"}` |
| 连接失败 | `{"error":"图片接口连接失败: …","error_code":"network"}` |
| 异步 `task_id` | `{"error":"上游返回异步任务（task_id），本工具不轮询","error_code":"async_task_unsupported"}` |
| `data` 空 / 无图字段 | `{"error":"上游未返回图片数据","error_code":"empty_data"}` |

错误信息与 `error_code` 交给调用方 / Agent；日志中的 `apiKey` 一律脱敏（对齐 probe 的 `redact`）。

## 四、模块设计

### 4.1 目录与职责

```text
backend-ts/src/harness/tool/
  image-api-client.ts          ← 新增：共享客户端（协议唯一实现点）
  image-file-support.ts        ← 复用：MIME / 魔数 / 体积工具
  impl/
    generate-image-tool.ts     ← 改造：文生图编排
    generate-image-tool.spec.ts
    edit-image-tool.ts         ← 新增：改图编排
    edit-image-tool.spec.ts
```

### 4.2 `image-api-client.ts`（核心）

```ts
export interface ImageApiConfig {
  baseUrl: string;       // 含 /v1，无尾斜杠（客户端再统一 trim）
  apiKey: string;
  model: string;         // 已归一的完整模型名
  clientImpersonation?: string | null;
}

export interface ImageApiImage {
  bytes: Buffer;
  mime: string;
  source: 'b64_json' | 'url';
  fileName: string;      // 建议扩展名用的逻辑名
}

export interface ImageApiResult {
  images: ImageApiImage[];
  model?: string;
  size?: string;
  revisedPrompt?: string;
  usage?: Record<string, unknown>;
  rawItemMeta?: Array<Record<string, unknown>>; // generation_id 等
}

export function normalizeImageModelName(name: string): string;
export async function callImageGenerations(cfg, params: GenerateParams): Promise<ImageApiResult>;
export async function callImageEdits(cfg, params: EditParams): Promise<ImageApiResult>;
```

**实现要点（协议逐条落实）：**

1. **基址**：`baseUrl` 去尾 `/` 后拼 `/images/generations` | `/images/edits`。
2. **鉴权**：`apiKey` 已匹配 `/^Bearer\s+/i` 则原样，否则前缀 `Bearer `；日志与错误回显脱敏。
3. **公共头**：`Accept-Encoding: identity`；按需注入 `applyClientImpersonationHeaders`。
4. **超时**：`AbortSignal.timeout(600_000)`（10 分钟）；超时错误码 `timeout`。
5. **重试**：仅 `429/502/503/504` 或 JSON `error.code == 'rate_limit_exceeded'`；延迟 250ms → 1s → 2.5s 各一次；其余（含 401/400）不重试。
6. **文生图 body**：仅 `model/prompt/n/size/quality`（值为默认时可省略可选字段，或统一带上——推荐**只发送非空/非默认可选字段**，减少无谓字段）；**不**发 `response_format` 等。
7. **改图 body**：`FormData` + `Blob`（Node 18+ 全局，与 probe 一致）；禁止手写无 boundary 的 `Content-Type`；多图重复 `image` 字段；`output_compression` 仅 jpeg 时 append。
8. **响应**：`data` 必须为数组且每项 `b64_json` 或 `url`（`url` 可为 string 或 string[]，取第一个）；相对 URL 相对 `baseUrl` 解析后再下载；`task_id` 无图 → 抛 `async_task_unsupported`。
9. **模型别名**：`normalizeImageModelName`：`flare`→`gpt-image-2.5-flare`，`sunburst`→`gpt-image-2.5-sunburst`，`gpt-image-2` 原样；未知值原样透传（上游可扩展）。**失败不换模重试。**
10. **HTTP 传输**：建议统一改用 `fetch`（FormData/AbortSignal 自然），替换现 `http.request` 手写；若保留 `node:http`，则 multipart 需自行拼 boundary——不推荐。

### 4.3 `GenerateImageTool`

- 构造：`ImageModelLookup`、`uploadDir`、`getUploadBaseUrl`、`pathSandbox?`（本次可不强依赖）。
- 流程：校验参数 → 取模型（或 `model` 覆盖）→ `callImageGenerations` → 按 MIME/扩展名写入 `uploadDir/gen-<uuid>.<ext>` → 组装返回。
- `getToolPrompt()` 更新：补充 `quality`/`model`/尺寸含 `auto`、产物路径用法、无模型时引导配置后台。

### 4.4 `EditImageTool`

- 构造：同上 + **`PathSandbox`**（解析 `image_paths` / `mask_path`）。
- 流程：校验 `prompt` 与至少一张本地图 → `pathSandbox.resolve` + 存在性 + 大小 + `ImageFileSupport` 魔数 → `callImageEdits` → 落盘 `edit-<uuid>.<ext>`（`output_format` 决定默认扩展名，并以实际字节魔数兜底）→ 组装返回。
- 入参兼容：`image_paths` 接受 `string | string[]`；若模型只传了 `image`（单数）也可接受（`image` / `image_paths` 二选一，schema 以 `image_paths` 为准，prompt 中写清）。

### 4.5 配置映射（后台不变）

| 后台 `llm_model` 字段 | 客户端 |
|----------------------|--------|
| `base_url` | `baseUrl`（建议运维配到含 `/v1`、无尾 `/`；客户端再 trim） |
| `api_key` | `apiKey` |
| `model_id` | 默认 `model`（工具未覆盖时） |
| `client_impersonation` | 可选伪装头 |
| `model_type='image'` + `status=1` | `findFirstActiveImageModel()` 选取条件 |

管理后台仅需确认运维把 `model_id` 配成完整名（或别名，客户端会归一）；**无需改表、无需改 admin 表单**。

可选增强（本期不做，记入演进）：在模型备注 / 文档中说明推荐 `gpt-image-2.5-flare`（快）/ `gpt-image-2.5-sunburst`（精细编辑）/ `gpt-image-2`（兜底）。

## 五、返回落盘与展示

| 项 | 规则 |
|----|------|
| 落盘目录 | 沿用 `uploadDir`（与现 `generate_image` 一致，便于 `/uploads` URL 展示与微信/飞书发送工具衔接） |
| 文件名 | `gen-<uuid>.<ext>` / `edit-<uuid>.<ext>` |
| 扩展名 | `output_format=jpeg`→`.jpg`，`png`→`.png`；否则按魔数 `ImageFileSupport.extensionForMime`，默认 `.png` |
| `image_url` | `getUploadBaseUrl()` + 文件名；无 base 时回退本地 `image_path` |
| 对话内容 | 只回结构化 JSON 摘要字段，**永不内嵌整段 base64** |
| 下游衔接 | 产物 `image_path` 可直接被 `send_wechat_image` / `feishu_send_image` 消费（已有能力，无需改） |

## 六、同步清单（按 AGENTS.md 工具变更规范）

| # | 位置 | 改动 |
|---|------|------|
| 1 | `tool-registry.ts` | 注册 `EditImageTool`；`GenerateImageTool` 构造参数若调整则同步 |
| 2 | `tool-dispatcher.ts` `SERVER_ONLY_TOOLS` | 增加 `'edit_image'` |
| 3 | `session/util/tool-result-summarizer.ts` | `summarizeGenerateImage` 补 `quality` 可读性（可选）；**新增** `summarizeEditImage`：`编辑图片: prompt (N 张)` / `编辑图片 (失败)` |
| 4 | `desktop/src/utils/toolDisplay.ts` | `edit_image: '编辑图片'`；`getToolInputPreview` 可预览 `prompt` 或 `image_paths` 首项 |
| 5 | `desktop/src/components/chat/ToolCallGroup.vue` | `edit_image` 图标（可复用 `Picture` 或 `MagicStick`） |
| 6 | `admin/src/views/session/components/ToolCallGroup.vue` | `edit_image: '编辑图片'` |
| 7 | 测试 | 见 §七；含成功 / 失败 / 缺参 |
| 8 | `CHANGELOG.md` | 用户可见：`generate_image` 协议对齐 + 新增 `edit_image` |
| 9 | 文档 | `README`/`skills/mao-cli` 若提及图片能力则补改图一句；本方案归档 `docs/plan/` |

## 七、测试计划

### 7.1 单元测试（Vitest，本地 mock HTTP）

**`generate-image-tool.spec.ts`（扩展）**

- 成功：`data[].b64_json` 落盘、返回 `image_url`/`image_path`/`usage`/`revised_prompt`；响应 `model`/`size` 以响应为准。
- 成功：仅 `url`（含相对路径）→ 下载落盘，`source=url`。
- 参数：缺 `prompt`；`n` 越界钳制到 1–10；`size`/`quality` 透传；`model` 别名归一后出现在请求 body。
- 协议：请求 body **不含** `response_format`/`background`/`image`/`mask`；含 `Accept-Encoding: identity`；`Bearer` 不双加。
- 失败：无模型；HTTP 400（不重试）；HTTP 429（重试后仍败则返回 `http_status`）；`task_id`；`data: []`；非 JSON 正文；超时（可缩短 timeout 注入测试）。
- `clientImpersonation=codex` 头注入（保留现有用例）。

**`edit-image-tool.spec.ts`（新增）**

- 成功：multipart 含 `model/prompt/n/size/quality/background/output_format`；`image` 文件字段名与 MIME 正确；多图重复 `image`；`mask` 可选；`output_compression` 仅 jpeg。
- 路径：工作区相对路径可解析；越界路径被 PathSandbox 拒绝；缺文件 / 超 20MB / 非图片魔数。
- 缺参：无 `prompt`；`image_paths` 空。
- 失败路径与文生图共用客户端用例可抽测客户端。

**`image-api-client` 专项（若单独导出）**

- 别名归一表；Bearer 判重；重试次数与退避；相对 URL 解析；错误脱敏（日志不含 apiKey）。

### 7.2 回归 / 手工

- 管理后台配置一条 `model_type=image`（可用 sub2api + `gpt-image-2.5-flare`）→ 桌面会话：「画一只橙色小猫」→ 出图卡片；「把小猫改成蓝色」→ `edit_image` 出图。
- 微信 / 飞书通道：`generate_image` 后 `send_wechat_image` 衔接不受影响。
- `npm run build` + `cd backend-ts && npm test`（长输出先落盘再 grep 摘要）。

## 八、实施步骤（建议顺序）

| 步骤 | 内容 | 产出 |
|------|------|------|
| 1 | 落地 `image-api-client.ts` + 单测 | 协议唯一实现点 |
| 2 | 改造 `GenerateImageTool` 接客户端，删本地 `postJson` | 协议对齐的文生图 |
| 3 | 新增 `EditImageTool` + 单测 | 改图能力 |
| 4 | 注册 / 分发 / 摘要 / 桌面 / admin 展示同步 | 全链路可见 |
| 5 | CHANGELOG + 文档（含 mao-cli 一句） | 发版说明 |
| 6 | 对 mock + 真实 sub2api 各跑一轮 generate / edit | 验收 |

## 九、风险与对策

| 风险 | 对策 |
|------|------|
| 移除 `response_format: 'b64_json'` 后旧网关只回 `url` | 客户端已强制支持 `url` 下载落盘；不依赖 b64 |
| 上游对多余字段严格校验 | 严格只发协议字段；可选字段省略默认值 |
| 10 分钟长请求占用 Agent 循环 | 与协议一致；错误可重试由 Agent 决定；后续可演进为后台任务（本期不做） |
| 多图 / 大图 multipart 内存 | 单文件 20MB 上限 + 文件流式读入 Buffer（与 probe 一致）；超限直接报错 |
| 换模型后行为差异 | 工具提示词写明 flare/sunburst 用途；点名不换模 |
| 历史会话工具卡片 | `edit_image` 为新名，旧记录无影响；`generate_image` 返回字段只增不删，摘要向后兼容 |

## 十、验收标准

1. `generate_image` 请求/响应/头/超时/重试/错误与《图片生成 / 编辑 API 对接说明》一致（抽样对照 probe 请求形状）。
2. `edit_image` 可对工作区本地图（1–N 张）+ 可选 mask 完成改图，产物落盘并可在聊天中展示。
3. 模型仍仅来自后台 `model_type=image`；工具内无写死 key/URL/模型名。
4. 缺参、上游失败、超时、异步 task 均返回 §3.3 错误契约，且日志无 apiKey 明文。
5. 摘要、桌面 / admin 工具名与图标、`SERVER_ONLY_TOOLS`、单测（成功/失败/缺参）全部同步到位。
