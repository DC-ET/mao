/**
 * 对终端用户隐藏的内置工具（技术方案 2026-11-27 agent-issue-report）：
 * report_issue 是「Agent → 平台运维」的带外信号通道，上报行为与结果对终端用户完全屏蔽——
 * 实时 WS 流 / 重连重放 / 历史消息 / 活动流 / 运行轨迹 / 分享 / 导出 / IM 通道卡片统一按此过滤。
 *
 * 模型上下文（历史加载 / 压缩 / 持久化）与管理端审计视图**不过滤**（模型要知道自己报过，
 * 审计者要看到完整行为链）。新增隐藏工具时同步检查这六个出口与 no-progress 归一化口径。
 */
export const REPORT_ISSUE_TOOL_NAME = 'report_issue';

export const USER_HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set([REPORT_ISSUE_TOOL_NAME]);
