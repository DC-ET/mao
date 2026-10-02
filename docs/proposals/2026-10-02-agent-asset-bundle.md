# 提案：Agent 资产化 —— 导出 / 导入 / 克隆 / 团队共享目录

- 状态：提案，未评审
- 日期：2026-10-02
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

一个调教好的 Agent 在 Mao 里是一组分散的资产：

- **主体**：`agent` 表（`systemPrompt`、`configJson`、`skillNames`、`mcpServerIds`、`defaultModelId`、`enabled`，见 `backend-ts/src/agent/types.ts`）。
- **提示词版本**：`agent_prompt_versions`（version / systemPrompt / sourceVersion，已支持回滚）。
- **附属**：`agent_experiences`（最佳实践）、`agent_suggested_questions`（推荐问题）、`agent_tag`。
- **依赖**：技能（系统技能在 skillsDir、用户技能经 `src/skill/user-skill.service.ts` 上传）、MCP（`mcp_server` + `agent_mcp_config` 绑定）。

这些资产目前**锁死在单个实例里**：换一个自托管环境要手工逐项重配；同一实例内同事之间也只能靠"照着抄"来复用别人的 Agent。Mao 没有 SaaS、主打自托管，配置本身就是生态载体——但没有可搬运的格式。

## 2. 目标 / 非目标

**目标**

1. 实例内一键克隆 Agent（含全部子资产）。
2. 导出为标准 bundle 文件、跨实例导入，格式带版本号可演进。
3. 管理员"共享目录"：精选 Agent 上架，用户端展示推荐语与依赖自检。
4. 密钥零导出：bundle 中绝不出现任何明文密钥。

**非目标**

- 不做在线"市场"、不做评分评论（先做目录，生态起来再说）。
- 不做跨实例自动同步（导入即复制，之后各自演进）。
- 不改 Agent 运行时行为，本提案纯资产搬运。

## 3. Bundle 格式（`mao-agent-bundle` v1）

```json
{
  "format": "mao-agent-bundle",
  "formatVersion": 1,
  "exportedAt": "2026-10-02T00:00:00Z",
  "agent": {
    "name": "代码评审员",
    "description": "...",
    "systemPrompt": "...",
    "configJson": { "…": "…" }
  },
  "experiences": ["…"],
  "suggestedQuestions": ["…"],
  "skills": [
    { "name": "code-review", "include": "inline",  "files": { "SKILL.md": "…" } },
    { "name": "web-search",  "include": "reference" }
  ],
  "mcpServers": [
    { "name": "context7", "definition": { "transport": "stdio", "command": "…", "args": [], "env": { "API_KEY": "$MAO_REDACTED" } } }
  ]
}
```

导出规则：

- **模型绑定不导出**：`defaultModelId` 在目标实例无意义，导入后置空。
- **技能**：系统技能（skillsDir 内）只能 `reference`；用户技能可 `inline`（导出预览中可勾选）。inline 内容沿用 user-skill 上传的大小限制。
- **MCP**：环境变量 / header 中的密钥一律替换为 `$MAO_REDACTED`，导入后该字段为空、要求使用者自行填写。MCP 定义整体随包带走但**导入后默认停用**。
- 头像不内联；`agent_prompt_versions` 只导出当前生效版本（版本历史不搬运）。

## 4. 技术方案

### 4.1 API 面（沿用 `agent:read` / `agent:write` 权限码风格）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/agents/:id/clone` | 实例内克隆：主体 + experiences + suggestedQuestions + prompt 从 v1 起版 + 技能/MCP 引用；名称自动加"副本"后缀 |
| GET | `/api/v1/agents/:id/bundle` | 导出 bundle（`?skills=inline` 控制技能内联）；管理后台操作 |
| POST | `/api/v1/agents/bundle:import` | 导入：校验 format/formatVersion → 预检报告（名称冲突、技能缺失、MCP 待确认）→ 建为可编辑的新 Agent |

导入语义：**两段式**。第一步返回预检报告（缺什么、冲突什么），第二步带 `confirm=true` 落库。名称冲突自动加后缀而非覆盖；导入的 Agent 默认启用但提示词需在管理后台过目（预检报告即预览）。

### 4.2 共享目录

- 新表（迁移 V129 或与记忆提案合并排号）：

```sql
CREATE TABLE IF NOT EXISTS `shared_agent_entry` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`   BIGINT NOT NULL,
    `note`       VARCHAR(512) COMMENT '推荐语：适合什么任务、怎么用',
    `sort_order` INT NOT NULL DEFAULT 0,
    `created_by` BIGINT NOT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_shared_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- 管理后台 Agent 管理页新增操作：**克隆 / 导出 / 导入 / 上架共享目录**（上架时填写推荐语、排序）。
- 工作台 Agent 选择页新增"团队共享"分区：展示推荐语 + **依赖自检徽标**——该 Agent 绑定的用户技能 / 用户级 MCP 当前用户是否具备，缺什么一目了然（复用 skill-doc / mcp 偏好查询）。
- 共享目录不改变 Agent 可见性（Agent 本就全局可选），它的价值是：管理员背书、排序与说明、依赖自检。

### 4.3 前端落点

- admin：`admin/src/views` Agent 管理页加克隆/导出/导入按钮与导入向导（上传 JSON → 预检报告 → 确认）。
- desktop：Agent 选择页共享分区；设置页不加东西（导入导出是管理员动作）。

## 5. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 克隆 + 导出/导入 API + admin 按钮 + 脱敏与 round-trip 测试 | 小 |
| P2 | 共享目录（表 + admin 管理 + 工作台分区 + 依赖自检） | 中 |
| P3 | `mao-cli` 支持 `mao agent import/export`；bundle 格式文档化，供社区交换 | 小 |

## 6. 风险与开放问题

- **密钥泄漏**：最高风险项。对 `mcp_server` 的 env / header 字段做模式识别脱敏，round-trip 测试断言输出不含任何原始密钥值；导入端 `$MAO_REDACTED` 占位符还原为空并提示补填。
- **恶意 bundle**：提示词注入、MCP 指向内网地址。缓解：导入默认 MCP 停用、预检报告展示完整 systemPrompt 与 MCP 定义、SKILL.md 大小限制沿用 user-skill。
- **技能引用悬空**：`reference` 技能在目标实例不存在时，预检报告列出缺失清单，导入不阻断（Agent 可建，技能标记缺失）。
- **开放问题**：导出权限边界——当前经验/提示词版本是管理资产，bundle 导出限定管理后台操作（管理员）是否足够？是否需要允许 Agent creator 导出自己的？建议 P1 先只开管理员。

## 7. 测试要点

- round-trip：导出 → 导入 → 逐字段断言（systemPrompt、experiences、questions、技能引用、MCP 结构）。
- 脱敏：构造含密钥的 MCP 定义，断言 bundle 与落库后的 Agent 均无明文。
- 名称冲突加后缀；formatVersion 不识别时明确报错。
- 权限：非管理员访问 bundle/clone 路径被拒；共享目录上架/下架的权限码校验。
