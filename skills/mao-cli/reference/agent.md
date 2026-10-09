# Agent 模块（agent）

## 模块职责

管理用户可见的 Agent：列表、详情、创建、更新、删除，以及 Agent 经验（experience）独立 CRUD。Agent 可另配推荐问题（suggestedQuestions，Embed SDK 空白态展示，最多 5 条），随创建/更新全量同步，无独立子命令。

## Agent 头像（REST / 管理后台）

- `POST /api/v1/agents/avatar`：需登录及 `agent:write`，以 multipart 字段 `file` 上传 PNG / JPEG / WebP，最大 2 MiB。服务端校验内容并转为 PNG，返回 `data: { avatarUrl: "/uploads/<uuid>.png" }`。
- 创建 / 更新 Agent 的 JSON 支持 `avatarUrl`，使用上传返回的路径；更新省略字段保留原头像，传 `null` 清空。上传本身不修改 Agent，随后保存才生效。
- 列表和详情的 `avatarUrl` 为头像路径或 `null`，供客户端、后台及 SDK 共用；跨域调用方以 Mao 服务端 origin 解析 `/uploads/` 路径。
- 头像为公开展示资源，不要上传敏感内容。CLI 暂无专用头像上传/设置参数，使用管理后台或 REST。

## 角色定义与运行时注入

管理后台 / CLI 的 `systemPrompt`（角色定义）只写身份、业务目标、文风和领域禁忌。通道规则由引擎按会话注入，不要复制进每个 Agent：

- **嵌入网页浮窗**（会话持有 `page_*`）：页面上下文协议、可见范围、page 工具纪律、截图展示、安全边界、窄浮窗交互；不注入编程工作区 / `AGENTS.md`。
- **桌面 / CLI 编程会话**：工作目录、文件与 shell 用法、上传文件、`AGENTS.md`。
- **微信**：另有媒体发送说明与默认经验。
- **能力插件**：有对应工具才追加（待办、子代理、技能目录等）。

已写过页面上下文或「不要 glob 当前页」的旧提示词可删掉重复段，避免与系统注入叠床架屋。经验仍走「最佳实践」表。

## 系统提示词版本（REST / 管理后台）

创建及更新提示词会自动保存版本；内容不变不新增版本。管理后台「Agent 管理 → 提示词版本」支持预览和确认回滚，详见 [admin.md](admin.md#系统提示词版本与回滚)。现有 Agent 在迁移时保留当前提示词为 v1，无法恢复迁移前已覆盖的内容。

以下接口均要求 `agent:write` 权限（路径相对于 `/api/v1`）；CLI 暂无专用子命令：

| 操作 | 接口 | 返回 |
|------|------|------|
| 历史列表 | `GET /agents/:id/prompt-versions` | 按版本倒序的数组，包含 `id`、`agentId`、`version`、`systemPrompt`、`operatorId`、`sourceVersion`、`createdAt` |
| 回滚 | `POST /agents/:id/prompt-versions/:version/rollback` | 最新 Agent 详情；`:version` 为正整数版本号，无需请求体 |

回滚仅恢复提示词并生成带 `sourceVersion` 的新版本，不删除历史、不改动其他 Agent 配置。目标内容与当前一致时不重复生成版本。普通 `agent create/update` 命令同样触发服务端自动版本记录。


## 命令选择

| 场景 | 命令 |
|------|------|
| 搜索/列出 Agent | `agent list` |
| 查看详情 | `agent get` |
| 新建 | `agent create` |
| 修改 | `agent update` |
| 停用/启用 | `agent set-enabled` |
| 删除 | `agent delete` |
| 导出 bundle（跨实例搬运） | `agent export` |
| 导入 bundle | `agent import` |
| 经验列表 | `agent experience list` |
| 新增经验 | `agent experience create` |
| 更新经验 | `agent experience update` |
| 删除经验 | `agent experience delete` |

---

## Agent Bundle 导出/导入（跨实例搬运）

把 Agent（主体 + 经验 + 推荐问题 + 当前提示词 + 技能 + MCP 定义）打包为 `mao-agent-bundle` v1 JSON，用于自托管实例之间交换或离线备份。两个命令均需 `agent:write`；格式契约与脱敏规则（MCP env 值全量替换 `$MAO_REDACTED`、HTTP url 不脱敏）见仓库 [docs/guides/agent-bundle-format.md](../../docs/guides/agent-bundle-format.md)。

导入为两段式：缺省 `confirm=false` 仅输出预检报告（名称冲突、技能/MCP 逐项动作、警告），`--confirm` 落库（服务端重新执行全部校验）。导入生成全新 Agent：名称冲突自动加“ 副本”后缀；MCP 以停用态创建、同名跳过且不绑定，需在管理端补齐 env 并手动启用；内联技能写入系统技能目录（同名不覆盖）。`configJson` 原样搬运；`defaultModelId` 置空、`isDefault=0`、`enabled=1`、起提示词版本 v1。团队共享目录（上架/下架/推荐语）暂无 CLI 子命令，REST 见下文“团队共享目录”。

---

## 命令：mao agent export

### 用途

导出 Agent bundle 到 JSON 文件（MCP 环境变量值全量脱敏，零密钥出包）。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `<id>` | 是 | 数字 | Agent ID（位置参数；兼容 `--id`） |
| `--inline-skills` | 否 | 逗号分隔 | 内联导出的用户技能，格式 `name` 或 `name@userId`（同名多归属时必须带 `@userId`）；系统技能不能内联 |
| `-o` / `--out` | 否 | 字符串 | 输出文件路径，缺省 `./mao-agent-bundle-<名称>-v1.json` |

内联技能文本总量上限 10MB，超出报错（提示改用引用方式）。`--json` 时额外输出 bundle 内容。

### 示例

```bash
mao agent export 3
mao agent export 3 --inline-skills code-review@12,packer -o ./reviewer.json
```

---

## 命令：mao agent import

### 用途

导入 bundle。缺省输出人类可读的预检报告且不落库；`--confirm` 执行导入并输出最终名称与 agentId。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `<文件>` | 是 | 字符串 | bundle JSON 文件路径（位置参数；兼容 `--file`） |
| `--confirm` | 否 | 布尔 | 确认落库 |

### 示例

```bash
mao agent import ./mao-agent-bundle-代码评审员-v1.json
mao agent import ./reviewer.json --confirm
```

---

## 团队共享目录（REST）

管理员将启用中的 Agent 上架到工作台“团队共享”分区（登录即可读，写路径需 `agent:write`；CLI 暂无子命令）：

| 操作 | 接口 | 说明 |
|------|------|------|
| 列表 + 依赖自检 | `GET /api/v1/shared-agents` | 按 `sortOrder asc, agentId asc` 返回条目；`missingSkills` 为当前用户缺失的技能，`mcpIssues` 形如 `context7（已停用）`；`sourceUrl` 为条目远端来源（可空） |
| 依赖一键补装 | `POST /api/v1/shared-agents/:agentId/fix-deps` | 登录即可；缺失的用户技能自动安装到**操作者本人**名下（多归属/无属主/名称非法逐项标注），MCP 停用需操作者有 `mcp:write`（无则报 needs-admin）；响应含重算后的 `selfCheck` |
| 上架/更新 | `PUT /api/v1/agents/:id/shared-entry` | body `{ note, sortOrder, sourceUrl? }`，note ≤512，sourceUrl 为可选 registry URL（≤1024，http/https，空串清除）；停用中的 Agent 报错“请先启用该 Agent”；重复上架即更新 |
| 下架 | `DELETE /api/v1/agents/:id/shared-entry` | 幂等 |

Agent 删除时条目级联删除；停用时条目保留、列表隐藏，重新启用即恢复展示。

---

## Bundle registry 与 URL 导入/检查更新（REST）

跨实例分发的只读源与远端变更感知（均需先在源实例「系统设置 → Agent 资产」开启 Bundle registry，默认关闭；CLI 暂无子命令）：

| 操作 | 接口 | 说明 |
|------|------|------|
| registry 拉取 | `GET /api/v1/agent-bundle/registry/:agentId` | 免登录（源实例开启后）；响应为 bundle JSON 本体 + `X-Mao-Content-Hash` 头；配置了 accessToken 时须带 `?token=` 或 `X-Mao-Registry-Token`；不存在/停用/未授权一律 404；同名歧义/超 inline 上限返回 409 |
| URL 导入 | `POST /api/v1/agent-bundle/import-from-url` | `agent:write`；body `{ url, confirm? }`，服务端拉取（http/https、10s 超时、20MB 上限、禁用重定向）后完全复用文件导入两段式；confirm 落库后写入导入来源（source_url + contentHash + systemPrompt 快照） |
| 检查更新 | `POST /api/v1/agent-bundle/check-updates` | `agent:write`；body `{ agentIds? }` 缺省=全部有来源的 Agent；逐项返回 `{ changed, localEdited, originHash, remoteHash, error? }`，changed 以导入时快照 hash 为基准，localEdited 仅覆盖 systemPrompt 漂移 |

更新应用 = 对该 URL 重新走 import-from-url 两段式生成**新副本**（名称冲突自动加“副本”后缀），旧 Agent 原样保留。

## 技能独立 Bundle（mao-skill-bundle v1，REST）

技能的独立搬运格式（格式契约见仓库 [docs/guides/agent-bundle-format.md](../../docs/guides/agent-bundle-format.md)）：

| 操作 | 接口 | 说明 |
|------|------|------|
| 导出 | `GET /api/v1/skill-bundles/:name` | 系统技能（无 `owner` 参数）要求 `skill:read`；`?owner=<userId>` 导出指定用户技能，本人即可、他人需 `skill:read`；响应为 bundle JSON 本体。同一用户多个目录 frontmatter 同名时拒绝导出并列出目录，不静默取第一个 |
| 导入 | `POST /api/v1/skill-bundle/import` | `skill:write`；body `{ bundle, confirm? }` 两段式写入**系统技能目录**，同名 exists-skip 不覆盖 |

---

## 命令：mao agent list

### 用途

列出使用侧可见的 Agent。默认只返回启用中的 Agent；已停用的不会出现，也不能用来新建会话。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--keyword` | 否 | 字符串 | 按名称等关键词过滤，对应查询参数 `keyword` |
| `--include-disabled` | 否 | 布尔 | 同时列出已停用 Agent。需要 `agent:read` 或 `agent:write`，否则服务端忽略 |

### 示例

```bash
mao agent list --keyword 助手 --json
mao agent list --include-disabled --json
```

返回元素含 `enabled`（布尔）。管理后台列表使用 `includeDisabled=true`。

---

## 命令：mao agent set-enabled

### 用途

停用或启用 Agent。需要 `agent:write`。默认 Agent 不能停用；已停用的 Agent 不能设为默认。停用后使用侧列表不再展示，且不能用它新建会话。已有会话可以继续。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | Agent ID |
| `--enabled` | 是 | 布尔 `true/false` | `true` 启用，`false` 停用 |

`PATCH /agents/{id}/enabled`，请求体 `{ "enabled": true|false }`。

### 示例

```bash
mao agent set-enabled --id 3 --enabled false
mao agent set-enabled --id 3 --enabled true
```

---

## 命令：mao agent get

### 用途

按 ID 获取 Agent 详情（含 tags、skillNames、experiences、suggestedQuestions、enabled）。已停用的 Agent 仍可按 ID 查看。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | Agent ID |

### 示例

```bash
mao agent get --id 1
```

---

## 命令：mao agent create

### 用途

创建 Agent。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--name` | 是 | 字符串 | Agent 名称 → `name` |
| `--system-prompt` | 是 | 字符串 | 角色定义（身份、业务目标、文风）→ `systemPrompt`；通道规则由引擎注入，不必写在这里 |
| `--description` | 否 | 字符串 | 描述 → `description` |
| `--tags` | 否 | 逗号分隔字符串 | 标签列表 → `tags` 数组 |
| `--skill-names` | 否 | 逗号分隔字符串 | 绑定技能名 → `skillNames` 数组 |
| `--experiences-json` | 否 | JSON 字符串 | 经验数组 → `experiences`。元素字段：`content`（字符串）、`sortOrder`（整数）、`enabled`（布尔）、可选 `id` |
| `--suggested-questions-json` | 否 | JSON 字符串 | 推荐问题数组 → `suggestedQuestions`。元素字段：`content`（字符串，1～100 字）、`sortOrder`（整数）、可选 `id`；最多 5 条 |
| `--is-default` | 否 | 布尔 `true/false` | 是否设为默认 Agent → `isDefault` |
| `--default-model-id` | 否 | 数字 | Agent 默认模型 ID（须为启用中的文本模型）→ `defaultModelId`；`0` 表示清除 |

### 参数约束

- `name`、`systemPrompt` 不能为空
- `--experiences-json` 必须是合法 JSON 数组

### 示例

```bash
mao agent create \
  --name '代码助手' \
  --system-prompt '你是资深工程师' \
  --tags 'dev,code' \
  --skill-names 'git-helper' \
  --experiences-json '[{"content":"优先读 README","sortOrder":0,"enabled":true}]'
```

---

## 命令：mao agent update

### 用途

更新已有 Agent。至少提供一个可更新字段。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | Agent ID |
| `--name` | 否 | 字符串 | 新名称 |
| `--description` | 否 | 字符串 | 新描述 |
| `--system-prompt` | 否 | 字符串 | 新角色定义（身份、业务目标、文风） |
| `--tags` | 否 | 逗号分隔 | 覆盖标签 |
| `--skill-names` | 否 | 逗号分隔 | 覆盖技能名 |
| `--experiences-json` | 否 | JSON | 覆盖经验列表 |
| `--suggested-questions-json` | 否 | JSON | 覆盖推荐问题列表 |
| `--is-default` | 否 | 布尔 | 是否设为默认 Agent |
| `--default-model-id` | 否 | 数字 | Agent 默认模型 ID；`0` 表示清除（回退系统默认模型） |

### 示例

```bash
mao agent update --id 1 --description '更新说明'
```

---

## 命令：mao agent delete

### 用途

删除 Agent。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | Agent ID |

### 示例

```bash
mao agent delete --id 1
```

---

## 命令：mao agent experience list

### 用途

列出某 Agent 的经验条目。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 是 | 数字 | Agent ID |

### 示例

```bash
mao agent experience list --agent-id 1
```

---

## 命令：mao agent experience create

### 用途

为 Agent 新增一条经验。

### 参数说明

| 参数 | 必填 | 类型 | 默认值 | 含义 |
|------|------|------|--------|------|
| `--agent-id` | 是 | 数字 | — | Agent ID |
| `--content` | 是 | 字符串 | — | 经验正文 → `content` |
| `--sort-order` | 否 | 整数 | 服务端默认 | 排序 → `sortOrder` |
| `--enabled` | 否 | 布尔 `true/false` | 服务端默认 | 是否启用 → `enabled` |

### 示例

```bash
mao agent experience create --agent-id 1 --content '先搜索再改代码' --sort-order 1 --enabled true
```

---

## 命令：mao agent experience update

### 用途

更新一条经验。至少提供一个字段。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 是 | 数字 | Agent ID |
| `--id` | 是 | 数字 | 经验 ID |
| `--content` | 否 | 字符串 | 新内容 |
| `--sort-order` | 否 | 整数 | 新排序 |
| `--enabled` | 否 | 布尔 | 是否启用 |

### 示例

```bash
mao agent experience update --agent-id 1 --id 9 --enabled false
```

---

## 命令：mao agent experience delete

### 用途

删除一条经验。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--agent-id` | 是 | 数字 | Agent ID |
| `--id` | 是 | 数字 | 经验 ID |

### 示例

```bash
mao agent experience delete --agent-id 1 --id 9
```
