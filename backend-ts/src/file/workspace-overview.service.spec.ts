import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../testing/tmp-dir.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { WorkspaceOverviewService } from './workspace-overview.service.js';
import { SessionRepository } from '../session/session.repository.js';

type UsageMap = Map<string, { total: number; active: number; archived: number; lastUsedAt: string | null }>;

function makeService(root: string, usage: UsageMap = new Map()) {
  const repo = {
    aggregateWorkspaceUsage: vi.fn(async () => usage),
    listActiveWorkspaceReferences: vi.fn(async () => [] as Array<{ id: number; title: string | null; phase: string | null }>),
  };
  const service = new WorkspaceOverviewService(new PathSandbox(root), repo as never);
  return { service, repo };
}

async function waitSizeQueue(service: WorkspaceOverviewService): Promise<void> {
  const inflight = (service as unknown as { sizeInFlight: Map<string, Promise<void>> }).sizeInFlight;
  while (inflight.size > 0) {
    await Promise.all([...inflight.values()]);
  }
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

  it('marks uncached sizes pending then ready after background compute; symlink files not counted', async () => {
    const root = useTmpDir('ws-ov-');
    const userRoot = join(root, '7');
    mkdirSync(join(userRoot, '42'), { recursive: true });
    writeFileSync(join(userRoot, '42', 'a.txt'), 'x'.repeat(10));
    symlinkSync(join(userRoot, '42', 'a.txt'), join(userRoot, '42', 'link.txt'));
    const { service } = makeService(root);
    const first = await service.listOverview(7);
    expect(first.entries[0]!.sizeState).toBe('pending');
    await waitSizeQueue(service);
    const second = await service.listOverview(7);
    expect(second.entries[0]!.sizeState).toBe('ready');
    // 符号链接文件不计入大小（只统计真实文件 10 字节）
    expect(second.entries[0]!.sizeBytes).toBe(10);
  });

  it('refresh invalidates cache and recomputes', async () => {
    const root = useTmpDir('ws-ov-');
    const userRoot = join(root, '7');
    mkdirSync(join(userRoot, '42'), { recursive: true });
    writeFileSync(join(userRoot, '42', 'a.txt'), 'x'.repeat(5));
    const { service } = makeService(root);
    await service.listOverview(7);
    await waitSizeQueue(service);
    const cached = await service.listOverview(7);
    expect(cached.entries[0]!.sizeState).toBe('ready');
    await service.refresh(7, join(userRoot, '42'));
    await waitSizeQueue(service);
    const after = await service.listOverview(7);
    expect(after.entries[0]!.sizeBytes).toBe(5);
  });

  it('TTL 过期后再次打开总览会重算并得到新大小（worker 不能把过期条目当缓存跳过）', async () => {
    const root = useTmpDir('ws-ov-');
    const userRoot = join(root, '7');
    mkdirSync(join(userRoot, '42'), { recursive: true });
    writeFileSync(join(userRoot, '42', 'a.txt'), 'x'.repeat(5));
    const { service } = makeService(root);
    await service.listOverview(7);
    await waitSizeQueue(service);
    const first = await service.listOverview(7);
    expect(first.entries[0]!.sizeState).toBe('ready');

    // 模拟 10 分钟后缓存过期，且目录内容已变化
    const cache = (service as unknown as { sizeCache: Map<string, { at: number }> }).sizeCache;
    cache.get(`7:${join(userRoot, '42')}`)!.at = Date.now() - 11 * 60 * 1000;
    writeFileSync(join(userRoot, '42', 'b.txt'), 'y'.repeat(20));

    const second = await service.listOverview(7);
    expect(second.entries[0]!.sizeState).toBe('pending');
    await waitSizeQueue(service);
    const third = await service.listOverview(7);
    expect(third.entries[0]!.sizeState).toBe('ready');
    expect(third.entries[0]!.sizeBytes).toBe(25);
  });

  it('refresh 拒绝本人根之外的路径（越界不可触发任意目录遍历）', async () => {
    const root = useTmpDir('ws-ov-');
    mkdirSync(join(root, '8', '42'), { recursive: true });
    const { service } = makeService(root);
    await expect(service.refresh(7, join(root, '8', '42'))).rejects.toThrow('只能操作本人工作区根目录下的目录');
    await expect(service.refresh(7, '/etc')).rejects.toThrow('只能操作本人工作区根目录下的目录');
    // 本人根内路径放行
    await expect(service.refresh(7, join(root, '7', 'nope'))).resolves.toBeUndefined();
  });

  it('walk 超过深度上限标 timeout（30 层嵌套）', async () => {
    const root = useTmpDir('ws-ov-');
    const userRoot = join(root, '7');
    let deep = join(userRoot, '42');
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 30; i++) {
      deep = join(deep, `lvl${i}`);
    }
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'leaf.txt'), 'x');
    const { service } = makeService(root);
    await service.listOverview(7);
    await waitSizeQueue(service);
    const { entries } = await service.listOverview(7);
    expect(entries[0]!.sizeState).toBe('timeout');
  });

  it('missing user root returns empty without error', async () => {
    const root = useTmpDir('ws-ov-');
    const { service } = makeService(root);
    const { entries, error } = await service.listOverview(7);
    expect(entries).toEqual([]);
    expect(error).toBeNull();
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
    expect(params).toEqual([7, '/root/7/proj%ect', '/root/7/proj\\%ect/']);
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
