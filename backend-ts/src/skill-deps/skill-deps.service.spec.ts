import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { harnessLog } from '../harness/log.js';
import { BuiltinSkillCatalog, locateBuiltinRoot } from '../harness/skill/builtin-skill-catalog.js';
import { SkillDepsService } from './skill-deps.service.js';
import type { SkillDepsItem, SkillDepsProvider } from './skill-deps.types.js';
import { createBrowserDepsProvider } from './providers/browser-deps.provider.js';

function item(overrides: Partial<SkillDepsItem> = {}): SkillDepsItem {
  return { id: 'main', label: '依赖', kind: 'install', phase: 'ready', detail: null, ...overrides };
}

function provider(skillName: string, overrides: Partial<SkillDepsProvider> = {}): SkillDepsProvider {
  return { skillName, status: vi.fn(async () => [item()]), ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function expectBusiness(promise: Promise<unknown>, code: number) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BusinessException);
  expect((err as BusinessException).code).toBe(code);
}

vi.mock('../harness/log.js', () => ({ harnessLog: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('SkillDepsService 构造校验', () => {
  it('拒绝非法技能名与重复技能名', () => {
    expect(() => new SkillDepsService([provider('bad name')])).toThrow(/不合法/);
    expect(() => new SkillDepsService([provider('a'), provider('a')])).toThrow(/重复/);
  });

  it('技能不在已知目录中只 warn 不抛', () => {
    expect(() => new SkillDepsService([provider('ghost')], { knownSkillNames: ['browser-use'] })).not.toThrow();
    expect(harnessLog).toHaveBeenCalledWith('warn', expect.stringContaining('ghost'));
  });

  it('已注册 provider 的技能名都存在于仓库内置技能（防改名/删目录后 provider 变死代码）', () => {
    const names = new BuiltinSkillCatalog().load(locateBuiltinRoot()).map((s) => s.name);
    const browser = createBrowserDepsProvider({ getStatus: vi.fn(), install: vi.fn(), ensureForSkills: vi.fn() } as never);
    expect(names).toContain(browser.skillName);
  });
});

describe('SkillDepsService.getStatusMap', () => {
  it('只包含已注册技能，按技能名键控', async () => {
    const svc = new SkillDepsService([provider('browser-use'), provider('MySkill')]);
    const map = await svc.getStatusMap();
    expect(Object.keys(map).sort()).toEqual(['MySkill', 'browser-use']);
    expect(map['browser-use'].items[0].phase).toBe('ready');
  });

  it('provider 并发探测而非串行', async () => {
    const a = deferred<SkillDepsItem[]>();
    const b = deferred<SkillDepsItem[]>();
    const pa = provider('a', { status: vi.fn(() => a.promise) });
    const pb = provider('b', { status: vi.fn(() => b.promise) });
    const svc = new SkillDepsService([pa, pb]);
    const pending = svc.getStatusMap();
    await Promise.resolve();
    await Promise.resolve();
    expect(pa.status).toHaveBeenCalledTimes(1);
    expect(pb.status).toHaveBeenCalledTimes(1);
    b.resolve([item({ id: 'b' })]);
    a.resolve([item({ id: 'a' })]);
    const map = await pending;
    expect(map.a.items[0].id).toBe('a');
    expect(map.b.items[0].id).toBe('b');
  });

  it('单个 provider 抛错只降级该技能，其余照常返回', async () => {
    const svc = new SkillDepsService([
      provider('broken', { status: vi.fn(async () => { throw new Error('boom'); }) }),
      provider('ok'),
    ]);
    const map = await svc.getStatusMap();
    expect(map.ok.items[0].phase).toBe('ready');
    expect(map.broken.items).toEqual([expect.objectContaining({ phase: 'failed', text: '状态读取失败' })]);
    expect(map.broken.items[0].detail).toContain('boom');
  });

  it('探测超时降级，不拖住整体响应', async () => {
    vi.useFakeTimers();
    const svc = new SkillDepsService([
      provider('slow', { status: vi.fn(() => new Promise<SkillDepsItem[]>(() => undefined)) }),
    ], { statusTimeoutMs: 1000 });
    const pending = svc.getStatusMap();
    await vi.advanceTimersByTimeAsync(1001);
    const map = await pending;
    expect(map.slow.items[0]).toMatchObject({ phase: 'failed', text: '状态读取失败' });
    expect(map.slow.items[0].detail).toContain('超时');
  });

  it('探测失败时回退上次成功结果（安装中不被打成失败，前端继续轮询）', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce([item({ phase: 'installing', detail: '下载 chromium' })])
      .mockRejectedValueOnce(new Error('db down'));
    const svc = new SkillDepsService([provider('browser-use', { status })]);
    await svc.getStatusMap();
    const map = await svc.getStatusMap();
    expect(map['browser-use'].items[0].phase).toBe('installing');
    expect(map['browser-use'].items[0].detail).toBe('下载 chromium（本次状态读取失败，显示上次结果）');
  });

  it('并发请求复用进行中的探测，不重复调用 provider', async () => {
    const d = deferred<SkillDepsItem[]>();
    const p = provider('browser-use', { status: vi.fn(() => d.promise) });
    const svc = new SkillDepsService([p]);
    const first = svc.getStatusMap();
    const second = svc.getStatusMap();
    d.resolve([item()]);
    await Promise.all([first, second]);
    expect(p.status).toHaveBeenCalledTimes(1);
    await svc.getStatusMap();
    expect(p.status).toHaveBeenCalledTimes(2);
  });
});

describe('SkillDepsService.install', () => {
  it('非法名 → PARAM_INVALID；未注册 → SKILL_NOT_FOUND；无 install（config 类）→ PARAM_INVALID', async () => {
    const svc = new SkillDepsService([provider('config-only')]);
    await expectBusiness(svc.install('../x'), ErrorCode.PARAM_INVALID.code);
    await expectBusiness(svc.install('unknown'), ErrorCode.SKILL_NOT_FOUND.code);
    await expectBusiness(svc.install('config-only'), ErrorCode.PARAM_INVALID.code);
  });

  it('大写技能名能通过校验并派发', async () => {
    const install = vi.fn(async () => ({ started: true }));
    const svc = new SkillDepsService([provider('MySkill', { install })]);
    await expect(svc.install('MySkill')).resolves.toEqual({ started: true });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('不同技能的安装互不阻塞', async () => {
    const a = deferred<{ started: boolean }>();
    const installB = vi.fn(async () => ({ started: true }));
    const svc = new SkillDepsService([
      provider('a', { install: vi.fn(() => a.promise) }),
      provider('b', { install: installB }),
    ]);
    const pendingA = svc.install('a');
    await expect(svc.install('b')).resolves.toEqual({ started: true });
    a.resolve({ started: true });
    await pendingA;
  });
});

describe('SkillDepsService.ensureForSkills', () => {
  it('把完整名单透传给每个实现了 ensure 的 provider；null/空名单 no-op', () => {
    const ensureA = vi.fn();
    const ensureB = vi.fn();
    const svc = new SkillDepsService([
      provider('browser-use', { ensureForSkills: ensureA }),
      provider('other', { ensureForSkills: ensureB }),
      provider('config-only'),
    ]);
    svc.ensureForSkills(null);
    svc.ensureForSkills([]);
    expect(ensureA).not.toHaveBeenCalled();
    svc.ensureForSkills(['browser-use', 'git']);
    expect(ensureA).toHaveBeenCalledWith(['browser-use', 'git']);
    expect(ensureB).toHaveBeenCalledWith(['browser-use', 'git']);
  });

  it('某个 provider ensure 同步抛错不影响其他 provider', () => {
    const ensureB = vi.fn();
    const svc = new SkillDepsService([
      provider('a', { ensureForSkills: vi.fn(() => { throw new Error('x'); }) }),
      provider('b', { ensureForSkills: ensureB }),
    ]);
    expect(() => svc.ensureForSkills(['a'])).not.toThrow();
    expect(ensureB).toHaveBeenCalledWith(['a']);
  });
});
