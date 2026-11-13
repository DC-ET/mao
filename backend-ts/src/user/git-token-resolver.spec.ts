import { describe, expect, it, vi } from 'vitest';
import { DefaultGitTokenResolver, type GitTokenResolverDeps } from './git-token-resolver.js';

/**
 * 解析器测试矩阵（技术方案 2026-11-06 §7 + 2026-11-12 §10.1）：
 * 宽松/严格 × 未配置/禁止/白名单 × 有/无上下文 × 故障 fail-closed × 系统默认逐域兜底。
 */

const USER_ID = 7;
const AGENT_ID = 10;
const SESSION_ID = 100;

/** 用户持有两个域的 token（git.acg.team 命中白名单，github.com 不命中）。 */
function fullMap(): Map<string, string> {
  return new Map([
    ['git.acg.team', 'tok-acg'],
    ['github.com', 'tok-gh'],
  ]);
}

/** 系统默认覆盖两个域（git.acg.team 与用户同域，other.com 为用户缺域）。 */
function defaultMap(): Map<string, string> {
  return new Map([
    ['git.acg.team', 'tok-default-acg'],
    ['other.com', 'tok-default-other'],
  ]);
}

function makeDeps(overrides: Partial<GitTokenResolverDeps> = {}): GitTokenResolverDeps {
  return {
    gitCredentialService: {
      getTokenMapByUser: vi.fn(async () => fullMap()),
      getTokenMapByUserFiltered: vi.fn(async (_userId: number, domains: string[]) => {
        const full = fullMap();
        const result = new Map<string, string>();
        for (const domain of domains) {
          const token = full.get(domain);
          if (token != null) result.set(domain, token);
        }
        return result;
      }),
    },
    // 系统默认：默认空表（等价现状，存量断言不受影响）；用例按需覆写
    systemGitCredentialService: {
      getTokenMap: vi.fn(async () => new Map<string, string>()),
      getTokenMapFiltered: vi.fn(async (domains: string[]) => {
        const full = defaultMap();
        const result = new Map<string, string>();
        for (const domain of domains) {
          const token = full.get(domain);
          if (token != null) result.set(domain, token);
        }
        return result;
      }),
    },
    agentLookup: {
      selectGitAllowedDomainsById: vi.fn(async () => ({ domains: null as string | null })),
    },
    sessionLookup: {
      selectById: vi.fn(async () => ({ userId: USER_ID, agentId: AGENT_ID })),
    },
    scopePolicy: {
      getGitScopePolicy: vi.fn(async () => 'lenient' as 'lenient' | 'strict'),
    },
    ...overrides,
  };
}

function resolverOf(deps: GitTokenResolverDeps): DefaultGitTokenResolver {
  return new DefaultGitTokenResolver(deps);
}

describe('DefaultGitTokenResolver.resolveForAgent', () => {
  it('agent 未配置（NULL）+ 宽松：返回用户全部 token（现状兼容）', async () => {
    const deps = makeDeps();
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({ 'git.acg.team': 'tok-acg', 'github.com': 'tok-gh' });
    expect(deps.gitCredentialService.getTokenMapByUser).toHaveBeenCalledWith(USER_ID);
  });

  it('agent 未配置（NULL）+ 严格：不注入任何凭据（fail-closed）', async () => {
    const deps = makeDeps({ scopePolicy: { getGitScopePolicy: vi.fn(async () => 'strict' as const) } });
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({});
    expect(deps.gitCredentialService.getTokenMapByUser).not.toHaveBeenCalled();
  });

  it('agent 显式禁止（[]）：两种策略下都不注入', async () => {
    for (const policy of ['lenient', 'strict'] as const) {
      const deps = makeDeps({
        agentLookup: { selectGitAllowedDomainsById: vi.fn(async () => ({ domains: '[]' })) },
        scopePolicy: { getGitScopePolicy: vi.fn(async () => policy) },
      });
      const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
      expect(result, policy).toEqual({});
      expect(deps.gitCredentialService.getTokenMapByUserFiltered).not.toHaveBeenCalled();
    }
  });

  it('白名单：只返回交集（只解密命中域），两种策略下一致', async () => {
    for (const policy of ['lenient', 'strict'] as const) {
      const deps = makeDeps({
        agentLookup: {
          selectGitAllowedDomainsById: vi.fn(async () => ({ domains: '["git.acg.team"]' })),
        },
        scopePolicy: { getGitScopePolicy: vi.fn(async () => policy) },
      });
      const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
      expect(result, policy).toEqual({ 'git.acg.team': 'tok-acg' });
      expect(deps.gitCredentialService.getTokenMapByUserFiltered).toHaveBeenCalledWith(USER_ID, ['git.acg.team']);
      expect(deps.gitCredentialService.getTokenMapByUser).not.toHaveBeenCalled();
    }
  });

  it('白名单无命中：空对象', async () => {
    const deps = makeDeps({
      agentLookup: {
        selectGitAllowedDomainsById: vi.fn(async () => ({ domains: '["git.zizaitianye.com"]' })),
      },
    });
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({});
  });

  it('agentId == null（无 Agent 上下文）：宽松全量 / 严格为空', async () => {
    const lenient = await resolverOf(makeDeps()).resolveForAgent(USER_ID, null);
    expect(lenient).toEqual({ 'git.acg.team': 'tok-acg', 'github.com': 'tok-gh' });

    const strictDeps = makeDeps({ scopePolicy: { getGitScopePolicy: vi.fn(async () => 'strict' as const) } });
    const strict = await resolverOf(strictDeps).resolveForAgent(USER_ID, null);
    expect(strict).toEqual({});
  });

  it('agent id 不存在（row == null）：故障 fail-closed（两种策略一致）', async () => {
    for (const policy of ['lenient', 'strict'] as const) {
      const deps = makeDeps({
        agentLookup: { selectGitAllowedDomainsById: vi.fn(async () => null) },
        scopePolicy: { getGitScopePolicy: vi.fn(async () => policy) },
      });
      const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
      expect(result, policy).toEqual({});
    }
  });

  it('软删 Agent（行存在、查询不过滤软删）按当时配置解析', async () => {
    // repository 的 selectGitAllowedDomainsById 不过滤软删；resolver 层只需验证「行存在」即按配置走。
    const deps = makeDeps({
      agentLookup: {
        selectGitAllowedDomainsById: vi.fn(async () => ({ domains: '["git.acg.team"]' })),
      },
    });
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({ 'git.acg.team': 'tok-acg' });
  });

  it('resolver 内部异常（DB 挂）：空集 + 不抛出', async () => {
    const deps = makeDeps({
      agentLookup: {
        selectGitAllowedDomainsById: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    });
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({});
  });

  it('白名单 JSON 解析失败 / 非数组：按无允许域（空集）', async () => {
    for (const bad of ['not-json', '{"a":1}', 'null']) {
      const deps = makeDeps({
        agentLookup: { selectGitAllowedDomainsById: vi.fn(async () => ({ domains: bad })) },
      });
      const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
      expect(result, bad).toEqual({});
    }
  });
});

describe('DefaultGitTokenResolver.resolveForSession', () => {
  it('正常会话：查 session 后按 agentId 委托（白名单 = 交集）', async () => {
    const deps = makeDeps({
      agentLookup: {
        selectGitAllowedDomainsById: vi.fn(async () => ({ domains: '["git.acg.team"]' })),
      },
    });
    const result = await resolverOf(deps).resolveForSession(USER_ID, SESSION_ID);
    expect(result).toEqual({ 'git.acg.team': 'tok-acg' });
    expect(deps.sessionLookup.selectById).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.agentLookup.selectGitAllowedDomainsById).toHaveBeenCalledWith(AGENT_ID);
  });

  it('sessionId == null：走无 Agent 上下文（宽松全量）', async () => {
    const deps = makeDeps();
    const result = await resolverOf(deps).resolveForSession(USER_ID, null);
    expect(result).toEqual({ 'git.acg.team': 'tok-acg', 'github.com': 'tok-gh' });
    expect(deps.sessionLookup.selectById).not.toHaveBeenCalled();
  });

  it('session 查不到：故障 fail-closed（宽松模式也不放行）', async () => {
    const deps = makeDeps({
      sessionLookup: { selectById: vi.fn(async () => null) },
    });
    const result = await resolverOf(deps).resolveForSession(USER_ID, SESSION_ID);
    expect(result).toEqual({});
  });

  it('session.userId 与入参 userId 不一致且非最近运行身份（跨用户误传）：fail-closed', async () => {
    const deps = makeDeps({
      sessionLookup: { selectById: vi.fn(async () => ({ userId: 99, agentId: AGENT_ID, lastRuntimeUserId: null })) },
    });
    const result = await resolverOf(deps).resolveForSession(USER_ID, SESSION_ID);
    expect(result).toEqual({});
    expect(deps.agentLookup.selectGitAllowedDomainsById).not.toHaveBeenCalled();
  });

  it('群聊会话：非首发发言人（owner 不符但 lastRuntimeUserId 相符）按运行身份解析', async () => {
    // 群聊按 (appId, chatId) 复用会话、归属者是首个发言人；B 发言时 shell/容器按运行身份调用。
    const deps = makeDeps({
      sessionLookup: {
        selectById: vi.fn(async () => ({ userId: 1, agentId: AGENT_ID, lastRuntimeUserId: USER_ID })),
      },
      agentLookup: {
        selectGitAllowedDomainsById: vi.fn(async () => ({ domains: '["git.acg.team"]' })),
      },
    });
    const result = await resolverOf(deps).resolveForSession(USER_ID, SESSION_ID);
    expect(result).toEqual({ 'git.acg.team': 'tok-acg' });
  });

  it('owner 与最近运行身份都不相符：fail-closed（不放行任何凭据）', async () => {
    const deps = makeDeps({
      sessionLookup: {
        selectById: vi.fn(async () => ({ userId: 1, agentId: AGENT_ID, lastRuntimeUserId: 2 })),
      },
    });
    const result = await resolverOf(deps).resolveForSession(USER_ID, SESSION_ID);
    expect(result).toEqual({});
  });

  it('session.agentId 为空：按无 Agent 上下文处理（宽松全量 + 日志）', async () => {
    const deps = makeDeps({
      sessionLookup: { selectById: vi.fn(async () => ({ userId: USER_ID, agentId: null })) },
    });
    const result = await resolverOf(deps).resolveForSession(USER_ID, SESSION_ID);
    expect(result).toEqual({ 'git.acg.team': 'tok-acg', 'github.com': 'tok-gh' });
  });

  it('sessionLookup 异常：空集 + 不抛出', async () => {
    const deps = makeDeps({
      sessionLookup: {
        selectById: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    });
    const result = await resolverOf(deps).resolveForSession(USER_ID, SESSION_ID);
    expect(result).toEqual({});
  });
});

// ── 系统默认凭据逐域兜底（技术方案 2026-11-12 §5.1 矩阵） ──
describe('DefaultGitTokenResolver system defaults', () => {
  it('NULL 白名单 + 宽松：用户 ∪ 默认合并，同域用户优先', async () => {
    const deps = makeDeps({
      systemGitCredentialService: {
        getTokenMap: vi.fn(async () => defaultMap()),
        getTokenMapFiltered: vi.fn(async () => new Map<string, string>()),
      },
    });
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({
      'git.acg.team': 'tok-acg',            // 用户覆盖默认
      'github.com': 'tok-gh',
      'other.com': 'tok-default-other',      // 用户缺域，默认兜底
    });
    expect(deps.systemGitCredentialService.getTokenMap).toHaveBeenCalled();
  });

  it('NULL 白名单 + 严格：{} 且不查默认（D2）', async () => {
    const deps = makeDeps({
      scopePolicy: { getGitScopePolicy: vi.fn(async () => 'strict' as const) },
      systemGitCredentialService: {
        getTokenMap: vi.fn(async () => defaultMap()),
        getTokenMapFiltered: vi.fn(async () => defaultMap()),
      },
    });
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({});
    expect(deps.systemGitCredentialService.getTokenMap).not.toHaveBeenCalled();
    expect(deps.systemGitCredentialService.getTokenMapFiltered).not.toHaveBeenCalled();
  });

  it("'[]' 显式禁止：{} 且不查默认（含系统默认）", async () => {
    const deps = makeDeps({
      agentLookup: { selectGitAllowedDomainsById: vi.fn(async () => ({ domains: '[]' })) },
      systemGitCredentialService: {
        getTokenMap: vi.fn(async () => defaultMap()),
        getTokenMapFiltered: vi.fn(async () => defaultMap()),
      },
    });
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({});
    expect(deps.systemGitCredentialService.getTokenMap).not.toHaveBeenCalled();
    expect(deps.systemGitCredentialService.getTokenMapFiltered).not.toHaveBeenCalled();
  });

  it('白名单：默认只按允许域查询（getTokenMapFiltered(allowed)），交集合并，用户优先', async () => {
    const deps = makeDeps({
      agentLookup: {
        selectGitAllowedDomainsById: vi.fn(async () => ({ domains: '["git.acg.team","other.com"]' })),
      },
    });
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({
      'git.acg.team': 'tok-acg',             // 用户优先
      'other.com': 'tok-default-other',      // 默认兜底
    });
    expect(deps.systemGitCredentialService.getTokenMapFiltered).toHaveBeenCalledWith(['git.acg.team', 'other.com']);
    expect(deps.systemGitCredentialService.getTokenMap).not.toHaveBeenCalled();
  });

  it('白名单不含默认域：默认不注入（B 不在白名单，默认也不进）', async () => {
    const deps = makeDeps({
      agentLookup: {
        selectGitAllowedDomainsById: vi.fn(async () => ({ domains: '["git.acg.team"]' })),
      },
    });
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({ 'git.acg.team': 'tok-acg' });
  });

  it('默认查询异常：降级为「仅用户 Token」，不抛出、不 fail-closed 整个解析', async () => {
    const deps = makeDeps({
      systemGitCredentialService: {
        getTokenMap: vi.fn(async () => {
          throw new Error('db down');
        }),
        getTokenMapFiltered: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    });
    const result = await resolverOf(deps).resolveForAgent(USER_ID, AGENT_ID);
    expect(result).toEqual({ 'git.acg.team': 'tok-acg', 'github.com': 'tok-gh' });
  });

  it('默认为空表：等价现状（合并 no-op）', async () => {
    const deps = makeDeps();
    const result = await resolverOf(deps).resolveForAgent(USER_ID, null);
    expect(result).toEqual({ 'git.acg.team': 'tok-acg', 'github.com': 'tok-gh' });
  });
});
