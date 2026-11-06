import { harnessLog } from '../harness/log.js';
import type { GitTokenResolver } from '../session/types.js';

/**
 * Git 凭据统一解析器（技术方案 2026-11-06 §3.3）：
 * 六条注入通道的凭据数据源统一收敛到此；把「注入哪些域」从「该用户全部域」收敛为
 * 「用户凭据域 ∩ 当前 Agent 允许域」。
 *
 * 兜底口径（与方案 §3.3 故障表一致）：
 * - agentId == null（历史会话等结构上无 Agent 上下文）→ 配置未就绪：按全局策略（宽松全量 / 严格空）；
 * - sessionId == null（调用方未传上下文）→ 同上，但独立打日志用于排查漏传；
 * - session 查不到 / owner 不匹配 / agent id 不存在 / 任何异常 → 故障 fail-closed（空集 + 日志）。
 */

/** 解析器最小依赖（结构化类型，便于单测与装配）。 */
export interface GitTokenResolverDeps {
  gitCredentialService: {
    getTokenMapByUser(userId: number | null | undefined): Promise<Map<string, string>>;
    getTokenMapByUserFiltered(userId: number | null | undefined, domains: string[]): Promise<Map<string, string>>;
  };
  /** 不过滤软删的轻量查询（D1）：null=agent id 不存在（故障）；{ domains: null }=未配置。 */
  agentLookup: {
    selectGitAllowedDomainsById(id: number): Promise<{ domains: string | null } | null>;
  };
  sessionLookup: {
    selectById(id: number): Promise<{
      userId: number;
      agentId?: number | null;
      /** 最近一次执行的运行身份（V183）：群聊会话按发言人放行、子代理继承父会话身份。 */
      lastRuntimeUserId?: number | null;
    } | null>;
  };
  scopePolicy: {
    getGitScopePolicy(): Promise<'lenient' | 'strict'>;
  };
}

export class DefaultGitTokenResolver implements GitTokenResolver {
  constructor(private readonly deps: GitTokenResolverDeps) {}

  async resolveForSession(userId: number, sessionId: number | null): Promise<Record<string, string>> {
    try {
      if (sessionId == null) {
        // 独立观察点（复核修正 §3.3）：调用方漏传排查；语义同「配置未就绪」。
        harnessLog('info', `[git-scope] no session context uid=${userId}`);
        return await this.resolveForAgent(userId, null);
      }
      const session = await this.deps.sessionLookup.selectById(sessionId);
      if (session == null) {
        harnessLog('warn', `[git-scope] session not found sid=${sessionId} uid=${userId}`);
        return {};
      }
      // 资格校验（code review 2026-11-06 修订）：shell / 容器通道按「运行身份」调用
      // （tool-dispatcher §5.5：toolUserId = runtimeUserId），而群聊会话按 (appId, chatId) 复用、
      // 归属者固定为首个发言人——因此 owner 或「最近一次运行身份」命中都放行；
      // 两者都不命中才 fail-closed（防传错 / 跨用户 sessionId，疑似越权不放行）。
      const ownerMatch = session.userId === userId;
      const runtimeMatch = session.lastRuntimeUserId != null && session.lastRuntimeUserId === userId;
      if (!ownerMatch && !runtimeMatch) {
        harnessLog(
          'warn',
          `[git-scope] session owner mismatch sid=${sessionId} uid=${userId} owner=${session.userId} runtime=${session.lastRuntimeUserId ?? 'null'}`,
        );
        return {};
      }
      return await this.resolveForAgent(userId, session.agentId ?? null);
    } catch (e) {
      harnessLog('warn', `[git-scope] resolve failed sid=${sessionId} uid=${userId}: ${(e as Error).message}`);
      return {};
    }
  }

  async resolveForAgent(userId: number, agentId: number | null): Promise<Record<string, string>> {
    try {
      const policy = await this.deps.scopePolicy.getGitScopePolicy();
      if (agentId == null) {
        harnessLog('info', `[git-scope] no agent context uid=${userId} policy=${policy}`);
        return policy === 'lenient' ? await this.fullTokenMap(userId) : {};
      }
      const row = await this.deps.agentLookup.selectGitAllowedDomainsById(agentId);
      if (row == null) {
        harnessLog('warn', `[git-scope] agent not found agentId=${agentId} uid=${userId}`);
        return {};
      }
      if (row.domains == null) {
        harnessLog('info', `[git-scope] agent unconfigured agentId=${agentId} uid=${userId} policy=${policy}`);
        return policy === 'lenient' ? await this.fullTokenMap(userId) : {};
      }
      const allowed = parseDomainList(row.domains);
      if (allowed.length === 0) {
        // '[]' 显式禁止：不注入任何凭据（两种策略下一致）。
        return {};
      }
      const result = toRecord(await this.deps.gitCredentialService.getTokenMapByUserFiltered(userId, allowed));
      harnessLog('info', `[git-scope] injected=${Object.keys(result).length} allowed=${allowed.length} agentId=${agentId} uid=${userId}`);
      return result;
    } catch (e) {
      harnessLog('warn', `[git-scope] resolve failed agentId=${agentId} uid=${userId}: ${(e as Error).message}`);
      return {};
    }
  }

  private async fullTokenMap(userId: number): Promise<Record<string, string>> {
    return toRecord(await this.deps.gitCredentialService.getTokenMapByUser(userId));
  }
}

/** Map → 普通对象（注入通道消费的形态）。 */
function toRecord(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries(map);
}

/** 解析白名单 JSON；非数组 / 解析失败 / 空数组一律按「无允许域」（安全侧）。 */
function parseDomainList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
  } catch {
    return [];
  }
}
