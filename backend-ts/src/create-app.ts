import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fastifyLoggerOptions, redactCredentialQuery } from './common/structured-logger.js';
import { sendJson, sendOk, handleError } from './common/http-error.js';
import { loadConfig, type AppConfig } from './config/app-config.js';
import { corsForRequest } from './config/cors-policy.js';
import { loadTrustedProxyAddresses } from './config/trusted-proxy.js';
import { createPool, Db } from './db/db.js';
import { runFlywayIfEnabled } from './db/flyway.js';
import { JwtService } from './crypto/jwt.service.js';
import { hashPassword, matchesPassword } from './crypto/password.js';
import { AuthService } from './auth/auth.service.js';
import { LdapAuthService } from './auth/ldap-auth.service.js';
import { FeishuAuthService } from './auth/feishu-auth.service.js';
import { MysqlFeishuOauthStateRepository } from './auth/feishu-oauth.repository.js';
import { EcpAuthService } from './auth/ecp-auth.service.js';
import { createEcpCredentialsInjector } from './auth/ecp-credentials-injector.js';
import { EcpClient } from './auth/ecp.client.js';
import { EcpIdentityRepository } from './auth/ecp-identity.repository.js';
import { createLarkUatInjector } from './auth/lark-uat-injector.js';
import { MysqlEcpOauthStateRepository } from './auth/ecp-oauth.repository.js';
import { MysqlEcpSessionRepository } from './auth/ecp-session.repository.js';
import { MysqlUserRepository } from './user/user.repository.js';
import { UserService } from './user/user.service.js';
import { GitCredentialService, assertGitCredentialSecret } from './user/git-credential.service.js';
import { MysqlEnvVariableRepository } from './env/env-variable.repository.js';
import { EnvVariableService } from './env/env-variable.service.js';
import {
  MysqlPermissionRepository,
  MysqlRolePermissionRepository,
  MysqlRoleRepository,
  MysqlUserRoleRepository,
} from './permission/permission.repository.js';
import { PermissionService } from './permission/permission.service.js';
import { MysqlAgentExperienceRepository, MysqlAgentRepository, MysqlAgentSuggestedQuestionRepository } from './agent/agent.repository.js';
import { AgentExperienceService } from './agent/agent-experience.service.js';
import { AgentSuggestedQuestionService } from './agent/agent-suggested-question.service.js';
import { AgentService } from './agent/agent.service.js';
import { AgentBundleService } from './agent/agent-bundle.service.js';
import { AgentImportOriginRepository } from './agent/agent-import-origin.repository.js';
import { McpServerValidatorImpl, MysqlMcpServerLookup } from './agent/mcp-validator.js';
import { MysqlLlmModelRepository, MysqlSessionModelRepository } from './model/model.repository.js';
import { OpenAiChatClient } from './model/llm-chat.client.js';
import { AnthropicChatClient } from './model/anthropic-chat.client.js';
import { ResponsesChatClient } from './model/responses-chat.client.js';
import type { LlmChatClient, LlmModelConfig } from './model/types.js';
import { ModelService } from './model/model.service.js';
import { MysqlSystemSettingRepository } from './settings/settings.repository.js';
import { SystemSettingService } from './settings/settings.service.js';
import { runSettingsBootstrap } from './settings/settings-bootstrap.js';
import { MysqlUserCommandRepository } from './command/command.repository.js';
import { UserCommandService } from './command/command.service.js';
import {
  MysqlUserTaskPanelPreferenceRepository,
  MysqlUserWeixinPreferenceRepository,
} from './preference/preference.repository.js';
import { UserWeixinPreferenceService } from './preference/weixin-preference.service.js';
import { UserTaskPanelPreferenceService } from './preference/task-panel-preference.service.js';
import { ToolService } from './tool/tool.service.js';
import { MysqlAuditLogRepository } from './audit/audit.repository.js';
import { AuditLogService } from './audit/audit.service.js';
import { PathSandbox } from './harness/safety/path-sandbox.js';
import { SessionRepository, MessageRepository, FileChangeRepository } from './session/session.repository.js';
import { SessionCompactionRepository, SessionCompactionEventRepository } from './session/session-compaction.repository.js';
import { SessionCompactionService } from './session/session-compaction.service.js';
import { SessionCompactionEventService } from './session/session-compaction-event.service.js';
import { GitOperationService } from './session/git-operation.service.js';
import { SessionService } from './session/session.service.js';
import { SessionTitleService } from './session/session-title.service.js';
import { ActivityService } from './session/activity.service.js';
import { RunTraceService } from './session/run-trace.service.js';
import { RunTraceRecordService } from './session/run-trace-record.service.js';
import { SessionActivityRepository, SessionTodoRepository, SubagentExecutionRepository } from './session/activity.repository.js';
import { MessageQueueService } from './session/message-queue.service.js';
import { MessageQueueRepository } from './session/message-queue.repository.js';
import { SessionActivityHeartbeat } from './session/session-activity-heartbeat.js';
import { ApprovalRuleRepository } from './approval-rule/approval-rule.repository.js';
import { ApprovalRuleService } from './approval-rule/approval-rule.service.js';
import { InboxRepository } from './inbox/inbox.repository.js';
import { InboxService } from './inbox/inbox.service.js';
import { InboxCleanupScheduler, type InboxCleanupStore } from './inbox/inbox.cleanup.js';
import { EnvironmentInfoProvider } from './harness/core/environment-info-provider.js';
import { FileEntityRepository, FileService } from './file/file.service.js';
import { WorkspaceBrowseService } from './file/workspace-browse.service.js';
import { WorkspaceGitService } from './file/workspace-git.service.js';
import { GitWriteOperationService } from './file/git-write-operation.service.js';
import { GitCommitMessageService } from './file/git-commit-message.service.js';
import { OssStsService, createAliyunAssumeRoleClient } from './oss/oss-sts.service.js';
import { SkillBundleService } from './skill/skill-bundle.service.js';
import { UserSkillService } from './skill/user-skill.service.js';
import { SkillDocService } from './skill/skill-doc.service.js';
import { SkillSyncService } from './harness/skill/skill-sync-service.js';
import { SkillLoader } from './harness/skill/skill-loader.js';
import { ScheduledTaskDbStore } from './schedule/scheduled-task.store.js';
import { AnalyticsDbStore, AnalyticsService } from './analytics/analytics.service.js';
import { StatisticsDbStore, StatisticsService } from './statistics/statistics.service.js';
import { FEISHU_DISLIKE_SOURCE, FeedbackRepository } from './feedback/feedback.repository.js';
import { FeedbackDbLookup, FeedbackService } from './feedback/feedback.service.js';
import { AdminAnalyticsDbStore, AdminAnalyticsService } from './admin/admin-analytics.service.js';
import { McpServerMapper, UserMcpPreferenceMapper } from './harness/mcp/mapper/mcp-server.mapper.js';
import { McpSyncService } from './harness/mcp/local/mcp-sync-service.js';
import { LlmAdapterFacade } from './harness/llm/llm-adapter-facade.js';
import { HttpApiExecutor } from './harness/tool/impl/http-api-executor.js';
import { DangerAssessor } from './harness/tool/danger-assessor.js';
import { ProxyApprover } from './harness/tool/proxy-approver.js';
import { JevRiskAssessor } from './harness/tool/jev-risk-assessor.js';
import { ApprovalModelResolver } from './harness/tool/approval-model-resolver.js';
import { BudgetRepository, BudgetSpendStore } from './budget/budget.repository.js';
import { BudgetService } from './budget/budget.service.js';
import { AskUserQuestionsRegistry } from './harness/tool/ask-user-questions-registry.js';
import { InFlightToolRegistry } from './harness/core/in-flight-tool-registry.js';
import { AgentLoop } from './harness/core/agent-loop.js';
import { HarnessService } from './harness/core/harness-service.js';
import { WorkspaceRulesSnapshotRepository } from './harness/core/workspace-rules-snapshot.repository.js';
import { WorkspaceRulesSnapshotService } from './harness/core/workspace-rules-snapshot.service.js';
import { CompactionSignalBus } from './harness/core/compaction-signal-bus.js';
import { BackgroundTaskManager } from './harness/core/background-task-manager.js';
import { readActiveBackendPort, readDeployLock } from './harness/core/deploy-lock.js';
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
import { SubagentInvocationService } from './harness/delegate/subagent-invocation.service.js';
import { SubagentResultDeliveryService } from './harness/delegate/subagent-result-delivery.service.js';
import { ApprovalRegistry } from './harness/approval/approval-registry.js';
import { SessionTreeSignalPublisher } from './harness/approval/session-tree-signal-publisher.js';
import { StreamingWsRegistry } from './session/ws/streaming-ws-registry.js';
import { EmbedPageToolRegistry, resolveEmbedPageToolTimeoutMs } from './harness/embed-page-tool-registry.js';
import { TerminalManager } from './harness/terminal/terminal-manager.js';
import { TerminalWsHandler } from './harness/terminal/terminal-ws-handler.js';
import { DEFAULT_WEIXIN_BOT_CONFIG, type WeixinBotConfig } from './weixin/types.js';
import { PreferenceDbStore, DeliveryDbStore } from './notification/task/stores.js';
import { WebhookSecretCipher } from './notification/task/webhook-secret-cipher.js';
import { WebhookDeliveryScheduler, DeliverySchedulerDbStore } from './notification/task/delivery.scheduler.js';
import { WebhookSenderRegistry, DingTalkWebhookSender, FeishuWebhookSender } from './notification/task/webhook-sender.js';
import { LlmUsageRepository, LlmUsageService } from './usage/llm-usage.service.js';
import { LlmCallRepository } from './usage/llm-call.repository.js';
import { LlmCallService } from './usage/llm-call.service.js';
import { RecordingLlmChatClient } from './usage/recording-llm-chat-client.js';
import { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';
import { FeishuInboundProcessor } from './feishu/inbound-processor.js';
import { MysqlFeishuPendingBindingRepository } from './feishu/pending-binding.repository.js';
import { replayFeishuPendingMessage } from './feishu/pending-replay.js';
import {
  completeFeishuPendingAfterEcp,
  FEISHU_ECP_IDENTITY_MISMATCH_TEXT,
} from './feishu/ecp-inbound-gate.js';
import { feishuSendTargetOf, sendFeishuFile, sendFeishuImage } from './feishu/media-sender.js';
import type { DingtalkMediaSendSupport } from './harness/tool/impl/dingtalk-tools.js';
import { buildFeishuProgressCard, feishuSessionDetailUrl } from './feishu/progress-card.js';
import { FeishuAskFormStore } from './feishu/ask-form-store.js';
import { FeishuActiveProgressRegistry } from './feishu/active-progress.js';
import { createFeishuAskMount } from './feishu/ask-mount.js';
import { chatFilesDirOf, resolveChatFileTarget } from './feishu/chat-files.js';
import { createFeishuMediaHelper, IMAGE_EXT_BY_CONTENT_TYPE, createResolveMessageTextHelper } from './feishu-media.js';
import { createFeishuQueueCardHelper, createPatchedProgressHelper, createFeishuProgressCardHelper, createFeishuRecoveryProgressHelper, createSendUnauthorizedCardHelper, createUnauthorizedTextHelper } from './feishu-cards.js';
import { createFeishuSessionUrlHelper, createFeishuUserIdHelper, createResolveUserIdHelper, createAuthorizeSenderHelper, createResolveQuotedMessageHelper, createThreadSessionHelper } from './feishu-session.js';
import { createPersistCancelledHelper, createQueuePositionHelper, registerUploadStatic, createContainerPtyFactory, createTerminalAudit } from './app-utils.js';
import type { FeishuNormalizedMessage } from './feishu/types.js';
import { MysqlApiTokenRepository, MysqlOutboundDeliveryRepository, MysqlOutboundSubscriptionRepository, MysqlWebhookTriggerRepository } from './openapi/openapi.repository.js';
import { ApiTokenService } from './openapi/api-token.service.js';
import { ApiTokenCipher } from './openapi/api-token-cipher.js';
import { FixedWindowRateLimiter } from './openapi/rate-limiter.js';
import { OpenRunService, type OpenRunDeps } from './openapi/open-run.service.js';
import { WebhookTriggerService, type WebhookTriggerDeps } from './openapi/webhook-trigger.service.js';
import { OutboundSubscriptionService } from './openapi/outbound-subscription.service.js';
import { OPEN_HOOKS_PATH_PREFIX, registerOpenApiRoutes, type RawBodyRequest } from './openapi/open.routes.js';
import { OpenApiCallLogService } from './openapi/open-api-call-log.service.js';
import { MysqlHttpToolRepository } from './http-tool/http-tool.repository.js';
import { HttpToolService } from './http-tool/http-tool.service.js';
import { HttpToolValidatorImpl, MysqlHttpToolLookup } from './http-tool/http-tool-validator.js';
import { HttpToolHeaderCipher } from './http-tool/http-tool-cipher.js';
import { MysqlSignalCheckRepository, MysqlSignalWatcherRepository } from './signal/signal.repository.js';
import { RuntimeModeResolver, RUNTIME_MODE_SETTING_KEY, validateRuntimeModeSave } from './harness/container/runtime-mode.js';
import { SessionEnvelopeBuilder, buildDepsEnv } from './harness/container/session-envelope-builder.js';
import {
  resolveFeishuChatWorkspace,
  sanitizeFeishuFileName,
  downloadFeishuMediaBuffer,
  dataUriOf,
} from './feishu-media.js';
import { expandHome, parseSqlTimeMs, resolveShareDir, runtimeSessionCleanup } from './app-utils.js';
import { registerAllRoutes } from './app-routes.js';
import { registerAppHooks } from './app-hooks.js';
import { assembleContainerRuntime } from './app-container-runtime.js';
import { assembleLlmEngine } from './app-llm-engine.js';
import { assembleNotificationServices } from './app-notification-services.js';
import { assembleOpenApiServices } from './app-openapi-services.js';
import { assembleWeixinServices } from './app-weixin-services.js';
import { assembleFeishuHandler } from './app-feishu-handler.js';
import { assembleFeishuMessaging } from './app-feishu-messaging.js';
import { assembleLifecycle } from './app-lifecycle.js';
import { assembleWeixinMcpServices } from './app-weixin-mcp-services.js';
import { assembleHarnessEngine } from './app-harness-engine.js';
import { assembleWsHandler } from './app-ws-handler.js';
import { assembleSessionServices } from './app-session-services.js';

export interface MaoApp {
  app: FastifyInstance;
  close(): Promise<void>;
}

/**
 * 装配期共享上下文：集中管理 createMaoApp 内部的延迟解引用变量。
 * 这些变量在构造顺序上晚于某些 service 的构造，通过 ctx 属性访问
 * 使依赖关系显式化，避免散落的 let + 闭包捕获。
 */
export interface AppContext {
  db: Db;
  /** 飞书入站处理器：构造于 feishu AuthService 之后，pendingBinding 回调延迟解引用。 */
  pendingBindingProcessor: FeishuInboundProcessor | undefined;
  /** 飞书待绑定消息不匹配通知：同上，延迟解引用。 */
  notifyFeishuPendingMismatch: ((pending: { appId: number; event: FeishuNormalizedMessage }) => Promise<void>) | undefined;
  /** 终端管理器：会话删除回调延迟解引用。 */
  terminalManagerRef: TerminalManager | null;
  /** 定时任务清理回调：会话删除路径延迟解引用。 */
  deleteScheduledTasksForSession: ((sessionId: number) => Promise<void>) | null;
  /** MCP 同步服务：会话删除路径延迟解引用。 */
  mcpSyncRef: McpSyncService | null;
  /** 容器运行时激活标志：幂等激活用。 */
  containerRuntimeActive: boolean;
  /** 幂等关闭 Promise：drain 监听器与 SIGTERM 可能同时触发。 */
  closing: Promise<void> | null;
}

export async function createMaoApp(cfg: AppConfig = loadConfig(), existing?: FastifyInstance): Promise<MaoApp> {
  assertGitCredentialSecret(cfg.app.gitCredential.secretKey);
  await runFlywayIfEnabled(cfg);
  const pool = createPool(cfg);
  const db = new Db(pool);
  const ctx: AppContext = {
    db,
    pendingBindingProcessor: undefined,
    notifyFeishuPendingMismatch: undefined,
    terminalManagerRef: null,
    deleteScheduledTasksForSession: null,
    mcpSyncRef: null,
    containerRuntimeActive: false,
    closing: null,
  };
  const settingsSecret = process.env.SETTINGS_SECRET ?? '';
  const settingRepo = new MysqlSystemSettingRepository(db);
  await runSettingsBootstrap(settingRepo, settingsSecret);
  // 上传上限后台可配：multipart 截断阈值取配置值与默认 1GB 的较大者，避免后台调大后被 multipart 层先截断
  const bootstrapSettings = new SystemSettingService(settingRepo, { findById: async () => null }, { findById: async () => null }, { workspaceRoot: '', skillsDir: '' }, settingsSecret);
  const bootstrapUploadCfg = await bootstrapSettings.getUploadConfig();
  const multipartLimitMb = Math.max(1024, bootstrapUploadCfg.maxSizeMb);
  // Agent 线程池/WS 超时/harness 调参启动时从 DB 构建，后台改动需重启生效；调度参数走 getter 即时生效
  const agentRuntimeCfg = await bootstrapSettings.getAgentRuntimeConfig();
  const harnessTuning = await bootstrapSettings.getHarnessTuningConfig();
  const terminalCfg = await bootstrapSettings.getTerminalConfig();
  const app = existing ?? Fastify({ logger: fastifyLoggerOptions, trustProxy: loadTrustedProxyAddresses(), bodyLimit: Math.max(52, multipartLimitMb + 2) * 1024 * 1024 });
  const hasher = { hash: hashPassword, matches: matchesPassword };
  const jwt = new JwtService(cfg.jwt.secret, cfg.jwt.expiration, cfg.jwt.refreshExpiration, cfg.jwt.shellExpiration);

  const apiPrefix = cfg.server.servlet.contextPath || '/api';
  const ssoExchangePath = `${apiPrefix}/v1/auth/sso/exchange`;
  await app.register(cors, {
    delegator: async (request: FastifyRequest) => corsForRequest(request, ssoExchangePath, bootstrapSettings),
  });
  await app.register(multipart, { limits: { fileSize: multipartLimitMb * 1024 * 1024, files: 500 } });
  const uploadDir = resolve(expandHome(cfg.app.file.uploadDir));
  mkdirSync(uploadDir, { recursive: true });
  // 公共共享目录（共享目录方案 §3.1）：与 uploadDir 同口径启动兜底创建，
  // 容器模式 ro 挂载前保证宿主机源目录存在（docker -v 对缺失源虽会自动建空目录，
  // 但属主会是 root，这里以后端运行用户创建，管理员投放时属主一致）。
  // resolveShareDir 对空值/相对路径启动即拒：静默按 cwd 解析会把后端工作树
  // （含 .env 密钥）ro 挂进所有用户容器（round-02 review Bug 1）。
  const shareDir = resolveShareDir(cfg.app.harness.shareDir);
  mkdirSync(shareDir, { recursive: true });
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
  // 邮箱变更监听（决策 2）：闭包延迟绑定 notifPref（装配顺序上它构造于后），
  // 仅在资料更新的请求处理期被调用，不存在时序风险。
  const userService = new UserService(userRepo, permissionService, hasher, (userId, email) => notifPref.refreshEmailAddress(userId, email));
  const ldap = new LdapAuthService(userRepo, userRoleRepo, jwt, async () => (await settingService.getLdapConfig()));
  const authService = new AuthService(userRepo, jwt, hasher, ldap, permissionService);
  const earlyFeishuBinding = new MysqlFeishuBindingRepository(db);
  const pendingBindingMessages = new MysqlFeishuPendingBindingRepository(db);
  // pendingBindingProcessor / notifyFeishuPendingMismatch 已迁移到 ctx（延迟解引用）
  const feishu = new FeishuAuthService(
    userRepo, userRoleRepo, new MysqlFeishuOauthStateRepository(db), jwt, async () => (await settingService.getFeishuOAuthConfig()),
    undefined,
    async (user, targetUserId, state) => {
      if (user.id != null && user.feishuUserId != null && user.feishuUserId !== '') {
        await earlyFeishuBinding.bind(targetUserId ?? user.id, user.feishuUserId);
      }
      if (state != null && ctx.pendingBindingProcessor != null) {
        const pending = await pendingBindingMessages.claim(state);
        if (pending != null) {
          try {
            await replayFeishuPendingMessage(ctx.pendingBindingProcessor, pending);
            await pendingBindingMessages.complete(state!);
          } catch (error) {
            await pendingBindingMessages.release(state!);
            console.error(`恢复飞书待绑定消息失败, state=${state}`, error);
          }
        }
      }
    },
  );
  const ecpOAuthRepo = new MysqlEcpOauthStateRepository(db);
  const ecpIdentityRepo = new EcpIdentityRepository(db);
  const ecpSessionRepo = new MysqlEcpSessionRepository(db, settingsSecret);
  const ecpAuth = new EcpAuthService(
    userRepo,
    ecpOAuthRepo,
    ecpIdentityRepo,
    ecpSessionRepo,
    jwt,
    authService,
    () => settingService.getEcpConfig(),
    undefined,
    async (user, state) => {
      if (user.id == null) return;
      await completeFeishuPendingAfterEcp({
        state,
        ecpUserId: user.id,
        claim: (s) => pendingBindingMessages.claim(s),
        findUserIdByUnionId: (unionId) => earlyFeishuBinding.findUserIdByUnionId(unionId),
        bind: (userId, unionId) => earlyFeishuBinding.bind(userId, unionId),
        replay: async (pending) => {
          if (ctx.pendingBindingProcessor == null) throw new Error('飞书入站处理器未就绪');
          await replayFeishuPendingMessage(ctx.pendingBindingProcessor, pending);
        },
        complete: (s) => pendingBindingMessages.complete(s),
        release: (s) => pendingBindingMessages.release(s),
        failClaimed: (s) => pendingBindingMessages.failClaimed(s),
        notifyMismatch: async (pending) => {
          await ctx.notifyFeishuPendingMismatch?.(pending);
        },
      });
    },
  );
  const gitCredentials = new GitCredentialService(db, cfg.app.gitCredential.secretKey);
  const gitLookup = {
    getTokenMapByUser: async (userId: number) => Object.fromEntries(await gitCredentials.getTokenMapByUser(userId)),
  };

  const auditRepo = new MysqlAuditLogRepository(db);
  const auditService = new AuditLogService(auditRepo);

  // 开放接口：API Token 身份层（preHandler 的 mao_ 前缀查库降级）+ 共享限流器
  const apiTokenRepo = new MysqlApiTokenRepository(db);
  const apiTokenCipher = new ApiTokenCipher(cfg.app.openapi.tokenSecretKey);
  const apiTokenService = new ApiTokenService(apiTokenRepo, apiTokenCipher);
  const openApiRateLimiter = new FixedWindowRateLimiter();
  const openCallLogHolder: { current: OpenApiCallLogService | null } = { current: null };

  registerAppHooks({
    app, jwt, apiTokenService, openCallLogHolder, auditService, userRepo, ssoExchangePath,
  });


  const agentRepo = new MysqlAgentRepository(db);
  const experienceService = new AgentExperienceService(new MysqlAgentExperienceRepository(db));
  const suggestedQuestionService = new AgentSuggestedQuestionService(new MysqlAgentSuggestedQuestionRepository(db));
  const modelRepo = new MysqlLlmModelRepository(db);
  const agentService = new AgentService(agentRepo, experienceService, suggestedQuestionService, modelRepo);
  const llmCallService = new LlmCallService(
    new LlmCallRepository(db),
    {
      findUsername: async (id) => {
        const user = await userRepo.findById(id);
        return user ? { username: user.username, displayName: user.displayName } : null;
      },
    },
    {
      findName: async (id) => {
        const agent = await agentRepo.findById(id);
        return agent?.name ?? null;
      },
    },
    // 兜底价格缓存（60s TTL）：价格未随 LlmModelConfig 下发的调用路径按 modelId 回查模型行
    (id) => modelRepo.findById(id),
  );
  const modelChatClient = new RecordingLlmChatClient(
    new OpenAiChatClient({ timeoutMs: harnessTuning.llm.callTimeoutSeconds * 1000 }),
    llmCallService,
  );
  const anthropicChatClient = new RecordingLlmChatClient(
    new AnthropicChatClient({ timeoutMs: harnessTuning.llm.callTimeoutSeconds * 1000 }),
    llmCallService,
  );
  const responsesChatClient = new RecordingLlmChatClient(
    new ResponsesChatClient({ timeoutMs: harnessTuning.llm.callTimeoutSeconds * 1000 }),
    llmCallService,
  );
  const llmChatClients = new Map<string, LlmChatClient>([
    ['anthropic', anthropicChatClient],
    ['openai-responses', responsesChatClient],
  ]);
  /** 连通性测试、飞书溢出摘要等非流式链路共用的按 apiProtocol 协议路由（与 LlmAdapterFacade 同策略）。 */
  const routeChatClient = (config: LlmModelConfig): LlmChatClient => {
    const code = config.apiProtocol?.trim().toLowerCase();
    if (code != null && llmChatClients.has(code)) return llmChatClients.get(code)!;
    return modelChatClient;
  };
  const modelService = new ModelService(
    modelRepo,
    new MysqlSessionModelRepository(db),
    modelChatClient,
    llmChatClients,
  );

  const settingService = new SystemSettingService(
    settingRepo,
    { findById: (id) => agentRepo.findById(id) },
    { findById: (id) => modelRepo.findById(id) },
    {
      workspaceRoot: cfg.app.harness.workspaceRoot,
      skillsDir: cfg.app.harness.skillsDir,
    },
    settingsSecret,
  );
  const commandRepo = new MysqlUserCommandRepository(db);
  const commandService = new UserCommandService(commandRepo);
  // 三级环境变量（技术方案 §5.6）：系统层 + 用户层 + 工作区层共用一套仓储/校验/缓存
  const envVariableService = new EnvVariableService(
    new MysqlEnvVariableRepository(db),
    cfg.app.gitCredential.secretKey,
    cfg.app.harness.workspaceRoot,
    { shellEnvVarsEnabled: () => settingService.shellEnvVarsEnabled() },
    async (userId) => (await gitCredentials.listByUserId(userId))
      .map((credential) => GitCredentialService.envVarNameForDomain(credential.domain)),
  );
  const weixinPref = new UserWeixinPreferenceService(new MysqlUserWeixinPreferenceRepository(db));
  const taskPanelPref = new UserTaskPanelPreferenceService(new MysqlUserTaskPanelPreferenceRepository(db));

  const pathSandbox = new PathSandbox(cfg.app.harness.workspaceRoot);
  const runtimeRoot = cfg.app.harness.runtimeDir;
  // 放行 runtime 目录，使 Agent 工具（读文件/Shell/Grep/Glob 等）可访问会话 runtime 下的上传文件。
  pathSandbox.addAllowedRoot(runtimeRoot);
  const sessionRepo = new SessionRepository(db);
  const messageRepo = new MessageRepository(db);
  // run 轨迹读模型：零新表，读时聚合消息 / llm_call / session_activity / 压缩事件。
  const llmCallRepo = new LlmCallRepository(db);
  const runTraceService = new RunTraceService(
    messageRepo,
    llmCallRepo,
    new SessionActivityRepository(db),
    new SessionCompactionEventRepository(db),
  );
  // run 轨迹记录详情读模型（技术方案 2026-10-22-run-trace-deep-dive §5.3）：只读，
  // 按需拉取参数 / 结果 / 计时与元信息，与 buildTrace 共用 messageRepo / llmCallRepo。
  const runTraceRecordService = new RunTraceRecordService(messageRepo, llmCallRepo);
  const feedbackRepository = new FeedbackRepository(db);
  const feedbackMessageLookup = new FeedbackDbLookup(db);
  const feedbackService = new FeedbackService(
    feedbackRepository,
    feedbackMessageLookup,
    async (sessionId) => {
      const session = await sessionRepo.findById(sessionId);
      return session?.userId ?? null;
    },
    async (sessionId) => {
      const session = await sessionRepo.findById(sessionId);
      return session?.agentId ?? null;
    },
    // 事务内回写反馈状态必须同事务（db.transaction 把连接包成新 Db 传回调）
    db,
  );  const fileChangeRepo = new FileChangeRepository(db);
  const compactionRepo = new SessionCompactionRepository(db);
  const sessionCompactionService = new SessionCompactionService(compactionRepo, messageRepo, sessionRepo);
  const sessionCompactionEventService = new SessionCompactionEventService(new SessionCompactionEventRepository(db));
  const envInfo = new EnvironmentInfoProvider();
  const runtimeResolver = new RuntimeDataResolver(cfg.app.harness.runtimeDir, cfg.app.harness.userHomeDir);
  const gitOps = new GitOperationService(gitLookup, runtimeResolver);
  const todoMapper = new SessionTodoMapper(db);
  const todoRepo = new SessionTodoRepository(db);
  // TerminalManager / 定时任务存储 / MCP 同步服务已迁移到 ctx（延迟解引用）
  // 审批放行规则（V135）：repo/service 早于 sessionService 与 toolDispatcher 构造（双向依赖）
  const approvalRuleRepo = new ApprovalRuleRepository(db);
  const approvalRuleService = new ApprovalRuleService(
    approvalRuleRepo,
    { getValue: (key) => settingService.getValue(key) },
    { getUserId: async (sessionId) => (await sessionRepo.findById(sessionId))?.userId ?? null },
  );
  // 会话级工作区规则快照（V153）：只依赖 db，必须早于 sessionService 构造——
  // onSessionDeleted 钩子在下面就要直接引用它（技术方案 §4.6 评审补充）。
  const workspaceRulesSnapshotRepo = new WorkspaceRulesSnapshotRepository(db);
  const workspaceRulesSnapshotService = new WorkspaceRulesSnapshotService(workspaceRulesSnapshotRepo);
  const sessionService = new SessionService(
    sessionRepo, messageRepo, fileChangeRepo,
    {
      findById: (id) => agentRepo.findById(id) as never,
      findByIds: (ids) => agentRepo.findByIds(ids) as never,
      requireDefaultAgent: () => agentService.requireDefaultAgent() as never,
      listOptions: async () => (await agentRepo.selectList(null, true)).map((a) => ({ id: a.id!, name: a.name })),
    },
    pathSandbox, envInfo, commandService, gitOps, sessionCompactionService, sessionCompactionEventService, todoRepo,
    runtimeSessionCleanup(runtimeRoot),
    (sessionId) => { ctx.terminalManagerRef?.closeBySession(sessionId); },
    // 会话删除后清理绑定资源：定时任务 + CLOUD MCP 快照（技术方案 §4.5 第 3 点，
    // 快照存活期是会话级，只在会话删除路径回收）。mcpSync 晚于本 service 构造，故延迟解引用。
    async (sessionId) => {
      await ctx.deleteScheduledTasksForSession?.(sessionId);
      ctx.mcpSyncRef?.clearCloudSnapshot(sessionId);
      // 工作区规则快照同理会话级资源，物理删行（技术方案 §4.6）
      await workspaceRulesSnapshotService.deleteBySessionId(sessionId);
    },
    (sessionId) => approvalRuleRepo.deleteBySessionId(sessionId),
  );
  const sessionSvc = sessionService as never;
  const sessionMap = sessionRepo as never;
  const compactionSvc = sessionCompactionService as never;

  const activityService = new ActivityService(new SessionActivityRepository(db));
  const messageQueueService = new MessageQueueService(new MessageQueueRepository(db));
  const subagentExecutionRepo = new SubagentExecutionRepository(db);
  const activityHeartbeat = new SessionActivityHeartbeat(sessionService);

  const fileRepo = new FileEntityRepository(db);
  const fileService = new FileService(fileRepo, uploadDir, async () => (await settingService.getUploadConfig()).maxSizeMb);
  const workspaceBrowse = new WorkspaceBrowseService(pathSandbox);
  const workspaceGit = new WorkspaceGitService(pathSandbox);

  const ossSts = new OssStsService(
    () => settingService.getOssConfig(),
    // 客户端创建失败时保留原始原因：静默替换会让「配置错误」和「网络抖动」都显示成同一条无信息量的错误
    async (sts) => {
      try {
        return await createAliyunAssumeRoleClient(sts);
      } catch (e) {
        console.error('创建 OSS STS 客户端失败', e);
        throw new Error(`创建 OSS STS 客户端失败: ${(e as Error).message}`);
      }
    },
  );

  const userSkillsDir = cfg.app.harness.userSkillsDir || resolve(process.env.HOME ?? '/tmp', '.mao/data/userskills');
  const skillLoader = new SkillLoader(pathSandbox, cfg.app.harness.skillsDir, cfg.app.harness.skillsCacheSeconds);
  const ecpInjector = createEcpCredentialsInjector(
    ecpSessionRepo,
    (userId) => runtimeResolver.resolveUserHomeDir(userId),
  );
  const larkUatInjector = createLarkUatInjector({
    ecpInjector,
    ecpClient: new EcpClient(),
    getConfig: () => settingService.getEcpConfig(),
  });
  const skillSync = new SkillSyncService(skillLoader, pathSandbox, runtimeResolver, userSkillsDir);
  const userSkillService = new UserSkillService(userSkillsDir, skillLoader);
  const skillDocService = new SkillDocService(skillLoader);
  // 资产分发闭环 P3：mao-skill-bundle v1 导出/导入
  const skillBundleService = new SkillBundleService(skillLoader, userSkillService);

  const weixinMcpServices = assembleWeixinMcpServices({
    db, cfg, ctx, pathSandbox, userRepo, agentRepo, settingService, earlyFeishuBinding,
  });
  const { weixinConfig, weixinAccounts, feishuBots, feishuBinding, weixinTokens, weixinSend, weixinUpload, weixinMedia, weixinToolSupport, wechatBridges, mcpCipher, mcpMapper, mcpPref, mcpServerService, mcpClient, mcpToolsRegistry, userMcpLoadModeService, mcpLoadModeResolver, mcpSync } = weixinMcpServices;

  // 会话删除路径要回收 CLOUD MCP 快照，而 mcpSync 晚于 sessionService 构造：先用引用占位。
  ctx.mcpSyncRef = mcpSync;

  // 飞书消息层先于 harness 装配：tool registry 的飞书工具在执行期通过闭包取用这里的
  // message service / client，晚绑定语义与原 create-app 单体版本一致；同时保证后续
  // wsHandler / 微信 / 钉钉 / GitCommitMessageService 拿到真实 harness 实例。
  const feishuMessaging = assembleFeishuMessaging({
    db, cfg, feishuBots, feishuBinding, userRepo, agentService, modelService, sessionService, routeChatClient,
  });
  const { feishuMessageRepository, feishuMessageService, getFeishuClient, getFeishuChatTitle, sendFeishuText } = feishuMessaging;

  // Agent 资产化：bundle 导出/导入（P1）+ registry/URL 导入/检查更新（P2 分发闭环）
  const mcpServerLookup = new MysqlMcpServerLookup(db);
  const agentImportOriginRepo = new AgentImportOriginRepository(db);
  const agentBundleService = new AgentBundleService(
    agentRepo, experienceService, suggestedQuestionService, skillLoader, userSkillService,
    mcpServerService, mcpMapper, mcpCipher,
    agentImportOriginRepo,
  );
  const llmEngine = assembleLlmEngine({
    harnessTuning, llmCallService, skillLoader, pathSandbox, runtimeResolver,
    commandService, skillSync, workspaceRulesSnapshotService, sessionSvc,
    compactionSvc, sessionCompactionEventService, settingService, modelRepo,
  });
  const { openAiLlmAdapter, anthropicLlmAdapter, responsesLlmAdapter, llmAdapter, promptEngine, tokenEstimator, compactionService, contextManager, compactionArchiveService, compactionConfig, historyLoader, activeContext, compactionModelResolver, orchestrator } = llmEngine;

  const backgroundTasks = new BackgroundTaskManager();
  const shellManager = new ShellSessionManager(
    pathSandbox, runtimeResolver,
    harnessTuning.shell.maxSessionsPerConversation,
    harnessTuning.shell.sessionIdleTimeoutMinutes,
    harnessTuning.shell.sessionMaxLifetimeHours,
    undefined,
    undefined,
    // 三级环境变量：host 侧查库 + 解密，每条命令前随 refreshUserEnvironment 刷新
    (userId, workspace) => envVariableService.resolveForSession(userId, workspace),
  );
  // 云端终端：与 shellManager 并列（后者是 Agent 的管道 shell，本类是用户的交互式 PTY）
  const terminalAudit = createTerminalAudit(auditService);
  // ── 用户运行时容器隔离（技术方案 §5）：host 模式下整组组件闲置、派发分支短路 ──
  const containerRuntime = await assembleContainerRuntime({
    cfg, ctx, jwt, sessionRepo, userRepo, settingService, runtimeResolver, gitLookup,
    envVariableService, uploadDir, userSkillsDir, shareDir, mcpClient, activityHeartbeat,
    ecpInjector, larkUatInjector,
  });
  const { cloudRuntimeCfg, containerChannelHolder, channelServer, containerRegistry, runtimeModeResolver, activateContainerRuntime, envelopeBuilder, dockerRouter, sendBytesBridge, mcpRuntimeProbe, routingMcpClient, ptyChannelHubs, ptyHubGeneration, containerPtyFactory, bootRuntimeMode } = containerRuntime;

  const terminalManager = new TerminalManager({
    pathSandbox,
    runtimeResolver,
    gitCredentials: gitLookup,
    shellToken: jwt,
    userLookup: { findById: (id: number) => userRepo.findById(id) as Promise<{ username: string } | null> },
    ecpInjector,
    larkUatInjector,
    // §5.13：仅容器用户注入 deps env（npm/pip 安装落到每用户 /deps 挂载），host 用户零变化
    depsEnvProvider: async (userId) =>
      (await dockerRouter.enabledFor(userId)) ? buildDepsEnv(cloudRuntimeCfg.container.depsDir, userId) : null,
    envVariableService,
    config: terminalCfg,
    audit: terminalAudit,
    ptyFactory: containerPtyFactory,
  });
  ctx.terminalManagerRef = terminalManager;
  const terminalWsHandler = new TerminalWsHandler({
    terminalManager,
    jwtService: jwt,
    permissionService,
    audit: terminalAudit,
  });
  const outputManager = new OutputManager(
    cfg.app.harness.shell.output.maxPreviewLines,
    cfg.app.harness.shell.output.maxPreviewChars,
  );
  const localSkills = new LocalSkillRegistry();
  const localAgentsMd = new LocalAgentsMdRegistry();
  const wsRegistry = new StreamingWsRegistry(cfg.app.ws.outboundQueueCapacity);
  const embedPageToolRegistry = new EmbedPageToolRegistry(
    wsRegistry, resolveEmbedPageToolTimeoutMs(cfg.app.harness.embedPageToolTimeoutSeconds),
  );
  const localToolSessions = new LocalToolSessionRegistry(wsRegistry, sessionMap);
  // 通知渠道与开放接口（触发器/订阅 secret）共用的 AES-GCM 密文工具（APP_NOTIFICATION_WEBHOOK_SECRET）
  const notifCipher = new WebhookSecretCipher(cfg.app.taskNotification.secretKey);
  // 开放接口出站订阅（P3）：先于 inboxService 构造，question.pending 分发经 InboxService
  // 可选回调接入同一收口（ask_user 派发点在工具层直调 recordQuestionPending）
  const outboundSubscriptionRepo = new MysqlOutboundSubscriptionRepository(db);
  const outboundDeliveryRepo = new MysqlOutboundDeliveryRepository(db);
  const outboundSubscriptionService = new OutboundSubscriptionService({
    subscriptionRepo: outboundSubscriptionRepo,
    deliveryRepo: outboundDeliveryRepo,
    cipher: notifCipher,
  });
  const inboxRepo = new InboxRepository(db);
  const inboxService = new InboxService(
    inboxRepo,
    wsRegistry as never,
    {
      // 标题查询失败降级由 service 内部处理（子会话标题查不到时回落 taskDescription）
      userIdOf: async (sessionId) => (await sessionService.getSession(sessionId))?.userId ?? null,
      titleOf: async (sessionId) => (await sessionService.getSession(sessionId))?.title ?? null,
    },
    // LOCAL/审批路径的 userId 兜底：复用 LocalToolSessionRegistry 的内存缓存 → session 表
    // → SUBAGENT 父会话三级回退（与 tool-dispatcher 同一路径），不新造 session 查询
    (sessionId) => localToolSessions.getUserIdForSession(sessionId),
    (input) => outboundSubscriptionService.dispatchQuestionPending(input),
  );
  const inboxCleanupStore: InboxCleanupStore = {
    deleteHistory: (cutoff) => inboxRepo.deleteHistory(cutoff).then(() => undefined),
  };
  const definitionRegistry = new AgentDefinitionRegistry();
  const subagentMapper = new SubagentExecutionMapper(db);
  const subagentInvocation = new SubagentInvocationService(db);
  const subagentResultDelivery = new SubagentResultDeliveryService(db, fileChangeRepo as never, inboxService);
  const askUserQuestionsRegistry = new AskUserQuestionsRegistry();
  const inFlightToolRegistry = new InFlightToolRegistry();
  const feishuAskFormStore = new FeishuAskFormStore();
  const feishuActiveProgress = new FeishuActiveProgressRegistry();
  const feishuAskMount = createFeishuAskMount(feishuAskFormStore, feishuActiveProgress);
  const approvalRegistry = new ApprovalRegistry(sessionSvc, sessionMap, wsRegistry);
  const treeSignalPublisher = new SessionTreeSignalPublisher(
    sessionRepo, approvalRegistry, askUserQuestionsRegistry, wsRegistry,
  );
  const localToolExecutor = new LocalToolExecutor(
    localToolSessions, approvalRegistry, treeSignalPublisher, cfg.app.harness.localToolTimeoutSeconds,
    inboxService,
  );
  const dangerAssessor = new DangerAssessor(llmAdapter);
  const proxyApprover = new ProxyApprover(llmAdapter);
  const jevRiskAssessor = new JevRiskAssessor({
    getValue: (key) => settingService.getValue(key),
    getSecretValue: (key) => settingService.getSecretValue(key),
  });
  const approvalModelResolver = new ApprovalModelResolver(
    (key) => settingService.getValue(key),
    (id) => modelRepo.findById(id),
  );
  // 用量预算服务（技术方案 §5.5-5.9）：消耗查询 + admission BLOCK + WARN 结算 + CRUD。
  // usage_budget 无外键：USER/AGENT 目标删除后预算行仍在（检查跳过、列表展示"已删除"）。
  const budgetService = new BudgetService(
    new BudgetRepository(db),
    new BudgetSpendStore(db),
    {
      findUser: async (id) => {
        const user = await userRepo.findById(id);
        return user ? { id: user.id!, name: user.username } : null;
      },
      findAgent: async (id) => {
        const agent = await agentRepo.findById(id);
        return agent ? { id: agent.id!, name: agent.name } : null;
      },
    },
    inboxService,
  );
  const agentExecutor = createAgentExecutor(
    agentRuntimeCfg.threadPoolSize,
    agentRuntimeCfg.threadPoolMax,
    agentRuntimeCfg.threadPoolQueue,
  );

  const holder: { harness?: HarnessService; loop?: AgentLoop; compactionSignalBus?: CompactionSignalBus } = {};
  const scheduledStore = new ScheduledTaskDbStore(db);
  ctx.deleteScheduledTasksForSession = (sessionId) => scheduledStore.deleteBySessionId(sessionId);

  const notifServices = assembleNotificationServices({
    db, settingService, userRepo, sessionRepo, sessionService, messageRepo, messageQueueService,
    modelRepo, llmAdapter, notifCipher,
  });
  const { senderRegistry, notifPref, weixinWebhookFallback, deliveryService, memoryRepo, memoryService, memoryExtraction, messageCitationService } = notifServices;

  const weixinInboundMessagesRef: { current: any } = { current: null };
  const sessionServices = assembleSessionServices({
    db, sessionService, sessionSvc, sessionMap, messageRepo, messageQueueService,
    activityService, activityHeartbeat, todoMapper, modelRepo, llmCallRepo,
    fileChangeRepo, wsRegistry, treeSignalPublisher, inboxService, budgetService,
    deliveryService, memoryExtraction, messageCitationService, outboundSubscriptionService,
    weixinWebhookFallback, weixinSend, weixinAccounts, weixinTokens, weixinInboundMessagesRef,
    definitionRegistry, subagentMapper, subagentInvocation, localToolSessions,
    scheduledStore, agentExecutor, holder,
    // 等待子代理期间父侧无 AgentLoop 事件，飞书进度卡靠它每 10s 续更一次子代理轮次。
    waitProgressNotifier: (sessionId: number) => {
      void feishuActiveProgress.refresh(sessionId).catch((error) => {
        console.warn(`飞书进度卡等待子代理期间刷新失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });
  const { taskTerminal, visibility, backgroundSubagentManager, scheduledService } = sessionServices;

  const dingtalkMediaHolder: { current: DingtalkMediaSendSupport | null } = { current: null };

  // 自定义 HTTP 工具（V166）：定义域 + 执行内核 + Agent 关联校验器。保留字校验要读内置工具名，
  // 而 registry 在下方创建，用惰性闭包打破循环（调用只发生在管理请求期）。
  const httpToolRepo = new MysqlHttpToolRepository(db);
  const httpToolCipher = new HttpToolHeaderCipher(cfg.app.httpTool.secretKey);
  const httpToolService = new HttpToolService({
    repo: httpToolRepo,
    cipher: httpToolCipher,
    builtinToolNames: () => (toolRegistry as any).getAllTools().map((tool: any) => tool.getName()),
  });
  // 放行名单走系统设置（5s TTL 缓存由内核持有）；试运行与 http_call 共用同一实例。
  const httpApiExecutor = new HttpApiExecutor({
    allowlistProvider: () => settingService.getPrivateAllowlistCidrs(),
  });
  // Agent 关联校验（镜像 mcpValidator 接线）：id 存在性 + 启用态。
  const httpToolValidator = new HttpToolValidatorImpl(new MysqlHttpToolLookup(db));

  // harness 必须在 wsHandler / 微信 / 钉钉 / GitCommitMessageService 之前装配：
  // 这些消费者在构造时就读取真实的 harness 与 agentLoop（holder 只是给运行期晚绑定用）。
  const harnessEngine = assembleHarnessEngine({
    cfg, apiPrefix, uploadDir, harnessTuning, pathSandbox, todoMapper, scheduledService,
    sessionSvc, sessionMap, shellManager, outputManager, backgroundTasks, gitLookup, jwt,
    userRepo, ecpInjector, larkUatInjector, settingService, runtimeResolver, modelService,
    wechatBridges, feishuMessageService, feishuMessageRepository, getFeishuClient,
    sendBytesBridge, dingtalkMediaHolder, definitionRegistry, holder, subagentMapper,
    subagentInvocation, localToolSessions, visibility, backgroundSubagentManager,
    messageRepo, compactionSvc, embedPageToolRegistry, mcpToolsRegistry, routingMcpClient,
    httpToolService, httpApiExecutor, llmAdapter, promptEngine, contextManager,
    compactionService, compactionArchiveService, compactionConfig, historyLoader,
    activeContext, orchestrator, tokenEstimator, compactionModelResolver,
    localToolExecutor, dangerAssessor, proxyApprover, jevRiskAssessor, approvalModelResolver,
    approvalRuleService, dockerRouter, approvalRegistry, askUserQuestionsRegistry, inFlightToolRegistry,
    treeSignalPublisher, deliveryService, feishuAskMount,
    inboxService, skillLoader, skillSync, localSkills, localAgentsMd, agentRepo,
    experienceService, modelRepo, fileChangeRepo, envInfo, db, mcpSync, mcpLoadModeResolver,
    activityHeartbeat, memoryService, wsRegistry,
  });
  const { toolRegistry, toolDispatcher, compactionSignalBus, agentLoop, harness } = harnessEngine;

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
  const gitCommitMsg = new GitCommitMessageService(llmAdapter as never, harness as never, usageService, { getValue: (key: string) => settingService.getValue(key) });
  const gitWrite = new GitWriteOperationService(
    workspaceGit, gitCommitMsg, gitLookup, runtimeResolver, activityService,
  );

  const weixinServices = assembleWeixinServices({
    db, sessionService, sessionRepo, agentService, modelService, settingService,
    weixinConfig, weixinAccounts, weixinTokens, weixinSend, weixinUpload, weixinMedia,
    weixinPref, harness, agentLoop, shellManager, wsRegistry, taskTerminal,
    activityService, activityHeartbeat, todoMapper, weixinWebhookFallback, llmAdapter, agentExecutor,
  });
  const { weixinSession, voiceSynthesis, voiceCodec, voiceReply, weixinFiles, weixinInboundHandler, weixinInboundMessages, inboundProcessor, weixinMonitor, qrLogin } = weixinServices;
  weixinInboundMessagesRef.current = weixinInboundMessages;


  const restToolService = new ToolService({
    getAllTools: () => (toolRegistry as any).getAllTools().map((t: any) => ({ name: t.getName(), description: t.getDescription() })),
    getTool: (name) => {
      const t = (toolRegistry as any).getTool(name);
      return t ? { name: t.getName(), description: t.getDescription() } : null;
    },
  });

  const openTriggerSettle: { current: ((triggerId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>) | null } = { current: null };
  const openCallSettle: { current: ((callLogId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', queueWaitMs: number | null, messageId: number | null) => Promise<void>) | null } = { current: null };
  const wsHandler = assembleWsHandler({
    cfg, jwt, wsRegistry, sessionTitleService, harnessService: harness, agentLoop, compactionSignalBus, sessionService, taskTerminal,
    messageQueueService, embedPageToolRegistry, localToolSessions, askUserQuestionsRegistry,
    treeSignalPublisher, approvalRegistry, approvalRuleService, activityService,
    activityHeartbeat, todoMapper, backgroundSubagentManager, shellManager,
    skillSync, localSkills, localAgentsMd, mcpSync, routingMcpClient,
    agentRepo, modelRepo, userRepo, agentExecutor, budgetService, scheduledService,
    openTriggerSettle, openCallSettle,
  });

  const openApiServices = assembleOpenApiServices({
    db, cfg, sessionService, messageQueueService, taskTerminal, agentRepo, wsHandler,
    budgetService, apiTokenService, inboxService, settingService, openApiRateLimiter,
    notifCipher, outboundSubscriptionService, holder, agentExecutor,
    openCallLogHolder, openTriggerSettle, openCallSettle,
  });
  const { openRunService, callLogService, callLogCleanup, webhookTriggerService, watcherService, watcherScheduler, signalCheckCleanup, digestService, digestScheduler, signalWatcherRepo } = openApiServices;


  const feishuHandler = assembleFeishuHandler({
    db, cfg, ctx,
    feishuBots, feishuBinding, userRepo, agentService, modelService, settingService,
    sessionService, sessionRepo, wsRegistry, harness, agentLoop, shellManager,
    feishuMessageRepository, feishuMessageService, getFeishuClient, getFeishuChatTitle, sendFeishuText,
    taskTerminal, scheduledService, feedbackService, feedbackMessageLookup,
    backgroundSubagentManager, localToolSessions, treeSignalPublisher, askUserQuestionsRegistry,
    ecpAuth, ecpSessionRepo, feishu, pendingBindingMessages, sessionTitleService,
    permissionService, routeChatClient, feishuActiveProgress, feishuAskFormStore,
    dingtalkMediaHolder, mcpServerLookup, activityService, activityHeartbeat, todoMapper,
    jwt,
  });
  const { feishuInboundHandler, feishuInboundProcessor, feishuCardActionService, feishuMonitor, dingtalk, feishuTaskQueue, feishuProgressCardRepo, createFeishuRecoveryProgress, analyticsService, statisticsService, adminAnalytics, httpToolStatsStore, mcpValidator } = feishuHandler;

  await registerAllRoutes({
    app, db, cfg, apiPrefix, jwt, agentRuntimeCfg,
    authService, feishu, ecpAuth, userService, userRepo, permissionService,
    gitCredentials, envVariableService, sessionRepo,
    httpToolService, httpApiExecutor, httpToolStatsStore,
    fileService, agentService, experienceService, suggestedQuestionService,
    agentBundleService, mcpValidator, httpToolValidator,
    modelService,
    settingService, activateContainerRuntime, runtimeModeResolver,
    commandService, commandRepo, skillLoader, skillSync,
    weixinPref, taskPanelPref,
    restToolService,
    auditService,
    llmCallService,
    sessionService, activityService, messageQueueService,
    agentRepo, modelRepo, todoRepo, pathSandbox, subagentExecutionRepo,
    sessionCompactionEventService, sessionCompactionService, runTraceService, runTraceRecordService,
    approvalRegistry, askUserQuestionsRegistry, inFlightToolRegistry, treeSignalPublisher,
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
  });

  const { closeApp } = assembleLifecycle({
    app, db, cfg, ctx,
    scheduledStore, scheduledService, settingService, notifCipher, senderRegistry,
    sessionService, outboundDeliveryRepo, outboundSubscriptionRepo, auditService,
    agentExecutor, inboxCleanupStore, callLogService, callLogCleanup,
    ecpSessionRepo, weixinMonitor, feishuMonitor, dingtalk, pendingBindingMessages,
    shellManager, terminalManager, wsHandler, subagentMapper, sessionMap, sessionSvc,
    compactionSvc, definitionRegistry, backgroundSubagentManager, agentLoop: holder.loop!, visibility,
    localToolSessions, subagentResultDelivery, taskTerminal, harness: holder.harness!, wsRegistry,
    activityService, activityHeartbeat, todoMapper, modelRepo, feishuProgressCardRepo,
    feishuInboundHandler, feishuTaskQueue, createFeishuRecoveryProgress,
    weixinInboundHandler, feishuInboundProcessor, watcherScheduler, signalCheckCleanup,
    ptyChannelHubs, ptyHubGeneration, containerRegistry, channelServer,
  });

  return {
    app,
    close: closeApp,
  };
}
