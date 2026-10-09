# mao-agent-bundle v1 格式契约

mao-agent-bundle 是 Mao 的 Agent 资产搬运格式：把一个调教好的 Agent（主体 + 经验 + 推荐问题 + 当前生效提示词 + 技能 + MCP 定义）打包为单个 JSON 文件，用于跨实例（自托管环境之间）交换，或作为离线备份。

- 导出：`GET /api/v1/agents/:id/bundle`（需 `agent:write`），或 CLI `mao agent export <id>`。
- 导入：`POST /api/v1/agent-bundle/import`（需 `agent:write`，两段式：`confirm=false` 预检 → `confirm=true` 落库），或 CLI `mao agent import <file> [--confirm]`。
- admin 管理后台 Agent 管理页提供等价的导入/导出向导。

## 文件基本约束

- UTF-8 编码的 JSON 文本，顶层是一个 JSON 对象。
- 文件名建议 `mao-agent-bundle-<名称>-v1.json`（服务端导出响应带 `Content-Disposition: attachment`）。

## 顶层结构

```json
{
  "format": "mao-agent-bundle",
  "formatVersion": 1,
  "exportedAt": "2026-10-02T00:00:00.000Z",
  "agent": {
    "name": "代码评审员",
    "description": "负责 PR 评审的助手",
    "systemPrompt": "<当前生效版本全文>",
    "configJson": { "compaction": { "contextWindowTokens": 100000 } }
  },
  "experiences": [
    { "content": "先读变更说明再逐文件评审", "sortOrder": 0, "enabled": true },
    { "content": "历史经验（停用）", "sortOrder": 1, "enabled": false }
  ],
  "suggestedQuestions": [
    { "content": "帮我评审最近的 PR", "sortOrder": 0 }
  ],
  "skills": [
    { "name": "code-review", "include": "inline", "files": { "SKILL.md": "…", "scripts/run.py": "…" } },
    { "name": "web-search", "include": "reference" }
  ],
  "mcpServers": [
    {
      "name": "context7",
      "definition": {
        "serverType": "STDIO",
        "command": "npx",
        "args": ["-y", "ctx7-mcp"],
        "url": null,
        "env": { "API_KEY": "$MAO_REDACTED" }
      }
    }
  ]
}
```

## 字段说明

### 顶层

| 字段 | 类型 | 说明 |
|------|------|------|
| `format` | string | 固定 `"mao-agent-bundle"`。其它取值被导入端拒绝 |
| `formatVersion` | number | 当前 `1`。导入端不识别的版本明确报错；未来演进以整数递增，旧版本兼容策略届时另行约定 |
| `exportedAt` | string | ISO-8601 导出时间，仅 informational |
| `agent` | object | 必填。见下 |
| `experiences` | array | 最佳实践经验。单条 content 1～300 字；超限条目导入时跳过并列入预检 `warnings` |
| `suggestedQuestions` | array | 推荐问题。最多 5 条、单条 1～100 字；超限整体导入失败 |
| `skills` | array | **skillNames 全量**（与是否内联无关） |
| `mcpServers` | array | MCP 定义。可选 |

### agent

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 必填，≤128 字符。与目标实例现有 Agent 重名时导入自动加“ 副本”/“ 副本2”…后缀 |
| `description` | string \| null | 描述 |
| `systemPrompt` | string | 必填非空。导入后作为提示词版本 v1 起版 |
| `configJson` | object \| null | 原样搬运（当前仅 Harness 压缩配置覆盖项） |

### skills[].include

- `"reference"`：只带名字，目标实例需自行安装同名技能（系统技能或任意用户的用户技能）。导入预检中缺失标记为 `missing`，不阻断导入。
- `"inline"`：`files` 携带技能目录全部文本文件（“相对技能目录路径 → 文件内容”的扁平 map）。仅用户技能可内联；系统技能同名时导入跳过（不覆盖目标实例）。`files` 中二进制文件在导出时已跳过并在 `warnings` 标注。

### mcpServers[].definition

| 字段 | 类型 | 说明 |
|------|------|------|
| `serverType` | string | `"STDIO"` 或 `"HTTP"` |
| `command` / `args` | string / string[] | STDIO 必填（args 非空数组）；HTTP 时为 null |
| `url` | string \| null | HTTP 必填（http:// 或 https:// 开头）；STDIO 时为 null |
| `env` | object | 键名保留，**值一律为 `$MAO_REDACTED`**（见脱敏规则） |

## 脱敏规则（重要）

1. **env 值全量替换为 `$MAO_REDACTED`**：不做按键名模式识别（宁多勿漏），导出端把 MCP 环境变量解密后的所有值统一替换。正常导出的 bundle 中不存在任何明文密钥。
2. **HTTP url 不脱敏**：URL 查询串可能内嵌凭证，但导出是管理员主动动作、导入预检报告会完整展示 definition，管理员可在确认前自查。该边界是格式契约的一部分，社区分享 bundle 前请检查 url。
3. **导入端不落任何明文值**：`env` 的所有值（无论是否占位符）导入时统一置为空字符串、键名保留——管理员在 MCP 编辑页可见需补填哪些键，补齐并手动启用后生效。因此 bundle 不能用来搬运密钥。

## 版本演进策略

- 只做向后兼容的新增字段（可选字段），递增 `formatVersion` 主版本需同时提供迁移说明。
- 导入端遇到不识别的 `format` / `formatVersion` 报 `2001 参数校验失败`（“不支持的 bundle 格式”），不尝试猜测。

## 语义边界（导入端行为）

- 导入即复制：Agent 全新创建（`enabled=1`、`isDefault=0`、`defaultModelId=null`、头像为空、创建人为操作管理员），与源实例此后各自演进，无同步。
- MCP 一律以 `DISABLED` 状态新建（全局空间，描述注明“由 bundle 导入”），同名（跨全局与用户空间）跳过且不绑定。
- 内联技能写入目标实例系统技能目录（`validateSkillMd` 校验 + 暂存交换原子落盘），同名系统技能不覆盖。
- 两段式导入：`confirm=false` 返回预检报告（名称冲突、技能/MCP 逐项动作、警告）；`confirm=true` 服务端**重新执行全部校验**后落库，不信任预检结果。

## registry 只读端点（跨实例 URL 导入）

源实例在「系统设置 → Agent 资产」开启 Bundle registry（默认关闭）后，本实例即成为 bundle 只读源：

```
GET /api/v1/agent-bundle/registry/:agentId
```

- 免登录（自托管内网场景）；配置了 accessToken 时须携带 `?token=` 请求参数或 `X-Mao-Registry-Token` 请求头（非常量时间比较）。
- 响应为 bundle JSON 本体（非 Result 信封），附带 `X-Mao-Content-Hash` 响应头：bundle 内容指纹（sha256），剔除 `exportedAt`、对象键递归排序后计算，跨实例/跨时间可比。
- Agent 不存在、停用、开关关闭、token 错误一律 404（不暴露存在性）；同名技能多归属或超 inline 上限导致导出失败返回 409 + `{ error, detail[] }`。
- registry 导出对 Agent 的用户技能按 `name@userId` 显式 token 全量内联（URL 导入的完整性与 fix-deps 补装依赖这一点）。
- 每次拉取记录访问日志（审计）。

### skills[].sourceUrl（预留格式位）

`skills[]` 条目允许出现可选字段 `sourceUrl`（仅 reference 条目），当前版本导出端不填、导入端忽略（逐字段读取天然兼容旧包）。字段仅为未来"按来源补装技能"预留。

### contentHash 规范

```
canonicalize(bundle):
  1. 浅拷贝，删除 exportedAt
  2. 递归排序所有对象键（数组保序）
  3. JSON.stringify（无空格）
contentHash = sha256(canonicalized).hex()
```

check-updates 的比对基准是**导入时快照**（`agent_import_origin.content_hash`），而非本地重新导出的 hash——导入有损（同名 MCP 跳过、重复技能去重、超限经验跳过）时后者会产生永久假阳性。

## mao-skill-bundle v1（技能独立 Bundle）

技能的独立搬运格式，约束对齐 agent bundle inline 技能（纯文本、隐藏路径段丢弃、路径穿越拒绝、总量 ≤10MB）：

```json
{
  "format": "mao-skill-bundle",
  "formatVersion": 1,
  "exportedAt": "2026-10-05T00:00:00Z",
  "skill": { "name": "code-review", "description": "..." },
  "files": { "SKILL.md": "...", "scripts/run.md": "..." },
  "warnings": ["binary file skipped: assets/logo.bin"]
}
```

- `SKILL.md` 必须存在且通过 `validateSkillMd`（frontmatter `name` 为 slug 且与 `skill.name` 一致，`description` 必填）。
- **files 为纯文本**：二进制文件（可执行脚本、图片等）导出即跳过并在 `warnings` 标注——含二进制资产的技能包不完整，导入后需手工补齐。
- 导出：`GET /api/v1/skill-bundles/:name`（系统技能需 `skill:read`；`?owner=<userId>` 导出用户技能，本人即可、他人需 `skill:read`），响应为 bundle JSON 本体 + attachment 头。同一用户有多个目录的 frontmatter 名相同则拒绝导出，并在错误里列出这些目录，不静默取第一个。
- 导入：`POST /api/v1/skill-bundle/import`（`skill:write`，两段式 `confirm=false` 预检 → `confirm=true` 落库），写入**系统技能目录**，同名系统技能 `exists-skip` 不覆盖；`SKILL.md` 缺失/校验失败/frontmatter 不一致/路径穿越/超限以 `action=invalid` 在报告中逐项返回。
- 导入端不识别的 `format` / `formatVersion` 报 `2001 参数校验失败`；`files` 值必须全为字符串。
