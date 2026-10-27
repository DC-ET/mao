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

## 第十批（2026-10-22）

背景：前九批落定后，运行轨迹（2026-10-09 实施）已服务多个版本，基于与外部参照 deepseek-harness（DeepSeek 开源 agent harness，MIT，Trajectory 视图见 `packages/client/ui-trajectory`）的逐项对比盘点产出。共同主题是「**把摘要看板升级为执行调试器**」：时间维度可视化、记录内容下钻、搜索、计时/用量补全。避开已否决方向，全部建立在已实施设施（轨迹读模型 / message 表 / llm_call）之上，P1 零迁移。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 运行轨迹深度下钻 | [2026-10-22-run-trace-deep-dive.md](2026-10-22-run-trace-deep-dive.md)（待评审） | 借鉴 deepseek-harness Trajectory：run 内时间概览条带（首字/解码分段、悬停精确时刻、点击定位）+ 记录详情按需下钻（参数/结果/计时）+ 轨迹内搜索 + 解码耗时/吞吐/provider/请求编号补全 | 中 |

排期注意：P1 的 VO 增量（`startedAtMs` / `provider`）会动 `trace-export.ts` 与桌面既有轨迹测试（`trace-token.bugcheck.test.ts` 等），实施时同步断言；P2 的请求构成埋点（`llm_call` 加 `prompt_version_id` / `tools_digest` 两列）触 harness 写入链路，单独评审、单独占迁移编号。

## 第十一批（2026-10-24）

背景：前十批把自动化（定时 / 哨兵 / 开放接口）、治理（预算 / 审批 / 轨迹 / 检索）、资产分发与通知渠道基本铺满。本批不再沿「补既有链路缺口」走，而是回到**执行形态**本身找增量：平台已经能无人值守地跑一件事，但仍不会跑一批、不能在跑的过程中纠偏、也不把跑出来的成果当回事。三个方向分别对应「输入规模 / 过程控制 / 输出交付」，互不依赖，可单独评审、单独上线。全部避开已否决方向（RAG / Evals / 多 Agent DAG / 计划门 / 出网边界 / 备份恢复 / 数据保留 / 模型容灾 / 检查点回滚 / 技能蒸馏 / 工作区模板 / 人工接管 / 模型对照台 / Git 工具链 / 任务模板 / 团队知识层 / 结构化卡片），且建立在既有设施上（`message_queue` / `session` / `budget` / `file` / `session_share` / `send-file-bytes`）。

**评审结果（2026-10-24）：三项均驳回，存档勿再评审。** 下一批转向「团队长期使用中的 Agent 自我改进」，见第十二批。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 执行中引导 | [2026-10-24-run-steering.md](2026-10-24-run-steering.md)（已否决，存档） | 在工具轮边界插入用户引导，长任务不必取消重来；排队 / 引导 / 插队三种语义并存 | 中 |
| 批量任务 | [2026-10-24-batch-runs.md](2026-10-24-batch-runs.md)（已否决，存档） | 一份输入 N 条，每条独立会话执行，支持并发 / 重试 / 暂停 / 导出，补上 1→N 的执行形态 | 中~大 |
| 交付物中心 | [2026-10-24-artifact-center.md](2026-10-24-artifact-center.md)（已否决，存档） | 把 Agent 产出登记为不可变交付物，可检索 / 预览 / 下载 / 发送，跨会话与批次聚合 | 中 |

排期注意（存档，不再执行）：

1. **迁移编号（已作废，不占号）**：引导 V169（`message_queue.mode`）、批次 V170+V171（`batch_run` / `batch_item` + `session.batch_id`）、交付物 V172（`artifact` 表）。当前最新 V168，按实际实施顺序顺延。
2. **相邻收敛点**：引导改 `AgentLoop` 的工具轮边界（与 mid-loop 压缩、no-progress guard 同位置），与压缩相关改动错开；批次抽 `SessionRunLauncher` 会动 open-run 的执行路径（定时任务 P2 再收口），需单独评审并回归开放接口；交付物新增工具必须按规范同改 `tool-result-summarizer.ts` / `toolDisplay.ts` / `no-progress-notice.ts`。
3. **相互依赖**：交付物可独立先行；批次 P2 的「本批产物」聚合依赖交付物，未实施时降级为工作区路径列表；引导与两者无依赖。建议实施顺序：交付物 → 引导 → 批次，或先做引导（约 1.5 周即可见效）。

## 第十二批（2026-10-24）

背景：第十一批（执行形态三件）当日驳回后，按「团队长期使用时 Agent 越用越好用、越用越高效、越用越精准」重新脑暴。本批不从执行形态入手，而是把团队用出来的数据变成三种长期资产：**改进项（哪里该修）/ 经验（什么值得留下）/ 能力（该带哪些工具）**。三份可独立实施，组合起来是一条 measure → learn → capability 的复利链。全部避开已否决方向（RAG / Evals / 多 Agent DAG / 计划门 / 出网边界 / 备份恢复 / 数据保留 / 模型容灾 / 检查点回滚 / 技能蒸馏 / 工作区模板 / 人工接管 / 模型对照台 / Git 工具链 / 任务模板 / 团队知识层 / 结构化卡片），也不复活 0.0.299 下线的「逐条点踩转经验」。

**评审结果（2026-10-24）：三项均驳回，存档勿再评审。** 方向校准：要的是「Agent 越用越懂用户的模糊指令（推单 / 佣金 / 出货额等业务关键词）」，见第十三批。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| Agent 改进闭环 | [2026-10-24-agent-improvement-loop.md](2026-10-24-agent-improvement-loop.md)（已否决，存档） | 按 Agent 聚合反复出现的点踩 / 失败 / 模型错误，形成有证据、有影响分、有负责人、修复后验证的改进项 | 中~大 |
| 经验资产化 | [2026-10-24-experience-lifecycle.md](2026-10-24-experience-lifecycle.md)（已否决，存档） | 经验有来源、命中、成败、冲突 / 过时标记与退休；P2 从复发问题挖掘候选，人工确认 | 中 |
| 能力体检 | [2026-10-24-capability-health.md](2026-10-24-capability-health.md)（已否决，存档） | 记录工具调用的成败 / 耗时 / 结果大小，按 Agent 给出停用 / 替换 / 补能力建议 | 中 |

排期注意（存档，不再执行）：

1. **迁移编号（已作废，不占号）**：改进闭环 V169+V170（`agent_signal` / `improvement_*`）、经验 V171（经验字段 + `experience_hit`）、能力体检 V172（`tool_call_log` / `tool_call_daily`）。当前最新 V168，按实际实施顺序顺延。
2. **相邻收敛点**：改进闭环用后台聚合任务读既有表，刻意不动 `task-terminal.service.ts` 的相位收敛点；经验归因在 `HarnessService` 装配上下文时记录命中，只给 `ContextManifest` 加 id、不改变提示词字节；能力体检在 `AgentLoop` 拿到 `ToolResult` 后异步埋点，不改工具结果与审批语义。
3. **组合关系**：改进闭环的「加经验」接经验候选；经验命中的成败回流改进闭环做信号；能力体检的「写成经验」复用经验生命周期。建议实施顺序：能力体检（最快拿到数据）→ 改进闭环 → 经验生命周期；也可按痛点单独启动——问题反复做改进闭环、经验膨胀做经验生命周期、工具膨胀做能力体检。经验归因（提案二 P1）是验证「经验类修复」的基础，建议不晚于改进闭环的 P2。
4. **统一口径**：三份都只做生产数据的观察性关联，不做离线评测、不做 A/B、不宣称因果；所有自动标记都需人工确认后才改变 Agent 行为。

## 第十三批（2026-10-24）

背景：第十二批（改进闭环 / 经验资产化 / 能力体检）当日驳回后，方向校准为「**Agent 越用越懂用户发送的模糊指令**」——团队的大部分模糊指令里都带业务关键词，如**推单、佣金、出货额**。本批不从管理后台的度量与治理入手，而是补上 Agent 在「听懂业务黑话」上的三层能力：**业务词典（词是什么意思）→ 模糊指令解析（这句话里指哪个、缺什么、问不问）→ 术语学习（从每次澄清和纠错里更新词典）**。三份按依赖串成一条「配置 → 使用 → 回流」的链，可分别评审、分期上线。全部避开已否决方向（RAG / Evals / 多 Agent DAG / 计划门 / 出网边界 / 备份恢复 / 数据保留 / 模型容灾 / 检查点回滚 / 技能蒸馏 / 工作区模板 / 人工接管 / 模型对照台 / Git 工具链 / 任务模板 / 团队知识层 / 结构化卡片），也不复活 0.0.299 下线的「逐条点踩转经验」。

**评审结果（2026-10-24）：三项均驳回，存档勿再评审。** 结论：业务语义理解是值得深思的设计方向，本期不进入实施。

现实依据（来自现有业务技能）：

- **推单**：`ascm-cli` 里既有「查推单状态」的只读查询，也有「在仓订单-提前创建推单」的**唯一写操作**（货权转移、拦截/风控/冻结前置条件）；猜错含义的代价不是答错，而是误执行。
- **佣金**：`vtn-biz-cli` 里至少对应 `finance calculate`（按 SPU/SKU 算经销商佣金）、`revenue money`（推广佣金流水）、`revenue grow`（代理服务费）、`revenue ntx`（虚拟币收益）、`tengju provider jump-points`（服务商补贴/出货返点）。
- **出货额**：`bigdata-cli` 里 `pmt_gmv`（支付金额）与 `act_pmt_gmv`（实际成交销售额，受指标权限管控）是不同口径；其 SKILL.md 明确记录过「同义问题落到不同表、数字对不上」的真实教训。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 业务词典 | [2026-10-24-business-glossary.md](2026-10-24-business-glossary.md)（已否决，存档） | 把「推单/佣金/出货额」做成结构化术语：别名、一词多义、口径、数据源、默认参数、读写属性，按消息命中注入 | 中 |
| 模糊指令解析 | [2026-10-24-intent-resolution.md](2026-10-24-intent-resolution.md)（已否决，存档） | 先判断这句话里术语指哪个含义、缺哪些槽位，再决定直接查、按默认查，还是只问一个关键问题；写操作必须先确认 | 中 |
| 术语学习 | [2026-10-24-term-learning.md](2026-10-24-term-learning.md)（已否决，存档） | 把澄清回答、用户纠正、弱接受配对回解析记录，聚合出默认值/别名/歧义候选，管理员批准后写回词典 | 中 |

排期注意（存档，不再执行）：

1. **迁移编号（已作废，不占号）**：业务词典 V169（三表 + `glossary:*` 权限）、解析日志 V170（`term_resolution_log`）、术语学习 V171（事件 + 候选）。当前最新 V168；第十/十一/十二批已否决的编号不占号，按实际实施顺序顺延。
2. **相邻链路**：业务词典与解析都在 `HarnessService.buildContext` 装载历史后注入**不落库的 ephemeral system message**，不改写用户消息、不改系统提示词字节、不影响前缀缓存；术语学习只读解析日志与消息旁路，不改变执行语义。
3. **组合关系**：没有词典，解析没有锚点；没有解析，学习没有「当时理解成什么」；没有学习，词典只能靠人猜。建议顺序：业务词典（先录推单/佣金/出货额）→ 模糊指令解析（P1 先做只读+写确认）→ 术语学习（先做事件与观测，再做候选审批）。
4. **安全边界**：`推单` 这类写操作必须在解析卡与回答里显式标注，未确认不得执行；既有工具审批、权限、沙箱一律不绕过。三份都只存结构化术语/槽位/决策，不存用户原文。

## 第十四批（2026-10-25）

背景：第十一至十三批（共 9 件）连续三批全部驳回后，「补链路缺口」「执行形态」「长期学习」「业务语义」四条路均已探过且暂不推进。本批换轴：不再从既有链路找增量，而是把 Mao 从「自家五端的工作台」升级为「平台」——**对外协议**（任何 AI 客户端可用）、**向下扩边界**（任何机器可执行）、**向上放创造权**（任何用户可造 Agent）。三件互不依赖、分属三个域（协议端点 / 执行边界 / 用户侧资产），全部避开已否决方向（RAG / Evals / 多 Agent DAG / 计划门 / 出网边界 / 备份恢复 / 数据保留 / 模型容灾 / 检查点回滚 / 技能蒸馏 / 工作区模板 / 人工接管 / 模型对照台 / Git 工具链 / 任务模板 / 团队知识层 / 结构化卡片 / 执行中引导 / 批量任务 / 交付物中心 / 改进闭环 / 经验资产化 / 能力体检 / 业务词典三件套）与 README 贡献边界，且都建立在既有设施上（openapi 三件套、agent-cli local 执行栈与 WS 长连接、提示词版本 / 经验 / bundle）。

**评审结果（2026-10-25）：三项均驳回，存档勿再评审。** 平台扩张方向（对外协议 / 执行边界 / 创造权下放）整体不采，下一批收回「让已经在用的人和团队用得更顺」，见第十五批。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| MCP Server 输出 | [2026-10-25-mcp-server-out.md](2026-10-25-mcp-server-out.md)（已否决，存档） | 新增 `/api/v1/mcp` Streamable HTTP 端点，把开启暴露的 Agent 映射为 MCP 工具（鉴权 / 排队 / 预算 / 流水全复用开放 API），Claude Desktop / Cursor 等任何 AI 客户端直接调团队 Agent | 中 |
| 执行节点注册 | [2026-10-25-execution-nodes.md](2026-10-25-execution-nodes.md)（已否决，存档） | `mao-agent --register` 以节点凭据常驻连接，LOCAL 从「挂着桌面端的那台电脑」泛化为「我的任意机器」（公司工作站 / NAS / VPS），会话与定时任务绑定节点执行 | 中~大 |
| 用户自建 Agent | [2026-10-25-user-created-agents.md](2026-10-25-user-created-agents.md)（已否决，存档） | 普通用户创建私有 Agent（模型可选池 + MCP/工具引用制 + 本人预算兜底），用顺了经 bundle 提交为团队 Agent——创造权下放，治理口子仍握在管理员 | 中 |

排期注意（存档，不再执行）：

1. **迁移编号（已作废，不占号）**：三件各需一个迁移（MCP 暴露列 / `execution_node` + `session.node_id` / agent 归属列），当前最新 V170；已否决不占号，按实际实施顺序顺延。
2. **相邻收敛点**：MCP 输出只读 openapi 执行链路不动 `task-terminal.service.ts`；执行节点动 `streaming-ws-registry` / `streaming-ws-handler` 的路由维度，必须先补「node_id NULL 走现状」的回归护栏（`event-filter.ts` 注释记录的多端互扰场景是现成用例）；用户自建 Agent 的可见性过滤必须收口到 agent repository 单一方法，防读路径漏网。
3. **三处同改清单**：用户自建 Agent 的收件箱新 kind `AGENT_PUBLISH_REQUEST` 按规范同改 `@mao/contracts` InboxKind、`backend-ts/src/inbox/types.ts`、桌面抽屉图标与偏好；MCP 输出不新增工具（不触 `tool-result-summarizer.ts` / `toolDisplay.ts`），但 call-log source 扩 `MCP` 需同步调用中心筛选。
4. **安全评审**：MCP 输出（新对外协议端点）与执行节点（节点凭据 = 在用户机器上执行命令）两件各需一次安全评审，不合并。

## 第十五批（2026-10-25）

背景：第十四批（平台化三件：MCP 输出 / 执行节点 / 用户自建 Agent）当日驳回后，方向收回「**让已经在用的人和团队用得更顺**」。本批从日常使用的三个断点入手，共同主题是「**焊平断点**」：**配置断点**（定时任务早就能在对话里一句话建好，哨兵还得切去设置页抄参数——同一页面下两件事能力不对称）、**人员断点**（会话 / 定时任务 / 哨兵全部以人为锚，人休假离职时没有任何交接机制，磨合好的会话上下文是最不可交接的资产）、**上手断点**（自托管的流失发生在部署后的前 10 分钟：默认密码没改、模型 Key 没配、不知道让 Agent 干什么，全无机制兜底）。三件互不依赖、全部零 / 低迁移、不碰执行内核，均避开已否决方向与 README 贡献边界。

**评审结果（2026-10-25）：哨兵对话内配置、会话移交驳回（存档勿再评审）；首次成功体验方向认可，已细化技术方案待评审**，见 [../plan/2026-10-25-first-run-onboarding-technical-design.md](../plan/2026-10-25-first-run-onboarding-technical-design.md)（含 8 项待确认决策）。

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 信号哨兵对话内配置 | [2026-10-25-signal-watcher-tools.md](2026-10-25-signal-watcher-tools.md)（已否决，存档） | 补齐 `create/list/update/delete_signal_watcher` 工具组（与定时任务工具组对称，零迁移零服务端改动），「盯住这个接口变了叫我」从一句配置教程变成一句话当场建好 | 小~中 |
| 会话移交 | [2026-10-25-session-handover.md](2026-10-25-session-handover.md)（已否决，存档） | 终态会话整体移交（消息历史 + 绑定的定时任务 / 哨兵 + 边路记录）给同实例另一用户，双向确认 + 审计，人员变动不断链 | 小~中 |
| 首次成功体验 | [2026-10-25-first-run-onboarding.md](2026-10-25-first-run-onboarding.md)（**已细化，技术方案待评审**：[../plan/2026-10-25-first-run-onboarding-technical-design.md](../plan/2026-10-25-first-run-onboarding-technical-design.md)；V171 一表，readiness 只读端点 + admin 全局横幅 + desktop 三步向导 + 入门模板） | 管理员三步就绪清单（改密 / 配模型 / 建 Agent，全可直跳）+ 用户三步向导（选 Agent / 边界图解 / 发第一条示例任务）+ 入门 Agent 模板，把激活漏斗最大的洞补上 | 小~中 |

排期注意（1、2 已否决，条目作废；以下仅剩第 3 件）：

1. **迁移编号**：`V171__user_onboarding_preference.sql`（一表）；存量用户免打扰走运行时判定（无会话历史且无 preference 记录才弹向导），不回填。
2. **契约**：`ReadinessVO` 下沉 `@mao/contracts`（desktop + admin 双端消费）。
3. **相邻收敛点**：纯增量（一个只读端点 + 一个幂等写 + 覆盖层组件），不动 router、登录守卫、`task-terminal.service.ts`；向导覆盖层需补「不影响 CenterTabs 冷启动还原」断言。
4. **文档同步**：CHANGELOG 三节（backend-ts / admin / 前端）+ README「怎么用」+ install.md / deploy.md 上线检查与产品内清单互相指向。

## 第十六批（2026-10-25）

背景：第十五批把方向校准为「**让已经在用的人和团队用得更顺**」（首次成功体验已实施，0.0.347）。本批延续该方向，聚焦**日常使用的完整度与体验**，从代码现状摸底得出三类事实：**产出与阅读的错位**（Agent 天天产出 mermaid / 公式 / 表格，三端源码零渲染命中，用户只能复制到外部工具看图）、**半截子功能**（后端 pin / favorite / 列表 keyword 过滤全部就绪且排序已生效，desktop 零调用零入口）、**桌面壳的最后一块**（LOCAL 递不了文件、关窗即与任务失联，而 CLOUD 反而能传）。三件互不依赖，全部零迁移、零或近零后端改动，不碰执行内核。全部避开已否决方向（结构化回复卡片 / 会话移交 / 执行节点注册 / 安卓推送等）与 README 贡献边界。

**评审结果：回复渲染完整度先行实施（0.0.350，技术方案见 [../plan/2026-10-25-message-rendering-technical-design.md](../plan/2026-10-25-message-rendering-technical-design.md)）；会话列表与长会话导航已评审定稿（v1.1：favorite / pin 整体移除，P1 收敛为 keyword 过滤 + 批量归档，技术方案见 [../plan/2026-10-26-session-list-navigation-technical-design.md](../plan/2026-10-26-session-list-navigation-technical-design.md)，含 C1–C15 全量冲突清单）；Electron 壳补完待评审。**

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 回复渲染完整度 | [2026-10-25-message-rendering.md](2026-10-25-message-rendering.md)（**已实施**，技术方案见 [../plan/2026-10-25-message-rendering-technical-design.md](../plan/2026-10-25-message-rendering-technical-design.md)，含 §6 全量冲突清单） | Mermaid 图 / KaTeX 公式 / 表格复制——Agent 产出的结构化内容不再以源码形态阅读；零协议零后端，与已否决的「结构化回复卡片」划清边界 | 小~中 |
| 会话列表与长会话导航 | [2026-10-25-session-list-navigation.md](2026-10-25-session-list-navigation.md)（**已转入实施**，0.0.351，技术方案见 [../plan/2026-10-26-session-list-navigation-technical-design.md](../plan/2026-10-26-session-list-navigation-technical-design.md)，含 C1–C15 全量冲突清单） | 接通后端已就绪的标题过滤，补批量归档与轮次目录、只看回复；收藏与置顶两个半截子功能整体移除——会话找得回、排得开 | 小~中 |
| Electron 壳补完 | [2026-10-25-electron-shell-completeness.md](2026-10-25-electron-shell-completeness.md)（方向已认可，已细化，技术方案待评审：[../plan/2026-10-26-electron-shell-completeness-technical-design.md](../plan/2026-10-26-electron-shell-completeness-technical-design.md)，含 §7 全量冲突清单） | LOCAL 附件拷入工作区（文件不出本机）+ 托盘 / 主进程原生通知 / 角标 / 全局快捷键 / 开机自启——窗口一关不再与任务失联 | 小~中 |

排期注意：

1. **迁移编号**：会话列表与长会话导航占 V173（drop `is_favorite` / `is_pinned`，favorite / pin 整体移除）；另两件零迁移，不占号。
2. **三处同改清单**：本批不新增内置工具、不新增 LLM 调用场景、不新增收件箱 kind，均不触发既有「三处同改」规范。
3. **相邻收敛点**：三件均不动 `task-terminal.service.ts` / AgentLoop / prompt-engine；会话导航复用 `locateMessageId` 既有定位机制，与全文检索跳转共用回归口径；Electron 附件的 git exclude 复用团队经验库（0.0.342）同机制。
4. **文档同步**：实施时按节写 CHANGELOG（前端 / 桌面 Electron 小节）+ mao-cli `reference/desktop.md`、`reference/electron.md` 对应更新；Electron 冒烟清单进 CONTRIBUTING。
5. **实施顺序建议**：会话导航的拆除清理（favorite / pin 移除，可先行合入）→ 会话导航 P1（过滤 + 批量归档）→ 渲染 P1 → Electron P1，三件 P1 合计约一周量级，可各自由独立会话并行。

## 第十七批（2026-10-26）

背景：第十六批（回复渲染 / 会话列表导航 / Electron 壳补完）落定后，延续「**让已经在用的人和团队用得更顺**」方向，对 backend-ts 全部路由与六端（admin / desktop / android / agent-cli / mao-cli / sdk/embed）消费方做逐一比对摸底，得出三个共同主题为「**把已建成的能力接上插座、把黑盒翻给用户看**」的方向：**文件预览**停在四种格式，而 Agent 高频产出（CSV 报表 / 压缩包 / 音视频）全部不可读；**定时任务编辑**后端 / admin / mao-cli 三处就绪，日常入口桌面端却只能启停删除；**预算**执行链路完整运行但全部长在 admin 域，用户被拦时无从自查。三件互不依赖、全部零 / 近零迁移、不碰执行内核。均避开已否决方向（结构化回复卡片 / 交付物中心 / 任务模板 / 执行节点 / 会话移交等）与 README 贡献边界。

**评审结果（2026-10-26）：三件均已细化、技术方案待评审。**

| 提案 | 文档 | 一句话 | 规模 |
|---|---|---|---|
| 工作区文件预览完整度 | [2026-10-26-workspace-file-preview.md](2026-10-26-workspace-file-preview.md)（**已转入实施**，0.0.354，技术方案见 [../plan/2026-10-26-workspace-file-preview-technical-design.md](../plan/2026-10-26-workspace-file-preview-technical-design.md)，含 §6 全量冲突清单与 §13 实现期评审修正；方案对提案有三处范围修正：XLSX 库定 exceljs、`.tar/.gz` 收窄不做、DOCX 列 P2 伸展项） | CSV 表格化 / ZIP 包内浏览 / XLSX / DOCX / 音视频播放——0.0.350 回复渲染的同一条主线延伸到落盘文件，Agent 的成果不再以「二进制文件」面对 | 小~中 |
| 定时任务编辑下沉 | [2026-10-26-scheduled-task-editing.md](2026-10-26-scheduled-task-editing.md)（**已细化，技术方案待评审**：[../plan/2026-10-26-scheduled-task-editing-technical-design.md](../plan/2026-10-26-scheduled-task-editing-technical-design.md)，含 §0 八项待确认决策与 §7 十八条冲突风险表；方案对提案有两处修正：admin 其实已在用 cron-preview、一次性任务允许改 Cron 配 mismatch 警告） | 接通后端已就绪的 PUT 全字段与 cron-preview 端点，桌面端从「只能启停删」到「改得动、输不错」；顺带修正 cron-preview 错位的权限门 | 小 |
| 个人用量预算可见 | [2026-10-26-user-budget-visibility.md](2026-10-26-user-budget-visibility.md)（**已细化，技术方案待评审**：[../plan/2026-10-26-user-budget-visibility-technical-design.md](../plan/2026-10-26-user-budget-visibility-technical-design.md)，含 §0 十二项待确认决策与 §7 C1–C15 全量冲突风险表；零迁移、执行链路零改动、admin / mao-cli / agent-cli 零改动） | 只读端点 + 用量抽屉「预算」Tab + 收件箱预算提醒跳转，额度 / 已用 / 重置日翻给用户看，被拦时自查而非提工单 | 小~中 |

排期注意：

1. **迁移编号**：三件均零迁移，不占号（当前最新 V173）。
2. **三处同改清单**：三件均不新增内置工具、不新增 LLM 调用场景、不新增收件箱 kind（`BUDGET_WARN` 既有），不触发既有「三处同改」规范；预算 VO 按规范下沉 `@mao/contracts`（仅新增类型，不动既有联合）。
3. **相邻收敛点**：三件均不动 `task-terminal.service.ts` / AgentLoop / prompt-engine；文件预览不动渲染主链白名单（新解析输出仍过既有 DOMPurify / 表格组件通道）；预算只读端点与 usage 域同范式，消耗计算复用 `getPeriodSpend` 单一口径，不新造统计口径。
4. **体积护栏**：文件预览新增解析库（表格 / SheetJS / JSZip / mammoth）全部动态 chunk，扩充 `check-main-chunk` 断言（0.0.350 先例），不含新格式的会话首屏零增长。
5. **文档同步**：实施时按节写 CHANGELOG（前端 / 后端小节）+ mao-cli `reference/desktop.md`（定时任务编辑、预算 Tab）与用量 / 预算口径文档更新。

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
- **执行中引导（Run Steering）**：2026-10-24 评审：不采用（执行形态方向；同日转向团队长期学习）。存档：[2026-10-24-run-steering.md](2026-10-24-run-steering.md)。
- **批量任务（Batch Runs）**：2026-10-24 评审：不采用（执行形态方向；同日转向团队长期学习）。存档：[2026-10-24-batch-runs.md](2026-10-24-batch-runs.md)。
- **交付物中心（Artifacts）**：2026-10-24 评审：不采用（执行形态方向；同日转向团队长期学习）。存档：[2026-10-24-artifact-center.md](2026-10-24-artifact-center.md)。
- **Agent 改进闭环**：2026-10-24 评审：不采用（方向校准为「理解用户模糊指令中的业务关键词」）。存档：[2026-10-24-agent-improvement-loop.md](2026-10-24-agent-improvement-loop.md)。
- **经验资产化**：2026-10-24 评审：不采用（同上，方向校准为业务语义理解）。存档：[2026-10-24-experience-lifecycle.md](2026-10-24-experience-lifecycle.md)。
- **能力体检**：2026-10-24 评审：不采用（同上，方向校准为业务语义理解）。存档：[2026-10-24-capability-health.md](2026-10-24-capability-health.md)。
- **业务词典 / 模糊指令解析 / 术语学习**：2026-10-24 评审：三项均驳回，本期不进入实施（业务语义理解方向值得继续深思，但设计尚未定稿）。存档：[2026-10-24-business-glossary.md](2026-10-24-business-glossary.md)、[2026-10-24-intent-resolution.md](2026-10-24-intent-resolution.md)、[2026-10-24-term-learning.md](2026-10-24-term-learning.md)。
- **MCP Server 输出（Agent 暴露为 MCP 工具）**：2026-10-25 评审：不采用（平台扩张方向整体不采）。存档：[2026-10-25-mcp-server-out.md](2026-10-25-mcp-server-out.md)。
- **执行节点注册（LOCAL 多机泛化）**：2026-10-25 评审：不采用（同上）。存档：[2026-10-25-execution-nodes.md](2026-10-25-execution-nodes.md)。
- **用户自建 Agent（创造权下放）**：2026-10-25 评审：不采用（同上）。存档：[2026-10-25-user-created-agents.md](2026-10-25-user-created-agents.md)。
- **信号哨兵对话内配置（watcher 工具组）**：2026-10-25 评审：不采用。存档：[2026-10-25-signal-watcher-tools.md](2026-10-25-signal-watcher-tools.md)。
- **会话移交（人员变动的会话交接）**：2026-10-25 评审：不采用。存档：[2026-10-25-session-handover.md](2026-10-25-session-handover.md)。

## 已排除的方向（与产品定位或约束冲突）

- 低代码工作流画布（README 明确"不是 Dify / n8n"）。
- 安卓原生推送（安卓壳约束不变；Web Push 作为收件箱 P3 的可选探索）。
- 语音输入、官方 SaaS、界面国际化（README 贡献边界已声明）。
