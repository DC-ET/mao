import { describe, expect, it } from 'vitest';
import { isRunningPhase } from '../src/ws/event-filter';
import { ACTIVE_PHASES } from '../src/ws/event-types';

/**
 * BUGCHECK（审查新增，非产品代码）：agent-cli 的活跃相位集合漏了 RESUMING / CANCELLING。
 *
 * 位置：agent-cli/src/ws/event-types.ts:36
 *   export const ACTIVE_PHASES = new Set(['RUNNING', 'WAITING_APPROVAL']);
 *
 * 权威口径（后端唯一来源）：backend-ts/src/session/util/session-group-key.ts:238
 *   export const ACTIVE_PHASES = ['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'] as const;
 * 桌面端同口径：desktop/src/stores/session/types.ts:8（四个相位齐全）。
 *
 * 影响：isRunningPhase 是 session-runner 的「会话是否还在跑」判据
 * （session-runner.ts:106 snapshotIsActive / :137 wasActive / :385 快照采纳 executionId）。
 * RESUMING（崩溃恢复中）与 CANCELLING（取消流程进行中）都被判成空闲：
 *   - `mao-agent resume/-p` 撞上正在恢复或正在取消的会话时，wasActive=false → 不走
 *     handleAlreadyActive → `--if-running=fail` 不再快速失败、`--if-running=cancel` 不发取消；
 *   - REPL 的 snapshotIsActive=false → 把「还在取消中」的会话显示成空闲。
 *
 * 断言按「正确行为」书写（与后端/桌面端一致），当前源码下失败即证明 BUG 真实存在。
 */
describe('BUGCHECK agent-cli 活跃相位集合', () => {
  it('treats RESUMING (crash recovery in progress) as an active phase', () => {
    expect(isRunningPhase('RESUMING')).toBe(true);
  });

  it('treats CANCELLING (cancel flow in progress) as an active phase', () => {
    expect(isRunningPhase('CANCELLING')).toBe(true);
  });

  it('ACTIVE_PHASES covers exactly the backend active phase set', () => {
    // 后端 session-group-key.ts:238 的四个相位（顺序无关）
    expect([...ACTIVE_PHASES].sort()).toEqual(
      ['CANCELLING', 'RESUMING', 'RUNNING', 'WAITING_APPROVAL'].sort(),
    );
  });

  it('still treats terminal and idle phases as inactive (control group)', () => {
    expect(isRunningPhase('COMPLETED')).toBe(false);
    expect(isRunningPhase('FAILED')).toBe(false);
    expect(isRunningPhase('CANCELLED')).toBe(false);
    expect(isRunningPhase('IDLE')).toBe(false);
    expect(isRunningPhase(undefined)).toBe(false);
  });
});
