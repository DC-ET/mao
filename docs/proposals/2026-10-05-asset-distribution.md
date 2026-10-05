# 提案：资产分发闭环 —— 依赖一键补装、URL 导入、实例间更新订阅

- 状态：已实施（0.0.237；技术方案见 [docs/plan/2026-10-05-asset-distribution-technical-design.md](../plan/2026-10-05-asset-distribution-technical-design.md)，其中 §10 含对本文的修正与评审补充记录）
- 日期：2026-10-05
- 提案总览：见 `docs/proposals/README.md`
- 前置：Agent 资产化（已实施，0.0.236）

## 1. 背景与现状

Agent 资产化已交付：`mao-agent-bundle` v1 导出/导入（两段式预检、`$MAO_REDACTED` 脱敏，`agent-bundle.service.ts`）、团队共享目录（`shared_agent_entry` V132）、依赖自检（missingSkills / mcpIssues，`shared-agent.service.ts`）。

但分发链在三个地方断了：

1. **自检之后没有动作**。工作台共享分区提示"缺 2 个技能"就停了，用户还得自己去设置页找、传 zip（`user-skill.service.ts`）；缺的 MCP 也要手工新建。
2. **跨实例仍靠文件互拷**。导出 JSON → 聊天工具发给别人 → 手工导入；没有 URL 直达，也没有"源实例更新了怎么办"。
3. **技能没有对等的搬运格式**。bundle 里技能只是 inline/reference 附属品，独立分享一个技能包仍要走 zip 上传。

## 2. 目标 / 非目标

**目标**

1. 共享目录的依赖自检可一键修复：缺的用户技能一键安装、缺的用户级 MCP 一键建为停用态。
2. bundle 可通过 URL 导入（任意自托管实例都可作只读源）；实例间可检查"远端是否有更新"。
3. 技能获得独立 bundle 格式（`mao-skill-bundle` v1），可独立导出导入与分享。

**非目标**

- 不做评分/评论/排行榜（Java 时代 Hub 被删除的教训；等生态自然长出来）。
- 不做跨实例自动同步/推送（更新始终人工确认后应用）。
- 不做用户间点对点分享（仍以管理员上架为出口；机器到机器集成由开放 API 提案承担）。

## 3. 技术方案

### 3.1 依赖一键补装（P1）

- `POST /v1/shared-entries/:id/fix-deps`：对当前用户逐项处理 missingSkills（条目携带 inline 技能内容的直接走 user-skill 落盘；系统技能缺失则提示联系管理员）、mcpIssues（建为停用态 MCP，复用 bundle 导入的同款语义）。
- 完成后返回新的自检报告；前端共享分区"修复依赖"按钮一键完成，自检徽标实时消失。

### 3.2 URL 导入与更新检查（P2）

- 每个实例天然可作只读源：`GET /v1/agent-bundle/registry/:agentId` 返回 bundle + `contentHash`（管理员开关控制，默认关闭；可选访问 token）。
- admin 导入向导支持粘贴 URL：拉取 → 预检报告 → confirm 落库（完全复用现有两段式，无新导入语义）。
- 更新检查：导入来源落 `agent_import_origin`（source_url + contentHash + imported_at）；admin Agent 列表"检查更新"批量拉远端 hash，有差异给出 diff 入口（systemPrompt diff 复用 PromptHistory 视图）。
- 共享目录条目同理：`shared_agent_entry` 增加可选 source_url，管理员在条目上看到"远端有更新"角标。

### 3.3 技能 bundle（P3）

- `mao-skill-bundle` v1：`{ name, description, files: { "SKILL.md": "...", "scripts/...": "..." } }`，大小限制沿用 user-skill 上传限制。
- `GET /v1/skills/:name/bundle` + `POST /v1/skill-bundle/import`（走 staged-skill-writer 原子落盘）。
- agent bundle 的 reference 技能可填 source_url，导入预检报告里提示"一键补装"（与 3.1 串成闭环）。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 依赖一键补装 + 共享分区按钮 | 小 |
| P2 | registry 只读端点 + URL 导入 + 导入来源与更新检查 | 中 |
| P3 | 技能 bundle + 共享条目 source_url + 更新角标 | 中 |

## 5. 风险与开放问题

- **registry 端点暴露面**：bundle 含完整 systemPrompt 与技能内容，属敏感资产。缓解：默认关闭、管理员显式开启 + 可选访问 token；审计记录每次拉取。
- **更新覆盖用户自改**：检查更新只提示不自动应用；应用 = 重新走导入预检（名称冲突自动改名语义不变）。"从用户修改过的版本分叉"的提示依赖 AgentPromptVersion 判断是否被改过，实施时验证数据是否足够。
- **开放问题**：非管理员能否从 URL 导入？P2 先限管理员（与文件导入一致），社区有反馈再放开到 `agent:write` 用户。

## 6. 测试要点

- fix-deps：缺技能 / 缺 MCP / 混合三种场景的自检报告变化；越权操作他人资源被拒。
- registry：同内容同 contentHash；开关关闭时 404；审计写入。
- URL 导入：预检 → confirm 两段式无回归；远端不可达、格式错误的明确报错。
- 技能 bundle round-trip：导出 → 导入 → 文件逐字节一致；SKILL.md 校验（`harness/skill/skill-md.ts`）。
