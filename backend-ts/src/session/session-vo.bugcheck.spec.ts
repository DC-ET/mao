import { describe, expect, it } from 'vitest';
import {
  applySessionListSignals,
  isActivePhase,
  toSessionVO,
  visiblePhase,
  type SessionVO,
} from './session-vo.js';
import type { Session } from './types.js';

function session(over: Partial<Session> = {}): Session {
  return { userId: 1, phase: 'IDLE', status: 'ACTIVE', ...over } as Session;
}

const emptyAgentMap = new Map();
const emptyModelMap = new Map();

/**
 * 回归：CANCELLING 会话的 running / treeRunning 自相矛盾。
 *
 * 位置：backend-ts/src/session/session-vo.ts:187（toSessionVO 的 running 计算）。
 *
 * 触发条件：会话 phase = 'CANCELLING'（用户点了停止、取消流程进行中），
 * 经 `/v1/sessions`（session.routes.ts:124-138 enrichSessions）返回。
 *
 * 期望行为：running === true。同一文件的 isActivePhase（:588，treeRunning 的来源
 * fillTreeSignals）把 CANCELLING 算活跃；harness/approval/session-tree-signal-publisher.ts:8
 * 的活跃集合同样含 CANCELLING；session.service.ts:518/596 的删除与提升守卫也把
 * CANCELLING 当「运行中，无法操作」；桌面端 ACTIVE_PHASES（desktop/src/stores/
 * session/types.ts:8）同样含 CANCELLING。
 *
 * 实际行为：toSessionVO.running 的枚举只列了 RUNNING / RESUMING / WAITING_APPROVAL，
 * CANCELLING 得到 running=false；而同一次响应里 applySessionListSignals 会把同一个
 * VO 的 treeRunning 置为 true——同一份 JSON 里 { phase: 'CANCELLING',
 * running: false, treeRunning: true } 自相矛盾。桌面端 /sessions 首刷靠 VO 的
 * running 渲染（list.ts:141 applyRuntimeStatus 的 `!session.running` 早退、
 * TaskIndexPanel.vue:878 的运行中排序），取消中的会话被当成空闲。
 */
describe('toSessionVO running flag', () => {
  it('treats CANCELLING as still running', () => {
    const vo = toSessionVO(session({ phase: 'CANCELLING' }), emptyAgentMap, emptyModelMap);
    expect(vo.phase).toBe('CANCELLING');
    expect(vo.running).toBe(true);
  });

  it('keeps running consistent with isActivePhase for every phase', () => {
    for (const phase of ['IDLE', 'RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED']) {
      const vo = toSessionVO(session({ phase }), emptyAgentMap, emptyModelMap);
      expect(vo.running, `phase=${phase}`).toBe(isActivePhase(phase));
    }
  });

  it('does not contradict treeRunning inside one session-list response', () => {
    const main = session({ id: 1, phase: 'CANCELLING' });
    const vo: SessionVO = toSessionVO(main, emptyAgentMap, emptyModelMap);
    applySessionListSignals([main], [vo], new Map(), emptyApprovalRegistry(), emptyQuestionRegistry());
    expect(vo.running).toBe(vo.treeRunning);
  });

  it('maps RESUMING to RUNNING for display but keeps it running', () => {
    const vo = toSessionVO(session({ phase: 'RESUMING' }), emptyAgentMap, emptyModelMap);
    expect(visiblePhase('RESUMING')).toBe('RUNNING');
    expect(vo.running).toBe(true);
  });
});

function emptyApprovalRegistry() {
  return { countForSessionIds: () => new Map<number, number>() } as never;
}

function emptyQuestionRegistry() {
  return { countPendingBySessionIds: () => new Map<number, number>() } as never;
}
