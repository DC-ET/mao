import path from 'node:path';
import { harnessLog } from '../log.js';
import type { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import type { GitCredentialLookup } from '../../session/types.js';
import type { ShellTokenIssuer, ShellUserLookup, ShellEcpInjector, ShellLarkUatInjector } from '../tool/impl/shell-session-tool.js';
import type { RuntimeEnvelope } from './runtime-channel-protocol.js';

/**
 * 会话环境包构建器（技术方案 §5.7.2）：派发前查库取该用户凭据，与 §5.13 依赖目录
 * env 一起打进 envelope。容器用完即弃，不落盘、不写镜像。
 * 宿主机四处凭据注入点（shell 工具 / shell 会话管理 / 终端 / workdir）统一以 envelope 为数据源。
 */
export interface EnvelopeBuildInput {
  userId: number;
  sessionId: number | null;
  workspace: string | null;
}

export class SessionEnvelopeBuilder {
  constructor(
    private readonly deps: {
      runtimeResolver: RuntimeDataResolver;
      gitCredentialService?: GitCredentialLookup | null;
      jwtService?: ShellTokenIssuer | null;
      userLookup?: ShellUserLookup | null;
      ecpInjector?: ShellEcpInjector | null;
      larkUatInjector?: ShellLarkUatInjector | null;
    },
    private readonly depsRoot: string,
  ) {}

  async build(input: EnvelopeBuildInput): Promise<RuntimeEnvelope> {
    const { userId, sessionId, workspace } = input;
    let gitTokens: Record<string, string> = {};
    try {
      gitTokens = userId != null && this.deps.gitCredentialService
        ? await this.deps.gitCredentialService.getTokenMapByUser(userId)
        : {};
    } catch (e) {
      harnessLog('warn', `[envelope] git token lookup failed for user=${userId}: ${(e as Error).message}`);
    }

    let maoToken: string | null = null;
    if (this.deps.jwtService && this.deps.userLookup) {
      try {
        const user = await this.deps.userLookup.findById(userId);
        const username = user?.username;
        if (username && username.trim() !== '') {
          maoToken = this.deps.jwtService.generateShellToken(userId, username);
        }
      } catch (e) {
        harnessLog('warn', `[envelope] MAO_TOKEN issue failed for user=${userId}: ${(e as Error).message}`);
      }
    }

    let ecpToken: string | null = null;
    if (this.deps.ecpInjector) {
      try {
        ecpToken = await this.deps.ecpInjector.injectForUser(userId);
      } catch (e) {
        harnessLog('warn', `[envelope] ECP token lookup failed for user=${userId}: ${(e as Error).message}`);
      }
    }

    let larkUat: RuntimeEnvelope['larkUat'] = null;
    if (this.deps.larkUatInjector) {
      try {
        const lark = await this.deps.larkUatInjector.injectForUser(userId);
        if (lark) larkUat = { appId: lark.appId, uat: lark.uat };
      } catch (e) {
        harnessLog('warn', `[envelope] lark UAT lookup failed for user=${userId}: ${(e as Error).message}`);
      }
    }

    return {
      userId,
      sessionId,
      workspace: workspace ?? null,
      home: this.deps.runtimeResolver.resolveUserHomeDir(userId),
      runtimeDir: sessionId != null
        ? this.deps.runtimeResolver.resolveSessionRuntimeDir(userId, sessionId)
        : this.deps.runtimeResolver.resolveUserRuntimeDir(userId),
      gitTokens,
      maoToken,
      ecpToken,
      larkUat,
      depsEnv: this.buildDepsEnv(userId),
    };
  }

  /**
   * §5.13 依赖持久化：pip/npm 安装位置指向每用户挂载目录，容器重建后依赖不丢。
   * 由派发时注入 shell/pty 会话（与 git token 同一机制），不写进镜像。
   */
  private buildDepsEnv(userId: number): Record<string, string> {
    const depsUserDir = path.join(path.resolve(this.depsRoot), String(userId));
    return {
      NPM_CONFIG_PREFIX: path.join(depsUserDir, 'npm'),
      PIP_TARGET: path.join(depsUserDir, 'py'),
      PIP_BREAK_SYSTEM_PACKAGES: '1',
      // PATH 注入由容器侧拼接（depsUserDir/npm/bin 前置到现有 PATH），这里给前缀根
      MAO_DEPS_BIN: path.join(depsUserDir, 'npm', 'bin'),
    };
  }
}
