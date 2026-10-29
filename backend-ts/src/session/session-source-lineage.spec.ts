import { describe, expect, it, vi } from 'vitest';
import { WeixinSessionService } from '../weixin/session.service.js';
import { SessionGroupKey } from './util/session-group-key.js';
import { toAdminSessionVO } from './session-vo.js';
import { SessionService } from './session.service.js';
import type { FileChangeRepository, MessageRepository, SessionRepository } from './session.repository.js';
import type { AgentLookup, Session } from './types.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { EnvironmentInfoProvider } from '../harness/core/environment-info.js';
import type { GitOperationService } from './git-operation.service.js';
import type { SessionCompactionService } from './session-compaction.service.js';
import type { SessionCompactionEventService } from './session-compaction-event.service.js';

describe('会话来源写入点（技术方案 2026-10-29 §2.1）', () => {
  it('微信建会话：第 16 参落 weixin 且不与其他尾参串位', async () => {
    const sessionService = { createSession: vi.fn(async () => ({ id: 2 })) };
    const sessionRepo = { findActiveByUserAndProjectKey: vi.fn(async () => null), updateById: vi.fn() };
    const agentService = { getAgent: vi.fn(async () => ({ id: 5, name: 'a5' })), requireDefaultAgent: vi.fn(async () => ({ id: 5, name: 'a5' })) };
    const modelService = { getModel: vi.fn(), getDefaultModel: vi.fn(async () => ({ id: 3, name: 'm3' })) };
    const systemSettingService = { getValue: vi.fn(async () => '') };
    const service = new WeixinSessionService(
      sessionService as never, sessionRepo as never, agentService as never,
      modelService as never, systemSettingService as never,
    );
    await service.getOrCreateWeixinSession(1);
    expect(sessionService.createSession).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sessionService.createSession).mock.calls[0]!;
    expect(args).toHaveLength(16);
    expect(args[15]).toBe('weixin');
    // 通道写入点是纯尾参追加：中间参数零改动（workspace=null、projectKey=weixin-bot、workspaceMode=new）
    expect(args[4]).toBeNull();
    expect(args[5]).toBe('FULL');
    expect(args[11]).toBe('weixin-bot');
    expect(args[12]).toBe('new');
  });

  it('源码级 tripwire：飞书 / 钉钉工厂的 createSession 尾参携带来源', async () => {
    // 这两个写入点深埋在装配工厂里（位置强转无编译期保护），用源码断言防回归：
    // 尾参从 'new', null, null 变化时本用例失败，提醒重新确认来源落位。
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const here = dirname(new URL(import.meta.url).pathname);
    const feishu = readFileSync(join(here, '..', 'app-feishu-messaging.ts'), 'utf8');
    expect(feishu).toMatch(/'new', null, null, 'feishu',/);
    const dingtalk = readFileSync(join(here, '..', 'dingtalk', 'runtime.ts'), 'utf8');
    expect(dingtalk).toMatch(/'new', null, null, 'dingtalk',/);
    const openRun = readFileSync(join(here, '..', 'openapi', 'open-run.service.ts'), 'utf8');
    expect(openRun).toMatch(/input\.source === 'SIGNAL' \? 'signal' : 'openapi'/);
  });
});

describe('分组键对七个来源的落桶与扩宽前一致（技术方案 §6 护栏）', () => {
  function withSource(source: string, workspace: string): Session {
    return { id: 1, userId: 7, source, workspace, executionMode: 'CLOUD' } as Session;
  }

  it('新来源值不命中专属分支，自然落回路径 / 模式启发式', () => {
    // 飞书 / 钉钉仍按 workspace 路径分组（与 'web' 时代同规则，分组键不看新来源值）
    expect(SessionGroupKey.of(withSource('feishu', '/root/feishu-chat/1/2'))).toBe(SessionGroupKey.of(withSource('web', '/root/feishu-chat/1/2')));
    expect(SessionGroupKey.of(withSource('dingtalk', '/root/dingtalk-chat/1/x'))).toBe(SessionGroupKey.of(withSource('web', '/root/dingtalk-chat/1/x')));
    // embed / signal 专属分支保持
    expect(SessionGroupKey.of(withSource('embed', '/x'))).toContain('EMBED');
    expect(SessionGroupKey.of(withSource('signal', '/x'))).toBe('SIGNAL');
    // openapi / weixin 与 web 落桶一致（普通 CLOUD 工作区按模式/路径归桶）
    expect(SessionGroupKey.of(withSource('openapi', '/root/projects/demo'))).toBe(SessionGroupKey.of(withSource('web', '/root/projects/demo')));
    expect(SessionGroupKey.of(withSource('weixin', '/root/projects/demo'))).toBe(SessionGroupKey.of(withSource('web', '/root/projects/demo')));
  });
});

describe('admin 会话来源（技术方案 §4.1-6/7、§4.1-8）', () => {
  function makeAdminService() {
    const sessionRepo = {
      findById: vi.fn(async () => null),
      updateFields: vi.fn(async () => 1),
      selectPage: vi.fn(async () => ({ records: [] as Session[], total: 0 })),
      count: vi.fn(async () => 0),
      selectMatchingSessions: vi.fn(async () => []),
      countMatchingSessions: vi.fn(async () => 0),
      selectMessageSearchCandidates: vi.fn(),
      selectFirstMatchingMessages: vi.fn(async () => []),
      listDescendantSideTasks: vi.fn(async () => []),
      listDescendantSideTasksByRoots: vi.fn(async () => new Map<number, Session[]>()),
    } as unknown as SessionRepository;
    const service = new SessionService(
      sessionRepo,
      { selectMessagesForSearch: vi.fn(), selectHitMessages: vi.fn(async () => []) } as unknown as MessageRepository,
      { listBySession: vi.fn(async () => []) } as unknown as FileChangeRepository,
      { findById: vi.fn(async () => null), findByIds: vi.fn(async () => []) } as unknown as AgentLookup,
      {} as PathSandbox,
      {} as EnvironmentInfoProvider,
      {} as never,
      {} as GitOperationService,
      {} as SessionCompactionService,
      {} as SessionCompactionEventService,
    );
    return { service, sessionRepo };
  }

  it('listSessionsForAdmin 传 source 时拼等值过滤，不传时无 source 条件', async () => {
    const a = makeAdminService();
    await a.service.listSessionsForAdmin(1, 10, null, null, null, null, null, null, null, 'feishu');
    const call = vi.mocked(a.sessionRepo.selectPage).mock.calls[0]!;
    expect(String(call[2])).toContain('source = ?');
    expect(call[3]).toContain('feishu');

    const b = makeAdminService();
    await b.service.listSessionsForAdmin(1, 10, null, null, null, null, null, null, null, null);
    const call2 = vi.mocked(b.sessionRepo.selectPage).mock.calls[0]!;
    expect(String(call2[2])).not.toContain('source = ?');
  });

  it('listSessionsForAdmin 闭集外的非法 source 宽松忽略、不过滤（§4.1-6）', async () => {
    const { service, sessionRepo } = makeAdminService();
    await service.listSessionsForAdmin(1, 10, null, null, null, null, null, null, null, 'Feishu');
    const call = vi.mocked(sessionRepo.selectPage).mock.calls[0]!;
    expect(String(call[2])).not.toContain('source = ?');
    // 合法值不受影响
    await service.listSessionsForAdmin(1, 10, null, null, null, null, null, null, null, 'feishu');
    const call2 = vi.mocked(sessionRepo.selectPage).mock.calls[1]!;
    expect(String(call2[2])).toContain('source = ?');
  });

  it('toAdminSessionVO 输出 source，缺省归 web', () => {
    const base = { id: 1, userId: 7, title: 't', status: 'ACTIVE', executionMode: 'CLOUD' } as Session;
    const withSource = toAdminSessionVO({ ...base, source: 'dingtalk' } as Session, new Map(), new Map(), new Map());
    expect(withSource.source).toBe('dingtalk');
    const noSource = toAdminSessionVO(base, new Map(), new Map(), new Map());
    expect(noSource.source).toBe('web');
  });
});
