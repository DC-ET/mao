# 提案目录（docs/proposals）

产品方向头脑风暴的产出。每份提案独立成文，评审通过后转入实施（届时可挪入 `docs/plan/` 或直接拆任务）。

## 已细化（2026-10-02）

| 提案 | 文档 | 一句话 | 建议优先级 |
|---|---|---|---|
| 跨会话长期记忆 | [2026-10-02-long-term-memory.md](2026-10-02-long-term-memory.md)（已转入实施，技术方案见 [docs/plan/2026-10-02-long-term-memory-technical-design.md](../plan/2026-10-02-long-term-memory-technical-design.md)） | 任务收尾自动沉淀用户/项目记忆，跨会话注入系统提示词，用户全权管理 | 高（留存价值最大） |
| Agent 资产化 | [2026-10-02-agent-asset-bundle.md](2026-10-02-agent-asset-bundle.md) | Agent 克隆 / bundle 导出导入 / 团队共享目录，配置即生态 | 低（工程量小，适合穿插） |
| 任务收件箱 | [2026-10-02-task-inbox.md](2026-10-02-task-inbox.md)（已实施，技术方案见 [docs/plan/2026-10-02-task-inbox-technical-design.md](../plan/2026-10-02-task-inbox-technical-design.md)，0.0.235 发版） | 聚合任务完成/提问/审批/子代理事件的站内通知中心（实施时改为 V131 新建 notification 表：原表已在 V058 被 DROP） | 高（补齐异步闭环） |

排期注意：记忆与收件箱都会动 `task-terminal.service.ts` 附近的相位收敛点，建议错开实施。

## 第二批（2026-10-05）

背景：首批三件套（记忆 / 收件箱 / 资产化）已全部实施，本批为下一阶段方向。本批评审结果：资产分发闭环与开放 API 已转入实施；多 Agent 协作不做（见下方台账）。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 资产分发闭环 | [2026-10-05-asset-distribution.md](2026-10-05-asset-distribution.md)（已转入实施，技术方案见 [docs/plan/2026-10-05-asset-distribution-technical-design.md](../plan/2026-10-05-asset-distribution-technical-design.md)） | 依赖一键补装、bundle URL 导入与更新检查、技能独立 bundle | 小~中 |
| 开放 API | [2026-10-05-open-api-webhook.md](2026-10-05-open-api-webhook.md)（已转入实施，技术方案见 [docs/plan/2026-10-05-open-api-webhook-technical-design.md](../plan/2026-10-05-open-api-webhook-technical-design.md)） | API Token + 入站 Webhook 触发器 + 出站事件订阅，让外部系统驱动 Agent | 中 |

排期注意：资产分发 P2 的 bundle URL registry 是开放 API 之外唯一的对外暴露面，若两个提案都做，安全评审合并做一次。

## 第三批（2026-10-06）

背景：第二批两件转入实施后，基于代码现状摸底（工具并行已支持、用量无成本概念、审批无规则记忆、无会话分享/导出、压缩用主模型）产出的五个方向。本批评审结果（2026-10-06）：**检查点回滚不做**（存档勿评审）；**其余四件转入实施**，技术方案见 `docs/plan/2026-10-06-*-technical-design.md`。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 任务检查点与工作区回滚 | [2026-10-06-task-checkpoint-rollback.md](2026-10-06-task-checkpoint-rollback.md)（已否决，存档） | 轮次边界自动快照工作区+消息水位，Agent 改错文件可一键退回 | — |
| 用量成本核算与预算管控 | [2026-10-06-usage-cost-budget.md](2026-10-06-usage-cost-budget.md)（已实施，技术方案见 [docs/plan/2026-10-06-usage-cost-budget-technical-design.md](../plan/2026-10-06-usage-cost-budget-technical-design.md)，0.0.243 发版） | 模型价格→成本落账，用户/Agent 月度预算软提醒硬拦截；开放 API/Webhook 时代给费用装闸门 | 中 |
| 工具审批规则 | [2026-10-06-approval-rules.md](2026-10-06-approval-rules.md)（已转入实施，技术方案见 [docs/plan/2026-10-06-approval-rules-technical-design.md](../plan/2026-10-06-approval-rules-technical-design.md)） | 审批弹窗第三选项"本会话总是允许"+用户级 allowlist，在逐次审批与 FULL 档之间给中间态 | 中 |
| 上下文透视与手动治理 | [2026-10-06-context-inspector.md](2026-10-06-context-inspector.md)（已转入实施，技术方案见 [docs/plan/2026-10-06-context-inspector-technical-design.md](../plan/2026-10-06-context-inspector-technical-design.md)） | 检查器展示模型实际收到的上下文构成（分节/记忆条目/压缩摘要），支持手动压缩与单会话记忆开关 | 中 |
| 会话分享与导出 | [2026-10-06-session-share-export.md](2026-10-06-session-share-export.md)（已转入实施，技术方案见 [docs/plan/2026-10-06-session-share-export-technical-design.md](../plan/2026-10-06-session-share-export-technical-design.md)） | 只读快照链接（水位冻结）+ Markdown 导出，让任务结果走出会话列表 | 中 |

排期注意：预算 WARN 结算挂在 `task-terminal.service.ts` 的 `finishExecution`（记忆/收件箱曾动过的相位收敛点），与在途同类改动错开实施；上下文透视动 prompt-engine / agent-loop / compaction 链路，审批规则动 tool-dispatcher 判门，两者与分享（session 域 + desktop）互不冲突。迁移编号按实施时实际空闲号顺延（本批最终为 V138 / V139）。

## 第四批（2026-10-09）

背景：前三批提案全部落地后，基于代码现状摸底（工具耗时未落库、执行前无计划门、出网面无任何策略、备份恢复纯手工、除收件箱外数据无寿可尽）产出的五个方向，共同主题是"信任与治理加深度"：看得见执行（轨迹）、拦得住执行前（计划门）、管得住出口（出网与防泄漏）、救得回实例（备份）、退得了旧数据（保留与可携带）。本批评审结果（2026-10-09）：**运行轨迹透视转入实施**，其余四件不做（见下方台账）。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 任务运行轨迹透视 | [2026-10-09-run-trace-timeline.md](2026-10-09-run-trace-timeline.md)（已转入实施，技术方案见 [docs/plan/2026-10-09-run-trace-technical-design.md](../plan/2026-10-09-run-trace-technical-design.md)） | 按轮次聚合 LLM/工具/事件的执行时间线，回答"为什么慢、贵、失败"；向过去看，补上下文透视（向未来看）的另一半 | 中 |

## 第五批（2026-10-09）

背景：前四批全部落定后，基于代码现状摸底产出的五个方向，共同主题是"从能用到敢用"：故障时任务不断（模型容灾）、无人值守的自动化可信（定时任务可靠性）、人对工作区有直接掌控（文件直管）、过去找得回来（全文检索）、对外接口看得见（开放接口调用中心）。本批评审结果（2026-10-09）：**模型容灾与故障转移不做**（见下方台账），其余四件均转入实施。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 模型容灾与故障转移 | [2026-10-09-model-fallback-health.md](2026-10-09-model-fallback-health.md)（已否决，存档） | 主模型重试耗尽/额度耗尽/供应商故障时按备用链自动切换并熔断冷却，任务不中断；转移全程留痕 | — |
| 定时任务可靠性 | [2026-10-09-scheduled-task-reliability.md](2026-10-09-scheduled-task-reliability.md)（已实施，技术方案见 [docs/plan/2026-10-09-scheduled-task-reliability-technical-design.md](../plan/2026-10-09-scheduled-task-reliability-technical-design.md)，决策记录 11 条于 2026-10-09 逐条确认，0.0.256 发版） | 失败重试、停机错过补偿、按任务运行历史、连续失败自动暂停并通知——无人值守自动化的信任基础 | 小~中 |
| 工作区文件直管 | [2026-10-09-workspace-file-manager.md](2026-10-09-workspace-file-manager.md)（已实施，技术方案见 [docs/plan/2026-10-09-workspace-file-manager-technical-design.md](../plan/2026-10-09-workspace-file-manager-technical-design.md)，0.0.281 发版） | 文件树从只读浏览升级为文件管理器：上传/新建/重命名/删除（物理删除+强确认，不做回收站）/移动/复制，沙箱与 Agent 写锁协同 | 中 |
| 跨会话全文检索 | [2026-10-09-global-message-search.md](2026-10-09-global-message-search.md)（已实施，技术方案见 [docs/plan/2026-10-09-global-message-search-design.md](../plan/2026-10-09-global-message-search-design.md)，0.0.257 发版） | MySQL 8 ngram 全文索引覆盖 USER+ASSISTANT 消息，替代 LIKE 全表扫与只搜用户消息的现状，结果可筛选可跳转定位 | 中 |
| 开放接口调用中心 | [2026-10-09-open-api-call-center.md](2026-10-09-open-api-call-center.md)（已实施，技术方案见 [docs/plan/2026-10-09-open-api-call-center-technical-design.md](../plan/2026-10-09-open-api-call-center-technical-design.md)，0.0.255 发版） | 入站 API Token/Webhook 调用流水（含拒绝路径）、统计面板、失败告警与请求重放，补上开放接口三件套里缺失的可观测 | 小~中 |

排期注意：定时任务可靠性与模型容灾都碰执行收敛点附近，与历史上记忆/收件箱/预算动过的 `task-terminal.service.ts` 收敛点相邻，实施时错开；全文检索的 V142 迁移与另两份提案的新表（若都过）注意编号顺延（工作区文件直管零迁移，不占编号）；开放接口调用中心 P3 的 Token 自动停用与既有 Webhook 触发器自动停用模式对齐，可合并一次交互评审。

## 第六批（2026-10-11）

背景：前五批落定后（轨迹 / 定时任务可靠性 / 全文检索 / 文件直管 / 开放接口调用中心 / 成本预算 / 审批规则 / 上下文透视 / 资产分发等均已实施），基于代码现状摸底产出的五个方向，共同主题是"**让系统自己长起来**"：踩过的坑变成能力（负反馈闭环）、外部变化自己敲门（信号哨兵）、一次成功复用一辈子（技能蒸馏）、环境起点不用每次裸奔（工作区模板）。提案均严格避开已否决方向（RAG / Evals / 多 Agent DAG / 计划门 / 出网边界 / 备份恢复 / 数据保留 / 模型容灾 / 检查点回滚），且都建立在已实施设施之上（经验表、轨迹服务、staged 技能写入、出站投递），不新增大规模基础设施。本批评审结果（2026-10-11）：**技能蒸馏、工作区环境模板、渠道人工接管不做**（见下方台账），负反馈闭环与信号哨兵已转入实施（分别落地 0.0.276 / 0.0.278）。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 负反馈闭环 | [2026-10-11-feedback-experience-loop.md](2026-10-11-feedback-experience-loop.md)（**已实施**，技术方案见 [docs/plan/2026-10-11-feedback-experience-loop-technical-design.md](../plan/2026-10-11-feedback-experience-loop-technical-design.md)，决策记录 16 条于 2026-10-11 逐条确认；落地为 V148/V149 迁移 + 管理后台转经验向导与忽略闭环，CHANGELOG 0.0.276） | 点踩数据今天只进报表不改行为；单条 / 聚集反馈经 LLM 起草 + 人工确认流入既有 `agent_experiences` 管道，把"踩过的坑"变成 Agent 的能力 | 小~中 |
| 渠道人工接管 | [2026-10-11-human-handoff.md](2026-10-11-human-handoff.md)（已否决，存档） | Agent 答不动时经工具或卡片按钮把会话切给真人（新相位 `WAITING_HUMAN` + 收件箱新 kind），接管人从桌面端回答并经渠道回发，补上 IM 客服 / 运维场景缺失的"人进来"出口 | — |
| 信号哨兵 | [2026-10-11-signal-watcher.md](2026-10-11-signal-watcher.md)（已实施，技术方案见 [docs/plan/2026-10-11-signal-watcher-technical-design.md](../plan/2026-10-11-signal-watcher-technical-design.md)，决策记录 15 条于 2026-10-11 逐条确认，0.0.278 发版） | HTTP 探针轮询外部信号（内容哈希 / JSON 字段比对），**只在变化时**触发 Agent 运行，替代"每分钟 cron 硬扫让模型自己判断有没有变"的烧钱模式 | 中 |
| 技能蒸馏 | [2026-10-11-skill-distillation.md](2026-10-11-skill-distillation.md)（已否决，存档） | 从会话轨迹（既有 RunTraceService）+ 结论 + 文件变更起草 `SKILL.md`，人预览 / 编辑 / 试跑后落用户技能目录——把"那次跑通了"变成"下次直接用" | — |

排期注意：

1. **迁移编号**：本批剩余两个提案共需 2 个新迁移（feedback 状态列、signal 两表），当前最新为 V147，按实施顺序顺延 V148+。
2. **LLM 起草模式参照**：负反馈闭环的 `scene=feedback_experience_draft` 与 git 提交信息（`git_commit_message`）同为"轨迹摘要 → LLM 起草 → 人确认"，prompt 契约 / 敏感文件过滤 / 纠错重试可参照后者实现，不新建共享抽象（仅一处使用）。
3. **收件箱新 kind**：信号哨兵需加 `WATCHER_DISABLED`，须同步 `backend-ts/src/inbox/types.ts` 白名单、`@mao/contracts` 的 `InboxKind` 联合类型、桌面抽屉图标与通知偏好。
4. **桌面端工作量**：哨兵管理页为桌面端新界面，实施时注意与 `settings` 页既有改动的冲突。

## 第七批（2026-10-12）

背景：前六批落定后，自动化设施（定时任务 / 哨兵 / 开放接口）与治理设施（轨迹 / 预算 / 审批 / 反馈闭环）均已就位，基于代码现状摸底（联网工具结果里的 URL 出口即丢、模型选择器一次只能选一个、出站订阅只有事件粒度没有日报粒度）产出的三个方向，共同主题是"**从敢用到可信、可择优、可总览**"：答案可验证（引用）、模型可对照（选型）、运营可总览（日报）。提案均避开已否决方向（RAG / Evals / 多 Agent DAG / 容灾 / 技能蒸馏等），且全部建立在既有设施之上（消息渲染 / message_feedback / 出站订阅 / 收件箱 / 偏好），不新增大规模基础设施。本批评审结果（2026-10-12）：**模型对照台不做**（见下方台账），**引用溯源已实施**（技术方案见 [docs/plan/2026-10-12-answer-citations-technical-design.md](../plan/2026-10-12-answer-citations-technical-design.md)，决策记录 9 条于 2026-10-12 逐条确认，0.0.282 发版；实施时零迁移，citations 走 message.metadata），**每日运营摘要已实施**（技术方案见 [docs/plan/2026-10-12-daily-digest-technical-design.md](../plan/2026-10-12-daily-digest-technical-design.md)，决策记录 11 条于 2026-10-12 逐条确认，0.0.281 发版；投递渠道定为收件箱 + 出站订阅，IM 明确不做，v1 一次交付）。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 回复引用溯源 | [2026-10-12-answer-citations.md](2026-10-12-answer-citations.md)（已实施，技术方案见 [docs/plan/2026-10-12-answer-citations-technical-design.md](../plan/2026-10-12-answer-citations-technical-design.md)，0.0.282 发版） | 模型用 `[^n^]` 标记外部信息来源，后端按本轮工具结果 URL 白名单校验（伪造 URL 一律剥标），三端渲染可点击来源区——让每句话可验证 | 中 |
| 模型对照台 | [2026-10-12-model-compare.md](2026-10-12-model-compare.md)（已否决，存档） | 一次提问广播 2~4 个模型并排作答，人工择优固化进上下文，点踩 / 用量 / 轨迹全链路复用——换模型不用再复制原话重问 | — |
| 每日运营摘要 | [2026-10-12-daily-digest.md](2026-10-12-daily-digest.md)（已实施，技术方案见 [docs/plan/2026-10-12-daily-digest-technical-design.md](../plan/2026-10-12-daily-digest-technical-design.md)，决策记录 11 条于 2026-10-12 逐条确认，0.0.281 发版） | 按天汇总任务成败 / 定时任务 / 哨兵触发 / 审批待办 / 成本 Top，经收件箱（新 kind）与出站订阅（新事件）送达——"没有消息就是坏消息"的健康信号 | 小~中 |

排期注意：

1. **迁移编号**：Digest 需 V150（`user_digest_preference` 偏好表；事实表零新增）；引用溯源改走 metadata 后零迁移。当前最新 V149。
2. **三处同改清单**：Digest 新增收件箱 kind `DAILY_DIGEST`，按规范同改 `backend-ts/src/inbox/types.ts` 白名单、`@mao/contracts` 的 `InboxKind` 联合、桌面抽屉图标与通知偏好。
3. **相邻收敛点**：引用溯源（已实施）的 registry 构建挂在 `task-terminal.service.ts` 的 `TASK_COMPLETED` 相位收敛点（历史上记忆 / 收件箱 / 预算动过的同一位置），与在途同类改动错开；Digest 若做，其调度器与 `InboxCleanupScheduler` / `OutboundDeliveryScheduler` 同范式，不动收敛点。

## 第八批（2026-10-19）

背景：前七批落定后，基于代码现状摸底（35 个内置工具零 Git 能力而桌面 Git 面板服务层齐全、重复 SOP 无任务级模板资产、三层知识资产全部孤岛且负反馈闭环刚下线）产出的三个方向，共同主题是「**补上干活的角色欠的装备**」：Agent 手里的工具（Git）、重复劳动的资产化（模板）、团队尺度上的知识复利（共享与提案）。提案均避开已否决方向（RAG / Evals / 多 Agent DAG / 计划门 / 出网边界 / 备份恢复 / 数据保留 / 模型容灾 / 检查点回滚 / 技能蒸馏 / 工作区模板 / 人工接管 / 模型对照台）与 README 贡献边界（低代码画布 / 语音 / i18n / 官方 SaaS），且全部建立在既有设施之上（file 域 Git 服务层、schedule / signal 域模板先例、memory 注入管道与 agent_experiences）。本批评审结果（2026-10-19）：**三件均不做**（存档勿再评审，见下方台账）。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| Agent 结构化 Git 工具链 | [2026-10-19-agent-git-tools.md](2026-10-19-agent-git-tools.md)（已否决，存档） | 把桌面 Git 面板背后的 status/diff/commit/pull/push 服务层开放为 Agent 工具（只读双工具 + 审批门写操作 + reviewer 换装），替掉 shell 拼 git 字符串的现状 | — |
| 任务模板 / Runbook | [2026-10-19-task-template-runbook.md](2026-10-19-task-template-runbook.md)（已否决，存档） | Agent + 参数化提示词 + 调度建议存为模板，一键创建定时任务 / 会话，让重复 SOP 从「每次重打」变「一次配置多次运行」 | — |
| 团队知识层 | [2026-10-19-team-knowledge-layer.md](2026-10-19-team-knowledge-layer.md)（已否决，存档） | TEAM 级共享记忆（个人提升 + 管理员可见可删）+ 普通用户可发起的经验提案通道（管理员审核落 agent_experiences），补上被拆除的反馈闭环留下的知识流转缺口 | — |

## 第九批（2026-10-19）

背景：第八批三件（Git 工具链 / 任务模板 / 团队知识层）同日评审全部否决后，不再「补既有链路缺口」，转向**打开新轴线**的三个方向，共同主题是「**把 Agent 的触角伸到今天够不着的地方**」：够到外部世界最通用的异步通道（邮件）、够到用户自己的系统而不必先跑一个 server（自定义工具）、让输出本身长出界面（结构化卡片）。三件互不依赖、分属三个域（通知 / 工具树 / 消息渲染），均避开已否决方向与贡献边界。本批评审结果（2026-10-19）：**结构化卡片不做**（存档）；**邮件渠道方向认可但范围收窄**——只做「任务通知第三渠道（飞书 / 钉钉 / 邮件）」，入站邮件域明确不做（原入站框架随收窄存档）；**自定义 HTTP 工具方向认可但重新设计**——不做全量 schema 注入的 Agent tool（防上下文膨胀），改为参考 MCP 工作集的懒加载形态（目录分节 + describe 按需 + 单一 `http_call` 入口）。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 邮件通知渠道 | [2026-10-19-email-notification.md](2026-10-19-email-notification.md)（**已确认**，决策记录 8 条于 2026-10-19 逐条确认，技术方案见 [../plan/2026-10-19-email-notification-technical-design.md](../plan/2026-10-19-email-notification-technical-design.md)：仅出站通知渠道，实例 SMTP 配置 + `NotificationChannel` 扩 `EMAIL` + 复用既有偏好 / 调度 / 重试全链路；原「邮件渠道」入站部分不做） | 通知第三渠道：实例 SMTP 配置 + `NotificationChannel` 扩 `EMAIL` + 目标地址用本人资料邮箱（`user.email` 第一次被真正使用），投递全链路复用既有偏好 / 调度 / 重试 | 小~中 |
| 自定义 HTTP 工具（懒加载） | [2026-10-19-custom-http-tools.md](2026-10-19-custom-http-tools.md)（**已确认**，决策记录 6 条于 2026-10-19 逐条确认，技术方案见 [../plan/2026-10-19-custom-http-tools-technical-design.md](../plan/2026-10-19-custom-http-tools-technical-design.md)：MCP 工作集式懒加载，不进 `tools` 数组） | 声明式工具定义（端点 + 参数 + 加密请求头）填个表单连内部系统；提示词只放紧凑目录，`http_describe` 按需取 schema，`http_call` 单一入口执行——「连我的系统」从「先跑个 MCP server」降为「填个表单」 | 中 |
| 结构化回复卡片 | [2026-10-19-structured-reply-cards.md](2026-10-19-structured-reply-cards.md)（已否决，存档） | 封闭集块协议（table/chart/file/choices/actions）：模型埋围栏块 → 后端 citations 式校验 → 三端 + CLI + 分享原生渲染，主对话第一次拥有 IM 渠道早有卡片形态 | — |

排期注意：

1. **迁移编号**：邮件通知仅 V161（`system_setting` 的 SMTP seed 行，业务表零迁移——偏好 / 投递的 channel 列是字符串）；自定义工具 V162（`user_tool` + `user_tool_param` 两表）。当前最新 V160，按实施顺序顺延。
2. **三处同改清单**：邮件通知的 `NotificationChannel += 'EMAIL'` 按规范同改 `shared/contracts/src/notification.ts` 联合、后端 `notification/task/types.ts` 的 `parseNotificationChannel`、桌面 `NotificationSettingsView.vue` 的渠道单选（编译期穷尽兜底）；自定义工具按 AGENTS.md 规范同步 `tool-result-summarizer.ts` 与 `desktop/src/utils/toolDisplay.ts`（`http_call` / `http_describe` 分支）并补回归测试。
3. **SSRF 面**：自定义工具的用户配 URL = 服务端代发，需过安全评审（私网段禁令 + 管理员放行，复用哨兵同款判定）；邮件通知的 SMTP 是实例级管理员配置，无用户面 SSRF，两者不合并评审。
4. **前缀缓存**：自定义工具的目录分节是用户级内容（与 MCP 工作集同类，0.0.309 已接受的语义）；邮件通知不动提示词。结构化卡片否决后，其提示词分节方案一并存档。
5. **宪法级约束的机械保障**：自定义工具「不进 `tools` 数组」需在测试里加断言防回归（见该提案测试要点末条）。

## 已评估、明确不做

以下各项已复审定案，**不再重启、不再提案**（存档文档已标否决，勿再评审）：

- **知识库 / RAG**：2026-10-02 首评暂缓，2026-10-05 二次提案后仍定不做（与技能/工作区文件能力重叠、工程量大、需新增 embedding 设施）。存档：[2026-10-05-knowledge-rag.md](2026-10-05-knowledge-rag.md)。
- **提示词回归评测（Evals）**：2026-10-05 提案后定不做。存档：[2026-10-05-agent-evals.md](2026-10-05-agent-evals.md)。
- **多 Agent 协作（任务 DAG / 队友信箱 / Worktree）**：2026-10-05 提案后定不做（现有子代理 + wait 汇合已覆盖当前需求，编排语义引入的失控面与调试成本大于收益）。存档：[2026-10-05-agent-teams-dag.md](2026-10-05-agent-teams-dag.md)。
- **计划模式（执行前计划门）**：2026-10-09 评审：不做。存档：[2026-10-09-plan-mode.md](2026-10-09-plan-mode.md)。
- **出网边界与敏感数据防泄漏**：2026-10-09 评审：不做。存档：[2026-10-09-egress-data-boundary.md](2026-10-09-egress-data-boundary.md)。
- **实例备份与一键恢复**：2026-10-09 评审：不做。存档：[2026-10-09-backup-restore.md](2026-10-09-backup-restore.md)。
- **数据保留策略与个人数据可携带**：2026-10-09 评审：不做。存档：[2026-10-09-data-retention-portability.md](2026-10-09-data-retention-portability.md)。
- **模型容灾与故障转移**：2026-10-09 评审：不做。存档：[2026-10-09-model-fallback-health.md](2026-10-09-model-fallback-health.md)。
- **技能蒸馏（会话轨迹 → 技能）**：2026-10-11 评审：不做。存档：[2026-10-11-skill-distillation.md](2026-10-11-skill-distillation.md)。
- **CLOUD 工作区环境模板与快照**：2026-10-11 评审：不做（重复装环境的问题真实存在，但模板资产带来磁盘配额、敏感文件进 TEAM 共享、符号链接逃逸三重新增风险面，收益/风险比不划算；建会话时装依赖的需求可先用"Git clone + 初始化命令"的既有链路人工满足）。存档：[2026-10-11-workspace-template.md](2026-10-11-workspace-template.md)。
- **渠道会话人工接管（Human Handoff）**：2026-10-11 评审：不做。存档：[2026-10-11-human-handoff.md](2026-10-11-human-handoff.md)。
- **模型对照台（一次提问多模型并排作答）**：2026-10-12 评审：不做。存档：[2026-10-12-model-compare.md](2026-10-12-model-compare.md)。
- **Agent 结构化 Git 工具链**：2026-10-19 评审：不做。存档：[2026-10-19-agent-git-tools.md](2026-10-19-agent-git-tools.md)。
- **任务模板 / Runbook**：2026-10-19 评审：不做。存档：[2026-10-19-task-template-runbook.md](2026-10-19-task-template-runbook.md)。
- **团队知识层（TEAM 记忆 + 经验提案）**：2026-10-19 评审：不做。存档：[2026-10-19-team-knowledge-layer.md](2026-10-19-team-knowledge-layer.md)。
- **结构化回复卡片（封闭集块协议）**：2026-10-19 评审：不做。存档：[2026-10-19-structured-reply-cards.md](2026-10-19-structured-reply-cards.md)。

## 已排除的方向（与产品定位或约束冲突）

- 低代码工作流画布（README 明确"不是 Dify / n8n"）。
- 安卓原生推送（安卓壳约束不变；Web Push 作为收件箱 P3 的可选探索）。
- 语音输入、官方 SaaS、界面国际化（README 贡献边界已声明）。
