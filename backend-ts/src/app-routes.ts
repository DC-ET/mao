import type { FastifyInstance } from 'fastify';
import type { Db } from './db/db.js';
import type { AppConfig } from './config/app-config.js';
import type { JwtService } from './crypto/jwt.service.js';
import type { AuthService } from './auth/auth.service.js';
import type { FeishuAuthService } from './auth/feishu-auth.service.js';
import type { EcpAuthService } from './auth/ecp-auth.service.js';
import type { UserService } from './user/user.service.js';
import type { MysqlUserRepository } from './user/user.repository.js';
import type { PermissionService } from './permission/permission.service.js';
import type { GitCredentialService } from './user/git-credential.service.js';
import type { EnvVariableService } from './env/env-variable.service.js';
import type { SessionRepository } from './session/session.repository.js';
import type { UserToolService } from './user-tool/user-tool.service.js';
import type { MysqlUserToolRepository } from './user-tool/user-tool.repository.js';
import type { HttpApiExecutor } from './harness/tool/impl/http-api-executor.js';
import type { FileService } from './file/file.service.js';
import type { AgentService } from './agent/agent.service.js';
import type { AgentExperienceService } from './agent/agent-experience.service.js';
import type { AgentSuggestedQuestionService } from './agent/agent-suggested-question.service.js';
import type { AgentBundleService } from './agent/agent-bundle.service.js';
import type { McpServerValidatorImpl } from './agent/mcp-validator.js';
import type { ModelService } from './model/model.service.js';
import type { SystemSettingService } from './settings/settings.service.js';
import type { UserCommandService } from './command/command.service.js';
import type { SkillLoader } from './harness/skill/skill-loader.js';
import type { SkillSyncService } from './harness/skill/skill-sync-service.js';
import type { UserWeixinPreferenceService } from './preference/weixin-preference.service.js';
import type { UserTaskPanelPreferenceService } from './preference/task-panel-preference.service.js';
import type { ToolService } from './tool/tool.service.js';
import type { AuditLogService } from './audit/audit.service.js';
import type { LlmCallService } from './usage/llm-call.service.js';
import type { SessionService } from './session/session.service.js';
import type { ActivityService } from './session/activity.service.js';
import type { MessageQueueService } from './session/message-queue.service.js';
import type { MysqlAgentRepository } from './agent/agent.repository.js';
import type { MysqlLlmModelRepository } from './model/model.repository.js';
import type { SessionTodoRepository } from './session/activity.repository.js';
import type { PathSandbox } from './harness/safety/path-sandbox.js';
import type { SubagentExecutionRepository } from './session/activity.repository.js';
import type { SessionCompactionEventService } from './session/session-compaction-event.service.js';
import type { SessionCompactionService } from './session/session-compaction.service.js';
import type { RunTraceService } from './session/run-trace.service.js';
import type { ApprovalRegistry } from './harness/approval/approval-registry.js';
import type { AskUserQuestionsRegistry } from './harness/tool/ask-user-questions-registry.js';
import type { SessionTreeSignalPublisher } from './harness/approval/session-tree-signal-publisher.js';
import type { WorkspaceBrowseService } from './file/workspace-browse.service.js';
import type { TerminalManager } from './harness/terminal/terminal-manager.js';
import type { WorkspaceGitService } from './file/workspace-git.service.js';
import type { GitCommitMessageService } from './file/git-commit-message.service.js';
import type { GitWriteOperationService } from './file/git-write-operation.service.js';
import type { RuntimeDataResolver } from './harness/runtime/runtime-data-resolver.js';
import type { OssStsService } from './oss/oss-sts.service.js';
import type { SkillBundleService } from './skill/skill-bundle.service.js';
import type { UserSkillService } from './skill/user-skill.service.js';
import type { SkillDocService } from './skill/skill-doc.service.js';
import type { ScheduledTaskService } from './schedule/scheduled-task.service.js';
import type { OpenRunService } from './openapi/open-run.service.js';
import type { ApiTokenService } from './openapi/api-token.service.js';
import type { WebhookTriggerService } from './openapi/webhook-trigger.service.js';
import type { OutboundSubscriptionService } from './openapi/outbound-subscription.service.js';
import type { FixedWindowRateLimiter } from './openapi/rate-limiter.js';
import type { OpenApiCallLogService } from './openapi/open-api-call-log.service.js';
import type { WatcherService } from './signal/watcher.service.js';
import type { MysqlSignalWatcherRepository } from './signal/signal.repository.js';
import type { AnalyticsService } from './analytics/analytics.service.js';
import type { StatisticsService } from './statistics/statistics.service.js';
import type { FeedbackService } from './feedback/feedback.service.js';
import type { MemoryService } from './memory/memory.service.js';
import type { ApprovalRuleService } from './approval-rule/approval-rule.service.js';
import type { InboxService } from './inbox/inbox.service.js';
import type { DigestService } from './digest/service.js';
import type { BudgetService } from './budget/budget.service.js';
import type { AdminAnalyticsService } from './admin/admin-analytics.service.js';
import type { AdminAnalyticsDbStore } from './admin/admin-analytics.service.js';
import type { MysqlUserCommandRepository } from './command/command.repository.js';
import type { McpServerService } from './harness/mcp/service/mcp-server.service.js';
import type { McpClientManager } from './harness/mcp/mcp-client-manager.js';
import type { UserMcpPreferenceService } from './harness/mcp/preference/service/user-mcp-preference.service.js';
import type { UserMcpLoadModeService } from './harness/mcp/preference/service/user-mcp-load-mode.service.js';
import type { McpLoadModeResolver } from './harness/mcp/workingset/mcp-load-mode.js';
import type { QrLoginService } from './weixin/qr-login.service.js';
import type { WeixinAccountRepository } from './weixin/account.repository.js';
import type { WeixinMonitorService } from './weixin/monitor.service.js';
import type { MysqlFeishuBotRepository } from './feishu/feishu_bot.repository.js';
import type { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';
import type { FeishuMonitorService } from './feishu/monitor.service.js';
import type { TaskNotificationPreferenceService } from './notification/task/preference.service.js';
import type { StreamingWsHandler } from './session/ws/streaming-ws-handler.js';
import type { TerminalWsHandler } from './harness/terminal/terminal-ws-handler.js';
import type { RuntimeModeResolver } from './harness/container/runtime-mode.js';
import { validateRuntimeModeSave, RUNTIME_MODE_SETTING_KEY } from './harness/container/runtime-mode.js';

import { sendOk } from './common/http-error.js';
import { registerAuthRoutes } from './auth/auth.routes.js';
import { registerEcpAuthRoutes } from './auth/ecp.routes.js';
import { registerCompanySsoRoutes } from './auth/company-sso.routes.js';
import { CompanySsoService } from './auth/company-sso.service.js';
import { CompanySsoClient } from './auth/company-sso.client.js';
import { CompanySsoIdentityRepository } from './auth/company-sso-identity.repository.js';
import { CompanySsoError } from './auth/company-sso.error.js';
import { registerUserRoutes } from './user/user.routes.js';
import { registerPermissionRoutes } from './permission/permission.routes.js';
import { registerAdminGitCredentialRoutes, registerGitCredentialRoutes } from './user/git-credential.routes.js';
import { registerAdminEnvVariableRoutes, registerEnvVariableRoutes } from './env/env-variable.routes.js';
import { registerUserToolRoutes } from './user-tool/user-tool.routes.js';
import { registerAdminUserToolRoutes } from './user-tool/user-tool-admin.routes.js';
import { registerAgentAvatarRoutes } from './agent/agent-avatar.js';
import { registerAgentRoutes } from './agent/agent.routes.js';
import { registerAgentBundleRoutes } from './agent/agent-bundle.routes.js';
import { registerModelRoutes } from './model/model.routes.js';
import { registerSystemSettingRoutes } from './settings/settings.routes.js';
import { registerEmbedRoutes } from './embed/embed.routes.js';
import { registerCommandRoutes } from './command/command.routes.js';
import { registerPreferenceRoutes } from './preference/preference.routes.js';
import { registerToolRoutes } from './tool/tool.routes.js';
import { registerAuditLogRoutes } from './audit/audit.routes.js';
import { registerLlmCallRoutes } from './usage/llm-call.routes.js';
import { registerUploadRoutes } from './config/upload.routes.js';
import { registerSessionRoutes } from './session/session.routes.js';
import { registerSessionShareRoutes } from './session/session-share.routes.js';
import { MysqlSessionShareRepository } from './session/session-share.repository.js';
import { SessionShareService } from './session/session-share.service.js';
import { SessionExportService } from './session/session-export.service.js';
import { registerAdminSessionRoutes } from './session/admin-session.routes.js';
import { registerAdminSessionFilesRoutes } from './session/admin-session-files.routes.js';
import { registerTerminalRoutes } from './session/terminal.routes.js';
import { WorkspaceWriteService } from './file/workspace-write.service.js';
import { registerFileRoutes } from './file/file.routes.js';
import { registerOssRoutes } from './oss/oss.routes.js';
import { registerSkillBundleRoutes } from './skill/skill-bundle.routes.js';
import { registerSkillRoutes } from './skill/skill.routes.js';
import { registerScheduledTaskRoutes } from './schedule/scheduled-task.routes.js';
import { registerOpenApiRoutes } from './openapi/open.routes.js';
import { registerOpenApiCallLogRoutes } from './openapi/open-api-call-log.routes.js';
import { registerSignalWatcherRoutes } from './signal/watcher.routes.js';
import { registerSignalAdminRoutes } from './signal/signal-admin.routes.js';
import { registerAnalyticsRoutes } from './analytics/analytics.routes.js';
import { registerStatisticsRoutes } from './statistics/statistics.routes.js';
import { registerFeedbackRoutes } from './feedback/feedback.routes.js';
import { registerMemoryRoutes } from './memory/memory.routes.js';
import { registerApprovalRuleRoutes, type ApprovalRuleAuditInput } from './approval-rule/approval-rule.routes.js';
import { registerApprovalRuleAdminRoutes } from './approval-rule/approval-rule.admin.routes.js';
import { registerInboxRoutes } from './inbox/inbox.routes.js';
import { registerDigestRoutes } from './digest/routes.js';
import { registerBudgetRoutes } from './budget/budget.routes.js';
import { registerAdminAnalyticsRoutes, registerAdminRuntimeRoutes } from './admin/admin.routes.js';
import { registerAdminSystemCommandRoutes } from './command/admin-system-command.routes.js';
import { registerMcpServerRoutes } from './harness/mcp/controller/mcp-server.routes.js';
import { registerWeixinBotRoutes } from './weixin/weixin.routes.js';
import { registerFeishuBotRoutes } from './feishu/admin.routes.js';
import { registerFeishuBindingRoutes } from './feishu/binding.routes.js';
import { registerTaskNotificationPreferenceRoutes } from './notification/task/preference.routes.js';
import { attachWebSocket } from './session/ws/attach-websocket.js';

export interface RouteDeps {
  app: FastifyInstance;
  db: Db;
  cfg: AppConfig;
  apiPrefix: string;
  jwt: JwtService;
  agentRuntimeCfg: { wsIdleTimeoutMs: number };

  // auth
  authService: AuthService;
  feishu: FeishuAuthService;
  ecpAuth: EcpAuthService;
  userService: UserService;
  userRepo: MysqlUserRepository;
  permissionService: PermissionService;
  gitCredentials: GitCredentialService;
  envVariableService: EnvVariableService;
  sessionRepo: SessionRepository;

  // user-tool
  userToolService: UserToolService;
  userToolRepo: MysqlUserToolRepository;
  httpApiExecutor: HttpApiExecutor;
  userToolStatsStore: AdminAnalyticsDbStore;

  // agent
  fileService: FileService;
  agentService: AgentService;
  experienceService: AgentExperienceService;
  suggestedQuestionService: AgentSuggestedQuestionService;
  agentBundleService: AgentBundleService;
  mcpValidator: McpServerValidatorImpl;

  // model
  modelService: ModelService;

  // settings
  settingService: SystemSettingService;
  activateContainerRuntime: () => Promise<void>;
  runtimeModeResolver: RuntimeModeResolver;

  // command
  commandService: UserCommandService;
  commandRepo: MysqlUserCommandRepository;
  skillLoader: SkillLoader;
  skillSync: SkillSyncService;

  // preference
  weixinPref: UserWeixinPreferenceService;
  taskPanelPref: UserTaskPanelPreferenceService;

  // tool
  restToolService: ToolService;

  // audit
  auditService: AuditLogService;

  // llm-call
  llmCallService: LlmCallService;

  // session
  sessionService: SessionService;
  activityService: ActivityService;
  messageQueueService: MessageQueueService;
  agentRepo: MysqlAgentRepository;
  modelRepo: MysqlLlmModelRepository;
  todoRepo: SessionTodoRepository;
  pathSandbox: PathSandbox;
  subagentExecutionRepo: SubagentExecutionRepository;
  sessionCompactionEventService: SessionCompactionEventService;
  sessionCompactionService: SessionCompactionService;
  runTraceService: RunTraceService;
  approvalRegistry: ApprovalRegistry;
  askUserQuestionsRegistry: AskUserQuestionsRegistry;
  treeSignalPublisher: SessionTreeSignalPublisher;
  workspaceBrowse: WorkspaceBrowseService;
  terminalManager: TerminalManager;
  workspaceGit: WorkspaceGitService;
  gitCommitMsg: GitCommitMessageService;
  gitWrite: GitWriteOperationService;
  runtimeResolver: RuntimeDataResolver;

  // file
  ossSts: OssStsService;

  // skill
  skillBundleService: SkillBundleService;
  userSkillService: UserSkillService;
  skillDocService: SkillDocService;

  // schedule
  scheduledService: ScheduledTaskService;

  // openapi
  openRunService: OpenRunService;
  apiTokenService: ApiTokenService;
  webhookTriggerService: WebhookTriggerService;
  outboundSubscriptionService: OutboundSubscriptionService;
  openApiRateLimiter: FixedWindowRateLimiter;
  callLogService: OpenApiCallLogService;

  // signal
  watcherService: WatcherService;
  signalWatcherRepo: MysqlSignalWatcherRepository;

  // analytics
  analyticsService: AnalyticsService;
  statisticsService: StatisticsService;
  adminAnalytics: AdminAnalyticsService;

  // feedback
  feedbackService: FeedbackService;

  // memory
  memoryService: MemoryService;

  // approval-rule
  approvalRuleService: ApprovalRuleService;

  // inbox
  inboxService: InboxService;

  // digest
  digestService: DigestService;

  // budget
  budgetService: BudgetService;

  // mcp
  mcpServerService: McpServerService;
  mcpClient: McpClientManager;
  mcpPref: UserMcpPreferenceService;
  userMcpLoadModeService: UserMcpLoadModeService;
  mcpLoadModeResolver: McpLoadModeResolver;

  // weixin
  qrLogin: QrLoginService;
  weixinAccounts: WeixinAccountRepository;
  weixinMonitor: WeixinMonitorService;

  // feishu
  feishuBots: MysqlFeishuBotRepository;
  feishuBinding: MysqlFeishuBindingRepository;
  feishuMonitor: FeishuMonitorService;

  // dingtalk
  dingtalk: { registerRoutes(api: FastifyInstance): void };

  // notification
  notifPref: TaskNotificationPreferenceService;

  // ws
  wsHandler: StreamingWsHandler;
  terminalWsHandler: TerminalWsHandler;
}

export async function registerAllRoutes(deps: RouteDeps): Promise<void> {
  const {
    app, db, cfg, apiPrefix, jwt, agentRuntimeCfg,
    authService, feishu, ecpAuth, userService, userRepo, permissionService,
    gitCredentials, envVariableService, sessionRepo,
    userToolService, userToolRepo, httpApiExecutor, userToolStatsStore,
    fileService, agentService, experienceService, suggestedQuestionService,
    agentBundleService, mcpValidator,
    modelService,
    settingService, activateContainerRuntime, runtimeModeResolver,
    commandService, commandRepo, skillLoader, skillSync,
    weixinPref, taskPanelPref,
    restToolService,
    auditService,
    llmCallService,
    sessionService, activityService, messageQueueService,
    agentRepo, modelRepo, todoRepo, pathSandbox, subagentExecutionRepo,
    sessionCompactionEventService, sessionCompactionService, runTraceService,
    approvalRegistry, askUserQuestionsRegistry, treeSignalPublisher,
    workspaceBrowse, terminalManager, workspaceGit, gitCommitMsg, gitWrite, runtimeResolver,
    ossSts,
    skillBundleService, userSkillService, skillDocService,
    scheduledService,
    openRunService, apiTokenService, webhookTriggerService, outboundSubscriptionService,
    openApiRateLimiter, callLogService,
    watcherService, signalWatcherRepo,
    analyticsService, statisticsService, adminAnalytics,
    feedbackService,
    memoryService,
    approvalRuleService,
    inboxService,
    digestService,
    budgetService,
    mcpServerService, mcpClient, mcpPref, userMcpLoadModeService, mcpLoadModeResolver,
    qrLogin, weixinAccounts, weixinMonitor,
    feishuBots, feishuBinding, feishuMonitor,
    dingtalk,
    notifPref,
    wsHandler, terminalWsHandler,
  } = deps;

  await app.register(async (api) => {
    api.get('/swagger-ui.html', async (_req, reply) => reply.redirect(`${apiPrefix}/swagger-ui`));
    api.get('/v3/api-docs', async (_req, reply) => {
      return reply.send(app.swagger());
    });
    api.get('/v1/health', async (_req, reply) => sendOk(reply, { status: 'UP' }));
    registerAuthRoutes(api, authService, feishu, ecpAuth);
    registerEcpAuthRoutes(api, ecpAuth);
    registerCompanySsoRoutes(api, new CompanySsoService(
      new CompanySsoClient(), new CompanySsoIdentityRepository(db), jwt,
    ), settingService, async (event) => {
      await auditService.record({
        action: event.action === 'created' ? 'CREATE' : event.action === 'bound' ? 'UPDATE' : 'LOGIN',
        objectType: 'sso.identity',
        objectId: event.userId == null ? null : String(event.userId),
        userId: event.userId,
        method: 'POST',
        path: '/v1/auth/sso/exchange',
        ip: event.ip,
        status: event.outcome === 'success' ? 200 : new CompanySsoError(event.outcome).status,
        success: event.outcome === 'success' ? 1 : 0,
        errorMessage: event.outcome === 'success' ? null : event.outcome,
        queryString: JSON.stringify({ requestId: event.requestId, provider: event.provider, durationMs: event.durationMs }),
      });
    });
    registerUserRoutes(api, userService, userRepo, permissionService);
    registerPermissionRoutes(api, permissionService);
    registerGitCredentialRoutes(api, gitCredentials);
    registerAdminGitCredentialRoutes(api, { gitCredentialService: gitCredentials, permissionService });
    registerEnvVariableRoutes(api, { envVariableService, sessionLookup: sessionRepo });
    registerAdminEnvVariableRoutes(api, {
      envVariableService,
      permissionService,
      userLookup: { findById: (id: number) => userRepo.findById(id) },
    });
    registerUserToolRoutes(api, { userToolService, httpApiExecutor });
    registerAdminUserToolRoutes(api, {
      repo: userToolRepo,
      stats: userToolStatsStore,
      permissionService,
    });
    registerAgentAvatarRoutes(api, fileService, permissionService);
    registerAgentRoutes(api, {
      agentService, experienceService, suggestedQuestionService, userRepo, mcpServerValidator: mcpValidator,
      permissionService,
    });
    registerAgentBundleRoutes(api, { agentBundleService, permissionService, registryConfig: settingService });
    registerModelRoutes(api, { modelService, permissionService });
    registerSystemSettingRoutes(api, {
      systemSettingService: settingService,
      permissionService,
      adminEmailLookup: { findEmailById: (userId) => userRepo.findEmailById(userId) },
      beforeSave: async (items) => {
        await validateRuntimeModeSave(items, activateContainerRuntime);
      },
      afterSave: (keys) => {
        if (keys.includes(RUNTIME_MODE_SETTING_KEY)) runtimeModeResolver.invalidate();
      },
    });
    registerEmbedRoutes(api, { systemSettingService: settingService, agentService });
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
    registerAuditLogRoutes(api, { auditLogService: auditService, permissionService });
    registerLlmCallRoutes(api, { llmCallService, permissionService });
    registerUploadRoutes(api, () => settingService.getUploadConfig());
    registerSessionRoutes(api, {
      sessionService, activityService, messageQueueService,
      agentLookup: {
        findById: (id: number) => agentRepo.findById(id),
        findByIds: (ids: number[]) => agentRepo.findByIds(ids),
        requireDefaultAgent: () => agentService.requireDefaultAgent(),
        listOptions: async () => (await agentRepo.selectList(null, true)).map((a) => ({ id: a.id!, name: a.name })),
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
      sessionCompactionService,
      runTraceService,
      approvalRegistry,
      askUserQuestionsRegistry,
      treeSignalPublisher,
    });
    const sessionShareService = new SessionShareService(
      new MysqlSessionShareRepository(db),
      sessionService,
      userRepo,
      {
        findById: (id: number) => agentRepo.findById(id),
        findByIds: (ids: number[]) => agentRepo.findByIds(ids),
        requireDefaultAgent: () => agentService.requireDefaultAgent(),
        listOptions: async () => (await agentRepo.selectList(null, true)).map((a) => ({ id: a.id!, name: a.name })),
      } as never,
      auditService,
      () => settingService.shareTokenLinksEnabled(),
    );
    registerSessionShareRoutes(api, {
      sessionService,
      shareService: sessionShareService,
      exportService: new SessionExportService(sessionService, {
        findById: (id: number) => agentRepo.findById(id),
        findByIds: (ids: number[]) => agentRepo.findByIds(ids),
        requireDefaultAgent: () => agentService.requireDefaultAgent(),
        listOptions: async () => (await agentRepo.selectList(null, true)).map((a) => ({ id: a.id!, name: a.name })),
      } as never),
      tokenLinksEnabled: () => settingService.shareTokenLinksEnabled(),
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
        listOptions: async () => (await agentRepo.selectList(null, true)).map((a) => ({ id: a.id!, name: a.name })),
      } as never,
      modelLookup: {
        findById: (id: number) => modelRepo.findById(id),
        findByIds: (ids: number[]) => modelRepo.findByIds(ids),
        findDefault: () => modelRepo.findDefault(),
      } as never,
      permissionService,
      askUserQuestionsRegistry,
    });
    registerAdminSessionFilesRoutes(api, {
      sessionService,
      workspaceBrowseService: workspaceBrowse,
      permissionService,
    });
    registerTerminalRoutes(api, {
      terminalManager,
      sessionService,
      permissionService,
      userLookup: { findById: (id: number) => userRepo.findById(id) as Promise<{ username: string } | null> },
    });
    const workspaceWrite = new WorkspaceWriteService(pathSandbox, activityService);
    registerFileRoutes(api, {
      fileService, sessionService, workspaceBrowseService: workspaceBrowse,
      workspaceGitService: workspaceGit, gitCommitMessageService: gitCommitMsg,
      gitWriteOperationService: gitWrite, workspaceWriteService: workspaceWrite, pathSandbox,
      getUploadBaseUrl: async () => (await settingService.getUploadConfig()).baseUrl,
      runtimeDataResolver: runtimeResolver,
    });
    registerOssRoutes(api, { ossStsService: ossSts });
    registerSkillBundleRoutes(api, { skillBundleService, permissionService });
    registerSkillRoutes(api, {
      userSkillService, skillDocService, skillSyncService: skillSync,
      sessionService, agentService,
      agentLookup: {
        findById: (id: number) => agentRepo.findById(id),
        findByIds: (ids: number[]) => agentRepo.findByIds(ids),
        requireDefaultAgent: () => agentService.requireDefaultAgent(),
        listOptions: async () => (await agentRepo.selectList(null, true)).map((a) => ({ id: a.id!, name: a.name })),
      } as never,
      permissionService,
      userLookup: {
        findByIds: async (ids: number[]) => (await userRepo.findByIds(ids)).map((u) => ({
          id: u.id!,
          username: u.username,
          displayName: u.displayName,
        })),
        listOptions: async () => (await userRepo.listOptions()).map((u) => ({
          id: u.id!,
          username: u.username,
          displayName: u.displayName,
        })),
      },
    });
    registerScheduledTaskRoutes(api, { service: scheduledService, jwt, permission: permissionService });
    registerOpenApiRoutes(api, {
      apiPrefix,
      openRun: openRunService,
      apiTokenService,
      triggerService: webhookTriggerService,
      subscriptionService: outboundSubscriptionService,
      rateLimiter: openApiRateLimiter,
      callLog: callLogService,
    });
    registerOpenApiCallLogRoutes(api, { callLog: callLogService, permissionService });
    registerSignalWatcherRoutes(api, { service: watcherService });
    registerSignalAdminRoutes(api, {
      watcherRepo: signalWatcherRepo,
      permissionService,
      userLookup: {
        findByIds: async (ids: number[]) => (await userRepo.findByIds(ids)).map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
        })),
      },
    });
    registerAnalyticsRoutes(api, { analytics: analyticsService, jwt, permissionService });
    registerStatisticsRoutes(api, { statistics: statisticsService, jwt, permissionService });
    registerFeedbackRoutes(api, { feedback: feedbackService, jwt, permissionService });
    registerMemoryRoutes(api, { memoryService });
    registerApprovalRuleRoutes(api, {
      approvalRuleService,
      audit: (input: ApprovalRuleAuditInput) => {
        void auditService.record({
          action: input.action,
          objectType: 'approval.rule',
          objectId: String(input.objectId),
          method: input.request.method,
          path: input.request.url,
          userId: (input.request as { userId?: number }).userId ?? null,
          username: null,
          ip: input.request.ip ?? null,
          status: 200,
          success: 1,
          errorMessage: null,
          queryString: input.detail,
        }).catch((e) => console.error('Failed to record approval rule audit log', e));
      },
    });
    registerApprovalRuleAdminRoutes(api, { approvalRuleService, permissionService });
    registerInboxRoutes(api, { inboxService });
    registerDigestRoutes(api, { service: digestService });
    registerBudgetRoutes(api, { budgetService, permissionService });
    const adminDeps = {
      jwt, analytics: adminAnalytics,
      sessionLister: sessionService as never,
      permissionService,
      memoryAuditor: memoryService,
      memoryUserLookup: {
        findByIds: async (ids: number[]) => (await userRepo.findByIds(ids)).map((u) => ({
          id: u.id!,
          username: u.username,
          displayName: u.displayName,
        })),
      },
    };
    registerAdminAnalyticsRoutes(api, adminDeps);
    registerAdminRuntimeRoutes(api, adminDeps);
    registerAdminSystemCommandRoutes(api, {
      commandRepo,
      permissionService,
      userLookup: {
        findByIds: async (ids: number[]) => (await userRepo.findByIds(ids)).map((u) => ({
          id: u.id!,
          username: u.username,
          displayName: u.displayName,
        })),
      },
    });
    registerMcpServerRoutes(api, {
      mcpServerService, mcpClientManager: mcpClient, userMcpPreferenceService: mcpPref,
      userMcpLoadModeService, mcpLoadModeResolver, permissionService,
    });
    registerWeixinBotRoutes(api, { jwt, qrLogin, accountRepository: weixinAccounts, monitorService: weixinMonitor });
    registerFeishuBotRoutes(api, {
      repository: feishuBots,
      secretKey: cfg.feishu.bot.appSecretKey,
      permissionService,
      monitorStatus: { getStatus: (botId: number) => feishuMonitor.getStatus(botId) },
      monitorReconnect: { reconnect: (botId: number) => feishuMonitor.reconnect(botId) },
    });
    registerFeishuBindingRoutes(api, { jwt, repository: feishuBinding, auth: feishu });
    dingtalk.registerRoutes(api);
    registerTaskNotificationPreferenceRoutes(api, { preference: notifPref, jwt });
    await attachWebSocket(api, {
      handler: wsHandler,
      idleTimeoutMs: agentRuntimeCfg.wsIdleTimeoutMs,
      terminalHandler: terminalWsHandler,
    });
  }, { prefix: apiPrefix });
}
