/**
 * 审批卡片「本会话总是允许」hint：由后端从当次工具参数归一化生成，
 * 随 tool_execute 帧下发到桌面审批卡片；用户点「总是允许」后客户端只回传布尔，
 * 后端按 requestId 从 ApprovalRegistry 取回服务端存储的同一 hint 落会话级规则。
 * 客户端永远拿不到 pattern 的决定权（不能注入 ruleValue）。
 */
export interface ApprovalHint {
  ruleType: 'SHELL_PREFIX' | 'SHELL_EXACT' | 'MCP_TOOL';
  /** 归一化后的模式值（匹配语义的真实载体，卡片副标题展示全文） */
  ruleValue: string;
  /** 卡片按钮/副标题文案（如「本会话总是允许以 npm run 开头的命令」） */
  label: string;
}

/** 规则放行的匹配结果（fire-and-forget 命中计数 + approvalMark 留痕用）。 */
export interface ApprovalRuleMatchHit {
  ruleId: number;
  ruleValue: string;
}

/**
 * ToolDispatcher 对审批规则域的最小依赖面（接口化避免 harness 反向依赖域实现）。
 * 实现方 ApprovalRuleService 保证：match/buildHint 内部吞掉自身异常返回 null（规则是放行优化，
 * 任何故障都必须退回原审批链，绝不能因规则服务故障而放行或阻断执行）。
 */
export interface ApprovalRuleFacade {
  /**
   * 规则匹配（档位准入由调用方判定后进入）。
   * 命中 → 静默放行并计数；未命中/denylist 命中/任何异常 → null，走原判定链。
   */
  match(input: {
    userId: number | null;
    sessionId: number | null;
    toolName: string;
    argumentsJson: string;
  }): Promise<ApprovalRuleMatchHit | null>;
  /**
   * 生成审批 hint（denylist 命中/不可规则化/异常 → null，卡片退化为两按钮）。
   * 仅 shell 与 MCP 工具可规则化。
   */
  buildHint(toolName: string, argumentsJson: string): Promise<ApprovalHint | null>;
  /** 规则命中计数（fire-and-forget，实现方内部吞异常）。 */
  recordHit(ruleId: number): void;
}
