# 首次成功体验（就绪清单 + 首启向导）技术方案

> 版本：v1.0（2026-10-25）
> 状态：已实施（2026-10-25；§0 决策按「推荐」列落定，并经评审确认：向导为一次性体验、不设重进入口）（提案见 [../proposals/2026-10-25-first-run-onboarding.md](../proposals/2026-10-25-first-run-onboarding.md)；第十五批另两件已否决存档）

## 0. 待确认决策（评审逐条定）

| # | 决策点 | 推荐 | 备选 |
|---|--------|------|------|
| 1 | admin 就绪提醒的形态 | **Layout 全局横幅**（红牌项未清时常驻顶栏下方，可折叠当日不再展开，直跳对应页） | analytics 顶部卡组（依赖落地页恰为 /analytics，弱） |
| 2 | 默认密码判定口径 | **bcrypt.compare('admin123', id=1 账号 hash)**，仅对种子管理员账号（V001 固定 id=1 / username='admin'），改密后自然转绿 | 硬编码种子 hash 常量比对（对 bcrypt 无优势） |
| 3 | 存量用户免打扰 | **运行时判定**：preference 无记录且该用户已有会话历史（任意 1 条）→ 视为已完成，不写库不回填 | 首登时惰性写入「存量静默」记录（多一次写，可观测性略好） |
| 4 | 向导组件形态 | **TaskView 内条件覆盖层**（不动 router，登录态 + 判定通过时渲染） | 独立路由 `/onboarding`（需动路由与守卫，侵入大） |
| 5 | 向导第三步「发第一条」 | **关闭向导 + 预填新任务 composer 草稿并聚焦**（复用会话草稿机制，发送仍走用户手点） | 向导内直接调发送 API（重复实现新建会话链路，风险大） |
| 6 | 示例指令来源 | **所选 Agent 第一条推荐问题，无则回退内置常量**（联网搜索类，零工作区依赖） | 固定内置一条（不贴 Agent 个性） |
| 7 | 入门模板内容 | **纯提示词 + 推荐问题的「信息助理」一个模板**（联网检索靠内置 `web_search` / `open_web_page` 工具，零技能 / MCP 依赖） | 多模板（维护面大，先验证一个） |
| 8 | readiness 端点归属 | `settings` 域（实例状态语义，挂 `settings.routes.ts`），VO 下沉 `@mao/contracts` | user / auth 域（语义不符） |

另有一组实现参数直接定死：跳过即完成语义（`skipped=1`，不再打扰；**不提供任何重进入口**，向导完成 / 跳过后即为一次性体验，2026-10-25 评审确认）；横幅折叠记忆存 localStorage（admin 侧无 preference 表，不为此新建）。

## 1. 需求背景

提案（§1）已论证：激活流失集中在部署后 10 分钟，三个断点（管理员不知道没配 Key 会全不可用 / 普通用户面对概念裸奔 / 没有一条「90 秒看到 Agent 干活」的路径）均无机制兜底。代码侧空白已核实：

- admin 无默认密码提醒（`admin123` 仅存在于 V001 种子注释与文档）；模型未配、Agent 为零时界面照常可用，首次报错发生在用户发消息时。
- desktop 无任何首登判定与向导组件（`views/` 仅 auth / settings / share / task 四类）。
- 会话列表空状态无根因分流（模型未配 ≠ 无 Agent ≠ 纯新用户，应指向不同动作）。

## 2. 需求描述

### 2.1 目标

1. `GET /v1/readiness`（登录可用）：返回实例就绪度（默认密码 / 模型数 / 启用 Agent 数 / 登录者向导状态），`defaultPasswordChanged` 仅管理员可见。
2. admin：Layout 全局横幅，未就绪项逐条列出并直跳（改密 → 用户页自身改密入口；模型 → `/models`；Agent → `/agents`），全绿自动消失。
3. desktop：三步向导（选 Agent → 边界图解 → 发第一条），完成 / 跳过写 `user_onboarding_preference`（一次性体验，无重进入口）。
4. admin 建 Agent：「从入门模板开始」（信息助理），一键填充名称 / 提示词 / 推荐问题。
5. 空状态分流：desktop 会话列表与 Agent 选择器按 readiness 根因呈现不同引导。

### 2.2 范围边界

| 维度 | 做 | 不做 |
|------|----|------|
| 判定 | 三项就绪检测（密码 / 模型 / Agent）+ 向导完成标记 | 不检测 SMTP / MCP / 技能目录等长尾项（后续按需加） |
| admin | 全局横幅 + 模板创建入口 | 不做独立就绪页、不改 `/`→`/analytics` 重定向 |
| 向导 | 三步、可跳过、可重进、示例指令预填 | 不做交互式教程 / 视频 / 多语言；不做匿名 demo |
| 存量 | 运行时静默判定（决策 3） | 不做迁移回填 |
| 遥测 | 无（readiness 不上报） | 不新增任何遥测 / 统计落库 |

## 3. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| 就绪判定 | settings 域新 service，只读聚合 | 与 `settings-test.service.ts`（模型连通性测试）同域语义；零写路径 |
| 密码判定 | `bcrypt.compare('admin123', hash)`，目标固定 id=1 | V001 种子（`V001__init_schema.sql:214`）固定 hash；比对明文比比对 hash 常量更稳（种子将来变了，改一处常量即可） |
| 向导标记 | `user_onboarding_preference` 表，照 `user_weixin_preference` / `user_task_panel_preference` 一表一好模式（`preference/preference.repository.ts`） | preference 域既有纪律；不发明通用 KV |
| 前端类型 | `ReadinessVO` 下沉 `@mao/contracts`（`contracts/src/readiness.ts`） | desktop + admin 双端消费，按规范走契约 |
| 模板 | `backend-ts/src/agent/agent-templates.ts` 代码常量 | 随版本分发、零迁移；只含提示词与推荐问题，零外部依赖 |
| 向导渲染 | TaskView 条件覆盖层组件 | 决策 4；不动 router 与登录守卫 |
| 示例指令预填 | 复用会话草稿机制（session-bound-draft，2026-08-21 已实施）写新任务 composer 草稿 | 决策 5；不重复实现发送链路 |

## 4. 总体架构

```
                 ┌──────────────────────────────┐
                 │ GET /v1/readiness (settings) │
                 └──────────────┬───────────────┘
        只读聚合：bcrypt(admin123) │ 模型 count │ Agent count │ 本人 preference + 会话数
                                ▼
   ┌────────────────────────┐   ┌────────────────────────────┐
   │ admin Layout 横幅      │   │ desktop TaskView 向导覆盖层 │
   │ （管理员上下文裁剪）    │   │ （普通用户首登判定）         │
   └────────────────────────┘   └────────────────────────────┘
        直跳 /models /agents            三步 → preference 落库 → 草稿预填
```

判定优先级（desktop 登录后 TaskView 挂载时执行一次）：

```
readiness.modelsConfigured == 0        → 降级提示页（等管理员配置，无向导）
readiness.agentsEnabled == 0           → 降级提示页（同上）
无 preference 记录 && 会话数 == 0      → 向导
其余                                    → 不显示（存量用户静默，决策 3）
```

## 5. 详设

### 5.1 数据模型（V171，当前最新 V170）

```sql
CREATE TABLE `user_onboarding_preference` (
  `user_id`     BIGINT PRIMARY KEY,
  `completed_at` DATETIME NULL COMMENT '三步走完时间',
  `skipped`     TINYINT NOT NULL DEFAULT 0 COMMENT '1=中途跳过（完成语义，不再弹）',
  `chosen_agent_id` BIGINT NULL COMMENT '向导第一步所选 Agent，运营分析用',
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='首启向导完成标记';
```

### 5.2 readiness 端点（`backend-ts/src/settings/`）

`GET /v1/readiness` → `Result<ReadinessVO>`：

```ts
// contracts/src/readiness.ts
export interface ReadinessVO {
  /** 仅管理员可见；非管理员恒为 true（不泄漏种子状态） */
  defaultPasswordChanged: boolean;
  modelsConfigured: number;
  agentsEnabled: number;
  /** 本人向导状态：DONE / SKIPPED / PENDING / AUTO_DONE（存量静默） */
  onboarding: 'DONE' | 'SKIPPED' | 'PENDING' | 'AUTO_DONE';
}
```

- 密码项：`userRepo.findById(1)` 存在且 `bcrypt.compare('admin123', passwordHash)` → 未改；账号不存在（已删）视为已改。
- `modelsConfigured`：既有模型列表口径（启用且配置了 Key 的计数，与「模型管理」页一致，复用 model repository 既有查询）。
- `onboarding`：preference 有记录按记录；无记录且本人会话数 > 0 → `AUTO_DONE`；否则 `PENDING`。
- 写路径：`PUT /v1/readiness/onboarding { chosenAgentId?, skipped? }` 由向导完成 / 跳过时调用，幂等（已存在则忽略）。

### 5.3 admin 全局横幅（`admin/src/components/Layout.vue`）

- 数据：Layout 挂载时拉 readiness（管理员角色才拉；沿用既有 auth store 角色判定）。
- 呈现：顶栏下方细横幅，未就绪项以「· 改默认密码（红）· 配置模型（黄）· 创建 Agent（黄）」串联，单项可点直跳；点击折叠图标当日收起（localStorage 记 `readiness_banner_dismissed_at`），有红牌项时次日重现。
- 全绿：横幅不渲染。零改动 analytics 页。

### 5.4 入门模板（`backend-ts/src/agent/agent-templates.ts`）

```ts
export const AGENT_TEMPLATES = [
  {
    slug: 'info-assistant',
    name: '信息助理',
    description: '联网检索与摘要：查新闻、找资料、带来源的简报',
    systemPrompt: '…（约 300 字：先检索再作答、逐条给出来源、不确定要说明）',
    suggestedQuestions: [
      '搜一下本周 AI 领域的重要新闻，给我 5 条带来源的摘要',
      '帮我查 XX 的最新价格，列出来源',
      '用三段话总结这篇网页的要点：<粘贴链接>',
    ],
  },
] as const;
```

- 提示词依赖的检索能力来自内置 `web_search` / `open_web_page` 工具（所有 Agent 默认可用，零技能 / MCP 配置），模板因此在任何全新实例可直接跑通。
- 挂点：admin `AgentListView.vue`「新建」旁加「从模板开始」→ 预填 `AgentEditView` 表单（名称 / 提示词 / 推荐问题），用户可改后正常保存；落库后即为普通 Agent，无模板运行时痕迹。
- 端点：`GET /v1/agent-templates`（登录可用，免权限码——只读常量）。

### 5.5 desktop 三步向导（`desktop/src/views/task/` 内覆盖层组件 `OnboardingOverlay.vue`）

- 挂载：TaskView `onMounted` 拉一次 readiness，按 §4 判定优先级决定渲染：`OnboardingOverlay`（PENDING）/ `ReadinessPending.vue`（降级提示页，含「联系管理员」文案与刷新按钮）/ 不渲染。
- **步骤 1 选 Agent**：卡片复用既有 Agent 列表数据（desktop agent store），每卡显示头像、名称、description、第一条推荐问题；模板未建且列表为空时本应已被 readiness 拦为降级页。
- **步骤 2 边界图解**：静态一屏两卡（CLOUD：在服务器工作区干活，浏览器 / 手机可用；LOCAL：在你电脑的目录干活，高风险可审批），文案硬编码中文，不引入图片资产。
- **步骤 3 发第一条**：输入框预填示例指令（决策 6：所选 Agent 第一条推荐问题，回退 `DEFAULT_SAMPLE_PROMPT`）；「开始任务」= `PUT /v1/readiness/onboarding` → 关闭覆盖层 → 将文本写入新任务 composer 草稿并聚焦输入框；「跳过」= 同端点 `skipped=1` 直接关闭。
- 失败兜底文案：「如果任务报错也没关系——点消息区的轨迹徽标可以看到 Agent 每一步在做什么」（顺带教育轨迹功能）。
- 无重进入口：完成 / 跳过后向导不再出现（2026-10-25 评审确认，不做「帮助」菜单入口）。

### 5.6 空状态分流

`TaskSessionGroupList.vue` 空态与 `AgentSelector.vue` 空态各分三支：

| 根因 | 文案指向 |
|------|----------|
| modelsConfigured == 0 | 「实例尚未配置模型，请联系管理员」+ 刷新按钮 |
| agentsEnabled == 0 | 「暂无可用 Agent」+（管理员）直跳模板创建提示 /（普通用户）联系管理员 |
| 纯新用户 | 向导入口按钮「查看新手引导」 |

数据源同一次 readiness 拉取（TaskView 已拉，经 provide/inject 或 store 下发，不重复请求）。

## 6. 改动面

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 契约 | `contracts/src/readiness.ts`（新增 + index 导出） | ReadinessVO |
| 后端 | `settings/`：readiness.routes / readiness.service / spec；`PUT onboarding` | 新增（只读聚合 + 一个幂等写） |
| 后端 | `agent/agent-templates.ts` + `GET /v1/agent-templates` + routes 挂载 | 新增常量与只读端点 |
| 后端 | `preference/`：UserOnboardingPreferenceRepository（照 weixin 模式） | 新增 |
| 迁移 | `V171__user_onboarding_preference.sql` | 一表 |
| admin | `Layout.vue` 横幅 + `AgentListView` 模板入口 | 中 |
| desktop | `OnboardingOverlay.vue` / `ReadinessPending.vue` + TaskView 挂载判定 + 两处空态分流 | 中（主要工作量） |
| 文档 | CHANGELOG（backend-ts / admin / 前端三节）、README「怎么用」补一句、skills/mao-cli/reference/install.md 与 deploy.md 上线检查指向产品内清单 | 同任务完成 |

## 7. 测试要点

- 后端单测：readiness 各组合（种子密码改 / 未改；模型 0/N；Agent 0/N；onboarding 四态）；非管理员响应不含 `defaultPasswordChanged=false`（恒 true）；`PUT onboarding` 幂等（二次调用不报错不覆盖已完成态）；账号 1 不存在时的判定；模板端点返回常量。
- admin：横幅三态渲染与直跳链接；红牌未清时折叠后次日重现（localStorage 逻辑单测）；全绿不渲染；模板入口预填表单。
- desktop：判定优先级三分支（未就绪降级页 / PENDING 向导 / 存量静默）；三步流转与 preference 写入；跳过 / 完成后任何路径都不再出现向导；示例指令预填草稿聚焦；空状态三分支文案。
- 回归：登录、analytics、Agent CRUD、新建会话链路、既有 preference（weixin / task-panel）读写零影响。
- E2E（Playwright，desktop.spec）：全新用户首登走完向导发出首条消息；admin 未改密时横幅出现、改密后消失（用 e2e 种子账号，注意 e2e 环境密码已非默认——用例内先造「未改」态需 seed 配合，实施时按 e2e-setup.sh 现状调整或只测横幅渲染分支）。

## 8. 验收标准

1. 全新部署：admin 首登见横幅（改密红牌），依次完成三项后横幅消失；「从模板开始」创建信息助理并发消息可得到带引用上标的回复。
2. 全新普通用户：首登见向导，三步完成，composer 已预填示例指令，发送成功；退出重登不再出现向导（任何路径均无重进入口）。
3. 存量实例升级：已有会话的老用户登录无任何向导 / 横幅打扰（desktop 侧；admin 横幅按密码事实呈现，属预期）。
4. 未配模型实例：新用户首登见降级提示页而非报错对话；配好模型后刷新进入向导。

## 9. 风险与开放问题

| 风险 | 应对 |
|------|------|
| 示例指令依赖外部网络（web_search）在离线内网实例失败 | 向导文案兜底（失败也是体验，引导看轨迹）；模板 description 注明需可访问公网 |
| e2e 种子密码非默认，红牌用例难造 | e2e-setup.sh 增加一个「未改密」判定注入或仅测渲染分支，实施时定 |
| readiness 每次登录多一次聚合查询 | 三次 count + 一次 bcrypt（仅管理员路径），量级可忽略；TaskView / Layout 各自只拉一次 |
| 向导覆盖层与 TaskView 既有挂载逻辑（CenterTabs 恢复等）冲突 | 覆盖层为纯显示层，不参与 Tab 状态；先补「覆盖层存在不影响 Tab 冷启动还原」断言 |
