import {
  NO_PROGRESS_ABORT_AT,
  NO_PROGRESS_EXEMPT_CALLS,
  NO_PROGRESS_EXEMPT_TOOLS,
  NO_PROGRESS_NUDGE_AT,
  buildNoProgressNotice,
  isNoProgressExempt,
  roundSignature,
  shortHash,
  type NoProgressCall,
  type NoProgressTail,
} from './no-progress-notice.js';

export {
  NO_PROGRESS_ABORT_AT,
  NO_PROGRESS_EXEMPT_CALLS,
  NO_PROGRESS_EXEMPT_TOOLS,
  NO_PROGRESS_NUDGE_AT,
};

export type NoProgressAction =
  | { kind: 'nudge'; afterToolCallId: string; text: string }
  | { kind: 'abort' };

interface NoProgressSnapshot {
  streak: number;
  toolNames: string[];
  digest: string;
  argsLength: number;
}

/**
 * 无进展工具循环的执行级状态机（技术方案 2026-10-21 §4.3 / §4.7）。
 *
 * 一次执行一个实例：`observeCall` 只累积本轮调用，`endRound` 才计算整轮签名并推进 streak。
 * 同一 `AgentLoop` 实例并发跑多个会话互不影响；压缩重载后用 `resetFrom(tail)` 对齐历史扫描。
 */
export class NoProgressGuard {
  private lastRoundKey: string | null = null;
  private roundToolNames: string[] = [];
  private roundCalls: NoProgressCall[] = [];
  private currentStreak = 0;
  private nudgedAt = new Set<number>();
  private anchorToolCallId = '';
  private snapshot: NoProgressSnapshot | null = null;

  constructor(tail?: NoProgressTail | null) {
    this.resetFrom(tail);
  }

  /** 用历史扫描的尾部状态整体替换运行时状态（执行开始 seed / 压缩重载）。 */
  resetFrom(tail?: NoProgressTail | null): void {
    this.lastRoundKey = tail?.lastRoundKey ?? null;
    this.currentStreak = tail?.streak ?? 0;
    this.nudgedAt = new Set(tail?.nudgedAt ?? []);
    this.roundToolNames = [];
    this.roundCalls = [];
    this.anchorToolCallId = '';
    this.snapshot = null;
  }

  /** 累积本轮调用；豁免调用不进入签名。 */
  observeCall(call: NoProgressCall): void {
    if (isNoProgressExempt(call)) return;
    this.roundCalls.push(call);
    this.roundToolNames.push(call.toolName);
  }

  /**
   * 收一轮：与本轮签名和上一轮比对推进 streak。
   * 整轮全是豁免调用（或没有工具调用）按「无工具轮」处理并重置。
   */
  endRound(anchorToolCallId: string): void {
    if (this.roundCalls.length === 0) {
      this.resetFrom(null);
      return;
    }
    const key = roundSignature(this.roundCalls);
    if (key === this.lastRoundKey) {
      this.currentStreak += 1;
    } else {
      this.lastRoundKey = key;
      this.currentStreak = 1;
      this.nudgedAt.clear();
    }
    this.anchorToolCallId = anchorToolCallId;
    this.snapshot = {
      streak: this.currentStreak,
      toolNames: [...this.roundToolNames],
      digest: shortHash(key),
      argsLength: this.roundCalls.reduce((total, call) => total + call.argumentsJson.length, 0),
    };
    this.roundToolNames = [];
    this.roundCalls = [];
  }

  /** 读取本轮应有的动作；同一 streak 只提醒一次，abort 可重复返回。 */
  takeAction(): NoProgressAction | null {
    if (this.snapshot == null) return null;
    if (this.snapshot.streak >= NO_PROGRESS_ABORT_AT) return { kind: 'abort' };
    const streak = this.snapshot.streak;
    if ((NO_PROGRESS_NUDGE_AT as readonly number[]).includes(streak) && !this.nudgedAt.has(streak)) {
      this.nudgedAt.add(streak);
      return {
        kind: 'nudge',
        afterToolCallId: this.anchorToolCallId,
        text: buildNoProgressNotice(streak, this.snapshot.toolNames),
      };
    }
    return null;
  }

  get streak(): number {
    return this.snapshot?.streak ?? this.currentStreak;
  }

  get toolNames(): string[] {
    return this.snapshot?.toolNames ?? [];
  }

  get digest(): string {
    return this.snapshot?.digest ?? '';
  }

  get argsLength(): number {
    return this.snapshot?.argsLength ?? 0;
  }
}

/** 与 `EmptyResponseExhaustedException` 同风格：由各入口既有 catch 统一收尾为 FAILED。 */
export class NoProgressLoopException extends Error {
  constructor(toolNames: string[], streak: number) {
    super(`检测到 Agent 连续 ${streak} 轮重复执行同一组工具调用（${toolNames.join('/')}）`
      + '且结果没有任何变化，已自动中止本次执行以避免无限循环。请调整需求描述后重试。');
    this.name = 'NoProgressLoopException';
  }
}
