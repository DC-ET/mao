import type { AppConfig } from './config/app-config.js';
import type { JwtService } from './crypto/jwt.service.js';
import type { SessionRepository } from './session/session.repository.js';
import type { MysqlUserRepository } from './user/user.repository.js';
import type { SystemSettingService } from './settings/settings.service.js';
import type { RuntimeDataResolver } from './harness/runtime/runtime-data-resolver.js';
import type { EnvVariableService } from './env/env-variable.service.js';
import type { SessionActivityHeartbeat } from './session/session-activity-heartbeat.js';
import type { McpClientManager } from './harness/mcp/mcp-client-manager.js';
import type { AppContext } from './create-app.js';
import type { SpawnPtyOptions, PtyLike } from './harness/terminal/remote-terminal.js';
import type { ShellEcpInjector, ShellLarkUatInjector } from './harness/tool/impl/shell-session-tool.js';

import { RuntimeChannelServer } from './harness/container/runtime-channel-server.js';
import { ContainerRegistry } from './harness/container/container-registry.js';
import { RuntimeModeResolver } from './harness/container/runtime-mode.js';
import { SessionEnvelopeBuilder, buildDepsEnv } from './harness/container/session-envelope-builder.js';
import { DockerToolRouter } from './harness/container/docker-tool-router.js';
import { DockerSendBytesBridge } from './harness/container/read-bytes-bridge.js';
import { RoutingMcpClientManager } from './harness/container/routing-mcp-client-manager.js';
import { PtyChannelHub } from './harness/container/pty-bridge.js';
import { isChannelWorkspace } from './harness/container/channel-workspace.js';
import { nodePtyFactory } from './harness/terminal/remote-terminal.js';
import { createContainerPtyFactory } from './app-utils.js';

export interface ContainerRuntimeDeps {
  cfg: AppConfig;
  ctx: AppContext;
  jwt: JwtService;
  sessionRepo: SessionRepository;
  userRepo: MysqlUserRepository;
  settingService: SystemSettingService;
  runtimeResolver: RuntimeDataResolver;
  gitLookup: { getTokenMapByUser: (userId: number) => Promise<Record<string, string>> };
  envVariableService: EnvVariableService;
  uploadDir: string;
  userSkillsDir: string;
  mcpClient: McpClientManager;
  activityHeartbeat: SessionActivityHeartbeat;
  ecpInjector: ShellEcpInjector;
  larkUatInjector: ShellLarkUatInjector;
}

export interface ContainerRuntimeResult {
  cloudRuntimeCfg: AppConfig['app']['cloudRuntime'];
  containerChannelHolder: { registry: ContainerRegistry | null };
  channelServer: RuntimeChannelServer;
  containerRegistry: ContainerRegistry;
  runtimeModeResolver: RuntimeModeResolver;
  activateContainerRuntime: () => Promise<void>;
  envelopeBuilder: SessionEnvelopeBuilder;
  dockerRouter: DockerToolRouter;
  sendBytesBridge: DockerSendBytesBridge;
  mcpRuntimeProbe: unknown;
  routingMcpClient: McpClientManager;
  ptyChannelHubs: Map<number, PtyChannelHub>;
  ptyHubGeneration: Map<number, number>;
  containerPtyFactory: (options: SpawnPtyOptions) => Promise<PtyLike>;
  bootRuntimeMode: string;
}

export async function assembleContainerRuntime(deps: ContainerRuntimeDeps): Promise<ContainerRuntimeResult> {
  const { cfg, ctx, jwt, sessionRepo, userRepo, settingService, runtimeResolver, gitLookup, envVariableService, uploadDir, userSkillsDir, mcpClient, activityHeartbeat, ecpInjector, larkUatInjector } = deps;

  const cloudRuntimeCfg = cfg.app.cloudRuntime;
  const containerChannelHolder: { registry: ContainerRegistry | null } = { registry: null };
  const channelServer = new RuntimeChannelServer({
    channelDir: cloudRuntimeCfg.container.channelDir,
    tokenOf: (userId): string => channelServer.issueToken(userId),
    onConnectionDead: (userId) => containerChannelHolder.registry?.markConnectionDead(userId),
    onRuntimeStatus: (userId, status) => containerChannelHolder.registry?.reportRuntimeStatus(userId, status),
  });
  const containerRegistry = new ContainerRegistry({
    config: cloudRuntimeCfg,
    workspaceRoot: cfg.app.harness.workspaceRoot,
    userHomeDir: cfg.app.harness.userHomeDir,
    runtimeDir: cfg.app.harness.runtimeDir,
    userSkillsDir,
    skillsDir: cfg.app.harness.skillsDir,
    uploadDir,
    ensureChannelListening: async (userId) => channelServer.ensureListening(userId),
    issueChannelToken: (userId) => channelServer.issueToken(userId),
    waitSocketReady: async (userId, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (channelServer.getConnection(userId)) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`容器运行时通道连接超时: userId=${userId} (${timeoutMs}ms)`);
    },
    requestShutdown: async (userId) => {
      const conn = channelServer.getConnection(userId);
      return conn ? conn.requestShutdown(5000) : false;
    },
    sessionWorkspacesOf: async (userId) => {
      const all = await sessionRepo.listWorkspacesByUser(userId).catch((e) => {
        console.debug(`Session workspace lookup skipped for user ${userId}: ${(e as Error).message}`);
        return [] as string[];
      });
      return all.filter((w) => isChannelWorkspace(w, cfg.app.harness.workspaceRoot));
    },
  });
  containerChannelHolder.registry = containerRegistry;
  const runtimeModeResolver = new RuntimeModeResolver({
    systemSettingService: settingService,
    fallbackMode: cloudRuntimeCfg.mode,
  });
  const activateContainerRuntime = async (): Promise<void> => {
    if (ctx.containerRuntimeActive) return;
    await containerRegistry.precheck();
    containerRegistry.startIdleLoop();
    ctx.containerRuntimeActive = true;
  };
  const envelopeBuilder = new SessionEnvelopeBuilder({
    runtimeResolver,
    gitCredentialService: gitLookup,
    jwtService: jwt,
    userLookup: { findById: (id: number) => userRepo.findById(id) as Promise<{ username?: string | null } | null> },
    ecpInjector,
    larkUatInjector,
    envVariableService,
  }, cloudRuntimeCfg.container.depsDir);
  const dockerRouter = new DockerToolRouter({
    containerRegistry,
    channelServer,
    envelopeBuilder,
    runtimeModeLookup: {
      runtimeModeOf: async (userId) => {
        const user = await userRepo.findById(userId).catch(() => null);
        const mode = user?.runtimeMode ?? null;
        return mode === 'docker' || mode === 'host' ? mode : null;
      },
    },
    globalMode: () => runtimeModeResolver.resolve(),
  });
  const sendBytesBridge = new DockerSendBytesBridge({
    router: dockerRouter,
    runtimeResolver,
    runtimeDir: cfg.app.harness.runtimeDir,
    uploadDir,
  });
  const mcpRuntimeProbe = {
    shouldHandle: async (sessionId: number): Promise<boolean> => {
      const session = await sessionRepo.findById(sessionId).catch(() => null);
      if (session?.userId == null) return false;
      return dockerRouter.enabledFor(session.userId);
    },
    userIdOf: async (sessionId: number): Promise<number | null> => {
      const session = await sessionRepo.findById(sessionId).catch(() => null);
      return session?.userId ?? null;
    },
  };
  const routingMcpClient = new RoutingMcpClientManager({
    host: mcpClient,
    router: dockerRouter,
    probe: mcpRuntimeProbe,
  }) as unknown as McpClientManager;
  const ptyChannelHubs = new Map<number, PtyChannelHub>();
  const ptyHubGeneration = new Map<number, number>();
  const containerPtyFactory = createContainerPtyFactory({
    dockerRouter, containerRegistry, channelServer, ptyChannelHubs, ptyHubGeneration, nodePtyFactory,
  });
  activityHeartbeat.onActivity((sessionId) => {
    void (async () => {
      const session = await sessionRepo.findById(sessionId).catch(() => null);
      if (session?.userId == null) return;
      if (!(await dockerRouter.enabledFor(session.userId))) return;
      await containerRegistry.ensureRunning(session.userId, session.workspace ?? null);
    })().catch((e) => {
      console.debug(`Container prewarm skipped for session ${sessionId}: ${(e as Error).message}`);
    });
  });
  const bootRuntimeMode = await runtimeModeResolver.resolve();
  if (bootRuntimeMode === 'docker') {
    try {
      await activateContainerRuntime();
    } catch (e) {
      const message = (e as Error).message;
      if (cloudRuntimeCfg.mode === 'docker') {
        console.error(`[container] 启动预检失败，请先安装 Docker 并构建运行时镜像: ${message}`);
        process.exit(1);
      }
      console.error(`[container] 全局运行时模式为 docker，但预检失败（可在管理后台「系统设置 → 运行环境」切回 host）: ${message}`);
    }
  }

  return {
    cloudRuntimeCfg,
    containerChannelHolder,
    channelServer,
    containerRegistry,
    runtimeModeResolver,
    activateContainerRuntime,
    envelopeBuilder,
    dockerRouter,
    sendBytesBridge,
    mcpRuntimeProbe,
    routingMcpClient,
    ptyChannelHubs,
    ptyHubGeneration,
    containerPtyFactory,
    bootRuntimeMode,
  };
}
