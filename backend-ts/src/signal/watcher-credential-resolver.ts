import { harnessLog } from '../harness/log.js';
import type { ShellTokenIssuer, ShellUserLookup } from '../harness/tool/impl/shell-session-tool.js';
import type { EcpCredentialsInjector } from '../auth/ecp-credentials-injector.js';
import {
  containsCredentialPlaceholder,
  replaceCredentialPlaceholders,
  type CredentialPlaceholderKind,
} from './probe-validate.js';

/**
 * 哨兵凭据占位符解析（2026-11-06 技术方案 §5.1.2）。
 * 请求头值里的 `{{MAO_TOKEN}}` / `{{ECP_TOKEN}}` 在探针执行时按哨兵属主身份现取
 * 当时有效的 token：占位符本身落库（加密），明文 token 只存在于执行前的内存中。
 */

export interface WatcherCredentialResolver {
  /** 返回 null = 该凭据当前不可用（用户异常 / ECP 票过期未重新登录等），调用方跳过对应请求头。 */
  resolve(userId: number, kind: CredentialPlaceholderKind): Promise<string | null>;
}

/**
 * 头值占位符解析（D2/D3/D6/D8）：
 * - 无占位符的头原样直通（零开销，存量哨兵零变化）；
 * - resolver 未装配（缺省路径）：值含占位符时告警后原样下发——装配遗漏不能静默，
 *   否则占位符字面量直发目标服务，用户只看到 401 无从判断是配置错还是部署缺件（D6）；
 * - 同一次调用内同一 kind 只 resolve 一次（跨头去重：MAO_TOKEN 每次调用都重新签发，
 *   一次请求里两份不同 token 是自相矛盾的凭据，§8.9）；不同 kind 并发解析
 *   （探针预算 10s 连接 + 15s 读取，串行查库会把多头哨兵拖到超时）；
 * - 任一 kind 解析失败（返回 null 或抛错）→ 丢弃含该 kind 的整个头 + 告警，
 *   探针照常执行（目标服务的 401 本身就是有效信号，不计连败，D2/D3）；
 *   抛错与 null 同口径，异常不得冒泡到 runCheck 的探针 try 块外（§5.1.2）。
 */
export async function resolveProbeHeaders(
  headers: Record<string, string> | null,
  userId: number,
  resolver: WatcherCredentialResolver | null | undefined,
): Promise<Record<string, string>> {
  if (headers == null) return {};
  const entries = Object.entries(headers);
  if (resolver == null) {
    if (entries.some(([, value]) => containsCredentialPlaceholder(value))) {
      harnessLog('warn', `[signal] watcher headers contain credential placeholders but no credentialResolver is wired, placeholders are sent verbatim, userId=${userId}`);
    }
    return { ...headers };
  }

  const PLACEHOLDER_GLOBAL_RE = /\{\{(MAO_TOKEN|ECP_TOKEN)\}\}/g;
  const kindsOf = (value: string): CredentialPlaceholderKind[] =>
    (value.match(PLACEHOLDER_GLOBAL_RE) ?? []).map((m) => m.slice(2, -2) as CredentialPlaceholderKind);

  const kinds = new Set<CredentialPlaceholderKind>();
  for (const [, value] of entries) {
    for (const kind of kindsOf(value)) kinds.add(kind);
  }
  // 无占位符：原样直通，不触碰 resolver（存量哨兵零开销）
  if (kinds.size === 0) return { ...headers };

  const resolved = new Map<CredentialPlaceholderKind, string | null>();
  await Promise.all([...kinds].map(async (kind) => {
    try {
      resolved.set(kind, await resolver.resolve(userId, kind));
    } catch (e) {
      harnessLog('warn', `[signal] resolve ${kind} failed for probe headers, headers using it will be skipped, userId=${userId}: ${(e as Error).message}`);
      resolved.set(kind, null);
    }
  }));

  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    const needed = kindsOf(value);
    if (needed.length === 0) {
      result[key] = value;
      continue;
    }
    const missing = [...new Set(needed)].filter((kind) => resolved.get(kind) == null);
    if (missing.length > 0) {
      harnessLog('warn', `[signal] skip probe header ${key}: credential ${missing.join('/')} unavailable, userId=${userId}`);
      continue;
    }
    const replaced = replaceCredentialPlaceholders(value, (kind) => resolved.get(kind) ?? null);
    if (replaced == null) {
      // 校验层（D4）已拦非白名单占位符，理论上不可达；兜底按 D2 丢头而非把字面量发出去。
      harnessLog('warn', `[signal] skip probe header ${key}: placeholder resolution failed, userId=${userId}`);
      continue;
    }
    result[key] = replaced;
  }
  return result;
}

export interface WatcherCredentialResolverDeps {
  /** 生产传 JwtService（shell JWT 签发链，与 CLOUD shell 的 MAO_TOKEN 同权）。 */
  tokenIssuer: ShellTokenIssuer;
  /** 生产传 userRepo（findById 返回的 User 有 username，结构兼容 ShellUserLookup）。 */
  userLookup: ShellUserLookup;
  /**
   * 必须是**只读** ECP injector 实例（装配层用 `createEcpCredentialsInjector(ecpSessionRepo, () => null)` 新建）：
   * resolveUserHome 返回 null 时写/清 AccessOne 布局的分支全部跳过，探针路径不得有文件副作用，
   * 也不能把用户 shell 的 ECP 布局清掉（方案 §5.1.4 / §6.6）。不要传 create-app 里那个带副作用的实例。
   */
  ecpInjector: EcpCredentialsInjector;
}

/** 生产 resolver（方案 §5.1.2）。失败口径与 shell 注入对齐：跳过 + 告警，探针照常。 */
export function createWatcherCredentialResolver(deps: WatcherCredentialResolverDeps): WatcherCredentialResolver {
  return {
    async resolve(userId: number, kind: CredentialPlaceholderKind): Promise<string | null> {
      if (kind === 'ECP_TOKEN') {
        // injector 自带完整容错：无票 / renew FAILED / 过期 / 解密失败 → null + 告警
        return deps.ecpInjector.injectForUser(userId);
      }
      const user = await deps.userLookup.findById(userId);
      const username = user?.username;
      if (!username || username.trim() === '') {
        harnessLog('warn', `[signal] skip MAO_TOKEN resolve: user not found or username empty, userId=${userId}`);
        return null;
      }
      return deps.tokenIssuer.generateShellToken(userId, username);
    },
  };
}
