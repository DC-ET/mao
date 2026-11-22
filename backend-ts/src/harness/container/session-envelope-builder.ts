import path from 'node:path';
import { harnessLog } from '../log.js';
import type { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import type { GitTokenResolver } from '../../session/types.js';
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

/** 三级环境变量解析的结构化依赖（避免容器相关文件 import env 域模块）。 */
export interface EnvVarsLookup {
  resolveForSession(userId: number, workspace: string | null): Promise<Record<string, string>>;
}

/** 站点地址查询（注入 envelope.maoBaseUrl；口径同宿主机 ShellBaseUrlProvider）。 */
export interface SiteBaseUrlLookup {
  getSiteBaseUrl(): Promise<string | null>;
}

export class SessionEnvelopeBuilder {
  constructor(
    private readonly deps: {
      runtimeResolver: RuntimeDataResolver;
      gitTokenResolver?: GitTokenResolver | null;
      jwtService?: ShellTokenIssuer | null;
      userLookup?: ShellUserLookup | null;
      ecpInjector?: ShellEcpInjector | null;
      larkUatInjector?: ShellLarkUatInjector | null;
      /** 三级环境变量解析（宿主机侧查库 + 解密），容器内只消费 envelope.envVars。 */
      envVariableService?: EnvVarsLookup | null;
      /** 站点地址（注入 envelope.maoBaseUrl）：容器内 mao / mao-agent 不再有内置默认。 */
      siteBaseUrlProvider?: SiteBaseUrlLookup | null;
      /** 浏览器直播录制开关（V202）：开启时 envVars 追加 MAO_BROWSER_LIVE_RECORD=1（sidecar 采集侧录制）。 */
      browserLiveRecordEnabled?: (() => Promise<boolean>) | null;
    },
    private readonly depsRoot: string,
  ) {}

  async build(input: EnvelopeBuildInput): Promise<RuntimeEnvelope> {
    const { userId, sessionId, workspace } = input;
    let gitTokens: Record<string, string> = {};
    try {
      // 技术方案 2026-11-06：按会话上下文解析（用户 token ∩ Agent 允许域）；容器内消费方零改动
      gitTokens = userId != null && this.deps.gitTokenResolver
        ? await this.deps.gitTokenResolver.resolveForSession(userId, sessionId)
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

    let maoBaseUrl: string | null = null;
    if (this.deps.siteBaseUrlProvider) {
      try {
        maoBaseUrl = await this.deps.siteBaseUrlProvider.getSiteBaseUrl();
      } catch (e) {
        harnessLog('warn', `[envelope] site baseUrl lookup failed: ${(e as Error).message}`);
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

    let envVars: Record<string, string> = {};
    if (this.deps.envVariableService) {
      try {
        envVars = await this.deps.envVariableService.resolveForSession(userId, workspace ?? null);
      } catch (e) {
        harnessLog('warn', `[envelope] env vars resolve failed for user=${userId}: ${(e as Error).message}`);
      }
    }

    if (this.deps.browserLiveRecordEnabled) {
      try {
        if (await this.deps.browserLiveRecordEnabled()) {
          envVars = { ...envVars, MAO_BROWSER_LIVE_RECORD: '1' };
        }
      } catch (e) {
        harnessLog('warn', `[envelope] browser live record flag lookup failed: ${(e as Error).message}`);
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
      maoBaseUrl,
      ecpToken,
      larkUat,
      depsEnv: this.buildDepsEnv(userId),
      envVars,
    };
  }

  /**
   * §5.13 依赖持久化：pip/npm 安装位置指向每用户挂载目录，容器重建后依赖不丢。
   * 由派发时注入 shell/pty 会话（与 git token 同一机制），不写进镜像。
   */
  private buildDepsEnv(userId: number): Record<string, string> {
    return buildDepsEnv(this.depsRoot, userId);
  }
}

/**
 * §5.13 依赖持久化 env（NPM_CONFIG_PREFIX / PIP_TARGET / PIP_BREAK_SYSTEM_PACKAGES / MAO_DEPS_BIN）。
 * 另注入 pip 源覆盖（PIP_INDEX_URL，env 优先于镜像内 /etc/pip.conf）：镜像内置的 aliyun PyPI
 * 镜像对本环境 HTTP/1.1 连接限速约 200KB/s（pip 不支持 HTTP/2），pandas / matplotlib 等大包
 * 安装十分钟级、表现为工具反复等待超时；腾讯源同环境实测约 30MB/s（2026-11-16）。
 * 宿主机与容器路径逐字节一致（决策 15），shell 与 pty 子进程注入、MCP stdio env 共用。
 * PATH 注入由消费方拼接（MAO_DEPS_BIN 前置到现有 PATH），这里只给前缀根。
 */
export function buildDepsEnv(depsRoot: string, userId: number): Record<string, string> {
  // 这些路径在容器内消费（决策 15：宿主机与容器路径逐字节一致），固定 POSIX 语义：
  // Windows 开发机上 path.join/resolve 会产出盘符反斜杠路径，注入容器即失效。
  const depsUserDir = path.posix.join(path.posix.resolve(depsRoot), String(userId));
  return {
    NPM_CONFIG_PREFIX: path.posix.join(depsUserDir, 'npm'),
    PIP_TARGET: path.posix.join(depsUserDir, 'py'),
    PIP_BREAK_SYSTEM_PACKAGES: '1',
    MAO_DEPS_BIN: path.posix.join(depsUserDir, 'npm', 'bin'),
    PIP_INDEX_URL: 'https://mirrors.cloud.tencent.com/pypi/simple/',
    PIP_TRUSTED_HOST: 'mirrors.cloud.tencent.com',
  };
}
