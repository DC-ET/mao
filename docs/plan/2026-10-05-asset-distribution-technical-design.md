# 资产分发闭环技术方案：依赖一键补装 + URL 导入/更新检查 + 技能 Bundle

- 状态：技术方案，待实施（2026-10-05 评审补充版：registry 内联策略与错误映射、fix-deps 无属主/入口校验分支、check-updates hash 基准等，见 §5、§8、§10.7–10.12）
- 日期：2026-10-05
- 提案来源：[docs/proposals/2026-10-05-asset-distribution.md](../proposals/2026-10-05-asset-distribution.md)
- 前置：Agent 资产化已实施（0.0.236），本文所有改动建立在其产物之上（`agent-bundle.service.ts`、`shared-agent.service.ts`、V132 `shared_agent_entry`）

## 1. 需求背景

资产化已交付 bundle 导出/导入（两段式预检、`$MAO_REDACTED` 脱敏）与团队共享目录（上架 + 依赖自检）。分发链仍有三个断点：

1. **自检之后没有动作**：工作台共享分区提示"缺 2 个技能"即止，用户需自行到设置页上传 zip、新建 MCP。
2. **跨实例靠文件互拷**：导出 JSON → 聊天工具传 → 手工导入；无 URL 直达，无"远端有更新"的感知。
3. **技能无独立搬运格式**：技能在 bundle 中只是 inline/reference 附属品，单独分享仍要走 zip 上传。

## 2. 需求描述

### 2.1 目标（全部要做）

1. 共享目录条目支持**依赖一键补装**：缺失的用户技能自动安装到当前用户名下；MCP 问题给出可修性分类，管理员可一键修复。
2. bundle 支持 **URL 导入**：任意自托管实例可作为只读 bundle 源（默认关闭，管理员显式开启）；导入来源落库，支持批量**检查更新**。
3. 技能获得独立 bundle 格式（`mao-skill-bundle` v1），可独立导出/导入。

### 2.2 非目标（明确不做）

- 不做评分/评论/排行榜（Java 时代 Hub 教训）。
- 不做跨实例自动同步/推送；**更新检查只提示，应用永远生成新副本**，不覆盖任何现有 Agent（见 §10 决策 2）。
- 不做用户间点对点分享（管理员上架仍是唯一出口）。
- 不做 registry 的浏览/列表页（registry 只按 agentId 精确拉取，不做发现协议）。
- 不改 mao-agent / 桌面 LOCAL 链路。

## 3. 范围界定：做 / 不做清单

### 3.1 做什么

| 层 | 内容 |
|---|---|
| backend-ts | `UserSkillService.installUserSkillFiles`（内存文件安装用户技能）；`SharedAgentService.fixDependencies`；bundle registry 只读端点 + URL 导入 + 批量检查更新；V134 迁移（`agent_import_origin` 表 + `shared_agent_entry.source_url` 列）；`mao-skill-bundle` v1 导出/导入；settings 新增 registry 开关组 |
| admin | AgentListView 导入对话框加「从 URL 导入」页签；Agent 列表「检查更新」入口；SharedEntryDialog 加 `source_url` 字段与"远端有更新"角标；SystemSettingsView 加 registry 开关面板 |
| desktop | AgentSelector 团队共享分区每条目加「修复依赖」按钮（自检非空时显示），完成后刷新 store |
| 文档 | `docs/guides/agent-bundle-format.md` 增补 registry 端点与 `mao-skill-bundle` v1 格式 |

### 3.2 不做什么（与"做"同等明确）

- 不改 bundle v1 主体格式与导入语义（仅给 `BundleSkill` 增量可选字段 `sourceUrl`，见 §5.9）。
- 不新增权限码：复用 `agent:write`、`mcp:write`、`skill:read`、`skill:write`。
- 不做导入历史的版本树/时间线（`agent_import_origin` 只存最近一次来源）。
- 不做 registry 的 token 签发体系（可选访问 token 是静态字符串）。
- 不做飞书/钉钉/微信端的补装入口（共享分区仅在桌面端）。

## 4. 技术选型

零新增依赖。哈希用 `node:crypto` 的 sha256；HTTP 拉取用 Fastify 侧已有的 fetch（Node 22 全局 fetch）；安装写盘复用 `staged-skill-writer.ts` 与 `user-skill.service.ts` 的暂存交换/备份恢复机制。向量、存储、消息均不涉及。

## 5. 详细设计

### 5.1 自检口径回顾（fix-deps 的输入）

`SharedAgentService.listSharedAgents`（`shared-agent.service.ts:84`）按当前用户实时计算两类问题：

- `missingSkills`：skillNames 中既不在系统技能目录（`SkillLoader.hasSkill`）、也不在当前用户用户技能（frontmatter 名匹配）中的名字。**能出现在这里的一定是其他用户的用户技能**（系统技能缺失不可能）。
- `mcpIssues`：agent.mcpServerIds 逐 id `findById`——不存在 → `MCP#id（不存在）`；存在但 `status !== ENABLED` → `name（已停用）`。

运行时按 **id** 解析 MCP 绑定（`harness/mcp/local/mcp-sync-service.ts:26` 直接解析 agent.mcpServerIds 的 id 数组），且用户级启停偏好只能作用于 ENABLED 的 server（`McpServerService.validatePreferenceTarget` 对 DISABLED 直接拒绝）。这决定了 fix-deps 对 MCP 的正确语义（§5.3）。

### 5.2 P1：用户技能一键补装

**新方法** `UserSkillService.installUserSkillFiles(userId, skillName, files: Record<string, string>): SkillResult<string>`：

- 校验链完全对齐 bundle 导入侧（`agent-bundle.service.ts:551` buildImportPlan 的 inline 分支）：`validateSkillMd(files['SKILL.md'], skillName)`、SKILL.md frontmatter name 与 skillName 一致、隐藏路径段过滤（`isHiddenRelativePath` 同规则）、路径穿越拒绝。
- 落盘复用 `uploadUserSkill` 的暂存交换机制（stage → swap → backup → 失败恢复），等价于把"内存 files"走一遍 upload 的 `writeSkillGroup`/`swapStagedSkill`；调用后原技能不存在（自检缺失是前置条件），无需覆盖保护，但保留备份恢复以兜底并发。
- 大小限制沿用上传口径（单文件与总量限制对齐 zip 上传现有逻辑）。

**复制来源与属主分支**：用 `UserSkillService.listAllUserSkills()`（返回全量 name + userId + folderPath）按 frontmatter 名定位候选属主，读盘复用 bundle 导出的 `readUserSkillFiles` 逻辑（提取为可复用函数；文本文件、隐藏文件跳过、二进制跳过并告警）：

- **唯一属主** → 复制安装到当前用户名下。
- **多候选**（`candidates.length > 1`，涵盖"不同用户同名技能"与"同一用户多个同名目录"两种——listAllUserSkills 按 folderPath 逐条返回，两种形态相同）→ 该项标记 `ambiguous` 跳过，detail 列出属主 userId 列表，提示联系管理员整理（与 bundle 导出对多归属报错同口径，不静默选一个）。
- **无属主**（实例内已无任何同名技能）→ 该项标记 `failed`，detail "实例内已不存在该技能（可能已被删除）"，不中断其余项。**"同一实例内必有属主"不成立**：agent.skillNames 无格式校验，空串/路径片段会进 missingSkills（`computeMissingSkills` 对空串判缺失）；共享时的属主也可能事后删除了技能。

**入口校验（必须）**：fix-deps 的 skillName 来自 DB 的 `agent.skillNames`，不经过 `parseAndValidateBundle`，用作目录名前必须显式重过 `isValidBundleSkillName` 同款校验（非空白、≤64、不含 `/` `\`、非 `..`、无前导 `.` 与控制字符），不合法直接归 `failed`（detail 注明名称非法），不进入属主定位。`swapStagedSkill` 的 userRoot 前缀检查仅是写盘兜底，不能替代前置校验。

### 5.3 P1：MCP 可修性分类（修正提案语义）

提案原文"缺的用户级 MCP 一键建为停用态"**不成立**：新建副本不会改变共享 Agent 的 mcpServerIds 绑定（按 id 解析），装了也用不上。修正为按操作者权限分类：

| mcpIssues 条目 | 分类 | 可修动作 |
|---|---|---|
| `MCP#id（不存在）` | `dangling` | 无（需在 Agent 编辑中移除引用，fix-deps 不代办） |
| `name（已停用）`，操作者有 `mcp:write` | `will-enable` | 直接 `PUT` 同款逻辑启用（等价 MCP 管理页手动启用），成功后 `enabled` |
| `name（已停用）`，操作者无 `mcp:write` | `needs-admin` | 无动作，detail 提示"需管理员在 MCP 管理页启用" |

启用动作走 `McpServerService` 现有状态更新路径（与 `PUT /v1/mcp-servers/:id/status` 同一 service 方法），不绕过校验。

### 5.4 P1：API 与报告结构

```
POST /v1/shared-agents/:agentId/fix-deps    （登录用户；仅本人触发）
```

前置校验：agentId 必须在共享目录（`shared_agent_entry` 存在）且 Agent 启用，否则 `AGENT_NOT_FOUND`/`PARAM_INVALID`。

响应 `data`（`FixDepsReport`）：

```ts
{
  skills: Array<{ name: string; action: 'installed' | 'ambiguous' | 'failed'; detail?: string }>,
  mcpServers: Array<{ serverId: number; name: string | null; action: 'enabled' | 'needs-admin' | 'dangling' | 'failed'; detail?: string }>,
  selfCheck: SharedAgentVO   // 处理后重算的该条目自检（前端直接替换行数据）
}
```

幂等：无缺失时调用返回全空 actions + 当前自检，不报错。审计沿用现有拦截器。

### 5.5 P2：registry 开关（settings）

复用 settings 域的类型化配置组模式（对齐 `TavilySettings` 等现有形态），新增：

```ts
interface BundleRegistrySettings {
  enabled: boolean;          // 默认 false
  accessToken: string | null // 可选；非空时请求须带 query ?token= 或 header X-Mao-Registry-Token
}
```

管理入口：admin SystemSettingsView 新增面板（开关 + token 输入，token 保存后仅显示尾 4 位）。

### 5.6 P2：contentHash 规范

目的：同一 bundle 内容多次导出必须得到同一 hash（`exportedAt` 每次变化，必须剔除）。

```
canonicalize(bundle):
  1. 浅拷贝，删除 exportedAt
  2. 递归排序所有对象键（数组保序）
  3. JSON.stringify（无空格）
contentHash = sha256(canonicalized).hex()
```

实现为 `agent-bundle.service.ts` 导出的纯函数 `computeBundleContentHash(bundle: AgentBundle): string`，导出、registry、检查更新三处共用。

### 5.7 P2：registry 只读端点与 URL 导入

```
GET /v1/agent-bundle/registry/:agentId
```

- 鉴权挂载：登录校验在 `create-app.ts` 的 preHandler，按同步静态 `isPublicPath`（`jwt-hook.ts` 的 `PUBLIC_PREFIXES`）放行，而 settings 为异步读取。落点：把 `/v1/agent-bundle/registry/` 加入 `PUBLIC_PREFIXES`（保持 `isPublicPath` 同步），开关与 token 校验放路由处理器内——关闭时处理器返回 404，"不暴露存在性"语义不变。勿把 `isPublicPath` 改成异步。
- 鉴权规则：settings 开关关闭 → 404（不暴露存在性）；开启后无需登录（自托管内网场景），但配置了 accessToken 时校验 token（`timingSafeEqual` 非常量时间比较，长度不等直接拒绝）。
- **技能内联策略（必须明确，否则 URL 导入产出残缺 Agent）**：`exportBundle` 默认对用户技能输出 reference，仅显式 `inlineSkills` token 才内联。registry 导出必须对 Agent 的每个用户技能生成 `name@userId` 显式 token 全量内联（显式 token 规避跨用户多属主歧义）——否则目标实例导入后缺技能，且 fix-deps 无法补（目标实例内无属主），URL 导入的核心价值依赖内联。
- 失败映射（路由自行 catch，勿依赖 `handleError`——BusinessException 默认映射为 HTTP 200 + fail 信封，与非 Result 信封冲突）：Agent 不存在/停用/开关关闭 → 404；导出失败（同用户多目录同名、inline 总量超 `MAX_INLINE_BYTES`）→ 409 + 结构化 JSON `{ error: string, detail: string[] }`，check-updates 将其落为该项 `error`。
- 响应成功：bundle JSON 本体（非 Result 信封，与文件导出一致）+ header `X-Mao-Content-Hash`。
- 审计：`onResponse` 钩子已全量记录 `/v1/**` 请求（未登录 userId=null），"每次拉取可审计"自动满足，无需额外埋点。
- 该端点是本提案唯一对外暴露面，安全评审要点见 §8。

```
POST /v1/agent-bundle/import-from-url    （agent:write）
body: { url: string, confirm?: boolean }
```

- 服务端 fetch（超时 10s、响应体上限 20MB、仅 http/https），拿到 JSON 后**完全复用** `importBundle(parsed, confirm, operatorId)`，两段式预检语义不变。
- 预检报告新增 `sourceUrl` 字段回显（供确认页展示来源）。
- confirm 落库成功后 upsert `agent_import_origin`（uk agent_id，保留最近一次）。

### 5.8 P2：导入来源与更新检查

V134 迁移（迁移号顺延；openapi 特性已先行占用 V133）：

```sql
CREATE TABLE IF NOT EXISTS `agent_import_origin` (
    `id`                     BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`               BIGINT NOT NULL,
    `source_url`             VARCHAR(1024) NOT NULL,
    `content_hash`           CHAR(64) NOT NULL COMMENT '导入时远端 bundle 的 contentHash',
    `imported_system_prompt` MEDIUMTEXT NULL COMMENT '导入时 systemPrompt 快照，用于本地漂移检测',
    `imported_by`            BIGINT NOT NULL,
    `created_at`             DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`             DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_import_origin_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent bundle 导入来源（最近一次）';

ALTER TABLE `shared_agent_entry`
    ADD COLUMN `source_url` VARCHAR(1024) NULL DEFAULT NULL COMMENT '远端来源，非空时支持更新检查';
```

- `imported_system_prompt` 快照解决提案的开放问题"判断用户是否改过"：本地 `agent.systemPrompt` ≠ 快照 → 本地已漂移，检查更新结果中标记 `localEdited: true`。
- 文件导入（现有上传导入）不写 origin 表；仅 URL 导入写。

```
POST /v1/agent-bundle/check-updates    （agent:write）
body: { agentIds?: number[] }          // 缺省 = 全部有 origin 的 Agent + 全部带 source_url 的共享条目（去重）
```

响应：逐项 `{ agentId, sourceUrl, originHash, remoteHash, changed, localEdited, error? }`。

- **hash 比对基准（防假 changed）**：`changed = remoteHash ≠ origin.content_hash`，基准是导入时对远端包算出的快照——远端侧比较稳定，不受本地导入损耗影响。禁止"本地重新导出再算 hash 与远端比"的口径：导入时有损的包（同名 MCP 跳过、重复技能去重、超限经验跳过）会造成永久性假 changed。
- `localEdited` 仅覆盖 systemPrompt 漂移（快照比对，见上）；技能/MCP 的本地改动不检测，属已知边界（文档写明）。
- **双 URL 取舍**：同一 Agent 同时存在 `agent_import_origin.source_url`（URL 导入写入）与 `shared_agent_entry.source_url`（管理员手工维护）且不一致时，以条目 `source_url` 为准（管理员显式维护优先）。
- 执行：逐项 fetch 复用 import-from-url 的拉取约束；缺省全量时按小并发（4）拉取，单项失败（超时/超限/非 JSON/409 导出失败）落 `error` 不阻断其余项。

**更新应用语义**：检查更新只做提示。应用 = 管理员对该 URL 重新走 import-from-url 两段式——名称冲突自动生成"副本"，**旧 Agent 原样保留**。共享条目场景的管理员操作序列：导入新副本 → SharedEntryDialog 上架新副本（putEntry upsert by agent_id，天然新增一条）→ 下架旧条目 → 删除旧 Agent（可选，服务层级联清条目）。UI 按此序列出操作引导文案。

### 5.9 P3：技能 Bundle（`mao-skill-bundle` v1）

```json
{
  "format": "mao-skill-bundle",
  "formatVersion": 1,
  "exportedAt": "2026-10-05T00:00:00Z",
  "skill": { "name": "code-review", "description": "..." },
  "files": { "SKILL.md": "...", "scripts/run.md": "..." }
}
```

- 约束对齐 agent bundle inline 技能：总量 ≤ `MAX_INLINE_BYTES`（10MB）、隐藏路径段丢弃、路径穿越拒绝、`validateSkillMd` + frontmatter name 与 `skill.name` 一致。
- **导出** `GET /v1/skill-bundles/:name?owner=<userId>`：系统技能（无 owner）要求 `skill:read`；用户技能要求本人，或 `skill:read` 持有者指定 owner。
- **导入** `POST /v1/skill-bundle/import`（`skill:write`，管理员）：两段式（confirm=false 出预检报告：SKILL.md 校验结果、同名冲突 `exists-skip` 不覆盖——与 agent bundle inline 语义一致）；confirm 走 `writeSkillStaged` 写系统技能目录 + `skillLoader.invalidateCache()`。
- `BundleSkill` 增量可选字段 `sourceUrl?: string`（仅 reference 条目），**formatVersion 维持 1**：`parseAndValidateBundle` 逐字段读取、天然忽略未知字段，旧实例导入带此字段的包不受影响。**本版导出端一律不填**（`shared_agent_entry` 按 agent_id 而非技能索引，无可靠的"技能级来源"判定，不引入启发式），字段仅保留格式位供未来人工标注。本 P3 不做"从 sourceUrl 拉取技能补装"的执行（预检报告仅展示该字段作为安装线索），避免 URL 拉取扩散到用户技能路径。
- round-trip 边界：`mao-skill-bundle` 的 files 为纯文本（二进制文件导出即跳过并告警，`readUserSkillFiles` 既有口径），含二进制文件（可执行脚本、图片等）的技能包不完整，`docs/guides/agent-bundle-format.md` 明示该边界；"逐字节一致"仅对纯文本技能断言。

### 5.10 前端落点

- **desktop** `AgentSelector.vue` 共享分区：条目 `missingSkills.length + mcpIssues.length > 0` 时显示「修复依赖」按钮 → `POST fix-deps` → 用返回的 `selfCheck` 替换当前条目 → toast 汇总结果（installed/enabled 计数；ambiguous/needs-admin/dangling 明细进弹层）。
- **admin** `AgentListView.vue`：
  - `AgentImportDialog.vue` 加「从 URL 导入」页签（URL 输入 → 预检 → 确认，复用现有两段式 UI 流）。
  - 列表工具栏加「检查更新」→ 结果表格（changed/localEdited/error 三态），changed 行提供「重新导入」快捷入口（预填 URL 进 URL 导入页签）。
  - `SharedEntryDialog.vue` 加 `source_url` 输入（可选，须是 registry URL 形态）；条目列表对配置了 source_url 的行显示「远端有更新」角标（数据来自 check-updates 结果缓存）。
- **admin** `SystemSettingsView.vue`：registry 开关面板（enabled + accessToken）。

## 6. 实施步骤

### P1：依赖一键补装（backend + desktop）

1. `UserSkillService.installUserSkillFiles` + 单测（校验链、暂存交换、隐藏路径、多属主场景不涉及此方法）。
2. `SharedAgentService.fixDependencies`（复制来源定位、readUserSkillFiles 提取为可复用函数、MCP 分类、审计）。
3. 路由 `POST /v1/shared-agents/:agentId/fix-deps`。
4. desktop AgentSelector 按钮 + store 刷新。

### P2：registry + URL 导入 + 更新检查（backend + admin）

1. V134 迁移；settings 开关组 + SystemSettingsView 面板。
2. `computeBundleContentHash` 纯函数 + 单测。
3. registry 端点（isPublicPath 前缀放行 + 开关/token + 内联策略 + 错误映射）；`import-from-url`（拉取约束 + 复用 importBundle + origin 落库）；`check-updates`（小并发 + origin hash 基准 + 双 URL 取舍）。
4. `shared_agent_entry.source_url` 列 + SharedEntryDialog 字段与角标 + AgentListView 检查更新。

### P3：技能 Bundle（backend + 格式文档）

1. `mao-skill-bundle` v1 校验/导出/导入（两段式）+ 单测。
2. `BundleSkill.sourceUrl` 增量字段 + 导入端忽略性回归（旧 bundle 无该字段仍通过）。
3. `docs/guides/agent-bundle-format.md` 增补两节。

## 7. 测试方案（全部 Vitest，不新增 Playwright）

- `installUserSkillFiles`：SKILL.md 缺失/校验失败/frontmatter 不一致/隐藏路径过滤/暂存交换失败恢复。
- `fixDependencies`：唯一属主安装成功、多候选（跨用户同名与同用户多目录）ambiguous、无属主 failed、非法 skillName（路径片段/空串）failed 且不中断、系统技能不会出现、MCP 三分类（dangling / will-enable / needs-admin）、无缺失幂等、非共享条目 agentId 拒绝、越权（他人触发不影响他人环境——安装目标永远是操作者本人）。
- `computeBundleContentHash`：同内容同 hash、exportedAt 变化不影响、键顺序不影响、内容变化 hash 变化。
- registry：开关关闭 404、token 校验（错误 token 拒绝）、停用 Agent 404、拉到的包含 inline 技能文件（round-trip 到目标实例后自检不缺技能）、导出失败（同用户多目录同名 / 超 10MB）返回 409 结构化错误、审计写入（onResponse 覆盖）。
- import-from-url：超时/超限/非 JSON/非 http(s) 明确报错；两段式与文件导入结果等价（同一 bundle、同一 report 结构）；origin upsert。
- check-updates：changed 以 origin.content_hash 为基准（导入损耗场景不产生假 changed 的回归用例）、localEdited 判定（systemPrompt 漂移）、双 URL 不一致时条目 source_url 优先、单项失败不阻断。
- skill bundle：纯文本技能 round-trip 逐字节一致、二进制文件跳过并告警、exists-skip 不覆盖、旧版 agent bundle（无 sourceUrl）导入回归。
- 权限：fix-deps 登录即可但仅作用本人；registry 无登录（开启时）；import-from-url / check-updates / skill-bundle import 权限码校验。

## 8. 风险与对策

- **registry 暴露面**（最高风险项）：bundle 含完整 systemPrompt 与技能内容。缓解：默认关闭 + 管理员显式开启 + 可选 token（非常量时间比较）+ 404 不暴露存在性 + 全量审计；文档明示"开启即意味着内网可读这些资产"。
- **SSRF**：import-from-url / check-updates 拉取任意 URL。缓解：仅 http/https、10s 超时、20MB 上限、禁用重定向跟随（fetch 默认 follow，需 `redirect: 'error'`）。**默认不做私网段黑名单**：本功能主场景即"内网实例拉内网实例"，默认黑名单会打死主场景；如需限制作为可选配置项提供（文档列明）。**仅管理员可触发**（agent:write），攻击面已收敛。
- **fix-deps 扩大用户技能可读面（治理项，非阻塞）**：他人名下技能文件内容此前仅 `skill:read` 持有者可读；fix-deps 使任何登录用户可把共享 Agent 引用的他人技能复制到自己名下。定性：管理员上架 Agent 即视为其引用技能对全员可装（特性本意）；缓解：报告 detail 带属主 userId 供审计。原属主删除后唯一属主换成恶意同名技能的竞态，属用户技能体系既有面（本方案不新增），文档提示管理员留意同名技能归属。
- **多属主歧义**：不静默选择，报 ambiguous 由管理员整理（与 bundle 导出同哲学）。
- **更新覆盖用户自改**：应用语义定为"导入新副本、永不覆盖"（§5.8）；localEdited 标记让管理员自行判断。
- **origin 表膨胀**：uk agent_id 单行 upsert，无膨胀可能。

## 9. 落地清单

- [ ] V134 迁移（agent_import_origin + shared_agent_entry.source_url）
- [ ] `UserSkillService.installUserSkillFiles`
- [ ] `SharedAgentService.fixDependencies` + 路由
- [ ] `computeBundleContentHash`
- [ ] settings BundleRegistrySettings + admin 面板
- [ ] registry 端点 / import-from-url / check-updates
- [ ] admin：URL 导入页签、检查更新、SharedEntryDialog source_url 与角标
- [ ] desktop：AgentSelector 修复依赖按钮
- [ ] mao-skill-bundle v1 导出/导入 + BundleSkill.sourceUrl
- [ ] `docs/guides/agent-bundle-format.md` 增补（registry 端点、`mao-skill-bundle` v1 与纯文本边界、registry 开启的安全含义、私网黑名单可选项）
- [ ] CHANGELOG.md 发版条目 + README/DEPLOY 涉及章节同步（AGENTS.md 约定）
- [ ] proposals/README 与提案文档状态更新

## 10. 决策记录（相对提案的修正与确认）

1. **MCP"一键建为停用态"修正为"可修性分类"**。提案假设新建 MCP 副本能满足 Agent 需求，实际运行时按 agent.mcpServerIds 的 id 解析（`mcp-sync-service.ts`），副本无效；且 DISABLED 状态仅 `mcp:write` 可改（`validatePreferenceTarget` 拒绝普通用户启用）。故技能走补装、MCP 走分类提示 + 管理员一键启用。
2. **更新应用 = 导入新副本，永不覆盖**。提案未定义应用语义；本方案将其定为与 bundle"导入即复制"哲学一致的保守语义，消除"覆盖用户自改"风险，代价是旧副本需人工清理（UI 给操作引导）。
3. **contentHash 剔除 exportedAt + 键规范化排序**，保证跨实例、跨时间可比。
4. **BundleSkill.sourceUrl 为增量可选字段，formatVersion 维持 1**，旧实例零影响。
5. **fix-deps 的安装目标永远是操作者本人**（不是共享条目属主），权限上登录即可，但作用域天然收敛到本人目录。
6. **URL 拉取能力只出现在管理员动作**（import-from-url / check-updates），不扩散到普通用户与技能补装路径（P3 的 sourceUrl 仅展示不执行）。
7. **registry 导出按 `name@userId` 显式 token 全量内联用户技能**（§5.7）。默认 reference 导出会让 URL 导入产出缺技能的 Agent，且目标实例无属主、fix-deps 无法补齐——URL 导入的核心价值依赖内联。
8. **check-updates 的 changed 以 origin.content_hash（导入时快照）为基准**（§5.8），不做"本地重导出 vs 远端"比较——导入有损包（同名 MCP 跳过、重复技能去重、超限经验跳过）会产生永久性假 changed；`localEdited` 仅覆盖 systemPrompt 漂移，技能/MCP 本地改动不检测（已知边界）。
9. **SSRF 私网黑名单默认不做**（§8）：内网实例互拉是主场景，黑名单仅作为可选配置项。
10. **双 URL 冲突时条目 `source_url` 优先**于 origin 表（管理员显式维护优先）。但优先仅解决"从哪拉"：当条目 URL 与 origin URL 不一致时，remoteHash 与 originHash 来自两个不同远端、语义不对应（远端从未变化也恒 changed=true），此时该项落 error（"来源不一致，无法比对基线，请重新导入"）且不发起拉取，而不是输出误导性 changed。
11. **registry token 密文解不开时失败闭合**（§5.7）：`SETTINGS_SECRET` 轮换/实例迁移会导致旧密文解不开，此时按"未开启"处理（404），绝不能回落成"未配置 token"而整体跳过校验；配置页对该行显示"密钥已变更无法解密，请重新填写"提示。
12. **技能名去重口径全链路统一**（§5.7/§5.2）：`agent.skillNames` 是 DB 自由文本数组，可能含历史重复项——registry inline token 生成、`parseInlineSkillTokens`（完全相同 token 视为冗余而非歧义）、fix-deps 补装均按 Set 去重；fix-deps 同时把 `listAllUserSkills()` 全量扫描提到循环外一次获取（消除 N+1 与"扫描结果随安装变化"的候选竞态）。
13. **fix-deps 写盘前做目标目录占用检查**（§5.2）：自检按 frontmatter 名判"缺失"、写盘按目录名落盘，而上传侧不校验"目录名 == frontmatter 名"，操作者已有的"目录 A、frontmatter 名 B"技能会被补装静默覆盖（rename 备份成功后即删除）。占用且 frontmatter 名不一致时该条目标 failed；`installUserSkillFiles` 亦对已存在的目标目录直接拒绝（409）。
14. **fix-deps 意味着"上架 Agent 即其引用技能对全员可装"**（§8）：属主技能内容随共享目录对登录用户开放复制，报告 detail 带属主 userId 供审计。
15. **`BundleSkill.sourceUrl` 本版导出不填**（§5.9）：技能级来源无可靠判定，字段仅保留格式位。
16. **用户技能寻址统一为 frontmatter 名经 folderPath 解析**（§5.2 补救可达性）：上传侧不校验"目录名 == frontmatter 名"（属既有上传语义，不收紧），"目录 holder、frontmatter 名 theirs"可达；`getUserSkill`/`deleteUserSkill` 改为先按 frontmatter 名、再按目录名回退从 `listUserSkills` 的 `folderPath` 定位，使错位技能在桌面/后台可查看、可删除——决策 13 的占用失败指引（"请先删除该技能后重试"）因此真正可执行。不在上传侧收口的原因：修复后错位技能已可正常管理，收紧会拒绝现存可用的上传形态（如版本化目录名）。
17. **重名技能（同一用户多个目录、frontmatter 同名）寻址失败闭合，不做首命中**（§5.2）：上传侧不查重使该状态正常可达（决策 16 同源），若按 `find()` 取首个命中，按名删除会删错对象（列表删第二行实际删第一个目录）并误报成功。故 `getUserSkill`/`deleteUserSkill` 增加可选 `folderPath` 入参（列表行级下发）：传入时按绝对路径全等寻址（不用 basename 兜底，避免跨用户串删），未传时命中多个目录即 409 并列全部候选，由用户按行「路径」精确删除；四个路由透传可选 query `?folder=`，前端查看/删除按行传自身 folderPath。fix-deps 占用指引同步改为目录级双标识（目录名 + frontmatter 名）并附重名告警——只写 frontmatter 名在重名时不可寻址，只写目录名则回到决策 16 前的 404。不在上传侧加查重拒绝：会挡住历史可用的上传形态，以寻址失败闭合 + 引导整理收敛。

## 11. 验收口径

1. 桌面共享分区：缺技能条目点「修复依赖」→ 技能出现在本人技能列表、自检徽标消失；缺 MCP 时普通用户看到"需管理员"提示、管理员点击后 MCP 启用；属主已删除/名称非法的缺失项标注 failed，不阻塞其余项。
2. admin：粘贴 registry URL 完成两段式导入，Agent 列表出现导入记录；「检查更新」对未变更源返回 changed=false，对已变更源返回 changed=true 且本地改动被标记 localEdited。
3. registry：默认关闭时外部请求 404；开启后可拉到 bundle 且 hash header 与本地计算一致；拉到的包导入目标实例后技能自检通过（内联完整）；含同名歧义/超限技能的 Agent 拉取返回 409，check-updates 对应项显示 error。
4. 技能 bundle：导出 → 导入 round-trip 文件一致；同名导入不覆盖。
5. 全量 `cd backend-ts && npm test` 通过，新增 spec 覆盖 §7 全部用例。
