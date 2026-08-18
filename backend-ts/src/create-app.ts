import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail } from './common/result.js';
import { sendJson, handleError } from './common/http-error.js';
import { loadConfig, type AppConfig } from './config/app-config.js';
import { createPool, Db } from './db/db.js';
import { runFlywayIfEnabled } from './db/flyway.js';
import { JwtService } from './crypto/jwt.service.js';
import { hashPassword, matchesPassword } from './crypto/password.js';
import { authenticateRequest, isPublicPath } from './auth/jwt-hook.js';
import { AuthService } from './auth/auth.service.js';
import { LdapAuthService } from './auth/ldap-auth.service.js';
import { FeishuAuthService } from './auth/feishu-auth.service.js';
import { MysqlFeishuOauthStateRepository } from './auth/feishu-oauth.repository.js';
import { registerAuthRoutes } from './auth/auth.routes.js';
import { MysqlUserRepository } from './user/user.repository.js';
import { UserService } from './user/user.service.js';
import { registerUserRoutes } from './user/user.routes.js';
import { GitCredentialService, assertGitCredentialSecret } from './user/git-credential.service.js';
import { registerGitCredentialRoutes } from './user/git-credential.routes.js';
import {
  MysqlPermissionRepository,
  MysqlRolePermissionRepository,
  MysqlRoleRepository,
  MysqlUserRoleRepository,
} from './permission/permission.repository.js';
import { PermissionService } from './permission/permission.service.js';
import { registerPermissionRoutes } from './permission/permission.routes.js';
import { MysqlAgentExperienceRepository, MysqlAgentRepository, MysqlAgentTagRepository } from './agent/agent.repository.js';
import { AgentExperienceService } from './agent/agent-experience.service.js';
import { AgentService } from './agent/agent.service.js';
import { registerAgentRoutes } from './agent/agent.routes.js';
import { McpServerValidatorImpl, MysqlMcpServerLookup } from './agent/mcp-validator.js';
import { MysqlLlmModelRepository, MysqlSessionModelRepository } from './model/model.repository.js';
import { OpenAiChatClient } from './model/llm-chat.client.js';
import { ModelService } from './model/model.service.js';
import { registerModelRoutes } from './model/model.routes.js';
import { MysqlSystemSettingRepository } from './settings/settings.repository.js';
import { SystemSettingService } from './settings/settings.service.js';
import { registerSystemSettingRoutes } from './settings/settings.routes.js';
import { MysqlUserCommandRepository } from './command/command.repository.js';
import { UserCommandService } from './command/command.service.js';
import { registerCommandRoutes } from './command/command.routes.js';
import {
  MysqlUserTaskPanelPreferenceRepository,
  MysqlUserWeixinPreferenceRepository,
} from './preference/preference.repository.js';
import { UserWeixinPreferenceService } from './preference/weixin-preference.service.js';
import { UserTaskPanelPreferenceService } from './preference/task-panel-preference.service.js';
import { registerPreferenceRoutes } from './preference/preference.routes.js';
import { ToolService } from './tool/tool.service.js';
import { registerToolRoutes } from './tool/tool.routes.js';
import { MysqlAuditLogRepository } from './audit/audit.repository.js';
import { AuditLogService } from './audit/audit.service.js';
import { recordAudit } from './audit/audit.interceptor.js';
import { registerAuditLogRoutes } from './audit/audit.routes.js';
import { registerUploadRoutes } from './config/upload.routes.js';
import { PathSandbox } from './harness/safety/path-sandbox.js';
import { SessionRepository, MessageRepository, FileChangeRepository } from './session/session.repository.js';
import { SessionCompactionRepository, SessionCompactionEventRepository } from './session/session-compaction.repository.js';
import { SessionCompactionService } from './session/session-compaction.service.js';
import { SessionCompactionEventService } from './session/session-compaction-event.service.js';
import { GitOperationService } from './session/git-operation.service.js';
import { SessionService } from './session/session.service.js';
import { SessionTitleService } from './session/session-title.service.js';
import { ActivityService } from './session/activity.service.js';
import { SessionActivityRepository, SessionTodoRepository, SubagentExecutionRepository } from './session/activity.repository.js';
import { MessageQueueService } from './session/message-queue.service.js';
import { MessageQueueRepository } from './session/message-queue.repository.js';
import { registerSessionRoutes } from './session/session.routes.js';
import { registerAdminSessionRoutes } from './session/admin-session.routes.js';
import { SessionActivityHeartbeat } from './session/session-activity-heartbeat.js';
import { TaskTerminalService } from './session/task-terminal.service.js';
import { EnvironmentInfoProvider } from './harness/core/environment-info-provider.js';
import { FileEntityRepository, FileService } from './file/file.service.js';
import { WorkspaceBrowseService } from './file/workspace-browse.service.js';
import { WorkspaceGitService } from './file/workspace-git.service.js';
import { GitWriteOperationService } from './file/git-write-operation.service.js';
import { GitCommitMessageService } from './file/git-commit-message.service.js';
import { registerFileRoutes } from './file/file.routes.js';
import { OssStsService, createAliyunAssumeRoleClient, ossConfigFromApp } from './oss/oss-sts.service.js';
import { registerOssRoutes } from './oss/oss.routes.js';
import { registerSkillRoutes } from './skill/skill.routes.js';
import { UserSkillService } from './skill/user-skill.service.js';
import { SkillDocService } from './skill/skill-doc.service.js';
import { SkillSyncService } from './harness/skill/skill-sync-service.js';
import { SkillLoader } from './harness/skill/skill-loader.js';
import { ScheduledTaskDbStore } from './schedule/scheduled-task.store.js';
import { ScheduledTaskService, ScheduledTaskScheduler } from './schedule/scheduled-task.service.js';
import { registerScheduledTaskRoutes } from './schedule/scheduled-task.routes.js';
import { AnalyticsDbStore, AnalyticsService } from './analytics/analytics.service.js';
import { registerAnalyticsRoutes } from './analytics/analytics.routes.js';
import { StatisticsDbStore, StatisticsService } from './statistics/statistics.service.js';
import { registerStatisticsRoutes } from './statistics/statistics.routes.js';
import { AdminAnalyticsDbStore, AdminAnalyticsService } from './admin/admin-analytics.service.js';
import { registerAdminAnalyticsRoutes, registerAdminRuntimeRoutes } from './admin/admin.routes.js';
import { McpSecretCipher } from './harness/mcp/crypto/mcp-secret-cipher.js';
import { McpServerMapper, UserMcpPreferenceMapper } from './harness/mcp/mapper/mcp-server.mapper.js';
import { UserMcpPreferenceService } from './harness/mcp/preference/service/user-mcp-preference.service.js';
import { McpServerService } from './harness/mcp/service/mcp-server.service.js';
import { McpClientManager } from './harness/mcp/mcp-client-manager.js';
import { McpToolsRegistry } from './harness/mcp/local/mcp-tools-registry.js';
import { McpSyncService } from './harness/mcp/local/mcp-sync-service.js';
import { registerMcpServerRoutes } from './harness/mcp/controller/mcp-server.routes.js';
import { OpenAiLlmAdapter } from './harness/llm/openai-llm-adapter.js';
import { createDefaultToolRegistry } from './harness/tool/tool-registry.js';
import { ToolDispatcher } from './harness/tool/tool-dispatcher.js';
import { DangerAssessor } from './harness/tool/danger-assessor.js';
import { AskUserQuestionsRegistry } from './harness/tool/ask-user-questions-registry.js';
import { AgentLoop } from './harness/core/agent-loop.js';
import { HarnessService } from './harness/core/harness-service.js';
import { PromptEngine } from './harness/core/prompt-engine.js';
import { ContextManager } from './harness/core/context-manager.js';
import { CompactionService } from './harness/core/compaction-service.js';
import { SessionCompactionOrchestrator } from './harness/core/session-compaction-orchestrator.js';
import { SessionHistoryLoader } from './harness/core/session-history-loader.js';
import { TokenEstimator } from './harness/core/token-estimator.js';
import { ActiveContextCalculator } from './harness/core/active-context-calculator.js';
import { BackgroundTaskManager } from './harness/core/background-task-manager.js';
import { CompactionConfig } from './harness/core/compaction-config.js';
import { CrashRecoveryRunner } from './harness/core/crash-recovery-runner.js';
import { createAgentExecutor } from './harness/core/agent-executor.js';
import { LocalAgentsMdRegistry } from './harness/core/local-agents-md-registry.js';
import { RuntimeDataResolver } from './harness/runtime/runtime-data-resolver.js';
import { ShellSessionManager, OutputManager } from './harness/shell/shell-session-manager.js';
import { SessionTodoMapper } from './harness/todo/session-todo.mapper.js';
import { LocalSkillRegistry } from './harness/skill/local-skill-registry.js';
import { LocalToolSessionRegistry } from './harness/local/local-tool-session-registry.js';
import { LocalToolExecutor } from './harness/local/local-tool-executor.js';
import { AgentDefinitionRegistry } from './harness/delegate/agent-definition-registry.js';
import { SubagentExecutionMapper } from './harness/delegate/subagent-execution.mapper.js';
import { SubAgentVisibilityService } from './harness/delegate/subagent-visibility-service.js';
import { SubagentInvocationService } from './harness/delegate/subagent-invocation.service.js';
import { SubagentResultDeliveryService } from './harness/delegate/subagent-result-delivery.service.js';
import { BackgroundSubagentManager } from './harness/delegate/background-subagent-manager.js';
import { SubagentExecutionRecoveryService } from './harness/delegate/subagent-execution-recovery.service.js';
import { SubagentRecoveryCoordinator } from './harness/delegate/subagent-recovery-coordinator.js';
import { lazyRef } from './common/lazy-ref.js';
import { ApprovalRegistry } from './harness/approval/approval-registry.js';
import { SessionTreeSignalPublisher } from './harness/approval/session-tree-signal-publisher.js';
import { StreamingWsRegistry } from './session/ws/streaming-ws-registry.js';
import { StreamingWsHandler } from './session/ws/streaming-ws-handler.js';
import { attachWebSocket } from './session/ws/attach-websocket.js';
import { WeixinAccountRepository } from './weixin/account.repository.js';
import { ContextTokenRepository } from './weixin/context-token.repository.js';
import { WeixinMonitorService } from './weixin/monitor.service.js';
import { QrLoginService } from './weixin/qr-login.service.js';
import { registerWeixinBotRoutes } from './weixin/weixin.routes.js';
import { DEFAULT_WEIXIN_BOT_CONFIG, type WeixinBotConfig } from './weixin/types.js';
import { WeixinSendService } from './weixin/send.service.js';
import { WeixinMediaUploadService } from './weixin/media-upload.service.js';
import { WeixinMediaService } from './weixin/media.service.js';
import { WeixinMediaToolSupport } from './weixin/media-tool-support.js';
import { WeixinVoiceCodecService } from './weixin/voice-codec.service.js';
import { WeixinVoiceSynthesisService } from './weixin/voice-synthesis.service.js';
import { WeixinVoiceReplyService } from './weixin/voice-reply.service.js';
import { WeixinFileStorageService } from './weixin/file-storage.service.js';
import { WeixinSessionService } from './weixin/session.service.js';
import { InboundProcessor } from './weixin/inbound-processor.js';
import { AgentWeixinInboundHandler } from './weixin/agent-inbound-handler.js';
import { createWechatToolBridges } from './weixin/wechat-tool-bridge.js';
import { registerTaskNotificationPreferenceRoutes } from './notification/task/preference.routes.js';
import { TaskNotificationPreferenceService } from './notification/task/preference.service.js';
import { PreferenceDbStore, DeliveryDbStore } from './notification/task/stores.js';
import { WebhookSecretCipher } from './notification/task/webhook-secret-cipher.js';
import { WebhookDeliveryScheduler, DeliverySchedulerDbStore } from './notification/task/delivery.scheduler.js';
import { TaskNotificationDeliveryService } from './notification/task/delivery.service.js';
import { WebhookSenderRegistry, DingTalkWebhookSender, FeishuWebhookSender } from './notification/task/webhook-sender.js';
import { WebhookUrlValidator } from './notification/task/webhook-url-validator.js';
import { LlmUsageRepository, LlmUsageService } from './usage/llm-usage.service.js';

export interface MaoApp {
  app: FastifyInstance;
  close(): Promise<void>;
}

export async function registerUploadStatic(app: FastifyInstance, uploadDir: string, apiPrefix: string): Promise<void> {
  await app.register(fastifyStatic, { root: uploadDir, prefix: '/uploads/', decorateReply: false });
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: `${apiPrefix.replace(/\/$/, '')}/uploads/`,
    decorateReply: false,
  });
}

export async function createMaoApp(cfg: AppConfig = loadConfig(), existing?: FastifyInstance): Promise<MaoApp> {
  assertGitCredentialSecret(cfg.app.gitCredential.secretKey);
  await runFlywayIfEnabled(cfg);
  const pool = createPool(cfg);
  const db = new Db(pool);
  const app = existing ?? Fastify({ logger: true, bodyLimit: 52 * 1024 * 1024 });
  const hasher = { hash: hashPassword, matches: matchesPassword };
  const jwt = new JwtService(cfg.jwt.secret, cfg.jwt.expiration, cfg.jwt.refreshExpiration, cfg.jwt.shellExpiration);

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: '*',
    maxAge: 3600,
  });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 500 } });
  const apiPrefix = cfg.server.servlet.contextPath || '/api';
  const uploadDir = resolve(expandHome(cfg.app.file.uploadDir));
  mkdirSync(uploadDir, { recursive: true });
  await registerUploadStatic(app, uploadDir, apiPrefix);
  await app.register(swagger, {
    openapi: { info: { title: 'Mao API', version: '0.1.0' } },
  });
  await app.register(swaggerUi, { routePrefix: '/swagger-ui' });

  const userRepo = new MysqlUserRepository(db);
  const roleRepo = new MysqlRoleRepository(db);
  const permRepo = new MysqlPermissionRepository(db);
  const rolePermRepo = new MysqlRolePermissionRepository(db);
  const userRoleRepo = new MysqlUserRoleRepository(db);
  const permissionService = new PermissionService(roleRepo, permRepo, rolePermRepo, userRoleRepo, userRepo);
  const userService = new UserService(userRepo, permissionService, hasher);
  const ldap = new LdapAuthService(userRepo, userRoleRepo, jwt, cfg.ldap);
  const authService = new AuthService(userRepo, jwt, hasher, ldap, permissionService);
  const feishu = new FeishuAuthService(
    userRepo, userRoleRepo, new MysqlFeishuOauthStateRepository(db), jwt, cfg.feishu,
  );
  const gitCredentials = new GitCredentialService(db, cfg.app.gitCredential.secretKey);
  const gitLookup = {
    getTokenMapByUser: async (userId: number) => Object.fromEntries(await gitCredentials.getTokenMapByUser(userId)),
  };

  const auditRepo = new MysqlAuditLogRepository(db);
  const auditService = new AuditLogService(auditRepo);

  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    const userId = authenticateRequest(request, jwt);
    if (userId != null) request.userId = userId;
    if (!isPublicPath(request.method, request.url) && userId == null) {
      sendJson(reply, 401, fail(1001, '未登录或登录已过期'));
    }
  });
  app.setErrorHandler(handleError);
  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0].replace(/^\/api/, '');
    const user = request.userId != null ? await userRepo.findById(request.userId).catch(() => null) : null;
    void recordAudit(auditService, {
      method: request.method,
      path,
      queryString: request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : undefined,
      ip: request.ip,
      status: reply.statusCode,
      userId: request.userId,
      username: user?.username,
    });
  });

  const agentRepo = new MysqlAgentRepository(db);
  const experienceService = new AgentExperienceService(new MysqlAgentExperienceRepository(db));
  const agentService = new AgentService(agentRepo, new MysqlAgentTagRepository(db), experienceService);
  const modelRepo = new MysqlLlmModelRepository(db);
  const modelService = new ModelService(
    modelRepo,
    new MysqlSessionModelRepository(db),
    new OpenAiChatClient({ timeoutMs: cfg.app.harness.llm.callTimeoutSeconds * 1000 }),
  );

  const settingService = new SystemSettingService(
    new MysqlSystemSettingRepository(db),
    { findById: (id) => agentRepo.findById(id) },
    { findById: (id) => modelRepo.findById(id) },
    {
      workspaceRoot: cfg.app.harness.workspaceRoot,
      skillsDir: cfg.app.harness.skillsDir,
      ldapEnabled: cfg.ldap.enabled,
      ldapUrl: cfg.ldap.url,
      feishuEnabled: cfg.feishu.enabled,
      feishuAppId: cfg.feishu.appId,
    },
  );
  const commandService = new UserCommandService(new MysqlUserCommandRepository(db));
  const weixinPref = new UserWeixinPreferenceService(new MysqlUserWeixinPreferenceRepository(db));
  const taskPanelPref = new UserTaskPanelPreferenceService(new MysqlUserTaskPanelPreferenceRepository(db));

  const pathSandbox = new PathSandbox(cfg.app.harness.workspaceRoot);
  const sessionRepo = new SessionRepository(db);
  const messageRepo = new MessageRepository(db);
  const fileChangeRepo = new FileChangeRepository(db);
  const compactionRepo = new SessionCompactionRepository(db);
  const sessionCompactionService = new SessionCompactionService(compactionRepo, messageRepo, sessionRepo);
  const sessionCompactionEventService = new SessionCompactionEventService(new SessionCompactionEventRepository(db));
  const envInfo = new EnvironmentInfoProvider();
  const gitOps = new GitOperationService(gitLookup);
  const todoMapper = new SessionTodoMapper(db);
  const todoRepo = new SessionTodoRepository(db);
  const sessionService = new SessionService(
    sessionRepo, messageRepo, fileChangeRepo,
    {
      findById: (id) => agentRepo.findById(id) as never,
      findByIds: (ids) => agentRepo.findByIds(ids) as never,
      requireDefaultAgent: () => agentService.requireDefaultAgent() as never,
      listOptions: async () => (await agentRepo.selectList()).map((a) => ({ id: a.id!, name: a.name })),
    },
    pathSandbox, envInfo, commandService, gitOps, sessionCompactionService, sessionCompactionEventService, todoRepo,
  );
  const sessionSvc = sessionService as never;
  const sessionMap = sessionRepo as never;
  const compactionSvc = sessionCompactionService as never;

  const activityService = new ActivityService(new SessionActivityRepository(db));
  const messageQueueService = new MessageQueueService(new MessageQueueRepository(db));
  const subagentExecutionRepo = new SubagentExecutionRepository(db);
  const activityHeartbeat = new SessionActivityHeartbeat(sessionService);

  const fileRepo = new FileEntityRepository(db);
  const fileService = new FileService(fileRepo, uploadDir, cfg.app.file.maxSizeMb);
  const workspaceBrowse = new WorkspaceBrowseService(pathSandbox);
  const workspaceGit = new WorkspaceGitService(pathSandbox);

  const ossConfig = ossConfigFromApp(cfg);
  const ossClient = await createAliyunAssumeRoleClient(ossConfig.sts).catch(() => ({
    assumeRole: async () => {
      throw new Error('OSS STS 客户端不可用');
    },
  }));
  const ossSts = new OssStsService(ossConfig, ossClient);

  const userSkillsDir = cfg.app.harness.userSkillsDir || resolve(process.env.HOME ?? '/tmp', '.mao/data/userskills');
  const skillLoader = new SkillLoader(pathSandbox, cfg.app.harness.skillsDir, cfg.app.harness.skillsCacheSeconds);
  const runtimeResolver = new RuntimeDataResolver(cfg.app.harness.runtimeDir, cfg.app.harness.userHomeDir);
  const skillSync = new SkillSyncService(skillLoader, pathSandbox, runtimeResolver, userSkillsDir);
  const userSkillService = new UserSkillService(userSkillsDir);
  const skillDocService = new SkillDocService(skillLoader);

  const weixinConfig: WeixinBotConfig = {
    ...DEFAULT_WEIXIN_BOT_CONFIG,
    enabled: cfg.weixin.bot.enabled,
    voiceReply: cfg.weixin.bot.voiceReply,
    silkEncoderPath: cfg.weixin.bot.silkEncoderPath,
    ffmpegPath: cfg.weixin.bot.ffmpegPath,
    voiceMaxSeconds: cfg.weixin.bot.voiceMaxSeconds,
    ilinkBaseUrl: cfg.weixin.bot.ilinkBaseUrl,
    cdnBaseUrl: cfg.weixin.bot.cdnBaseUrl || DEFAULT_WEIXIN_BOT_CONFIG.cdnBaseUrl,
    maxInboundFileMb: cfg.weixin.bot.maxInboundFileMb,
    monitor: cfg.weixin.bot.monitor,
  };
  const weixinAccounts = new WeixinAccountRepository(db);
  const weixinTokens = new ContextTokenRepository(db);
  const weixinSend = new WeixinSendService(weixinAccounts, weixinTokens);
  const weixinUpload = new WeixinMediaUploadService(weixinConfig);
  const weixinMedia = new WeixinMediaService(weixinConfig);
  const weixinToolSupport = new WeixinMediaToolSupport(weixinAccounts, weixinTokens, pathSandbox);
  const wechatBridges = createWechatToolBridges(
    weixinToolSupport, weixinUpload, weixinSend, weixinAccounts, weixinTokens,
  );

  const mcpCipher = new McpSecretCipher(cfg.app.mcp.secretKey);
  const mcpMapper = new McpServerMapper(db);
  const mcpPref = new UserMcpPreferenceService(new UserMcpPreferenceMapper(db));
  const mcpServerService = new McpServerService(mcpMapper, mcpCipher, mcpPref, userRepo, {
    selectById: (id) => agentRepo.findById(id),
    listAll: () => agentRepo.selectList(),
    selectList: () => agentRepo.selectList(),
  });
  const mcpClient = new McpClientManager(cfg.app.mcp.clientTimeoutSeconds);
  const mcpToolsRegistry = new McpToolsRegistry();
  const mcpSync = new McpSyncService(mcpMapper, mcpServerService, mcpToolsRegistry, mcpPref);

  const llmAdapter = new OpenAiLlmAdapter({
    rateLimitMaxRetries: cfg.app.harness.llm.rateLimitMaxRetries,
    rateLimitRetryDelaySeconds: cfg.app.harness.llm.rateLimitRetryDelaySeconds,
    rateLimitMaxRetryDelaySeconds: cfg.app.harness.llm.rateLimitMaxRetryDelaySeconds,
    callTimeoutSeconds: cfg.app.harness.llm.callTimeoutSeconds,
    httpCallTimeoutSeconds: cfg.app.harness.llm.httpCallTimeoutSeconds,
    streamIdleTimeoutSeconds: cfg.app.harness.llm.streamIdleTimeoutSeconds,
  });
  const promptEngine = new PromptEngine(skillLoader, pathSandbox, runtimeResolver, commandService, skillSync);
  const tokenEstimator = new TokenEstimator();
  const compactionService = new CompactionService(llmAdapter, tokenEstimator);
  const contextManager = new ContextManager(tokenEstimator, compactionService);
  const compactionConfig = new CompactionConfig();
  compactionConfig.enabled = cfg.app.harness.compaction.enabled;
  compactionConfig.contextWindowTokens = cfg.app.harness.compaction.contextWindowTokens;
  compactionConfig.triggerRatio = cfg.app.harness.compaction.triggerRatio;
  compactionConfig.maxSummaryTokens = cfg.app.harness.compaction.maxSummaryTokens;
  compactionConfig.loopMidwayCompact = cfg.app.harness.compaction.loopMidwayCompact;
  const historyLoader = new SessionHistoryLoader(sessionSvc, contextManager);
  const activeContext = new ActiveContextCalculator(tokenEstimator);
  const orchestrator = new SessionCompactionOrchestrator(
    compactionSvc, sessionCompactionEventService, historyLoader,
    contextManager, sessionSvc, activeContext, promptEngine,
  );
  const backgroundTasks = new BackgroundTaskManager();
  const shellManager = new ShellSessionManager(
    pathSandbox, runtimeResolver,
    cfg.app.harness.shell.maxSessionsPerConversation,
    cfg.app.harness.shell.sessionIdleTimeoutMinutes,
    cfg.app.harness.shell.sessionMaxLifetimeHours,
  );
  const outputManager = new OutputManager(
    cfg.app.harness.shell.output.maxPreviewLines,
    cfg.app.harness.shell.output.maxPreviewChars,
  );
  const localSkills = new LocalSkillRegistry();
  const localAgentsMd = new LocalAgentsMdRegistry();
  const wsRegistry = new StreamingWsRegistry(cfg.app.ws.outboundQueueCapacity);
  const localToolSessions = new LocalToolSessionRegistry(wsRegistry, sessionMap);
  const definitionRegistry = new AgentDefinitionRegistry();
  const subagentMapper = new SubagentExecutionMapper(db);
  const subagentInvocation = new SubagentInvocationService(db);
  const subagentResultDelivery = new SubagentResultDeliveryService(db, fileChangeRepo as never);
  const askUserQuestionsRegistry = new AskUserQuestionsRegistry();
  const approvalRegistry = new ApprovalRegistry(sessionSvc, sessionMap, wsRegistry);
  const treeSignalPublisher = new SessionTreeSignalPublisher(
    sessionRepo, approvalRegistry, askUserQuestionsRegistry, wsRegistry,
  );
  const localToolExecutor = new LocalToolExecutor(
    localToolSessions, approvalRegistry, treeSignalPublisher, cfg.app.harness.localToolTimeoutSeconds,
  );
  const dangerAssessor = new DangerAssessor(llmAdapter);
  const agentExecutor = createAgentExecutor(
    cfg.app.harness.agentThreadPoolSize,
    cfg.app.harness.agentThreadPoolMax,
    cfg.app.harness.agentThreadPoolQueue,
  );

  const holder: { harness?: HarnessService; loop?: AgentLoop } = {};
  const scheduledStore = new ScheduledTaskDbStore(db);

  const notifCipher = new WebhookSecretCipher(cfg.app.taskNotification.secretKey);
  const senderRegistry = new WebhookSenderRegistry([new DingTalkWebhookSender(), new FeishuWebhookSender()]);
  const urlValidator = new WebhookUrlValidator();
  const notifPref = new TaskNotificationPreferenceService(
    new PreferenceDbStore(db), notifCipher, urlValidator, senderRegistry,
  );
  const deliveryService = new TaskNotificationDeliveryService(
    new DeliveryDbStore(db), notifPref, messageQueueService as never,
  );
  const taskTerminal = new TaskTerminalService(
    sessionService, wsRegistry, deliveryService, treeSignalPublisher, (fn) => agentExecutor.submit(fn),
  );
  const visibility = new SubAgentVisibilityService({
    registry: wsRegistry,
    activityService: activityService as never,
    activityHeartbeat,
    sessionTodoMapper: todoMapper,
    sessionService: sessionService as never,
    taskTerminalService: taskTerminal,
    llmModelLookup: modelRepo,
    harnessService: lazyRef(() => holder.harness!),
  });

  const backgroundSubagentManager = new BackgroundSubagentManager({
    definitionRegistry,
    harnessService: () => holder.harness!,
    agentLoop: () => holder.loop!,
    sessionMapper: sessionMap,
    sessionService: sessionSvc,
    subagentExecutionMapper: subagentMapper,
    subagentInvocationService: subagentInvocation,
    localToolSessionRegistry: localToolSessions,
    visibilityService: visibility,
    agentExecutor,
    fileChangeRepo: fileChangeRepo as never,
  });

  const scheduledService = new ScheduledTaskService(
    scheduledStore,
    sessionService as never,
    messageQueueService as never,
    {
      executeFromEvent: (sessionId, executionId, listener) => holder.harness!.executeFromEvent(sessionId, executionId, listener as never),
    },
    taskTerminal,
    weixinSend,
    weixinAccounts as never,
    weixinTokens as never,
    (fn) => agentExecutor.submit(fn),
  );

  const toolRegistry = createDefaultToolRegistry({
    pathSandbox,
    sessionTodoMapper: todoMapper,
    scheduledTaskService: scheduledService,
    sessionService: sessionSvc,
    sessionMapper: sessionMap,
    shellSessionManager: shellManager,
    outputManager,
    backgroundTaskManager: backgroundTasks,
    gitCredentialService: gitLookup,
    jwtService: jwt,
    shellUserLookup: { findById: (id: number) => userRepo.findById(id) },
    tavily: cfg.app.harness.tavily,
    webPage: cfg.app.harness.webPage,
    imageModelLookup: modelService,
    uploadDir,
    imageBaseUrl: cfg.app.upload.baseUrl,
    weixinToolSupport: wechatBridges.toolSupport,
    weixinUploadService: wechatBridges.uploadService,
    weixinSendService: wechatBridges.sendService,
    definitionRegistry,
    get harnessService() { return holder.harness!; },
    get agentLoop() { return holder.loop!; },
    subagentExecutionMapper: subagentMapper,
    subagentInvocationService: subagentInvocation,
    localToolSessionRegistry: localToolSessions,
    visibilityService: visibility,
    backgroundSubagentManager,
    messageMapper: messageRepo as never,
    sessionCompactionService: compactionSvc,
  });

  const toolDispatcher = new ToolDispatcher(
    toolRegistry, localToolExecutor, dangerAssessor, sessionMap,
    wsRegistry, askUserQuestionsRegistry, localToolSessions, treeSignalPublisher,
  );
  const agentLoop = new AgentLoop(
    llmAdapter, promptEngine, contextManager, toolDispatcher, backgroundTasks,
    shellManager, activityHeartbeat, sessionSvc, orchestrator, activeContext, mcpClient,
    () => backgroundSubagentManager,
  );
  holder.loop = agentLoop;
  const harness = new HarnessService(
    agentLoop, toolRegistry, skillLoader, skillSync, localSkills, localAgentsMd,
    sessionMap, agentRepo as never, experienceService, modelRepo as never, fileChangeRepo as never,
    sessionSvc, compactionSvc, historyLoader, orchestrator,
    promptEngine, activeContext, compactionConfig, envInfo, db, mcpClient, mcpSync,
  );
  holder.harness = harness;

  const sessionTitleService = new SessionTitleService(
    sessionRepo,
    messageRepo,
    commandService,
    llmAdapter,
    {
      selectById: (id: number) => modelRepo.findById(id),
      selectDefault: () => modelRepo.findDefault(),
    },
    { getValue: (key: string) => settingService.getValue(key) },
    wsRegistry,
    (fn) => agentExecutor.submit(fn),
  );

  const usageService = new LlmUsageService(new LlmUsageRepository(db));
  const gitCommitMsg = new GitCommitMessageService(llmAdapter as never, harness as never, usageService);
  const gitWrite = new GitWriteOperationService(
    workspaceGit, gitCommitMsg, gitLookup, runtimeResolver, activityService,
  );

  const weixinSession = new WeixinSessionService(
    sessionService, sessionRepo, agentService, modelService, settingService,
  );
  const voiceSynthesis = new WeixinVoiceSynthesisService(modelService, llmAdapter, weixinConfig);
  const voiceCodec = new WeixinVoiceCodecService(weixinConfig);
  const voiceReply = new WeixinVoiceReplyService(
    weixinConfig, weixinAccounts, weixinPref, voiceSynthesis, voiceCodec, weixinUpload, weixinSend,
  );
  const weixinFiles = new WeixinFileStorageService(weixinConfig);
  const weixinInboundHandler = new AgentWeixinInboundHandler({
    weixinSessionService: weixinSession,
    harnessService: harness as never,
    sessionService: sessionService as never,
    accountRepository: weixinAccounts,
    agentLoop,
    shellSessionManager: shellManager,
    registry: wsRegistry,
    taskTerminalService: taskTerminal,
    activityService: activityService as never,
    activityHeartbeat,
    sessionTodoMapper: todoMapper,
    modelService,
    weixinFileStorageService: weixinFiles,
    agentExecutor: (fn) => agentExecutor.submit(fn),
  });
  const inboundProcessor = new InboundProcessor(
    weixinInboundHandler, weixinTokens, weixinSend, weixinMedia, voiceReply,
  );
  const weixinMonitor = new WeixinMonitorService(weixinConfig, weixinAccounts, inboundProcessor);
  const qrLogin = new QrLoginService(weixinConfig, weixinAccounts, weixinMonitor);

  const restToolService = new ToolService({
    getAllTools: () => toolRegistry.getAllTools().map((t) => ({ name: t.getName(), description: t.getDescription() })),
    getTool: (name) => {
      const t = toolRegistry.getTool(name);
      return t ? { name: t.getName(), description: t.getDescription() } : null;
    },
  });

  const wsHandler = new StreamingWsHandler({
    registry: wsRegistry,
    titleService: sessionTitleService,
    harnessService: harness,
    sessionService,
    taskTerminalService: taskTerminal,
    messageQueueService,
    localToolSessionRegistry: localToolSessions,
    askUserQuestionsRegistry,
    treeSignalPublisher,
    approvalRegistry,
    activityService,
    activityHeartbeat,
    sessionTodoMapper: todoMapper,
    agentLoop,
    backgroundSubagentManager,
    shellSessionManager: shellManager,
    skillSyncService: skillSync,
    localSkillRegistry: localSkills,
    localAgentsMdRegistry: localAgentsMd,
    mcpSyncService: mcpSync,
    mcpClientManager: mcpClient,
    agentMapper: { selectById: (id: number) => agentRepo.findById(id) },
    llmModelMapper: {
      selectById: (id: number) => modelRepo.findById(id),
      selectDefault: () => modelRepo.findDefault(),
    },
    jwtService: jwt,
    agentExecutor: (fn: () => Promise<void>) => agentExecutor.submit(fn),
    mcpSyncTimeoutSeconds: cfg.app.mcp.syncTimeoutSeconds,
  } as never);
  scheduledService.setLiveExecution((session, userId, executionId, saved) =>
    wsHandler.executePersistedUserPrompt(session, userId, executionId, saved));

  const analyticsService = new AnalyticsService(new AnalyticsDbStore(db));
  const statisticsService = new StatisticsService(new StatisticsDbStore(db));
  const adminAnalytics = new AdminAnalyticsService(statisticsService, new AdminAnalyticsDbStore(db));
  const mcpValidator = new McpServerValidatorImpl(new MysqlMcpServerLookup(db));

  await app.register(async (api) => {
    api.get('/swagger-ui.html', async (_req, reply) => reply.redirect(`${apiPrefix}/swagger-ui`));
    api.get('/v3/api-docs', async (_req, reply) => {
      return reply.send(app.swagger());
    });
    registerAuthRoutes(api, authService, feishu);
    registerUserRoutes(api, userService, userRepo, permissionService);
    registerPermissionRoutes(api, permissionService);
    registerGitCredentialRoutes(api, gitCredentials);
    registerAgentRoutes(api, {
      agentService, experienceService, userRepo, mcpServerValidator: mcpValidator,
    });
    registerModelRoutes(api, { modelService });
    registerSystemSettingRoutes(api, { systemSettingService: settingService });
    registerCommandRoutes(api, {
      userCommandService: commandService,
      agentService,
      skillLoader,
      skillSyncService: skillSync as never,
    });
    registerPreferenceRoutes(api, {
      weixinPreferenceService: weixinPref,
      taskPanelPreferenceService: taskPanelPref,
      weixinVoiceReplyDefault: cfg.weixin.bot.voiceReply,
    });
    registerToolRoutes(api, { toolService: restToolService });
    registerAuditLogRoutes(api, { auditLogService: auditService });
    registerUploadRoutes(api, cfg.app.upload.storageMode, cfg.app.upload.baseUrl);
    registerSessionRoutes(api, {
      sessionService, activityService, messageQueueService,
      agentLookup: {
        findById: (id: number) => agentRepo.findById(id),
        findByIds: (ids: number[]) => agentRepo.findByIds(ids),
        requireDefaultAgent: () => agentService.requireDefaultAgent(),
        listOptions: async () => (await agentRepo.selectList()).map((a) => ({ id: a.id!, name: a.name })),
      } as never,
      modelLookup: {
        findById: (id: number) => modelRepo.findById(id),
        findByIds: (ids: number[]) => modelRepo.findByIds(ids),
        findDefault: () => modelRepo.findDefault(),
      } as never,
      todoRepo,
      pathSandbox,
      subagentExecutionRepo,
      sessionCompactionEventService,
      approvalRegistry,
      askUserQuestionsRegistry,
      treeSignalPublisher,
    });
    registerAdminSessionRoutes(api, {
      sessionService,
      userLookup: {
        findByIds: (ids: number[]) => userRepo.findByIds(ids),
        listOptions: () => userRepo.listOptions(),
      } as never,
      agentLookup: {
        findById: (id: number) => agentRepo.findById(id),
        findByIds: (ids: number[]) => agentRepo.findByIds(ids),
        requireDefaultAgent: () => agentService.requireDefaultAgent(),
        listOptions: async () => (await agentRepo.selectList()).map((a) => ({ id: a.id!, name: a.name })),
      } as never,
      modelLookup: {
        findById: (id: number) => modelRepo.findById(id),
        findByIds: (ids: number[]) => modelRepo.findByIds(ids),
        findDefault: () => modelRepo.findDefault(),
      } as never,
    });
    registerFileRoutes(api, {
      fileService, sessionService, workspaceBrowseService: workspaceBrowse,
      workspaceGitService: workspaceGit, gitCommitMessageService: gitCommitMsg,
      gitWriteOperationService: gitWrite, pathSandbox, uploadBaseUrl: cfg.app.upload.baseUrl,
    });
    registerOssRoutes(api, { ossStsService: ossSts });
    registerSkillRoutes(api, {
      userSkillService, skillDocService, skillSyncService: skillSync,
      sessionService, agentService,
      agentLookup: {
        findById: (id: number) => agentRepo.findById(id),
        findByIds: (ids: number[]) => agentRepo.findByIds(ids),
        requireDefaultAgent: () => agentService.requireDefaultAgent(),
        listOptions: async () => (await agentRepo.selectList()).map((a) => ({ id: a.id!, name: a.name })),
      } as never,
    });
    registerScheduledTaskRoutes(api, { service: scheduledService, jwt, permission: permissionService });
    registerAnalyticsRoutes(api, { analytics: analyticsService, jwt });
    registerStatisticsRoutes(api, { statistics: statisticsService, jwt });
    const adminDeps = {
      jwt, analytics: adminAnalytics,
      sessionLister: sessionService as never,
    };
    registerAdminAnalyticsRoutes(api, adminDeps);
    registerAdminRuntimeRoutes(api, adminDeps);
    registerMcpServerRoutes(api, {
      mcpServerService, mcpClientManager: mcpClient, userMcpPreferenceService: mcpPref, permissionService,
    });
    registerWeixinBotRoutes(api, { jwt, qrLogin, accountRepository: weixinAccounts, monitorService: weixinMonitor });
    registerTaskNotificationPreferenceRoutes(api, { preference: notifPref, jwt });
    await attachWebSocket(api, { handler: wsHandler, idleTimeoutMs: cfg.app.ws.idleTimeoutMs });
  }, { prefix: apiPrefix });

  const scheduler = new ScheduledTaskScheduler(scheduledStore, scheduledService);
  scheduler.start();
  const deliveryScheduler = new WebhookDeliveryScheduler(
    new DeliverySchedulerDbStore(db),
    cfg.app.taskNotification,
    notifCipher,
    senderRegistry,
  );
  deliveryScheduler.start();
  weixinMonitor.start();
  shellManager.startCleanup();
  const subagentExecutionRecovery = new SubagentExecutionRecoveryService(
    subagentMapper, sessionMap, sessionSvc, compactionSvc, definitionRegistry,
    (childSession, definition) => backgroundSubagentManager.buildSubContext(childSession, definition),
    agentLoop, visibility, localToolSessions,
  );
  const subagentCoordinator = new SubagentRecoveryCoordinator(
    subagentMapper, subagentExecutionRecovery, subagentResultDelivery,
    sessionMap, sessionSvc, compactionSvc, agentExecutor,
  );
  const crash = new CrashRecoveryRunner(
    sessionMap, sessionSvc, taskTerminal, harness, agentLoop, wsRegistry,
    activityService as never, activityHeartbeat, todoMapper, modelRepo as never,
    cfg.app.harness.runtimeDir,
    agentExecutor,
    (sessionId, userId) => wsHandler.autoConsumeQueue(sessionId, userId),
    subagentCoordinator,
  );
  void crash.run().catch((e) => console.error('Crash recovery failed', e));

  return {
    app,
    async close() {
      scheduler.stop();
      deliveryScheduler.stop();
      shellManager.stopCleanup();
      weixinMonitor.shutdown();
      weixinInboundHandler.shutdown();
      wsRegistry.shutdown();
      await app.close();
      await db.close();
    },
  };
}

function expandHome(v: string): string {
  if (v.startsWith('$HOME')) return v.replace(/^\$HOME/, process.env.HOME ?? '');
  if (v.startsWith('~/')) return resolve(process.env.HOME ?? '', v.slice(2));
  return v;
}
