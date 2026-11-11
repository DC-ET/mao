# 提案目录

产品方向头脑风暴的产出。每份提案独立成文；评审通过后的技术方案放在 `docs/plan/`。

**本文件是提案状态的唯一台账。** 单篇文首、技术方案文首若与本表不一致，以本表为准。技术方案文首不回写。

## 怎么维护

状态只有四档。一件提案只出现在下面一张表里。

| 档 | 含义 |
|---|---|
| 待评审 | 尚未拍板 |
| 已立项 | 已拍板，CHANGELOG 还没有对应改动 |
| 已落地 | CHANGELOG 已有对应改动 |
| 已否决 | 存档，不再评审 |

迭代时只做这些事：

1. **新提案**：在「待评审」加一行（链接、批次、一句话）。背景、范围、排期、迁移号写在单篇里。
2. **拍板通过**：把该行剪到「已立项」，说明里链上技术方案。
3. **进 CHANGELOG**：把该行剪到「已落地」，说明里写版本号。
4. **否决**：把该行剪到「已否决」，原因写一句。
5. 改档时，把单篇文首的「状态」改成同一个词。
6. 新开一批时，在文末「批次一览」加一行主题。不在本文件写排期注意、冲突清单或决策全文。

## 待评审

_当前无待评审提案。_

## 已立项

| 提案 | 批次 | 说明 |
|---|---|---|
| [Markdown 渲染补完](2026-11-11-markdown-render-polish.md) | 29 | 技术方案：[docs/plan/2026-11-11-markdown-render-polish-technical-design.md](../plan/2026-11-11-markdown-render-polish-technical-design.md)（复核修正：marked ^18 已渲染 checkbox，方案收窄为样式化 + 图片放大） |
| [命令面板动态组](2026-11-11-command-palette-dynamic-sources.md) | 29 | 技术方案：[docs/plan/2026-11-11-command-palette-dynamic-sources-technical-design.md](../plan/2026-11-11-command-palette-dynamic-sources-technical-design.md)（`?` 速查组为面板内新增，既有全局 `?` 不动） |
| [审批键盘流](2026-11-11-approval-keyboard-flow.md) | 29 | 技术方案：[docs/plan/2026-11-11-approval-keyboard-flow-technical-design.md](../plan/2026-11-11-approval-keyboard-flow-technical-design.md)（Y/N 走 ApprovalStack 同一 confirm；活跃 Tab 归属由 KeepAlive 结构性判定） |
| [多会话并行状态可见性](2026-11-11-parallel-session-glanceability.md) | 29 | 技术方案：[docs/plan/2026-11-11-parallel-session-glanceability-technical-design.md](../plan/2026-11-11-parallel-session-glanceability-technical-design.md)（Tab 角标砍掉；标题态 + 任务栏闪烁，通知复用既有收件箱体系不新增通道） |
| [中心 Tab 效率补完](2026-11-08-center-tab-efficiency.md) | 25 | 技术方案：[docs/plan/2026-11-08-center-tab-efficiency-technical-design.md](../plan/2026-11-08-center-tab-efficiency-technical-design.md) |
| [消息代码块折叠与换行](2026-11-08-message-code-block-polish.md) | 26 | 技术方案：[docs/plan/2026-11-08-message-code-block-polish-technical-design.md](../plan/2026-11-08-message-code-block-polish-technical-design.md) |
| [外观个性化与视觉令牌收编](2026-11-08-appearance-personalization.md) | 27 | 技术方案：[docs/plan/2026-11-08-appearance-personalization-technical-design.md](../plan/2026-11-08-appearance-personalization-technical-design.md)（密度档与暗色收编随方案取消，见其 §3.2 勘误） |
| [输入效率包](2026-11-10-rich-paste-annotate.md) | 28 | 技术方案：[docs/plan/2026-11-10-rich-paste-annotate-technical-design.md](../plan/2026-11-10-rich-paste-annotate-technical-design.md) |
| [工具结果表格化视图](2026-11-10-tool-result-table-view.md) | 28 | 技术方案：[docs/plan/2026-11-10-tool-result-table-view-technical-design.md](../plan/2026-11-10-tool-result-table-view-technical-design.md) |
| [工具卡文件路径联动中心 Tab](2026-11-11-tool-card-file-link.md) | 29 | 0.0.520 |

## 已落地

版本号只保留台账里已经写过的。余项未做的，继续做须重新写一篇提案放回「待评审」。

| 提案 | 批次 | 说明 |
|---|---|---|
| [跨会话长期记忆](2026-10-02-long-term-memory.md) | 1 | 任务收尾沉淀记忆，跨会话注入 |
| [Agent 资产化](2026-10-02-agent-asset-bundle.md) | 1 | 克隆 / bundle 导出导入 / 团队共享目录 |
| [任务收件箱](2026-10-02-task-inbox.md) | 1 | 0.0.235 |
| [资产分发闭环](2026-10-05-asset-distribution.md) | 2 | 依赖补装、bundle 导入与更新检查 |
| [开放 API](2026-10-05-open-api-webhook.md) | 2 | API Token、入站 Webhook、出站订阅 |
| [用量成本核算与预算管控](2026-10-06-usage-cost-budget.md) | 3 | 0.0.243 |
| [工具审批规则](2026-10-06-approval-rules.md) | 3 | 会话内「总是允许」与用户级 allowlist |
| [上下文透视与手动治理](2026-10-06-context-inspector.md) | 3 | 展示模型实际收到的上下文，可手动压缩 |
| [会话分享与导出](2026-10-06-session-share-export.md) | 3 | 只读快照链接与导出 |
| [任务运行轨迹透视](2026-10-09-run-trace-timeline.md) | 4 | 按轮次看 LLM / 工具 / 事件时间线 |
| [定时任务可靠性](2026-10-09-scheduled-task-reliability.md) | 5 | 0.0.256 |
| [工作区文件直管](2026-10-09-workspace-file-manager.md) | 5 | 0.0.281 |
| [跨会话全文检索](2026-10-09-global-message-search.md) | 5 | 0.0.257 |
| [开放接口调用中心](2026-10-09-open-api-call-center.md) | 5 | 0.0.255 |
| [负反馈闭环](2026-10-11-feedback-experience-loop.md) | 6 | 0.0.276 |
| [信号哨兵](2026-10-11-signal-watcher.md) | 6 | 0.0.278 |
| [回复引用溯源](2026-10-12-answer-citations.md) | 7 | 0.0.282 |
| [每日运营摘要](2026-10-12-daily-digest.md) | 7 | 0.0.281 |
| [邮件通知渠道](2026-10-19-email-notification.md) | 9 | 出站通知第三渠道；入站邮件不做 |
| [自定义 HTTP 工具](2026-10-19-custom-http-tools.md) | 9 | 目录分节 + 按需取 schema，不进 `tools` 数组 |
| [运行轨迹深度下钻](2026-10-22-run-trace-deep-dive.md) | 10 | P1（0.0.336 / 0.0.337）与请求构成已上线。轨迹内搜索、拖选聚焦未做，余项已否决（批次 24） |
| [首次成功体验](2026-10-25-first-run-onboarding.md) | 15 | 0.0.347 |
| [回复渲染完整度](2026-10-25-message-rendering.md) | 16 | 0.0.350。Mermaid / KaTeX / 表格 |
| [会话列表与长会话导航](2026-10-25-session-list-navigation.md) | 16 | 0.0.351。收藏与置顶已移除 |
| [Electron 壳补完](2026-10-25-electron-shell-completeness.md) | 16 | LOCAL 附件、托盘、通知、快捷键、开机自启 |
| [工作区文件预览完整度](2026-10-26-workspace-file-preview.md) | 17 | 0.0.354 |
| [定时任务编辑下沉](2026-10-26-scheduled-task-editing.md) | 17 | 桌面端可改 Cron 与提示词，并即时预览 |
| [个人用量预算可见](2026-10-26-user-budget-visibility.md) | 17 | 用量抽屉「预算」Tab |
| [待办未响应升级通知](2026-10-27-pending-escalation-notify.md) | 18 | 审批 / 提问 3 分钟无人处理则外推 |
| [选区引用追问](2026-10-27-selection-quote.md) | 18 | 回复选区与文件 / Diff 行区间引用 |
| [会话内切换 Agent](2026-10-29-in-session-agent-switch.md) | 19 | 「用其他 Agent 重开」已于 0.0.383 移除 |
| [会话来源全链路标记](2026-10-29-session-source-lineage.md) | 19 | 渠道写入真实 source，管理端可筛 |
| [工作区总览与生命周期](2026-10-29-workspace-overview-lifecycle.md) | 19 | 查看占用与关联会话，无进行中引用可删 |
| [定时任务立即执行](2026-11-02-scheduled-task-run-now.md) | 20 | 手动试跑，不改下次触发计划 |
| [个人资产与配置体验补完](2026-11-02-personal-assets-ux-completeness.md) | 20 | 会话级审批规则可撤可提升，改备注免重填密文 |
| [自助修改密码与开放接口体验补完](2026-11-02-self-service-password-and-openapi-polish.md) | 20 | 本地账号自助改密，Webhook 可编辑，订阅可测试投递 |
| [工作区文件预览与 Git 细节打磨](2026-11-02-file-viewer-and-git-ux-polish.md) | 20 | 自动换行 / 下载、Diff 并排与行内、Git 历史与新建本地分支 |
| [管理后台关联反查与自定义工具体验](2026-11-02-admin-capability-linking-and-http-tool-ux.md) | 20 | 工具可带密文测试、一键复制，Agent 与模型 / MCP / 工具双向可见 |
| [定时任务失败原因透出](2026-11-04-scheduled-run-failure-reason-visible.md) | 22 | 「最近运行」失败行展示 `errorSummary` |
| [哨兵轮询记录值对比](2026-11-04-signal-watcher-check-value-compare.md) | 22 | 轮询记录与列表卡展示旧值 → 新值 |
| [工具卡片「看得懂」的最后一公里](2026-11-06-tool-card-completeness.md) | 23 | 0.0.468 |
| [失败与中间态别再静默](2026-11-06-silent-failure-visibility.md) | 23 | 0.0.469 |
| [键盘、焦点与命中区](2026-11-06-keyboard-focus-hit-area.md) | 23 | 0.0.471 |
| [全局命令面板](2026-11-07-command-palette.md) | 24 | 0.0.476 |
| [工作区文件拖进聊天](2026-11-07-workspace-drag-into-chat.md) | 24 | 0.0.476 |

## 已否决

原因写一句，供以后避开。细节在存档正文，不再评审。

| 提案 | 批次 | 原因 |
|---|---|---|
| [知识库 / RAG](2026-10-05-knowledge-rag.md) | 2 | 与技能、工作区文件重叠，且要新建 embedding 设施 |
| [提示词回归评测（Evals）](2026-10-05-agent-evals.md) | 2 | 不做离线评测设施 |
| [多 Agent 协作（任务 DAG）](2026-10-05-agent-teams-dag.md) | 2 | 子代理与 wait 已够用，编排语义的失控面更大 |
| [任务检查点与工作区回滚](2026-10-06-task-checkpoint-rollback.md) | 3 | 不做执行回滚 |
| [计划模式](2026-10-09-plan-mode.md) | 4 | 不做执行前计划门 |
| [出网边界与敏感数据防泄漏](2026-10-09-egress-data-boundary.md) | 4 | 不做出网策略层 |
| [实例备份与一键恢复](2026-10-09-backup-restore.md) | 4 | 不做实例级备份恢复 |
| [数据保留与个人数据可携带](2026-10-09-data-retention-portability.md) | 4 | 不做数据寿命与导出治理 |
| [模型容灾与故障转移](2026-10-09-model-fallback-health.md) | 5 | 不做备用模型自动切换 |
| [技能蒸馏](2026-10-11-skill-distillation.md) | 6 | 不从会话轨迹自动起草技能 |
| [工作区环境模板](2026-10-11-workspace-template.md) | 6 | 模板资产的磁盘、共享与符号链接风险不划算 |
| [渠道人工接管](2026-10-11-human-handoff.md) | 6 | 不做会话切给真人的相位 |
| [模型对照台](2026-10-12-model-compare.md) | 7 | 不做一次提问多模型并排 |
| [Agent 结构化 Git 工具链](2026-10-19-agent-git-tools.md) | 8 | 不把 Git 面板服务层开放成 Agent 工具 |
| [任务模板 / Runbook](2026-10-19-task-template-runbook.md) | 8 | 不做任务级模板资产 |
| [团队知识层](2026-10-19-team-knowledge-layer.md) | 8 | 不做 TEAM 共享记忆与经验提案通道 |
| [结构化回复卡片](2026-10-19-structured-reply-cards.md) | 9 | 不做封闭集块协议 |
| [执行中引导](2026-10-24-run-steering.md) | 11 | 不在工具轮边界插入引导 |
| [批量任务](2026-10-24-batch-runs.md) | 11 | 不做一份输入 N 条独立会话 |
| [交付物中心](2026-10-24-artifact-center.md) | 11 | 不把产出登记为不可变交付物 |
| [Agent 改进闭环](2026-10-24-agent-improvement-loop.md) | 12 | 不做按 Agent 聚合的改进项 |
| [经验资产化](2026-10-24-experience-lifecycle.md) | 12 | 不做经验命中、退休与候选挖掘 |
| [能力体检](2026-10-24-capability-health.md) | 12 | 不做按工具成败给出的停用建议 |
| [业务词典](2026-10-24-business-glossary.md) | 13 | 业务语义理解本期不实施 |
| [模糊指令解析](2026-10-24-intent-resolution.md) | 13 | 同上 |
| [术语学习](2026-10-24-term-learning.md) | 13 | 同上 |
| [MCP Server 输出](2026-10-25-mcp-server-out.md) | 14 | 不把 Agent 暴露为对外 MCP 工具 |
| [执行节点注册](2026-10-25-execution-nodes.md) | 14 | 不把 LOCAL 泛化成多机节点 |
| [用户自建 Agent](2026-10-25-user-created-agents.md) | 14 | 不把创造 Agent 的权限下放给普通用户 |
| [信号哨兵对话内配置](2026-10-25-signal-watcher-tools.md) | 15 | 不补哨兵工具组 |
| [会话移交](2026-10-25-session-handover.md) | 15 | 不做会话交接给另一用户 |
| [记忆就地可见](2026-10-27-memory-in-context.md) | 18 | 不做对话内记忆回执与「记住这个」 |
| [会话导出 Markdown 与长会话定位补完](2026-11-02-session-markdown-export-and-in-session-find.md) | 20 | 不补 Markdown 导出与会话内查找 |
| [跨任务审批收件箱与审计](2026-11-04-cross-task-approval-inbox-and-audit.md) | 21 | 不把未决审批收成跨任务抽屉 |
| [失败任务重跑](2026-11-04-failed-task-retry-with-context-reuse.md) | 21 | 不做从失败轮续跑 |
| [子代理增量同步与半成品回拷](2026-11-04-subagent-incremental-file-sync.md) | 21 | 不做子代理运行中的文件增量回拷 |
| [分享一览与来源徽标](2026-11-04-session-share-management-and-source-badge.md) | 22 | 不做「我的分享」抽屉与任务列表来源徽标 |
| [运行轨迹深钻二阶段](2026-11-07-run-trace-search-drag-select.md) | 24 | 轨迹使用频率低，暂无需求；批次 10 余项就此收口 |
| [消息级上下文菜单与操作收敛](2026-11-08-message-context-menu.md) | 25 | footer 操作行已够用，右键菜单与溢出收敛收益不大 |
| [最近会话快切](2026-11-08-recent-session-switcher.md) | 25 | 会话切换无痛点（列表点击 + 搜索已够快） |
| [会话图片快览](2026-11-08-session-image-gallery.md) | 26 | 图片密集会话是低频场景，暂无需求 |
| [流式渲染平滑](2026-11-08-streaming-render-smoothness.md) | 27 | 评审否决（2026-11-08） |
| [设置可达性](2026-11-08-settings-discoverability.md) | 27 | 评审否决（2026-11-08） |
| [会话阅读视图](2026-11-10-reading-mode.md) | 28 | 评审否决（2026-11-10） |

## 产品边界

与定位冲突，不写提案：

- 低代码工作流画布
- 安卓原生推送
- 语音输入、官方 SaaS、界面国际化

## 批次一览

只记主题，方便新提案编号。状态看上面的表。

| 批 | 日期 | 主题 |
|---|---|---|
| 1 | 2026-10-02 | 长期记忆、收件箱、Agent 资产化 |
| 2 | 2026-10-05 | 资产分发、开放 API |
| 3 | 2026-10-06 | 成本预算、审批规则、上下文透视、会话分享 |
| 4 | 2026-10-09 | 信任与治理 |
| 5 | 2026-10-09 | 定时任务可靠性、文件直管、全文检索、调用中心 |
| 6 | 2026-10-11 | 负反馈、哨兵、技能蒸馏、工作区模板 |
| 7 | 2026-10-12 | 引用溯源、模型对照、每日摘要 |
| 8 | 2026-10-19 | Git 工具、任务模板、团队知识 |
| 9 | 2026-10-19 | 邮件通知、自定义 HTTP 工具、结构化卡片 |
| 10 | 2026-10-22 | 运行轨迹深度下钻 |
| 11 | 2026-10-24 | 执行中引导、批量任务、交付物 |
| 12 | 2026-10-24 | 改进闭环、经验资产、能力体检 |
| 13 | 2026-10-24 | 业务词典、模糊指令、术语学习 |
| 14 | 2026-10-25 | MCP 输出、执行节点、用户自建 Agent |
| 15 | 2026-10-25 | 哨兵对话内配置、会话移交、首次成功体验 |
| 16 | 2026-10-25 | 回复渲染、会话列表、Electron 壳 |
| 17 | 2026-10-26 | 文件预览、定时任务编辑、预算可见 |
| 18 | 2026-10-27 | 未响应升级、记忆就地可见、选区引用 |
| 19 | 2026-10-29 | 切换 Agent、会话来源、工作区总览 |
| 20 | 2026-11-02 | 定时任务试跑、个人资产、改密、文件与 Git、后台关联 |
| 21 | 2026-11-04 | 审批收件箱、失败重跑、子代理增量同步 |
| 22 | 2026-11-04 | 失败原因、分享一览、哨兵值对比 |
| 23 | 2026-11-06 | 工具卡片、静默失败、键盘与焦点 |
| 24 | 2026-11-07 | 命令面板、跨面板拖拽、轨迹深钻二阶段 |
| 25 | 2026-11-08 | 消息菜单、Tab 效率、会话快切 |
| 26 | 2026-11-08 | 图片快览、代码块折叠 |
| 27 | 2026-11-08 | 外观个性化、流式渲染平滑、设置可达性 |
| 28 | 2026-11-10 | 阅读视图、输入效率包、工具结果表格化 |
| 29 | 2026-11-11 | 文件联动、渲染补完、命令面板动态组、审批键盘流、并行状态可见性 |
