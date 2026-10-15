import { describe, expect, it } from 'vitest';
import { parseContextManifest, parseFailureReason, toAdminSessionVO, toSessionVO } from './session-vo.js';

describe('parseContextManifest', () => {
  it('parses a stored snapshot and drops broken json', () => {
    const raw = JSON.stringify({
      sections: [{ key: 'messages', label: '会话消息', tokens: 4000, count: 11 }],
      memoryIds: [3],
      estimatedWindowTokens: 256000,
    });
    expect(parseContextManifest(raw)?.sections[0]?.key).toBe('messages');
    expect(parseContextManifest('not-json')).toBeNull();
    expect(parseContextManifest(null)).toBeNull();
    expect(parseContextManifest('{"sections":"nope"}')).toBeNull();
  });

  it('toSessionVO exposes the snapshot and omits it when absent', () => {
    const withManifest = toSessionVO({
      userId: 1,
      contextTokens: 21000,
      contextManifestJson: JSON.stringify({
        sections: [{ key: 'system-prompt', label: '系统提示词', tokens: 3000 }],
        memoryIds: [],
        estimatedWindowTokens: 256000,
      }),
    }, new Map(), new Map());
    expect(withManifest.contextManifest?.sections).toHaveLength(1);

    const without = toSessionVO({ userId: 1, contextTokens: 21000 }, new Map(), new Map());
    expect(without.contextManifest).toBeNull();
  });
});

describe('toAdminSessionVO', () => {
  it('透出会话类型与父会话，主会话缺省为 NORMAL / null', () => {
    const normal = toAdminSessionVO({ userId: 1 }, new Map(), new Map(), new Map());
    expect(normal.sessionType).toBeNull();
    expect(normal.parentSessionId).toBeNull();

    const side = toAdminSessionVO(
      { userId: 1, sessionType: 'SIDE_TASK', parentSessionId: 12 },
      new Map(),
      new Map(),
      new Map(),
    );
    expect(side.sessionType).toBe('SIDE_TASK');
    expect(side.parentSessionId).toBe(12);

    const subagent = toAdminSessionVO(
      { userId: 1, sessionType: 'SUBAGENT', parentSessionId: 12 },
      new Map(),
      new Map(),
      new Map(),
    );
    expect(subagent.sessionType).toBe('SUBAGENT');
  });

  it('FAILED 会话透出失败原因，非失败态与坏快照均为 null', () => {
    const failed = toAdminSessionVO(
      {
        userId: 1,
        phase: 'FAILED',
        runtimeStatusJson: JSON.stringify({ executionError: 'LLM 请求超时' }),
      },
      new Map(),
      new Map(),
      new Map(),
    );
    expect(failed.failureReason).toBe('LLM 请求超时');

    // 非失败态：executionError 只应由 FAILED 终态写入，RUNNING/COMPLETED 一律不展示
    const running = toAdminSessionVO(
      {
        userId: 1,
        phase: 'RUNNING',
        runtimeStatusJson: JSON.stringify({ executionError: '上一次失败的原因' }),
      },
      new Map(),
      new Map(),
      new Map(),
    );
    expect(running.failureReason).toBeNull();
    expect(
      toAdminSessionVO(
        { userId: 1, phase: 'COMPLETED', runtimeStatusJson: JSON.stringify({ executionError: 'x' }) },
        new Map(),
        new Map(),
        new Map(),
      ).failureReason,
    ).toBeNull();

    // 缺字段 / 空串 / 坏 JSON 都不让整份 VO 失败
    expect(
      toAdminSessionVO({ userId: 1, phase: 'FAILED', runtimeStatusJson: '{"compacting":true}' }, new Map(), new Map(), new Map())
        .failureReason,
    ).toBeNull();
    expect(
      toAdminSessionVO({ userId: 1, phase: 'FAILED', runtimeStatusJson: '{"executionError":""}' }, new Map(), new Map(), new Map())
        .failureReason,
    ).toBeNull();
    expect(
      toAdminSessionVO({ userId: 1, phase: 'FAILED', runtimeStatusJson: 'not-json' }, new Map(), new Map(), new Map())
        .failureReason,
    ).toBeNull();
    expect(
      toAdminSessionVO({ userId: 1, phase: 'FAILED', runtimeStatusJson: null }, new Map(), new Map(), new Map())
        .failureReason,
    ).toBeNull();
  });
});

describe('parseFailureReason', () => {
  it('按相位取值：FAILED 才解析，RESUMING 归一到 RUNNING 后同样不解析', () => {
    const raw = JSON.stringify({ executionError: 'boom' });
    expect(parseFailureReason(raw, 'FAILED')).toBe('boom');
    expect(parseFailureReason(raw, 'CANCELLED')).toBeNull();
    expect(parseFailureReason(raw, 'RESUMING')).toBeNull();
    expect(parseFailureReason(raw, null)).toBeNull();
  });
});
