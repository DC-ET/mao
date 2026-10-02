# Agent 资产化技术方案：Bundle 导出/导入 + 团队共享目录

- 状态：已评审定稿（基于提案 2026-10-02 评审讨论，决策记录见第 10 节；已吸收 2026-10-02 技术评审补充，含第 1 节事实修正）
- 日期：2026-10-02
- 来源提案：[docs/proposals/2026-10-02-agent-asset-bundle.md](../proposals/2026-10-02-agent-asset-bundle.md)
- 实施范围：P1（Bundle 导出/导入）+ P2（团队共享目录）+ P3（mao-cli 支持、格式文档化），三期全部实施，按序推进

## 1. 需求背景

一个调教好的 Agent 在 Mao 里是一组分散的资产：`agent` 表主体（systemPrompt、configJson、skillNames、mcpServerIds、defaultModelId、enabled，见 `backend-ts/src/agent/types.ts`）、`agent_prompt_versions` 提示词版本、`agent_experiences` 最佳实践、`agent_suggested_questions` 推荐问题，以及两类依赖——技能（系统技能在 skillsDir、用户技能在 `userSkillsDir/<userId>/<name>/`）和 MCP（`mcp_server` 全局记录 + `agent.mcpServerIds` 绑定）。

这些资产目前锁死在单个实例里：换一个自托管环境要手工逐项重配；同一实例内同事之间只能靠 admin 的"复制"按钮在表单里照着抄。Mao 没有 SaaS、主打自托管，Agent 配置本身就是生态载体，但缺少一个可搬运的标准格式。

代码事实（本方案的依据，已逐一核实）：

1. **admin 已有"复制"按钮**（`admin/src/views/agent/AgentListView.vue` 的 `handleCopy`）：拉取 Agent 详情 → 预填创建表单（含经验/推荐问题/技能/MCP）→ 管理员手动保存。无服务端 clone API。
2. **`mcp_server.envJson` 是 AES-GCM 加密落库的**（`backend-ts/src/harness/mcp/crypto/mcp-secret-cipher.ts`，密钥来自实例配置）。导出脱敏前必须先解密。
3. **`mcp_server` 只有 `envJson` 一个敏感承载字段**：STDIO 类型有 command/argsJson/envJson，HTTP 类型有 url/envJson，**没有独立的 header 字段**（提案中"header 密钥"的说法不成立，已修正）。
4. **Agent 只能绑定全局 MCP**（`McpServerService.validateForAgent` 拒绝 userId≠0 的记录）；全局与用户私有空间的 server 名称全局唯一（`NAME_PATTERN` + 跨空间查重）。
5. 权限模型：`requirePermission(permissionService, userId, code)` 助手；V121 权限目录补 17 个码（skill / feishu-bot / dingtalk-bot / command / mcp r/w、session:write 等），`agent:read`/`agent:write`/`mcp:write`/`skill:write` 均可用（前两者为更早迁移中的旧码）。
6. 用户技能以磁盘目录存储、multipart 上传；系统技能经 `/v1/skill-docs/upload` 写入 skillsDir，但 **`SkillDocService.uploadSkill` 为直接写入，无暂存/交换/回滚**——暂存/交换/回滚能力在用户技能服务 `UserSkillService`（`.staging` 暂存 + `swapStagedSkill` + 失败 `restoreSwappedSkills` 回滚），`validateSkillMd` 在 `harness/skill/skill-md.ts`。文件大小走 Fastify 全局 bodyLimit（`max(52, multipartLimitMb+2) MB`；multipartLimitMb 取 DB 上传配置与下限 1024 的较大值）。
7. `agent.configJson` 当前用途是 Harness 的 CompactionConfig 覆盖项（`harness-service.ts resolveCompactionConfig`），无实例绑定语义；目前没有任何 API/UI 写入口，仅落库保留。
8. Flyway 迁移最新到 V128；迁移号统一分配：长期记忆 V129/V130、任务收件箱 V131、本方案 V132（2026-10-02 评审定号）。

## 2. 需求描述

### 2.1 目标（全部要做）

1. **Bundle 导出**：管理员将任一 Agent（主体 + 经验 + 推荐问题 + 当前生效提示词 + 技能 + MCP 定义）导出为 `mao-agent-bundle` v1 格式的 JSON 文件；env 值全量脱敏，零密钥出包。
2. **Bundle 导入**：管理员上传 bundle，走"预检报告 → 确认落库"两段式流程，生成可编辑的新 Agent；名称冲突自动加后缀、技能缺失不阻断、MCP 默认停用。
3. **团队共享目录**：管理员将启用中的 Agent 上架（推荐语 + 排序）；工作台 Agent 选择器顶部展示"团队共享"分区，按当前用户实时计算依赖自检（技能存在性 + MCP 启用态）。
4. **mao-cli 支持**：`mao agent export` / `mao agent import` 命令；bundle 格式文档化，供社区跨实例交换。

### 2.2 非目标（明确不做）

- 不做在线"市场"、评分评论。
- 不做跨实例自动同步：导入即复制，之后各自演进。
- 不改 Agent 运行时行为：提示词注入、上下文管理、工具执行链路一律不动，本方案纯资产搬运。
- 不做服务端 clone API：实例内克隆由现有 admin"复制"按钮承担（见第 10 节决策 2）。
- 不做 bundle 签名/加密：JSON 明文 + 格式版本号预留演进；安全性靠脱敏与导入端校验。
- 不做普通用户侧的导出/导入入口：全部是管理员动作，desktop 设置页不加东西。

## 3. 范围界定：做 / 不做清单

### 3.1 做什么

| 项 | 内容 | 阶段 |
|---|---|---|
| 导出 API | `GET /api/v1/agents/:id/bundle`，支持 `?inlineSkills=` 指定内联的用户技能 | P1 |
| 导入 API | `POST /api/v1/agent-bundle/import`，两段式（`confirm=false` 预检 / `confirm=true` 落库） | P1 |
| 脱敏 | mcp env 值解密后全量替换为 `$MAO_REDACTED` | P1 |
| admin 导出向导 | 技能勾选（系统技能只读 reference / 用户技能可勾 inline）→ 下载 JSON | P1 |
| admin 导入向导 | 上传 JSON → 预检报告（systemPrompt 全文、MCP 完整定义、缺失/冲突清单）→ 确认 | P1 |
| 共享目录表 | Flyway 迁移 `shared_agent_entry`（V132） | P2 |
| 共享目录 API | `GET /v1/shared-agents`（登录即可）、`PUT/DELETE /v1/agents/:id/shared-entry`（agent:write） | P2 |
| 依赖自检 | 按当前用户实时计算：系统技能存在性、用户技能安装、全局 MCP 存在且启用 | P2 |
| admin 上架/下架 | Agent 行内"上架/下架/编辑推荐语"，填 note + sortOrder | P2 |
| desktop 共享分区 | `AgentSelector.vue` 顶部"团队共享"分组：推荐语 + 缺依赖角标 | P2 |
| mao-cli 命令 | `mao agent export` / `mao agent import [--confirm]` | P3 |
| 格式文档 | `docs/guides/agent-bundle-format.md` 格式契约 | P3 |

### 3.2 不做什么（与"做"同等明确）

| 项 | 结论 |
|---|---|
| 服务端 clone API | 不做。现有 admin"复制"按钮即克隆路径，零后端改动 |
| 权限码 | 不新增。导出/导入/上架/下架全部复用 `agent:write`；共享目录查看仅需登录 |
| MCP env 导出 | 不做按键名模式识别，全量脱敏（宁多勿漏） |
| MCP 同名导入 | 不复用现有 server、不加后缀新建——直接跳过并在预检报告列明，Agent 不绑该项 |
| inline 技能覆盖 | 不覆盖目标实例同名系统技能，跳过并报告 |
| 导出字段 | 不导出 `defaultModelId`（目标实例无意义，导入置空）、`isDefault`（实例本地语义）、`enabled`（导入一律 enabled=1）、头像（不内联）、提示词版本历史（只导当前生效版本，导入后起版 v1） |
| 经验筛选 | 不只导启用项——全部导出且保留 `enabled` 状态，round-trip 完整 |
| 二进制技能文件 | 不进 bundle（files map 只承载 UTF-8 文本文件），二进制文件跳过并在 bundle 中标注警告 |
| 用户级 MCP 自检 | 不做（Agent 绑不上用户级 MCP，检查无意义，提案表述已修正） |
| Playwright 用例 | 不新增。CI 不跑 Playwright，本方案以 Vitest 单测完整覆盖 |
| contracts 包 | 不改。bundle/共享目录类型定义在 `backend-ts/src/agent/` 本地，admin/desktop 前端本地声明 interface |
| 安卓端 | 不做专属改动（远程加载同一 Web，自动继承 desktop 改动） |
| 部署 | DEPLOY.md 无变更（无新环境变量、无新运行目录；迁移随启动自动执行） |

## 4. 技术选型

| 决策点 | 选型 | 理由 |
|---|---|---|
| Bundle 格式 | JSON（UTF-8），`format: "mao-agent-bundle"` + 整数 `formatVersion` | 与现有栈零新依赖；人可读可改；版本号支持演进，不识别的版本明确报错 |
| 传输方式 | 导出 GET 返回 `application/json` + `Content-Disposition: attachment`；导入 POST `application/json` body | 复用 Fastify bodyLimit（与 user-skill 上传同一限额体系），避免引入 multipart 解析分支 |
| 权限 | 复用 `requirePermission` + `agent:write`，共享目录查看仅 `requireUserId` | 与 agent 域现有路由（`agent.routes.ts`）同构，不扩 V121 目录 |
| MCP 读写 | 导出经 `McpSecretCipher.decrypt` 解密 envJson 后脱敏；导入经 `encrypt` 重新加密落库 | 复用现有加解密，不绕过安全层 |
| inline 技能写盘 | 导入写入系统 skillsDir：校验复用 `validateSkillMd`（`harness/skill/skill-md.ts`）；写盘采用轻量暂存交换——先写 `skillsDir/.staging/<token>` 临时目录，校验通过后原子 rename 到 `skillsDir/<name>`，失败清理暂存（对齐 `UserSkillService` stage/swap 模式，P1 内抽为可复用小工具） | `SkillDocService.uploadSkill` 是直接写入、无暂存回滚（评审修正），不可照抄；暂存交换保证导入失败不污染 skillsDir |
| 技能所有权消歧 | `?inlineSkills=code-review@12`（`name@userId`） | admin 已有 `GET /v1/admin/user-skills` 全量列表（含 userId），前端可精确选择；单候选可省略 `@userId` |
| 共享目录自检计算 | 服务端按当前用户实时计算，随 `GET /v1/shared-agents` 返回 | 前端零额外请求；用户技能/MCP 状态变化即时反映 |
| 新表 | `shared_agent_entry`（BIGINT 自增、snake_case、created_at/updated_at），无外键，服务层级联 | 与全库规范一致 |

## 5. 详细设计

### 5.1 Bundle 格式（mao-agent-bundle v1）

```json
{
  "format": "mao-agent-bundle",
  "formatVersion": 1,
  "exportedAt": "2026-10-02T00:00:00.000Z",
  "agent": {
    "name": "代码评审员",
    "description": "负责 PR 评审的助手",
    "systemPrompt": "<当前生效版本全文>",
    "configJson": { "compaction": { "…" : "…" } }
  },
  "experiences": [
    { "content": "…", "sortOrder": 0, "enabled": true }
  ],
  "suggestedQuestions": [
    { "content": "…", "sortOrder": 0 }
  ],
  "skills": [
    { "name": "code-review", "include": "inline", "files": { "SKILL.md": "…", "scripts/run.py": "…" } },
    { "name": "web-search", "include": "reference" }
  ],
  "mcpServers": [
    {
      "name": "context7",
      "definition": {
        "serverType": "HTTP",
        "command": null, "args": null,
        "url": "https://mcp.example.com/sse",
        "env": { "API_KEY": "$MAO_REDACTED" }
      }
    }
  ]
}
```

字段与 `mcp_server`/`agent` 实际模型对齐（`serverType` 取值 `STDIO`/`HTTP`，修正提案示例中的 `transport` 写法）。`configJson` 为对象或 null；`experiences[].enabled` 布尔；`skills[].files` 为"相对技能目录路径 → 文件文本内容"的扁平 map。

脱敏范围声明：**env 值全量替换 `$MAO_REDACTED`；HTTP url 不脱敏**（查询串可能内嵌凭证；导出为管理员主动动作、预检报告完整展示 definition，该边界须写入 P3 格式文档）。

### 5.2 导出：`GET /api/v1/agents/:id/bundle`

权限：`agent:write`。查询参数：`inlineSkills`（可选，逗号分隔 token，`name` 或 `name@userId`）。

处理流程：

1. 取 Agent（不存在 → `AGENT_NOT_FOUND`），取全部经验（含停用）、推荐问题、当前 systemPrompt、configJson（原样，仅压缩配置无敏感语义）。
2. `agent.skillNames` 逐个生成 skills 条目：
   - 系统技能（SkillLoader 内存在）→ `reference`。若出现在 `inlineSkills` 中 → `PARAM_INVALID`（系统技能只能 reference）。
   - 用户技能出现在 `inlineSkills` → 解析归属：唯一候选直接用；多用户同名且未带 `@userId` → `PARAM_INVALID` 并列出候选 userId；`name@userId` 指向不存在/非该用户的技能 → `PARAM_INVALID`。
   - 其余技能 → `reference`。**bundle 的 skills 数组包含 skillNames 全量**，与是否 inline 无关。
   - inline 条目读取该用户技能目录全部文件：跳过隐藏文件/目录（与上传写入规则对称），二进制（UTF-8 解码失败）文件跳过并在该条目 `warnings: ["binary file skipped: <path>"]` 标注。
   - **inline 总量上限**：全部 inline 条目 files 内容累计（UTF-8 字节数）≤ 10MB（代码常量）。累计超出报 `PARAM_INVALID`，提示管理员将该技能改用 reference——bodyLimit 只保护导入侧，导出响应须自行设限。
3. `agent.mcpServerIds` 逐个取全局 server（经 `getForRuntime`），解密 envJson（解密失败 → `PARAM_INVALID`"MCP 环境变量解密失败，无法导出"，提示管理员检查实例密钥配置后重试），**全部 env 值替换为 `$MAO_REDACTED`**，组装 definition。
4. 响应头 `Content-Disposition: attachment; filename="mao-agent-bundle-<安全化的名称>-v1.json"`。

### 5.3 导入：`POST /api/v1/agent-bundle/import`（两段式）

权限：`agent:write`。请求体 `{ bundle: object, confirm: boolean }`（`confirm` 缺省视为 false）。

**公共校验（两段都执行）**：

- `bundle.format !== "mao-agent-bundle"` 或 `bundle.formatVersion !== 1` → `PARAM_INVALID`"不支持的 bundle 格式，format/formatVersion 不识别"。
- `agent.name`/`systemPrompt` 必填非空。
- **字段级约束（bundle 为半可信输入，两段都执行；数字对齐现有服务常量）**：
  - `agent.name` ≤ 128 字符（列宽）；名称冲突后缀在**截断后的原名**上追加，保证 finalName ≤ 128。
  - `experiences[].content` 1~300 字（对齐 `AgentExperienceService.MAX_CONTENT_LENGTH`）；超限条目跳过并在报告 `warnings` 列明，不整体失败。
  - `suggestedQuestions` ≤ 5 条、单条 1~100 字（对齐 `AgentSuggestedQuestionService.MAX_ITEMS` / `MAX_CONTENT_LENGTH`）；超限整体 `PARAM_INVALID`。
  - `mcpServers[].name` 须匹配 `NAME_PATTERN`（`[a-z0-9_-]+`，≤ 64，对齐 `mcp_server.name` 列宽）；不符合归 `skip-invalid`。
  - `skills[].name` 非空白、≤ 64、不含路径分隔符与控制字符（`agent.skillNames` 现状无格式校验，导入不引入存在性校验，但拒绝不可读/危险字符）。

**预检报告**（`confirm=false` 返回，不落库）：

```ts
interface BundleImportReport {
  agentName: string;              // bundle 内原名
  finalName: string;              // 冲突加后缀后的最终名
  nameConflict: boolean;
  systemPrompt: string;           // 全文返回，admin 向导完整展示（恶意提示词的缓解措施）
  experiencesCount: number;
  suggestedQuestionsCount: number;
  skills: Array<{
    name: string; include: 'inline' | 'reference';
    action: 'system-exists' | 'will-import' | 'import-failed' | 'exists-skip' | 'ok' | 'missing';
    detail?: string;              // 失败/跳过原因
  }>;
  mcpServers: Array<{
    name: string; serverType: 'STDIO' | 'HTTP';
    action: 'will-create-disabled' | 'skip-name-conflict' | 'skip-invalid';
    definition: object;           // 完整定义（内网地址等拓扑信息对管理员可见）
  }>;
  warnings: string[];
}
```

预检规则：

- **名称冲突**：目标实例存在同名 Agent → `finalName = "<原名> 副本"`，仍冲突则 `<原名> 副本2` 递增；不覆盖任何现有 Agent。
- **技能**：`inline` 条目检查系统技能目录同名——已存在 → `exists-skip`（不覆盖，Agent 的 skillNames 仍含该名字）；否则 `will-import`（校验 `validateSkillMd`，失败 → `import-failed` 并给出原因）。`reference` 条目检查系统技能或**任一**用户技能存在 → `ok`，都不存在 → `missing`（不阻断）。
- **MCP**：同名（跨全局+用户空间，复用现有查重口径）→ `skip-name-conflict`；serverType/必填字段校验失败（STDIO 缺 command/args、HTTP 缺合法 url）→ `skip-invalid`；否则 `will-create-disabled`。

**确认落库**（`confirm=true`）：**重新执行上述全部校验**（不信任前端缓存的预检结果，防并发窗口），然后：

1. **inline 技能写盘**：对 `will-import` 条目，经第 4 节选型的暂存交换路径写入系统 skillsDir（`validateSkillMd` 校验 + `.staging` 暂存 + 原子 rename，失败清理暂存）；写盘失败该技能降级为 `import-failed`，不阻断 Agent 创建。
2. **MCP 创建**：对 `will-create-disabled` 条目创建全局记录（`userId=0`、`status='DISABLED'`、description 注明"由 bundle 导入"）；envJson 落库时**占位符值置为空字符串、键名保留**（管理员在 MCP 编辑页可见需补填哪些键），经 `McpSecretCipher.encrypt` 加密。新建记录的 id 直接绑定给 Agent，**不走 `validateForAgent`**（新记录处于 DISABLED 态会被其拒绝），由导入 service 层直写。
3. **Agent 落库**：`skillNames` = bundle 技能名全量 JSON；`mcpServerIds` = 成功创建的 MCP id；`defaultModelId = null`、`isDefault = 0`、`enabled = 1`、`creatorId` = 操作管理员、头像为空；经 `agentRepo.insert` 落库并起提示词版本 v1；同步写入 experiences（保留 enabled）与 suggestedQuestions。
4. 返回 `{ agentId, report }`，admin 向导展示"导入完成"+ 报告，刷新列表。

### 5.4 共享目录

**迁移**（P2，`backend-ts/db/migration/V132__shared_agent_entry.sql`，编号见第 1 节事实 8）：

```sql
CREATE TABLE IF NOT EXISTS `shared_agent_entry` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`   BIGINT NOT NULL,
    `note`       VARCHAR(512) NOT NULL DEFAULT '' COMMENT '推荐语：适合什么任务、怎么用',
    `sort_order` INT NOT NULL DEFAULT 0,
    `created_by` BIGINT NOT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_shared_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**API**：

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/v1/shared-agents` | 登录即可 | 条目列表 + 按当前用户计算的依赖自检 |
| PUT | `/api/v1/agents/:id/shared-entry` | `agent:write` | 上架/更新（body: `{ note, sortOrder }`，note ≤ 512） |
| DELETE | `/api/v1/agents/:id/shared-entry` | `agent:write` | 下架 |

上架校验：Agent 存在且 `enabled !== 0`（停用 Agent 报 `PARAM_INVALID`"请先启用该 Agent"）；重复上架即更新（upsert by agent_id）。Agent 删除时（`AgentService.deleteAgent`，注意其为逻辑删除且不删 prompt_versions）在服务层级联删除条目；Agent 停用时条目保留，工作台因现有的 enabled 过滤自然隐藏，重新启用即恢复展示。

**GET /v1/shared-agents 响应**（按 `sortOrder asc, agentId asc`）：

```ts
interface SharedAgentVO {
  agentId: number;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  note: string;
  sortOrder: number;
  missingSkills: string[];   // 既不在系统技能、也不在当前用户用户技能中的 skillNames
  mcpIssues: string[];       // 形如 "context7（已停用）" / "context7（不存在）"
}
```

**自检算法**（服务端，按当前用户实时计算）：

- 技能：`agent.skillNames` 逐个 → SkillLoader 系统技能存在 → 通过；否则查 `userSkillsDir/<当前用户>/<name>` 存在 → 通过；否则进 `missingSkills`。
- MCP：`agent.mcpServerIds` 逐个 → server 存在且 `ENABLED` → 通过；否则进 `mcpIssues`。
- `missingSkills` 与 `mcpIssues` 均为空 → 前端不展示角标。

共享目录不改变 Agent 可见性（`GET /v1/agents` 本就全员可读）；它的价值是管理员背书、排序与说明、依赖自检。

### 5.5 前端落点

**admin（P1 + P2）**，全部在 Agent 管理页（`admin/src/views/agent/`）：

- `AgentListView.vue`：头部新增"导入"按钮；行内操作列（`canWrite`）新增"导出"与"上架/推荐语/下架"。现有"复制"按钮**原样保留**（即克隆路径）。
- 新增 `AgentExportDialog.vue`：列出该 Agent 技能，系统技能标"引用（不可内联）"，用户技能带所有者复选框（同名多候选时并列展示供选择）→ 确认后带 `?inlineSkills=` 请求下载。
- 新增 `AgentImportDialog.vue`：选择 JSON 文件 → `confirm=false` 预检 → 报告展示（最终名称、systemPrompt 全文折叠、经验/推荐问题计数、技能 action 表、MCP action 表含完整 definition）→ "确认导入" `confirm=true` → 成功提示并刷新。
- 新增 `SharedEntryDialog.vue`：填推荐语（≤512）与排序数字；已上架行显示"推荐语"标记并提供"编辑推荐语/下架"。

**desktop（P2）**：

- `stores/agent.ts`：新增 `sharedAgents` state 与 `fetchSharedAgents()`（GET /v1/shared-agents），随 `fetchAgents` 一并调用。
- `components/task/AgentSelector.vue`（新任务配置条的智能体卡片网格）：顶部渲染"团队共享"分组（按 sortOrder 排序置顶），卡片展示推荐语（tooltip）与缺依赖角标（icon + tooltip 列出 `missingSkills`/`mcpIssues`）；**缺依赖的共享 Agent 仍可选中**（技能/MCP 缺失只降级能力，不阻断建会话）。注意：该组件当前为扁平 `agent-grid` 无分组容器，"团队共享"分区是对现有模板的改造而非插入，工作量按改造评估。
- 设置页不加任何入口；不做安卓专属改动。

### 5.6 P3：mao-cli 与格式文档

- `mao agent export <id> [--inline-skills name[@userId],...] [-o <file>]`：调 GET bundle，缺省输出到 `./mao-agent-bundle-<name>-v1.json`。
- `mao agent import <file> [--confirm]`：缺省输出预检报告（人类可读）；`--confirm` 落库。均要求管理员凭据（与现有 admin 命令同源）。
- 同步更新 `skills/mao-cli/SKILL.md` 与 `skills/mao-cli/reference/agent.md`。
- 新建 `docs/guides/agent-bundle-format.md`：格式契约（字段定义、脱敏规则——env 值全量替换 `$MAO_REDACTED`、**HTTP url 不脱敏及其理由**、版本演进策略），供社区跨实例交换。

## 6. 实施步骤

### P1：Bundle 导出/导入（后端 + admin）

1. `backend-ts/src/agent/agent-bundle.types.ts`：Bundle v1、`BundleImportReport` 类型定义。
2. `backend-ts/src/agent/agent-bundle.service.ts` + `agent-bundle.service.spec.ts`：导出组装（脱敏、inline 读取、消歧）、导入校验/报告/落库（复用 `McpSecretCipher`、`SkillDocService.uploadSkill`、`agentRepo.insert`）。
3. `backend-ts/src/agent/agent-bundle.routes.ts` + `agent.routes.spec.ts` 补权限用例；`create-app.ts` 装配依赖。
4. admin：`AgentListView.vue` 按钮 + `AgentExportDialog.vue` + `AgentImportDialog.vue`。
5. 变更写入根 `CHANGELOG.md` 顶部版本条目；README 如涉及 Agent 管理章节则同步。

### P2：团队共享目录

1. `V132__shared_agent_entry.sql`。
2. `backend-ts/src/agent/shared-agent.repository.ts`、`shared-agent.service.ts` + spec；`AgentService.deleteAgent` 注入级联删除。
3. 共享目录路由（并入 `agent-bundle.routes.ts` 或独立 `shared-agent.routes.ts`，实施时按文件体量定）+ 装配。
4. admin：`SharedEntryDialog.vue` + 行内上架/下架。
5. desktop：`stores/agent.ts` + `AgentSelector.vue` 共享分区。
6. CHANGELOG 同步。

### P3：CLI 与格式文档

1. `docs/guides/agent-bundle-format.md`。
2. `skills/mao-cli/`：export/import 命令实现 + SKILL.md + reference/agent.md。
3. CHANGELOG 同步。

## 7. 测试方案（全部 Vitest，不新增 Playwright）

| 用例组 | 断言 |
|---|---|
| 导出组装 | bundle 含全部 skillNames 条目；inline 条目 files 为文本文件内容、二进制跳过且有 warning；系统技能指定 inline 报 `PARAM_INVALID`；同名多用户技能未带 `@userId` 报 `PARAM_INVALID` 并列候选 |
| 脱敏（最高优先） | 构造含密钥 env 的 MCP：解密后 bundle 中所有 env 值均为 `$MAO_REDACTED`，**断言整个序列化 bundle 不含任何原始密钥值**；envJson 解密失败时导出明确报错 |
| round-trip | 导出 → 导入（confirm）→ 逐字段断言：systemPrompt、description、configJson、经验（含 enabled=false 条目）、推荐问题、技能引用、MCP 结构与 DISABLED 态、`defaultModelId=null`、`isDefault=0`、`enabled=1`、提示词版本表恰有 v1 |
| 导入校验 | format/formatVersion 不识别明确报错；名称冲突加"副本"后缀且不覆盖现有 Agent；MCP 同名跳过且 Agent 不绑；STDIO/HTTP 必填缺失跳过并列 `skip-invalid`；inline 技能同名系统技能 `exists-skip` 不覆盖；`confirm=true` 阶段重算后缀与冲突 |
| 字段级校验 | name ≤128 且后缀追加后仍 ≤128（超长原名截断）；experiences 超 300 字条目跳过并列 warnings；suggestedQuestions 超 5 条 / 单条超 100 字报错；MCP name 不符 NAME_PATTERN 归 `skip-invalid`；skillNames 含路径分隔符/控制字符被拒 |
| 导出体积 | inline files 累计超 10MB 报 `PARAM_INVALID` 且不产出 bundle |
| 权限 | 非 `agent:write` 用户访问 bundle/import/shared-entry 写路径被拒；普通登录用户可 GET /v1/shared-agents 但写路径被拒 |
| 共享目录 | 上架校验停用 Agent 被拒；upsert 更新 note/sortOrder；自检：系统技能通过、仅当前用户安装的用户技能通过、他人技能进 missingSkills、MCP 停用进 mcpIssues；Agent 删除级联删条目 |
| 排序展示 | GET /v1/shared-agents 按 sortOrder asc, agentId asc |

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 密钥泄漏（最高风险） | env 全量脱敏（不做模式识别，杜绝漏网键名）；round-trip 测试对序列化全文断言无原始密钥；解密失败时拒绝导出而非降级输出 |
| 恶意 bundle（提示词注入、MCP 指向内网） | 导入默认 MCP 全部 DISABLED，须管理员在 MCP 管理页补 env 后手动启用；预检报告完整展示 systemPrompt 与 MCP definition；SKILL.md 校验复用 `validateSkillMd`；写盘复用 uploadSkill 的路径防穿越与暂存交换 |
| 技能引用悬空 | 预检报告列缺失清单，导入不阻断；共享目录自检把缺失对使用者透明化 |
| 导入与预检之间的并发漂移 | confirm 阶段不信任预检结果，全部校验重算 |
| envJson 解密失败（实例密钥不一致） | 导出直接报错终止，提示修复密钥配置；不做"跳过该 server 静默导出"的降级 |
| HTTP url 查询串可能内嵌凭证（url 不脱敏） | 导出为管理员主动动作、预检报告完整展示 definition；P3 格式文档明示该边界，导出前管理员自查 |
| 并发导入同名 bundle 产生双"副本"（agent.name 无唯一约束） | 现状 agent.name 本就不唯一，接受；如需收紧，confirm 落库前对 finalName 复查存在性并报错重试 |
| bundle 体积过大 | 导入受全局 bodyLimit（与 user-skill 上传同源限额）；导出侧二进制文件不进包、inline 文本总量受 10MB 上限约束 |

## 9. 落地清单

后端（backend-ts）：

- [ ] `db/migration/V132__shared_agent_entry.sql`（P2，编号见第 1 节事实 8）
- [ ] `src/agent/agent-bundle.types.ts`（P1）
- [ ] `src/agent/agent-bundle.service.ts` / `agent-bundle.service.spec.ts`（P1）
- [ ] `src/agent/agent-bundle.routes.ts` + `agent.routes.spec.ts` 权限用例（P1）
- [ ] `src/agent/shared-agent.repository.ts` / `shared-agent.service.ts` / `shared-agent.service.spec.ts`（P2）
- [ ] `src/agent/agent.service.ts` deleteAgent 级联（P2）
- [ ] `src/create-app.ts` 装配（P1/P2）

admin：

- [ ] `src/views/agent/AgentListView.vue`：导入按钮 + 导出/上架/下架行内操作（P1/P2）
- [ ] `src/views/agent/AgentExportDialog.vue`（P1）
- [ ] `src/views/agent/AgentImportDialog.vue`（P1）
- [ ] `src/views/agent/SharedEntryDialog.vue`（P2）

desktop：

- [ ] `src/stores/agent.ts`：sharedAgents + fetchSharedAgents（P2）
- [ ] `src/components/task/AgentSelector.vue`：团队共享分组 + 依赖角标（P2）

mao-cli / 文档：

- [ ] `skills/mao-cli/`：`mao agent export` / `mao agent import` + SKILL.md + reference/agent.md（P3）
- [ ] `docs/guides/agent-bundle-format.md`（P3）
- [ ] 根 `CHANGELOG.md`：P1/P2/P3 各自任务内写入顶部版本条目
- [ ] README.md 涉及 Agent 管理章节的同步（如有）

## 10. 决策记录（相对提案的修正与确认）

| # | 议题 | 结论 |
|---|---|---|
| 1 | 方案范围 | 三期全覆盖，一次成型 |
| 2 | 克隆定位 | **不做 clone API**。admin 现有"复制"按钮（预填表单式）即实例内克隆路径；提案目标 1 由此满足 |
| 3 | 权限边界 | 导出/导入/上架/下架仅 `agent:write`（管理员），不新增权限码；开放问题"是否放开 creator"结论为不放开 |
| 4 | 脱敏策略 | env 值**全量**替换 `$MAO_REDACTED`（统一了提案第 3 节"一律替换"与第 6 节"模式识别"的矛盾，取保守项）；提案"header 密钥"表述修正——`mcp_server` 无 header 字段，敏感承载仅 envJson |
| 5 | MCP 同名冲突 | 跳过并报告，Agent 不绑该项（否决了自动后缀/复用现有两个方向） |
| 6 | 依赖自检范围 | 修正为"系统技能存在性 + 当前用户用户技能安装 + 全局 MCP 存在且启用"；删除提案中"用户级 MCP 自检"（Agent 绑不上用户级 MCP，检查无意义） |
| 7 | inline 技能导入落点 | 写入系统技能目录（复用 skill-docs 上传逻辑），全员自检通过；同名不覆盖 |
| 8 | 其余细化 | 经验全量导出含 enabled；configJson 原样搬运；导出不带 defaultModelId/isDefault/enabled/头像/版本历史，导入 enabled=1、isDefault=0、起版 v1；`?inlineSkills=name[@userId]` 消歧；MCP 导入绕过 validateForAgent 直写（新建即 DISABLED）；confirm 阶段校验重跑；迁移号 V132（第 1 节事实 8）；缺依赖共享 Agent 仍可选中；不新增 Playwright |
| 9 | 2026-10-02 技术评审补充 | §1 事实修正（`uploadSkill` 无暂存回滚、V121 码数、bodyLimit 下限语义）；inline 写盘改为 `validateSkillMd` + `.staging` 暂存原子 rename；导入补字段级校验（name ≤128 / 经验 ≤300 / 推荐问题 ≤5×100 / MCP NAME_PATTERN）；导出 inline 总量上限 10MB；url 不脱敏写入格式契约；迁移号定 V132 |

## 11. 验收口径

1. 在 A 实例导出任意含用户技能与 MCP 的 Agent，到全新 B 实例导入：预检报告完整、确认后 Agent 可用，技能与 MCP 状态与报告一致，B 实例无任何明文密钥。
2. admin Agent 列表完成上架 → desktop 工作台"团队共享"分区可见推荐语与排序；未安装依赖技能的用户看到缺失角标，安装后角标消失。
3. `mao agent export` / `mao agent import` 走通同一 bundle 文件。
4. `cd backend-ts && npm test` 全绿，新增 spec 覆盖第 7 节全部用例组。
