import { describe, expect, it, vi } from 'vitest';
import { sep as pathSep } from 'node:path';
import { escapeLike } from '../session/message-search.js';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../testing/tmp-dir.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { WorkspaceOverviewService } from './workspace-overview.service.js';
import { SessionRepository } from '../session/session.repository.js';

type UsageMap = Map<string, { total: number; active: number; archived: number; lastUsedAt: string | null }>;

function makeService(root: string, usage: UsageMap = new Map(), overrides: {
  userWorkspaces?: string[];
  channelUsage?: UsageMap;
  participated?: boolean;
} = {}) {
  const repo = {
    aggregateWorkspaceUsage: vi.fn(async () => usage),
    aggregateWorkspaceUsageAnyUser: vi.fn(async () => overrides.channelUsage ?? new Map()),
    listActiveWorkspaceReferences: vi.fn(async () => [] as Array<{ id: number; title: string | null; phase: string | null }>),
    listWorkspacesByUser: vi.fn(async () => overrides.userWorkspaces ?? []),
    existsSessionUnderWorkspace: vi.fn(async () => overrides.participated ?? false),
  };
  const service = new WorkspaceOverviewService(new PathSandbox(root), repo as never);
  return { service, repo };
}

describe('WorkspaceOverviewService.listOverview', () => {
  it('enumerates three kinds, skips symlinks and hides projects container', async () => {
    const root = useTmpDir('ws-ov-');
    const userRoot = join(root, '7');
    mkdirSync(join(userRoot, '42'), { recursive: true });                       // temp
    mkdirSync(join(userRoot, 'projects', 'demo'), { recursive: true });         // project
    mkdirSync(join(userRoot, 'custom-dir'), { recursive: true });               // other
    writeFileSync(join(userRoot, 'projects', 'demo', '.git'), '');
    symlinkSync(join(root, 'outside'), join(userRoot, '42-link'));              // 符号链接不列出
    const { service } = makeService(root);
    const { entries, error } = await service.listOverview(7);
    expect(error).toBeNull();
    const kinds = Object.fromEntries(entries.map(e => [e.name, e.kind]));
    expect(kinds['42']).toBe('temp');
    expect(kinds['demo']).toBe('project');
    expect(kinds['custom-dir']).toBe('other');
    expect(kinds['projects']).toBeUndefined();   // projects 容器不作为条目（§2.1-1）
    expect(kinds['42-link']).toBeUndefined();    // 符号链接不跟随也不列出
    const demo = entries.find(e => e.name === 'demo')!;
    expect(demo.isGit).toBe(true);
    expect(demo.path).toBe(join(userRoot, 'projects', 'demo'));
    expect(demo.sizeBytes).toBeNull();
    expect(demo.sizeState).toBe('ready');
  });

  it('merges session usage by directory prefix (exact + nested)', async () => {
    const root = useTmpDir('ws-ov-');
    const userRoot = join(root, '7');
    const demo = join(userRoot, 'projects', 'demo');
    const demoSub = join(demo, 'sub');
    mkdirSync(demoSub, { recursive: true });
    mkdirSync(join(userRoot, 'other-ws'), { recursive: true });
    const usage: UsageMap = new Map([
      [demo, { total: 3, active: 1, archived: 2, lastUsedAt: '2026-10-30 10:00:00' }],
      [demoSub, { total: 1, active: 1, archived: 0, lastUsedAt: '2026-10-30 11:00:00' }],
      [join(userRoot, 'other-ws'), { total: 5, active: 0, archived: 5, lastUsedAt: null }],
    ]);
    const { service } = makeService(root, usage);
    const { entries } = await service.listOverview(7);
    const demoEntry = entries.find(e => e.name === 'demo')!;
    // 前缀归并：目录本身 + 目录内工作区都计入；lastUsedAt 取 max
    expect(demoEntry.activeSessions).toBe(2);
    expect(demoEntry.archivedSessions).toBe(2);
    expect(demoEntry.lastUsedAt).toBe('2026-10-30 11:00:00');
    const otherEntry = entries.find(e => e.name === 'other-ws')!;
    expect(otherEntry.activeSessions).toBe(0);
  });

  it('does not walk directories to compute size', async () => {
    const root = useTmpDir('ws-ov-');
    const userRoot = join(root, '7');
    mkdirSync(join(userRoot, '42'), { recursive: true });
    writeFileSync(join(userRoot, '42', 'a.txt'), 'x'.repeat(10));
    const { service } = makeService(root);
    const { entries } = await service.listOverview(7);
    expect(entries[0]!.sizeBytes).toBeNull();
    expect(entries[0]!.sizeState).toBe('ready');
  });

  it('refresh 拒绝本人根之外的路径（越界不可触发任意目录遍历）', async () => {
    const root = useTmpDir('ws-ov-');
    mkdirSync(join(root, '8', '42'), { recursive: true });
    const { service } = makeService(root);
    await expect(service.refresh(7, join(root, '8', '42'))).rejects.toThrow('只能操作本人工作区根目录下的目录');
    await expect(service.refresh(7, '/etc')).rejects.toThrow('只能操作本人工作区根目录下的目录');
    // 本人根内路径放行
    await expect(service.refresh(7, join(root, '7', 'nope'))).resolves.toBeUndefined();
    await expect(service.refresh(7)).resolves.toBeUndefined();
  });

  it('missing user root returns empty without error', async () => {
    const root = useTmpDir('ws-ov-');
    const { service } = makeService(root);
    const { entries, error } = await service.listOverview(7);
    expect(entries).toEqual([]);
    expect(error).toBeNull();
  });
});

describe('WorkspaceOverviewService 机器人通道工作区（技术方案 2026-11-02）', () => {
  function setupChannels(root: string) {
    const feishuGroup = join(root, 'feishu-chat', 'bot-1', 'oc_chat');
    const feishuPrivateOwn = join(root, 'feishu-chat', 'bot-1', 'private-7');
    const feishuPrivateOther = join(root, 'feishu-chat', 'bot-1', 'private-8');
    const dingtalkGroup = join(root, 'dingtalk-chat', 'bot-2', 'cid_group');
    const dingtalkPrivateOwn = join(root, 'dingtalk-chat', 'bot-2', 'p2p-7');
    for (const dir of [feishuGroup, feishuPrivateOwn, feishuPrivateOther, dingtalkGroup, dingtalkPrivateOwn]) {
      mkdirSync(dir, { recursive: true });
    }
    return { feishuGroup, feishuPrivateOwn, feishuPrivateOther, dingtalkGroup, dingtalkPrivateOwn };
  }

  it('lists own private and participated group workspaces of both channels', async () => {
    const root = useTmpDir('ws-ch-');
    const { feishuGroup, feishuPrivateOwn, feishuPrivateOther, dingtalkGroup, dingtalkPrivateOwn } = setupChannels(root);
    const { service } = makeService(root, new Map(), { userWorkspaces: [feishuGroup, dingtalkGroup] });
    const { entries, error } = await service.listOverview(7);
    expect(error).toBeNull();
    const byPath = Object.fromEntries(entries.map(e => [e.path, e]));
    expect(byPath[feishuPrivateOwn]).toMatchObject({
      kind: 'channel', channel: 'feishu', chatType: 'private', accountId: 'bot-1', name: 'private-7',
    });
    expect(byPath[dingtalkPrivateOwn]).toMatchObject({
      kind: 'channel', channel: 'dingtalk', chatType: 'private', accountId: 'bot-2', name: 'p2p-7',
    });
    expect(byPath[feishuGroup]).toMatchObject({ kind: 'channel', channel: 'feishu', chatType: 'group', name: 'oc_chat' });
    expect(byPath[dingtalkGroup]).toMatchObject({ kind: 'channel', channel: 'dingtalk', chatType: 'group', name: 'cid_group' });
    // 他人私聊工作区不可见
    expect(byPath[feishuPrivateOther]).toBeUndefined();
  });

  it('hides group workspaces the user has not participated in', async () => {
    const root = useTmpDir('ws-ch-');
    const { feishuGroup, feishuPrivateOwn, dingtalkPrivateOwn } = setupChannels(root);
    const { service, repo } = makeService(root, new Map(), { userWorkspaces: [] });
    const { entries } = await service.listOverview(7);
    expect(entries.find(e => e.path === feishuGroup)).toBeUndefined();
    // 只剩本人私聊目录参与跨用户聚合，未参与的群目录不在其中
    expect(repo.aggregateWorkspaceUsageAnyUser).toHaveBeenCalledWith([feishuPrivateOwn, dingtalkPrivateOwn]);
  });

  it('aggregates group workspace usage across users', async () => {
    const root = useTmpDir('ws-ch-');
    const { feishuGroup, feishuPrivateOther } = setupChannels(root);
    const channelUsage: UsageMap = new Map([
      [feishuGroup, { total: 4, active: 2, archived: 2, lastUsedAt: '2026-11-01 09:00:00' }],
    ]);
    const { service, repo } = makeService(root, new Map(), { userWorkspaces: [feishuGroup], channelUsage });
    const { entries } = await service.listOverview(7);
    const entry = entries.find(e => e.path === feishuGroup)!;
    // 群目录按设计多人共享：计数走跨用户聚合（同群其他用户的会话也计入）
    expect(entry.activeSessions).toBe(2);
    expect(entry.archivedSessions).toBe(2);
    expect(entry.lastUsedAt).toBe('2026-11-01 09:00:00');
    const called = vi.mocked(repo.aggregateWorkspaceUsageAnyUser).mock.calls[0]![0];
    expect(called).toContain(feishuGroup);
    expect(called).not.toContain(feishuPrivateOther);
  });

  it('skips symlinks at channel account and leaf levels', async () => {
    const root = useTmpDir('ws-ch-');
    const { feishuGroup, dingtalkGroup } = setupChannels(root);
    mkdirSync(join(root, 'outside'), { recursive: true });
    symlinkSync(join(root, 'outside'), join(root, 'feishu-chat', 'bot-link'));
    symlinkSync(join(root, 'outside'), join(feishuGroup, 'leaf-link'));
    const { service } = makeService(root, new Map(), { userWorkspaces: [feishuGroup, dingtalkGroup] });
    const { entries } = await service.listOverview(7);
    expect(entries.filter(e => e.kind === 'channel').map(e => e.name).sort())
      .toEqual(['cid_group', 'oc_chat', 'p2p-7', 'private-7']);
  });

  it('delete guard rejects shared group, accepts own private, rejects foreign private', () => {
    const root = useTmpDir('ws-ch-');
    const { feishuGroup, feishuPrivateOwn, feishuPrivateOther } = setupChannels(root);
    const { service } = makeService(root);
    expect(service.resolveDeletablePath(7, feishuGroup)).toMatchObject({ error: 'shared' });
    expect(service.resolveDeletablePath(7, feishuPrivateOwn)).toEqual({ path: feishuPrivateOwn });
    expect(service.resolveDeletablePath(7, feishuPrivateOther)).toMatchObject({ error: 'out-of-scope' });
  });

  it('managed guard allows participated group and own private, rejects strangers', async () => {
    const root = useTmpDir('ws-ch-');
    const { feishuGroup, feishuPrivateOwn, feishuPrivateOther } = setupChannels(root);
    const { service } = makeService(root, new Map(), { participated: true });
    expect(await service.resolveManagedPath(7, feishuGroup)).toEqual({ path: feishuGroup });
    expect(await service.resolveManagedPath(7, feishuPrivateOwn)).toEqual({ path: feishuPrivateOwn });
    expect(await service.resolveManagedPath(7, feishuPrivateOther)).toMatchObject({ error: 'out-of-scope' });
    const { service: stranger } = makeService(root, new Map(), { participated: false });
    expect(await stranger.resolveManagedPath(7, feishuGroup)).toMatchObject({ error: 'out-of-scope' });
  });
});

describe('WorkspaceOverviewService.resolveDeletablePath / deleteWorkspace', () => {
  function setup() {
    const root = useTmpDir('ws-del-');
    const userRoot = join(root, '7');
    mkdirSync(join(userRoot, '42'), { recursive: true });
    mkdirSync(join(userRoot, 'projects', 'demo'), { recursive: true });
    mkdirSync(join(userRoot, 'projects', 'demo', 'nested'), { recursive: true });
    writeFileSync(join(userRoot, '42', 'a.txt'), 'x');
    return { service: makeService(root).service, root, userRoot };
  }

  it('accepts top-level and projects/* child, resolves to absolute path', () => {
    const { service, userRoot } = setup();
    expect(service.resolveDeletablePath(7, join(userRoot, '42'))).toEqual({ path: join(userRoot, '42') });
    expect(service.resolveDeletablePath(7, join(userRoot, 'projects', 'demo'))).toEqual({ path: join(userRoot, 'projects', 'demo') });
  });

  it('rejects out-of-scope, root itself, container and nested paths with 400-class errors', () => {
    const { service, userRoot, root } = setup();
    expect(service.resolveDeletablePath(7, join(root, '8', '42'))).toMatchObject({ error: 'out-of-scope' });
    expect(service.resolveDeletablePath(7, userRoot)).toMatchObject({ error: 'out-of-scope' });
    expect(service.resolveDeletablePath(7, join(userRoot, 'projects'))).toMatchObject({ error: 'container' });
    expect(service.resolveDeletablePath(7, join(userRoot, 'projects', 'demo', 'nested'))).toMatchObject({ error: 'out-of-scope' });
    expect(service.resolveDeletablePath(7, join(userRoot, 'nope'))).toMatchObject({ error: 'missing' });
  });

  it('deletes directory physically and tolerates duplicate delete (ENOENT)', async () => {
    const { service, userRoot } = setup();
    const target = join(userRoot, '42');
    await service.deleteWorkspace(7, target);
    expect(() => rmSync(target, { force: false })).toThrow();
    // 目录已不在：ENOENT 容错分支按已删除处理
    await expect(service.deleteWorkspace(7, target)).resolves.toBeUndefined();
  });

  it('per-path mutex rejects concurrent delete of the same directory', async () => {
    const { service, userRoot } = setup();
    const target = join(userRoot, '42');
    const first = service.deleteWorkspace(7, target);
    const second = service.deleteWorkspace(7, target);
    await expect(second).rejects.toThrow('该目录正在删除中');
    await first;
  });

  it('references passthrough: delete guard shares repo method with confirm dialog', async () => {
    const root = useTmpDir('ws-ref-');
    const refs = [{ id: 5, title: 't', phase: 'RUNNING' }];
    const { service, repo } = makeService(root);
    repo.listActiveWorkspaceReferences.mockResolvedValue(refs);
    expect(await service.listActiveReferences(7, join(root, 'x'))).toEqual(refs);
    expect(repo.listActiveWorkspaceReferences).toHaveBeenCalledWith(7, join(root, 'x'));
  });
});

describe('SessionRepository workspace usage SQL（技术方案 §3 D7）', () => {
  function mockDb() {
    return { query: vi.fn(async () => [] as unknown[]) };
  }

  it('aggregateWorkspaceUsage groups by workspace with active phase list and archived count', async () => {
    const db = mockDb();
    const repo = new SessionRepository(db as never);
    await repo.aggregateWorkspaceUsage(7);
    const [sql, params] = vi.mocked(db.query).mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toContain('GROUP BY workspace');
    expect(sql).toContain("status = 'ARCHIVED'");
    expect(sql).toContain("'RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'");
    expect(sql).not.toContain('undefined');
    expect(params).toEqual([7]);
  });

  it('listActiveWorkspaceReferences matches exact or escaped prefix', async () => {
    const db = mockDb();
    const repo = new SessionRepository(db as never);
    await repo.listActiveWorkspaceReferences(7, '/root/7/proj%ect');
    const [sql, params] = vi.mocked(db.query).mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toContain('workspace = ?');
    expect(sql).toContain("LIKE CONCAT(?, '%')");
    expect(sql).toContain('ESCAPE');
    // LIKE 通配符被转义，路径字面量（含 %）不扩大匹配范围
    // 前缀分隔符取平台 path.sep（Windows 下反斜杠会被 LIKE 转义），Linux 行为不变
    expect(params).toEqual([7, '/root/7/proj%ect', escapeLike('/root/7/proj%ect' + pathSep)]);
  });

  it('aggregateWorkspaceUsageAnyUser builds per-prefix OR clauses without user filter', async () => {
    const db = mockDb();
    const repo = new SessionRepository(db as never);
    // 空前缀集合不查库
    expect(await repo.aggregateWorkspaceUsageAnyUser([])).toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
    await repo.aggregateWorkspaceUsageAnyUser(['/root/feishu-chat/b/oc_a', '/root/dingtalk-chat/b/cid']);
    const [sql, params] = vi.mocked(db.query).mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toContain('GROUP BY workspace');
    // 群工作区多人共享：不能带 user_id 过滤，否则少计同群其他用户的会话
    expect(sql).not.toContain('user_id');
    expect(sql.match(/workspace = \?/g)?.length).toBe(2);
    // LIKE 通配符（含 _）被转义，路径字面量不扩大匹配范围
    expect(params).toEqual([
      '/root/feishu-chat/b/oc_a', escapeLike('/root/feishu-chat/b/oc_a' + pathSep),
      '/root/dingtalk-chat/b/cid', escapeLike('/root/dingtalk-chat/b/cid' + pathSep),
    ]);
  });

  it('existsSessionUnderWorkspace limits to one row with escaped prefix', async () => {
    const queryOne = vi.fn(async () => ({ id: 3 } as { id: number } | null));
    const repo = new SessionRepository({ query: vi.fn(async () => []), queryOne } as never);
    expect(await repo.existsSessionUnderWorkspace(7, '/root/feishu-chat/b/oc%x')).toBe(true);
    const [sql, params] = vi.mocked(queryOne).mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toContain('LIMIT 1');
    expect(sql).toContain('ESCAPE');
    expect(params).toEqual([7, '/root/feishu-chat/b/oc%x', escapeLike('/root/feishu-chat/b/oc%x' + pathSep)]);
    queryOne.mockResolvedValueOnce(null);
    expect(await repo.existsSessionUnderWorkspace(7, '/root/feishu-chat/b/oc_x')).toBe(false);
  });
});

describe('workspace-browse 缺根文案（技术方案 §4.1-4）', () => {
  it('missing workspace root yields dedicated message instead of bare 目录不存在', async () => {
    const { WorkspaceBrowseService } = await import('./workspace-browse.service.js');
    const root = useTmpDir('ws-missing-');
    const service = new WorkspaceBrowseService(new PathSandbox(root));
    const gone = join(root, 'ghost-ws');
    rmSync(gone, { force: true, recursive: true });
    expect(() => service.listDirectory(gone, '')).toThrow('工作区目录不存在（可能已被删除）');
  });
});
