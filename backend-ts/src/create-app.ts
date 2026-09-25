import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fail } from './common/result.js';
import { fastifyLoggerOptions, redactCredentialQuery } from './common/structured-logger.js';
import { sendJson, handleError } from './common/http-error.js';
import { loadConfig, type AppConfig } from './config/app-config.js';
import { corsForRequest } from './config/cors-policy.js';
import { loadTrustedProxyAddresses } from './config/trusted-proxy.js';
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
import { CompanySsoClient } from './auth/company-sso.client.js';
import { CompanySsoIdentityRepository } from './auth/company-sso-identity.repository.js';
import { CompanySsoService } from './auth/company-sso.service.js';
import { registerCompanySsoRoutes } from './auth/company-sso.routes.js';
import { CompanySsoError } from './auth/company-sso.error.js';
import { EcpAuthService } from './auth/ecp-auth.service.js';
import { createEcpCredentialsInjector } from './auth/ecp-credentials-injector.js';
import { EcpClient } from './auth/ecp.client.js';
import { EcpIdentityRepository } from './auth/ecp-identity.repository.js';
import { createLarkUatInjector } from './auth/lark-uat-injector.js';
import { MysqlEcpOauthStateRepository } from './auth/ecp-oauth.repository.js';
import { EcpRenewScheduler } from './auth/ecp-renew.scheduler.js';
import { registerEcpAuthRoutes } from './auth/ecp.routes.js';
import { MysqlEcpSessionRepository } from './auth/ecp-session.repository.js';
import { MysqlUserRepository } from './user/user.repository.js';
import { UserService } from './user/user.service.js';
import { registerUserRoutes } from './user/user.routes.js';
import { GitCredentialService, assertGitCredentialSecret } from './user/git-credential.service.js';
import { registerAdminGitCredentialRoutes, registerGitCredentialRoutes } from './user/git-credential.routes.js';
import {
  MysqlPermissionRepository,
  MysqlRolePermissionRepository,
  MysqlRoleRepository,
  MysqlUserRoleRepository,
} from './permission/permission.repository.js';
import { PermissionService } from './permission/permission.service.js';
import { registerPermissionRoutes } from './permission/permission.routes.js';
import { MysqlAgentExperienceRepository, MysqlAgentRepository, MysqlAgentSuggestedQuestionRepository } from './agent/agent.repository.js';
import { AgentExperienceService } from './agent/agent-experience.service.js';
import { AgentSuggestedQuestionService } from './agent/agent-suggested-question.service.js';
import { AgentService } from './agent/agent.service.js';
import { registerAgentAvatarRoutes } from './agent/agent-avatar.js';
import { registerAgentRoutes } from './agent/agent.routes.js';
import { McpServerValidatorImpl, MysqlMcpServerLookup } from './agent/mcp-validator.js';
import { MysqlLlmModelRepository, MysqlSessionModelRepository } from './model/model.repository.js';
import { OpenAiChatClient } from './model/llm-chat.client.js';
import { AnthropicChatClient } from './model/anthropic-chat.client.js';
import { ResponsesChatClient } from './model/responses-chat.client.js';
import type { LlmChatClient, LlmModelConfig } from './model/types.js';
import { ModelService } from './model/model.service.js';
import { registerModelRoutes } from './model/model.routes.js';
import { MysqlSystemSettingRepository } from './settings/settings.repository.js';
import { SystemSettingService } from './settings/settings.service.js';
import { runSettingsBootstrap } from './settings/settings-bootstrap.js';
import { registerSystemSettingRoutes } from './settings/settings.routes.js';
import { MysqlUserCommandRepository } from './command/command.repository.js';
import { UserCommandService } from './command/command.service.js';
import { registerCommandRoutes } from './command/command.routes.js';
import { registerAdminSystemCommandRoutes } from './command/admin-system-command.routes.js';
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
import { recordAudit, truncateAuditError } from './audit/audit.interceptor.js';
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
import { OssStsService, createAliyunAssumeRoleClient } from './oss/oss-sts.service.js';
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
import { AnthropicLlmAdapter } from './harness/llm/anthropic-llm-adapter.js';
import { ResponsesLlmAdapter } from './harness/llm/responses-llm-adapter.js';
import { LlmAdapterFacade } from './harness/llm/llm-adapter-facade.js';
import type { LlmAdapter } from './harness/llm/chat-request.js';
import { createDefaultToolRegistry } from './harness/tool/tool-registry.js';
import { ToolDispatcher } from './harness/tool/tool-dispatcher.js';
import { DangerAssessor } from './harness/tool/danger-assessor.js';
import { AskUserQuestionsRegistry } from './harness/tool/ask-user-questions-registry.js';
import { AgentLoop } from './harness/core/agent-loop.js';
import { HarnessService } from './harness/core/harness-service.js';
import { PromptEngine } from './harness/core/prompt-engine.js';
import { ContextManager } from './harness/core/context-manager.js';
import { CompactionService } from './harness/core/compaction-service.js';
import { CompactionArchiveService } from './harness/core/compaction-archive.service.js';
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
import { RuntimeCleanupScheduler } from './harness/runtime/runtime-cleanup-scheduler.js';
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
import { EmbedPageToolRegistry, resolveEmbedPageToolTimeoutMs } from './harness/embed-page-tool-registry.js';
import { StreamingWsHandler } from './session/ws/streaming-ws-handler.js';
import { attachWebSocket } from './session/ws/attach-websocket.js';
import { TerminalManager, TERMINAL_AUDIT_META, type TerminalAuditRecorder } from './harness/terminal/terminal-manager.js';
import { TerminalWsHandler } from './harness/terminal/terminal-ws-handler.js';
import { registerTerminalRoutes } from './session/terminal.routes.js';
import { WeixinAccountRepository } from './weixin/account.repository.js';
import { ContextTokenRepository } from './weixin/context-token.repository.js';
import { WeixinSessionPeerRepository } from './weixin/session-peer.repository.js';
import { configureWeixinSessionPeerStore } from './weixin/session-peer.js';
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
import { userMessagePreviewOf } from './notification/task/user-message-preview.js';
import { TaskNotificationDeliveryService } from './notification/task/delivery.service.js';
import { WebhookSenderRegistry, DingTalkWebhookSender, FeishuWebhookSender } from './notification/task/webhook-sender.js';
import { WebhookUrlValidator } from './notification/task/webhook-url-validator.js';
import { LlmUsageRepository, LlmUsageService } from './usage/llm-usage.service.js';
import { LlmCallRepository } from './usage/llm-call.repository.js';
import { LlmCallService } from './usage/llm-call.service.js';
import { RecordingLlmAdapter } from './usage/recording-llm-adapter.js';
import { RecordingLlmChatClient } from './usage/recording-llm-chat-client.js';
import { registerLlmCallRoutes } from './usage/llm-call.routes.js';
import * as Lark from '@larksuiteoapi/node-sdk';
import { decryptAesGcm } from './crypto/aes-gcm.js';
import { MysqlFeishuBotRepository } from './feishu/feishu_bot.repository.js';
import { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';
import { registerFeishuBotRoutes } from './feishu/admin.routes.js';
import { registerFeishuBindingRoutes } from './feishu/binding.routes.js';
import { FeishuMonitorService } from './feishu/monitor.service.js';
import { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import { FeishuMessageService, botSenderLabel, formatGroupTime, isBotSender, senderName } from './feishu/message.service.js';
import { buildQuotedInjection } from './feishu/quoted-injection.js';
import { GroupContextSummarizer } from './feishu/group-context-summarizer.js';
import type { ClientImpersonation } from '@mao/contracts';
import { FeishuInboundProcessor } from './feishu/inbound-processor.js';
import { MysqlFeishuPendingBindingRepository } from './feishu/pending-binding.repository.js';
import {
  completeFeishuPendingAfterEcp,
  FEISHU_ECP_IDENTITY_MISMATCH_TEXT,
  buildFeishuAuthGuideCard,
  feishuUnauthorizedFallbackText,
  feishuUnauthorizedGuide,
  persistFeishuPendingAuth,
  senderUnionIdOf,
  startFeishuChannelAuthLink,
} from './feishu/ecp-inbound-gate.js';
import { hasUsableEcpSession } from './auth/ecp-session.repository.js';
import { AgentFeishuInboundHandler } from './feishu/agent-inbound-handler.js';
import { FeishuInboundQueueRepository } from './feishu/inbound-queue.repository.js';
import { MysqlFeishuProgressCardRepository } from './feishu/progress-card.repository.js';
import { FeishuTaskQueueService } from './feishu/inbound-queue.service.js';
import { FeishuCardActionService } from './feishu/card-action.service.js';
import { persistFeishuCancelIfIdle } from './feishu/cancel-running.js';
import { readFeishuDocMarkdown } from './feishu/doc-reader.js';
import { fetchFeishuMessageDetail } from './feishu/message-detail.js';
import { feishuSendTargetOf, sendFeishuFile, sendFeishuImage } from './feishu/media-sender.js';
import { FeishuCardProgressListener, countCompletedAgentRounds, type FeishuCardProgress } from './feishu/card-progress-listener.js';
import { createDingtalkRuntime } from './dingtalk/runtime.js';
import type { DingtalkMediaSendSupport } from './harness/tool/impl/dingtalk-tools.js';
import { buildFeishuProgressCard, feishuSessionDetailUrl } from './feishu/progress-card.js';
import { FeishuAskFormStore } from './feishu/ask-form-store.js';
import { FeishuActiveProgressRegistry } from './feishu/active-progress.js';
import { createFeishuAskMount } from './feishu/ask-mount.js';
import { createFeishuPatchedProgress, type FeishuProgressHandle } from './feishu/patched-progress.js';
import { wsEvent } from './session/ws/ws-event.js';
import { inboundImageKeys } from './feishu/event-normalizer.js';
import { chatFilesDirOf } from './feishu/chat-files.js';
import type { FeishuInboundContext, FeishuNormalizedMessage } from './feishu/types.js';
import { WsStreamingEventListener } from './session/ws/ws-streaming-event-listener.js';

export interface MaoApp {
  app: FastifyInstance;
  close(): Promise<void>;
}

function resolveFeishuChatWorkspace(root: string, accountId: string, leaf: string): string {
  const safeAccountId = encodeURIComponent(accountId);
  const safeLeaf = encodeURIComponent(leaf);
  const workspaceRoot = resolve(root);
  const workspace = resolve(workspaceRoot, 'feishu-chat', safeAccountId, safeLeaf);
  for (const candidate of [workspaceRoot, resolve(workspaceRoot, 'feishu-chat'), resolve(workspaceRoot, 'feishu-chat', safeAccountId)]) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) throw new Error('飞书会话工作区路径不允许符号链接');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const rel = relative(workspaceRoot, workspace);
  if (rel.startsWith('..') || rel.includes('..' + '/') || rel.startsWith('/')) {
    throw new Error('飞书会话工作区路径非法');
  }
  return workspace;
}

/** 文件落盘文件名清洗：去除路径分隔符与穿越片段，仅保留 basename。 */
function sanitizeFeishuFileName(name: string | null | undefined, fallback: string): string {
  const raw = (name ?? '').trim();
  if (raw === '') return fallback;
  const basename = raw.replace(/\\/g, '/').split('/').pop() ?? fallback;
  const cleaned = basename.replace(/[^\w.\u4e00-\u9fa5-]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? fallback : cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned;
}

/** 引用消息注入文本截断：告警堆栈等长内容防止撑爆用户消息。 */
function truncateQuoted(text: string, maxLength = 1500): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…（引用内容过长已截断）`;
}

/** 下载消息资源（图片/文件），流式收集并校验大小上限（字节），超限抛错。 */
async function downloadFeishuMediaBuffer(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  maxBytes: number,
): Promise<{ buffer: Buffer; contentType: string }> {
  const result = await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  const contentType = String((result as { headers?: Record<string, string> }).headers?.['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
  const stream = result.getReadableStream();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error(`飞书资源超出大小限制: ${total} > ${maxBytes}`);
    chunks.push(buffer);
  }
  return { buffer: Buffer.concat(chunks), contentType };
}

function dataUriOf(contentType: string, buffer: Buffer): string {
  return `data:${contentType || 'image/jpeg'};base64,${buffer.toString('base64')}`;
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
  const ldap = new LdapAuthService(userRepo, userRoleRepo, jwt, async () => (await settingService.getLdapConfig()));
  const authService = new AuthService(userRepo, jwt, hasher, ldap, permissionService);
  const earlyFeishuBinding = new MysqlFeishuBindingRepository(db);
  const pendingBindingMessages = new MysqlFeishuPendingBindingRepository(db);
  let pendingBindingProcessor: FeishuInboundProcessor | undefined;
  let notifyFeishuPendingMismatch: ((pending: { appId: number; event: FeishuNormalizedMessage }) => Promise<void>) | undefined;
  const feishu = new FeishuAuthService(
    userRepo, userRoleRepo, new MysqlFeishuOauthStateRepository(db), jwt, async () => (await settingService.getFeishuOAuthConfig()),
    undefined,
    async (user, targetUserId, state) => {
      if (user.id != null && user.feishuUserId != null && user.feishuUserId !== '') {
        await earlyFeishuBinding.bind(targetUserId ?? user.id, user.feishuUserId);
      }
      if (state != null && pendingBindingProcessor != null) {
        const pending = await pendingBindingMessages.claim(state);
        if (pending != null) {
          try {
            await pendingBindingProcessor.process(String(pending.appId), { ...pending.event, progressCardMessageId: pending.cardMessageId }, true);
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
          if (pendingBindingProcessor == null) throw new Error('飞书入站处理器未就绪');
          await pendingBindingProcessor.process(
            String(pending.appId),
            { ...pending.event, progressCardMessageId: pending.cardMessageId },
            true,
          );
        },
        complete: (s) => pendingBindingMessages.complete(s),
        release: (s) => pendingBindingMessages.release(s),
        failClaimed: (s) => pendingBindingMessages.failClaimed(s),
        notifyMismatch: async (pending) => {
          await notifyFeishuPendingMismatch?.(pending);
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

  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url.split('?')[0] === ssoExchangePath) return;
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
      queryString: request.url.includes('?') ? redactCredentialQuery(request.url).split('?')[1] : undefined,
      ip: request.ip,
      status: reply.statusCode,
      userId: request.userId,
      username: user?.username,
    });
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
  const weixinPref = new UserWeixinPreferenceService(new MysqlUserWeixinPreferenceRepository(db));
  const taskPanelPref = new UserTaskPanelPreferenceService(new MysqlUserTaskPanelPreferenceRepository(db));

  const pathSandbox = new PathSandbox(cfg.app.harness.workspaceRoot);
  const runtimeRoot = cfg.app.harness.runtimeDir;
  // 放行 runtime 目录，使 Agent 工具（读文件/Shell/Grep/Glob 等）可访问会话 runtime 下的上传文件。
  pathSandbox.addAllowedRoot(runtimeRoot);
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
  // TerminalManager 依赖 runtimeResolver（稍后构造），此处先占位，供会话删除回调延迟解引用
  let terminalManagerRef: TerminalManager | null = null;
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
    (sessionId) => { terminalManagerRef?.closeBySession(sessionId); },
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
    async (sts) => createAliyunAssumeRoleClient(sts).catch(() => ({
      assumeRole: async () => {
        throw new Error('OSS STS 客户端不可用');
      },
    })),
  );

  const userSkillsDir = cfg.app.harness.userSkillsDir || resolve(process.env.HOME ?? '/tmp', '.mao/data/userskills');
  const skillLoader = new SkillLoader(pathSandbox, cfg.app.harness.skillsDir, cfg.app.harness.skillsCacheSeconds);
  const runtimeResolver = new RuntimeDataResolver(cfg.app.harness.runtimeDir, cfg.app.harness.userHomeDir);
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
  const feishuBots = new MysqlFeishuBotRepository(db);
  const feishuBinding = earlyFeishuBinding;
  const weixinTokens = new ContextTokenRepository(db);
  const weixinPeerRepo = new WeixinSessionPeerRepository(db);
  configureWeixinSessionPeerStore({
    save: (sessionId, wxUserId) => weixinPeerRepo.save(sessionId, wxUserId),
    load: (sessionId) => weixinPeerRepo.findBySessionId(sessionId),
  });
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
    listAll: () => agentRepo.selectList(null, true),
    selectList: () => agentRepo.selectList(null, true),
  });
  const mcpClient = new McpClientManager(cfg.app.mcp.clientTimeoutSeconds);
  const mcpToolsRegistry = new McpToolsRegistry();
  const mcpSync = new McpSyncService(mcpMapper, mcpServerService, mcpToolsRegistry, mcpPref);

  const openAiLlmAdapter = new OpenAiLlmAdapter({
    rateLimitMaxRetries: harnessTuning.llm.rateLimitMaxRetries,
    rateLimitRetryDelaySeconds: harnessTuning.llm.rateLimitRetryDelaySeconds,
    rateLimitMaxRetryDelaySeconds: harnessTuning.llm.rateLimitMaxRetryDelaySeconds,
    callTimeoutSeconds: harnessTuning.llm.callTimeoutSeconds,
    httpCallTimeoutSeconds: harnessTuning.llm.httpCallTimeoutSeconds,
    streamIdleTimeoutSeconds: harnessTuning.llm.streamIdleTimeoutSeconds,
  });
  const anthropicLlmAdapter = new AnthropicLlmAdapter({
    rateLimitMaxRetries: harnessTuning.llm.rateLimitMaxRetries,
    rateLimitRetryDelaySeconds: harnessTuning.llm.rateLimitRetryDelaySeconds,
    rateLimitMaxRetryDelaySeconds: harnessTuning.llm.rateLimitMaxRetryDelaySeconds,
    callTimeoutSeconds: harnessTuning.llm.callTimeoutSeconds,
    httpCallTimeoutSeconds: harnessTuning.llm.httpCallTimeoutSeconds,
    streamIdleTimeoutSeconds: harnessTuning.llm.streamIdleTimeoutSeconds,
  });
  const responsesLlmAdapter = new ResponsesLlmAdapter({
    rateLimitMaxRetries: harnessTuning.llm.rateLimitMaxRetries,
    rateLimitRetryDelaySeconds: harnessTuning.llm.rateLimitRetryDelaySeconds,
    rateLimitMaxRetryDelaySeconds: harnessTuning.llm.rateLimitMaxRetryDelaySeconds,
    callTimeoutSeconds: harnessTuning.llm.callTimeoutSeconds,
    httpCallTimeoutSeconds: harnessTuning.llm.httpCallTimeoutSeconds,
    streamIdleTimeoutSeconds: harnessTuning.llm.streamIdleTimeoutSeconds,
  });
  const llmAdapter = new RecordingLlmAdapter(
    new LlmAdapterFacade(
      new Map<string, LlmAdapter>([
        ['anthropic', anthropicLlmAdapter],
        ['openai-responses', responsesLlmAdapter],
      ]),
      openAiLlmAdapter,
    ),
    llmCallService,
  );
  const promptEngine = new PromptEngine(skillLoader, pathSandbox, runtimeResolver, commandService, skillSync);
  const tokenEstimator = new TokenEstimator();
  const compactionService = new CompactionService(llmAdapter, tokenEstimator);
  const contextManager = new ContextManager(tokenEstimator, compactionService);
  const compactionArchiveService = new CompactionArchiveService(runtimeResolver);
  const compactionConfig = new CompactionConfig();
  compactionConfig.enabled = harnessTuning.compaction.enabled;
  compactionConfig.contextWindowTokens = harnessTuning.compaction.contextWindowTokens;
  compactionConfig.triggerRatio = harnessTuning.compaction.triggerRatio;
  compactionConfig.maxSummaryTokens = harnessTuning.compaction.maxSummaryTokens;
  compactionConfig.loopMidwayCompact = harnessTuning.compaction.loopMidwayCompact;
  const historyLoader = new SessionHistoryLoader(sessionSvc, contextManager, compactionArchiveService);
  const activeContext = new ActiveContextCalculator(tokenEstimator);
  const orchestrator = new SessionCompactionOrchestrator(
    compactionSvc, sessionCompactionEventService, historyLoader,
    contextManager, sessionSvc, activeContext, promptEngine, compactionArchiveService,
  );
  const backgroundTasks = new BackgroundTaskManager();
  const shellManager = new ShellSessionManager(
    pathSandbox, runtimeResolver,
    harnessTuning.shell.maxSessionsPerConversation,
    harnessTuning.shell.sessionIdleTimeoutMinutes,
    harnessTuning.shell.sessionMaxLifetimeHours,
  );
  // 云端终端：与 shellManager 并列（后者是 Agent 的管道 shell，本类是用户的交互式 PTY）
  const terminalAudit: TerminalAuditRecorder = (event, terminal, ctx) => {
    const meta = TERMINAL_AUDIT_META[event];
    void auditService.record({
      action: meta.action,
      objectType: 'terminal',
      objectId: terminal.terminalId,
      method: meta.method,
      path: meta.path(terminal.sessionId, terminal.terminalId),
      userId: terminal.userId,
      username: ctx?.username ?? null,
      ip: ctx?.ip ?? null,
      status: ctx?.errorMessage == null ? 200 : 500,
      success: ctx?.errorMessage == null ? 1 : 0,
      errorMessage: truncateAuditError(ctx?.errorMessage),
    }).catch((e) => console.error('Failed to record terminal audit log', e));
  };
  const terminalManager = new TerminalManager({
    pathSandbox,
    runtimeResolver,
    gitCredentials: gitLookup,
    shellToken: jwt,
    userLookup: { findById: (id: number) => userRepo.findById(id) as Promise<{ username: string } | null> },
    ecpInjector,
    larkUatInjector,
    config: terminalCfg,
    audit: terminalAudit,
  });
  terminalManagerRef = terminalManager;
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
  const definitionRegistry = new AgentDefinitionRegistry();
  const subagentMapper = new SubagentExecutionMapper(db);
  const subagentInvocation = new SubagentInvocationService(db);
  const subagentResultDelivery = new SubagentResultDeliveryService(db, fileChangeRepo as never);
  const askUserQuestionsRegistry = new AskUserQuestionsRegistry();
  const feishuAskFormStore = new FeishuAskFormStore();
  const feishuActiveProgress = new FeishuActiveProgressRegistry();
  const feishuAskMount = createFeishuAskMount(feishuAskFormStore, feishuActiveProgress);
  const approvalRegistry = new ApprovalRegistry(sessionSvc, sessionMap, wsRegistry);
  const treeSignalPublisher = new SessionTreeSignalPublisher(
    sessionRepo, approvalRegistry, askUserQuestionsRegistry, wsRegistry,
  );
  const localToolExecutor = new LocalToolExecutor(
    localToolSessions, approvalRegistry, treeSignalPublisher, cfg.app.harness.localToolTimeoutSeconds,
  );
  const dangerAssessor = new DangerAssessor(llmAdapter);
  const agentExecutor = createAgentExecutor(
    agentRuntimeCfg.threadPoolSize,
    agentRuntimeCfg.threadPoolMax,
    agentRuntimeCfg.threadPoolQueue,
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

  const dingtalkMediaHolder: { current: DingtalkMediaSendSupport | null } = { current: null };
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
    shellEcpInjector: ecpInjector,
    shellLarkUatInjector: larkUatInjector,
    webSearch: () => settingService.getWebSearchConfig(),
    webPage: harnessTuning.webPage,
    runtimeDataResolver: runtimeResolver,
    imageModelLookup: modelService,
    uploadDir,
    getUploadBaseUrl: async () => (await settingService.getUploadConfig()).baseUrl,
    weixinToolSupport: wechatBridges.toolSupport,
    weixinUploadService: wechatBridges.uploadService,
    weixinSendService: wechatBridges.sendService,
    feishuToolSupport: {
      resolveBotAppId: async (sessionId) => {
        if (sessionId == null) return null;
        // 会话 → 通道绑定（创建时落行、不可变）：多会话并行下活跃指针行查不到非活跃会话，必须走绑定表。
        const channel = await feishuMessageService.findSessionChannel(sessionId);
        return channel?.appId ?? null;
      },
    },
    feishuDocReader: {
      readMarkdown: async (appId, link) => {
        const client = await getFeishuClient(Number(appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${appId}`);
        return readFeishuDocMarkdown(client, link);
      },
    },
    feishuMediaDownloader: {
      download: async (appId, messageId, fileKey, type, maxBytes) => {
        const client = await getFeishuClient(Number(appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${appId}`);
        return downloadFeishuMediaBuffer(client, messageId, fileKey, type, maxBytes);
      },
    },
    feishuGroupMediaLookup: { findMediaByMessageId: (messageId: string) => feishuMessageRepository.findMediaByMessageId(messageId) } as never,
    feishuMessageDetailFetcher: {
      fetchMessageDetail: async (appId, messageId) => {
        const client = await getFeishuClient(Number(appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${appId}`);
        const detail = await fetchFeishuMessageDetail(client, messageId);
        return detail == null ? null : { fileKey: detail.fileKey ?? null, fileName: detail.fileName ?? null, msgType: detail.msgType };
      },
    },
    feishuMaxInboundFileBytes: Math.max(1, cfg.feishu.bot.file.maxInboundFileMb) * 1024 * 1024,
    feishuMediaSendSupport: {
      resolveSendTarget: async (sessionId) => {
        if (sessionId == null) return null;
        // 会话 → 通道绑定（创建时落行、不可变）：多会话并行下活跃指针行查不到非活跃会话，必须走绑定表。
        const channel = await feishuMessageService.findSessionChannel(sessionId);
        if (channel == null) return null;
        const target = feishuSendTargetOf(channel.appId, channel.chatId);
        // 查最新入站消息 ID，用于 reply 发送（群聊话题中落入当前话题、私聊中 reply 到用户消息）。
        const replyMessageId = await feishuMessageService.findLatestInboundMessageId(sessionId, channel);
        if (replyMessageId != null) target.replyMessageId = replyMessageId;
        return target;
      },
      sendImage: async (target, image, sessionId) => {
        const client = await getFeishuClient(Number(target.appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${target.appId}`);
        const messageId = await sendFeishuImage(client, target, image);
        // 私聊图片出站消息可被回复/引用，记录归属映射供引用切换定位。
        if (messageId != null && sessionId != null && target.receiveIdType !== 'chat_id') {
          await feishuMessageService.recordP2pMessage(target.appId, messageId, sessionId, 'OUT');
        }
      },
      sendFile: async (target, fileName, file, sessionId) => {
        const client = await getFeishuClient(Number(target.appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${target.appId}`);
        const messageId = await sendFeishuFile(client, target, fileName, file);
        if (messageId != null && sessionId != null && target.receiveIdType !== 'chat_id') {
          await feishuMessageService.recordP2pMessage(target.appId, messageId, sessionId, 'OUT');
        }
      },
    },
    dingtalkMediaSendSupport: {
      resolveSendTarget: (sessionId) => dingtalkMediaHolder.current?.resolveSendTarget(sessionId) ?? Promise.resolve(null),
      sendImage: async (target, bytes, fileName) => {
        if (dingtalkMediaHolder.current == null) throw new Error('钉钉通道未就绪');
        return dingtalkMediaHolder.current.sendImage(target, bytes, fileName);
      },
      sendFile: async (target, fileName, bytes) => {
        if (dingtalkMediaHolder.current == null) throw new Error('钉钉通道未就绪');
        return dingtalkMediaHolder.current.sendFile(target, fileName, bytes);
      },
    },
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
    embedPageToolRegistry,
  });

  const toolDispatcher = new ToolDispatcher(
    toolRegistry, localToolExecutor, dangerAssessor, sessionMap,
    wsRegistry, askUserQuestionsRegistry, localToolSessions, treeSignalPublisher,
    backgroundTasks, deliveryService, feishuAskMount,
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
    { isEmbedSession: (sid: number) => embedPageToolRegistry.isEmbedSession(sid) },
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
  const gitCommitMsg = new GitCommitMessageService(llmAdapter as never, harness as never, usageService, { getValue: (key: string) => settingService.getValue(key) });
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
    embedPageToolRegistry,
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
    // busy 入队的定时任务在队列真正执行到终态后回写 lastExecutionStatus
    onScheduledTaskQueueConsumed: async (taskId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => {
      await scheduledStore.updateById({ id: taskId, lastExecutionStatus: status });
    },
  } as never);
  scheduledService.setLiveExecution((session, userId, executionId, saved) =>
    wsHandler.executePersistedUserPrompt(session, userId, executionId, saved));
  scheduledService.setSessionBusyCheck((sessionId) => wsHandler.hasExecutionClaim(sessionId));

  const feishuMessageRepository = new MysqlFeishuMessageRepository(db);
  const feishuMessageService = new FeishuMessageService(
    feishuMessageRepository,
    {
      create: async (accountId, context) => {
        const bot = await feishuBots.findById(Number(accountId));
        if (bot == null) throw new Error(`飞书Bot不存在: ${accountId}`);
        const unionId = context.senderUnionId ?? context.senderId;
        const userId = unionId == null ? null : await feishuBinding.findUserIdByUnionId(unionId);
        const user = userId == null ? null : await userRepo.findById(userId);
        if (user?.id == null) throw new Error(`飞书用户未绑定: ${context.senderId ?? ''}`);
        const agent = bot.agentId != null ? await agentService.getAgent(bot.agentId) : await agentService.requireDefaultAgent();
        const model = bot.modelId != null ? await modelService.getModel(bot.modelId) : await modelService.getDefaultModel();
        // 工作区：群聊按群 ID、私聊按 mao 用户 ID 隔离。私聊必须有工作区，否则入站文件
        // 无处落盘（downloadMedia 与 feishu_download_file 均依赖 session.workspace）。
        const workspaceLeaf = context.chatType === 'group' && context.chatId != null ? context.chatId! : `private-${user.id}`;
        const workspace = resolveFeishuChatWorkspace(cfg.app.harness.workspaceRoot, accountId, workspaceLeaf);
        mkdirSync(workspace, { recursive: true });
        const isGroup = context.chatType === 'group' && context.chatId != null;
        // 话题会话不预填群名，用默认标题，留给首条消息命名机制（awaitingFirstMessageTitle）重命名。
        const title = isGroup && context.threadId == null
          ? (await getFeishuChatTitle(Number(accountId), context.chatId!)) || '飞书Bot会话'
          : '飞书Bot会话';
        const session = await sessionService.createSession(
          user.id, agent.id, title, 'CLOUD', workspace, 'FULL', false,
          'linux', '/bin/bash', 'Linux', model?.id ?? null,
          isGroup ? `feishu-chat-${accountId}-${context.chatId}` : `feishu-${accountId}-private-${user.id}`,
          'new', null, null,
        );
        return { sessionId: session.id!, ownerUserId: user.id, workspace: session.workspace };
      },
    },
    cfg.feishu.bot.groupContext.maxItems,
    cfg.feishu.bot.groupContext.maxMinutes,
    new GroupContextSummarizer(routeChatClient, async (sessionId) => {
      // 溢出摘要优先用会话绑定的模型；会话未绑定（或模型已被删除）时回退系统默认模型，仍无则跳过摘要。
      const session = await sessionService.getSession(sessionId);
      const model = session?.modelId != null
        ? await modelService.getModel(session.modelId).catch(() => null)
        : await modelService.getDefaultModel();
      if (model == null || model.baseUrl === '' || model.modelId === '') return null;
      return {
        baseUrl: model.baseUrl, apiKey: model.apiKey, modelId: model.modelId,
        provider: model.provider ?? undefined,
        apiProtocol: model.apiProtocol ?? undefined,
        clientImpersonation: (model.clientImpersonation ?? 'none') as ClientImpersonation,
      };
    }),
    cfg.feishu.bot.groupContext.overflowItems,
  );
  // 会话复用时按机器人配置热切换 Agent/模型（对齐微信通道切换逻辑）。
  const applyFeishuBotConfig = async (sessionId: number, botId: number): Promise<void> => {
    const bot = await feishuBots.findById(botId);
    if (bot == null) return;
    const session = await sessionService.getSession(sessionId);
    if (session == null || session.id == null) return;
    const agent = bot.agentId != null ? await agentService.getAgent(bot.agentId) : await agentService.requireDefaultAgent();
    const model = bot.modelId != null ? await modelService.getModel(bot.modelId) : await modelService.getDefaultModel();
    const agentId = agent?.id ?? null;
    const modelId = model?.id ?? null;
    const fields: Record<string, unknown> = {};
    if (agentId != null && session.agentId !== agentId) fields.agentId = agentId;
    if (session.modelId !== modelId) fields.modelId = modelId;
    if (Object.keys(fields).length > 0) {
      console.info(`飞书会话热切换 Agent/模型, sessionId=${sessionId}, botId=${botId}`, fields);
      await sessionRepo.updateFields(session.id, fields);
    }
  };
  // 存量群会话标题仍为默认“飞书Bot会话”时，补一次群名称；失败静默，下次触发重试。
  const ensureFeishuSessionTitle = async (sessionId: number, accountId: number, context: FeishuInboundContext): Promise<void> => {
    try {
      if (context.chatType !== 'group' || context.chatId == null) return;
      const session = await sessionService.getSession(sessionId);
      if (session?.title !== '飞书Bot会话') return;
      const title = await getFeishuChatTitle(accountId, context.chatId);
      if (title === '') return;
      await sessionRepo.updateFields(sessionId, { title });
      console.info(`飞书会话标题更新为群名称, sessionId=${sessionId}, chatId=${context.chatId}, title=${title}`);
    } catch (error) {
      console.warn(`更新飞书会话标题失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // 按机器人缓存 Lark Client，避免每次收发都重新走 tenant_access_token 换取端点；
  // 缓存 key 包含 appId 与 appSecret 密文，admin 修改 app_id/app_secret 后自动失效重建；停用的机器人直接拒绝。
  const feishuClients = new Map<string, Lark.Client>();
  const feishuSenderNames = new Map<string, Promise<string | null>>();
  const getFeishuClient = async (botId: number): Promise<Lark.Client | null> => {
    const bot = await feishuBots.findById(botId);
    if (bot == null || bot.enabled === 0 || !cfg.feishu.bot.appSecretKey) return null;
    const key = `${botId}:${bot.appId}:${bot.appSecret}`;
    const cached = feishuClients.get(key);
    if (cached != null) return cached;
    const appSecret = decryptAesGcm(bot.appSecret, cfg.feishu.bot.appSecretKey, '飞书Bot appSecret解密失败');
    const client = new Lark.Client({ appId: bot.appId, appSecret });
    feishuClients.set(key, client);
    return client;
  };
  // 群名称按 botId+chatId 缓存（成功结果）；获取失败不缓存，下次触发重试并告警提示权限缺口。
  const feishuChatTitles = new Map<string, Promise<string>>();
  const getFeishuChatTitle = (botId: number, chatId: string): Promise<string> => {
    const key = `${botId}:${chatId}`;
    const cached = feishuChatTitles.get(key);
    if (cached != null) return cached;
    const promise = (async () => {
      try {
        const client = await getFeishuClient(botId);
        if (client == null) return '';
        const response = await client.im.v1.chat.get({ path: { chat_id: chatId } });
        return (response as { data?: { name?: string } }).data?.name?.trim() ?? '';
      } catch (error) {
        console.warn(`获取飞书群名称失败, botId=${botId}, chatId=${chatId}: ${error instanceof Error ? error.message : String(error)}`);
        return '';
      }
    })();
    feishuChatTitles.set(key, promise);
    return promise;
  };
  const sendFeishuText = async (botId: number, event: FeishuNormalizedMessage, text: string): Promise<string | null> => {
    const client = await getFeishuClient(botId);
    if (client == null) return null;
    const maxReplyLength = Math.max(100, Math.min(10000, cfg.feishu.bot.reply.maxLength));
    const limited = text.length > maxReplyLength ? `${text.slice(0, maxReplyLength)}…（回复过长已截断）` : text;
    if (event.chatType === 'group' && event.messageId != null) {
      const response = await client.im.v1.message.reply({
        path: { message_id: event.messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: limited }) },
      });
      return (response as { data?: { message_id?: string } }).data?.message_id ?? null;
    }
    const receiveId = event.chatType === 'group' ? event.chatId : event.senderId;
    const receiveIdType = event.chatType === 'group' ? 'chat_id' : 'open_id';
    if (receiveId == null) return null;
    const response = await client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: limited }) },
    });
    return (response as { data?: { message_id?: string } }).data?.message_id ?? null;
  };
  notifyFeishuPendingMismatch = async (pending) => {
    await sendFeishuText(pending.appId, pending.event, FEISHU_ECP_IDENTITY_MISMATCH_TEXT);
  };
  // 排队交互卡片：提示当前任务执行中、新消息已入队，并提供「立即发送/取消排队」两个按钮。
  const buildFeishuQueueCard = (context: FeishuInboundContext, queueId: number, position: number): Record<string, unknown> => {
    const summary = context.text.length > 60 ? `${context.text.slice(0, 60)}…` : context.text;
    // 私聊是一对一对话，对端即用户本人，无需（也不应）显示「发送者：」前缀；群聊则保留发送者名以区分多人。
    const showSender = context.chatType === 'group';
    const senderLabel = (context.senderLabel?.trim() || '用户');
    const body = showSender ? `${senderLabel}：${summary}` : summary;
    return {
      schema: '2.0',
      config: { update_multi: true },
      body: {
        direction: 'vertical', padding: '12px 12px 12px 12px',
        elements: [
          { tag: 'markdown', content: '**⏳ 任务排队中**', text_align: 'left', text_size: 'normal_v2' },
          { tag: 'markdown', content: `当前任务正在执行中，这条消息已进入队列（第 ${position} 位），将在当前任务完成后自动开始处理。`, text_align: 'left', text_size: 'normal_v2' },
          { tag: 'markdown', content: body, text_align: 'left', text_size: 'normal_v2' },
          {
            // 卡片 JSON 2.0 不支持 tag:'action' 交互模块，按钮需放入 elements（并排用 column_set）。
            tag: 'column_set', flex_mode: 'flow', background_style: 'default',
            columns: [
              { tag: 'column', width: 'auto', vertical_align: 'top', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '立即发送' }, type: 'primary', size: 'sm', value: { kind: 'feishu_queue', queueId, act: 'run' } }] },
              { tag: 'column', width: 'auto', vertical_align: 'top', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '取消排队' }, type: 'default', size: 'sm', value: { kind: 'feishu_queue', queueId, act: 'cancel' } }] },
            ],
          },
        ],
      },
    };
  };
  const createFeishuQueueCard = async (context: FeishuInboundContext, queueId: number, position: number, sessionId: number): Promise<string | null> => {
    const client = await getFeishuClient(Number(context.accountId));
    if (client == null) return null;
    const data = { msg_type: 'interactive', content: JSON.stringify(buildFeishuQueueCard(context, queueId, position)) };
    // 群聊用 reply 触发消息：话题群中 message.create 到 chat_id 会创建新话题，reply 才落入当前话题。
    const response = await (context.chatType === 'group' && context.messageId != null
      ? client.im.v1.message.reply({ path: { message_id: context.messageId }, data })
      : client.im.v1.message.create({ params: { receive_id_type: 'open_id' }, data: { ...data, receive_id: context.senderId! } }));
    const cardMessageId = (response as { data?: { message_id?: string } }).data?.message_id ?? null;
    // 私聊排队卡片可被回复/引用，记录卡片消息 → 会话映射供引用切换定位。
    if (cardMessageId != null && context.chatType === 'p2p') {
      await feishuMessageService.recordP2pMessage(context.accountId, cardMessageId, sessionId, 'OUT');
    }
    return cardMessageId;
  };
  /** 网页端会话详情深链：取 ECP desktopCallbackUrl 的 origin 拼 `/tasks/{id}`；配置异常时不渲染按钮。 */
  const resolveFeishuSessionDetailUrl = async (sessionId: number): Promise<string | undefined> => {
    try {
      const ecp = await settingService.getEcpConfig();
      return feishuSessionDetailUrl(ecp.desktopCallbackUrl, sessionId);
    } catch {
      return undefined;
    }
  };
  /** 250ms 节流的进度卡片 PATCH 闭包：正常执行与崩溃恢复续跑共用同一实现。
   *  真正 PATCH 前读取当前提问表单；终态先清表单。旧进度对象被新任务替换后不再改表单状态。
   *  @param startedAtMs 任务起算时间（毫秒），终态时据此计算卡片上的「耗时」。 */
  const createPatchedProgress = (
    client: Lark.Client,
    cardMessageId: string,
    sessionId: number,
    cancelAction: { sessionId: number; sender: string; botId?: number } | null,
    startedAtMs: number,
    sessionDetailUrl?: string,
    seed?: { round?: number; content?: string },
  ): FeishuCardProgress => {
    const gate: { progress: FeishuProgressHandle | null } = { progress: null };
    const progress = createFeishuPatchedProgress({
      listAsks: () => (
        gate.progress != null && feishuActiveProgress.current(sessionId) === gate.progress
          ? feishuAskFormStore.list(sessionId)
          : []
      ),
      clearAsks: () => {
        if (gate.progress != null && feishuActiveProgress.current(sessionId) === gate.progress) {
          feishuAskFormStore.clearSession(sessionId);
        }
      },
      patch: async (card) => {
        await client.im.v1.message.patch({ path: { message_id: cardMessageId }, data: { content: JSON.stringify(card) } });
      },
      buildCard: ({ status, round, content, tools, pendingAsks, elapsedMs }) => buildFeishuProgressCard(
        status, round, content, tools, cancelAction ?? undefined, elapsedMs, sessionDetailUrl, pendingAsks,
      ),
      startedAtMs,
      seed: { status: 'RUNNING', round: seed?.round ?? 0, content: seed?.content ?? '', tools: [] },
    });
    gate.progress = progress;
    feishuActiveProgress.bind(sessionId, cancelAction?.sender ?? '', progress);
    return progress;
  };
  const createFeishuProgressCard = async (context: FeishuInboundContext, sessionId: number): Promise<FeishuCardProgress | null> => {
    const botId = Number(context.accountId);
    const client = await getFeishuClient(botId);
    if (client == null) return null;
    const cancelAction = { sessionId, sender: context.senderId ?? '', botId };
    const sessionDetailUrl = await resolveFeishuSessionDetailUrl(sessionId);
    // 持久化「会话 → 活跃进度卡片」映射：进程重启后崩溃恢复续跑可凭此续更卡片直至终态。
    // 持久化失败不阻断执行，仅丢失该任务的恢复续更能力。
    const persistCard = async (cardMessageId: string): Promise<void> => {
      try {
        await feishuProgressCardRepo.upsert({
          sessionId, botId, cardMessageId,
          chatType: context.chatType,
          chatId: context.chatId,
          senderOpenId: context.senderId,
        });
      } catch (error) {
        console.warn(`飞书进度卡片映射持久化失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const existingMessageId = context.progressCardMessageId;
    // 任务起算时间取卡片就绪时刻：排队消息的等待时间不计入耗时。
    const startedAtMs = Date.now();
    if (existingMessageId != null) {
      const card = buildFeishuProgressCard('RUNNING', 0, '任务已接收，正在准备执行。', [], cancelAction, undefined, sessionDetailUrl);
      await client.im.v1.message.patch({ path: { message_id: existingMessageId }, data: { content: JSON.stringify(card) } });
      await persistCard(existingMessageId);
      return createPatchedProgress(client, existingMessageId, sessionId, cancelAction, startedAtMs, sessionDetailUrl, {
        content: '任务已接收，正在准备执行。',
      });
    }
    const card = buildFeishuProgressCard('RUNNING', 0, '任务已接收，正在准备执行。', [], cancelAction, undefined, sessionDetailUrl);
    const data = { msg_type: 'interactive', content: JSON.stringify(card) };
    const response = await (context.chatType === 'group' && context.messageId != null
      ? client.im.v1.message.reply({ path: { message_id: context.messageId }, data })
      : client.im.v1.message.create({
        params: { receive_id_type: context.chatType === 'group' ? 'chat_id' : 'open_id' },
        data: { ...data, receive_id: context.chatType === 'group' ? context.chatId! : context.senderId! },
      }));
    const messageId = (response as { data?: { message_id?: string } }).data?.message_id;
    if (messageId == null || messageId === '') throw new Error('飞书处理中卡片发送失败：未返回 message_id');
    await persistCard(messageId);
    // 私聊进度卡片可被回复/引用，记录卡片消息 → 会话映射供引用切换定位。
    if (context.chatType === 'p2p') await feishuMessageService.recordP2pMessage(String(botId), messageId, sessionId, 'OUT');
    return createPatchedProgress(client, messageId, sessionId, cancelAction, startedAtMs, sessionDetailUrl, {
      content: '任务已接收，正在准备执行。',
    });
  };
  /** 崩溃恢复续跑：按会话查找活跃进度卡片并构造续更 progress；无映射或加载失败返回 null（不阻断恢复）。 */
  const resolveFeishuRoundOffset = async (sessionId: number): Promise<number> => {
    try {
      return countCompletedAgentRounds(await sessionService.getMessages(sessionId));
    } catch {
      return 0;
    }
  };
  const createFeishuRecoveryProgress = async (sessionId: number): Promise<{ progress: FeishuCardProgress; roundOffset: number } | null> => {
    try {
      const row = await feishuProgressCardRepo.findBySessionId(sessionId);
      if (row == null) {
        console.warn(`飞书恢复进度卡片无映射, sessionId=${sessionId}`);
        return null;
      }
      const client = await getFeishuClient(row.botId);
      if (client == null) {
        console.warn(`飞书恢复进度卡片无法创建客户端, sessionId=${sessionId} botId=${row.botId}`);
        return null;
      }
      const cancelAction = row.senderOpenId != null && row.senderOpenId !== ''
        ? { sessionId, sender: row.senderOpenId, botId: row.botId }
        : null;
      const sessionDetailUrl = await resolveFeishuSessionDetailUrl(sessionId);
      // 续跑任务的耗时以崩溃前会话记录的 startedAt 起算（读不到时退回恢复开始的时刻）。
      const session = await sessionService.getSession(sessionId).catch(() => null);
      const startedAtMs = parseSqlTimeMs(session?.startedAt) ?? Date.now();
      const progress = createPatchedProgress(client, row.cardMessageId, sessionId, cancelAction, startedAtMs, sessionDetailUrl, {
        content: '任务正在恢复执行。',
      });
      // 卡片轮次按当前任务已落库的助手消息接续，避免重启后从 0 重计。
      const roundOffset = await resolveFeishuRoundOffset(sessionId);
      // 重启后续跑立刻刷新卡片并带上取消按钮，避免旧卡停在崩溃前的「正在处理」且取消回调失效。
      try {
        await progress.update('RUNNING', roundOffset, '任务正在恢复执行。', []);
      } catch (error) {
        console.warn(`飞书恢复进度卡片首次 PATCH 失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { progress, roundOffset };
    } catch (error) {
      console.warn(`飞书恢复进度卡片加载失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  // 私聊会话按当前绑定用户隔离：同一 union_id 换绑到其他用户时不复用原会话/工作区。
  const resolveFeishuUserId = async (accountId: string, context: FeishuInboundContext): Promise<number | undefined> => {
    const unionId = context.senderUnionId ?? context.senderId;
    if (unionId == null) return undefined;
    return (await feishuBinding.findUserIdByUnionId(unionId)) ?? undefined;
  };
  const feishuInboundQueueRepo = new FeishuInboundQueueRepository(db);
  const feishuProgressCardRepo = new MysqlFeishuProgressCardRepository(db);
  const feishuTaskQueue = new FeishuTaskQueueService(feishuInboundQueueRepo);
  /** 排队卡片展示位置：入队完成后队列中的 QUEUED 行数（含本条，插入语义=队尾第 N 位）。 */
  const queuePositionOf = async (sessionId: number): Promise<number> => (await feishuInboundQueueRepo.countPending(sessionId));
  /** 重启后内存无 cancel flag、DB 仍 RUNNING/RESUMING 时，把会话落成 CANCELLED（与桌面端停止同语义）。 */
  const persistCancelledIfActive = async (sessionId: number): Promise<boolean> => {
    const session = await sessionService.getSession(sessionId).catch(() => null);
    if (session == null) return false;
    if (session.phase !== 'RUNNING' && session.phase !== 'RESUMING') return false;
    await sessionService.cleanupIncompleteTail(sessionId);
    await taskTerminal.finishExecution(sessionId, session.userId, 'CANCELLED', randomUUID());
    try { await feishuProgressCardRepo.deleteBySessionId(sessionId); } catch (error) {
      console.warn(`清理飞书进度卡片映射失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  };
  const feishuInboundHandler = new AgentFeishuInboundHandler({
    registry: wsRegistry,
    resolveStreamUserId: async (sessionId) => {
      const session = await sessionService.getSession(sessionId).catch(() => null);
      return session?.userId ?? null;
    },
    sessionService: {
      getOrCreateSession: async (accountId, context) => {
        const triggerUserId = await resolveFeishuUserId(accountId, context);
        const conversation = context.chatType === 'group'
          ? await feishuMessageService.getOrCreateGroup(accountId, context)
          : await feishuMessageService.getOrCreateP2p(accountId, context, triggerUserId);
        await applyFeishuBotConfig(conversation.sessionId, Number(accountId));
        void ensureFeishuSessionTitle(conversation.sessionId, Number(accountId), context);
        return { id: conversation.sessionId, workspace: conversation.workspace ?? null, executionUserId: triggerUserId ?? null };
      },
      saveUserMessage: async (sessionId, content, metadata) => { await sessionService.saveMessage(sessionId, 'USER', content, null, null, null, 0, null, metadata ?? null); },
      updatePhase: async (sessionId, phase) => { await sessionService.updatePhase(sessionId, phase); },
      cleanupIncompleteTail: async (sessionId) => sessionService.cleanupIncompleteTail(sessionId),
      getPhase: async (sessionId) => (await sessionService.getSession(sessionId))?.phase ?? null,
      getLatestAssistantReply: async (sessionId) => {
        const messages = await sessionService.getMessages(sessionId);
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'ASSISTANT') return messages[i].content ?? '';
        }
        return '抱歉，暂时无法生成回复。';
      },
      getMessages: async (sessionId) => sessionService.getMessages(sessionId),
    },
    p2pSessionControl: {
      findActiveSession: async (accountId, context) => {
        const triggerUserId = await resolveFeishuUserId(accountId, context);
        const conversation = await feishuMessageService.findActiveP2p(accountId, context, triggerUserId);
        return conversation == null ? null : { id: conversation.sessionId };
      },
      createSession: async (accountId, context) => {
        const triggerUserId = await resolveFeishuUserId(accountId, context);
        if (triggerUserId == null) throw new Error(`飞书用户未绑定: ${context.senderId ?? ''}`);
        // 工作区按 `private-{userId}` 固定分配，同一私聊所有会话天然共享根工作区。
        const conversation = await feishuMessageService.createP2pSession(accountId, context, triggerUserId);
        await applyFeishuBotConfig(conversation.sessionId, Number(accountId));
        return { id: conversation.sessionId };
      },
      switchSession: async (accountId, context, targetSessionId) => {
        const triggerUserId = await resolveFeishuUserId(accountId, context);
        // 换绑越权守卫：目标会话必须属于当前绑定的 mao 用户（引用旧消息不能切入他人会话）。
        // findById 对不存在/已软删会话返回 null（getSession 会抛 SESSION_NOT_FOUND），空目标同样拒绝。
        if (triggerUserId != null) {
          const targetSession = await sessionRepo.findById(targetSessionId);
          if (targetSession == null || targetSession.userId !== triggerUserId) {
            console.warn(`飞书引用切换拒绝: 目标会话不存在或归属其他用户, sessionId=${targetSessionId}, trigger=${triggerUserId}`);
            return null;
          }
        }
        const conversation = await feishuMessageService.switchP2pSession(accountId, context, targetSessionId, triggerUserId);
        if (conversation == null) return null;
        await applyFeishuBotConfig(conversation.sessionId, Number(accountId));
        return { id: conversation.sessionId };
      },
      findSessionByMessageId: (accountId, messageId) => feishuMessageService.findP2pMessageSession(accountId, messageId),
      recordMessageMapping: (accountId, messageId, sessionId, direction) => feishuMessageService.recordP2pMessage(accountId, messageId, sessionId, direction),
      finalizeNewSessionTitle: async (sessionId, title) => {
        // 持久化待命名标志驱动（重启安全）：非新会话/标题已被改过时为 no-op。
        const channel = await feishuMessageService.findSessionChannel(sessionId);
        if (channel?.awaitingFirstMessageTitle !== 1) return false;
        const session = await sessionService.getSession(sessionId);
        if (session == null) return false;
        await feishuMessageService.clearAwaitingFirstMessageTitle(sessionId);
        // 仅替换默认标题，不覆盖用户/LLM 已改过的名字。
        if (session.title != null && session.title !== '飞书Bot会话') return false;
        await sessionRepo.updateFields(sessionId, { title });
        return true;
      },
    },
    threadSessionControl: {
      findSession: async (accountId, context) => {
        const result = await feishuMessageService.findThreadSession(accountId, context.threadId);
        return result == null ? null : { sessionId: result.sessionId, rootMessageId: result.rootMessageId };
      },
      getOrCreateSession: async (accountId, context) => {
        const result = await feishuMessageService.getOrCreateThreadSession(accountId, context);
        if (result == null) return null;
        const triggerUserId = await resolveFeishuUserId(accountId, context);
        await applyFeishuBotConfig(result.sessionId, Number(accountId));
        // 不调用 ensureFeishuSessionTitle：话题会话标题由首条消息命名机制处理（awaitingFirstMessageTitle）。
        return { sessionId: result.sessionId, rootMessageId: result.rootMessageId, workspace: result.workspace ?? null, executionUserId: triggerUserId ?? null };
      },
    },
    onReply: async (context, text, sessionId) => {
      const messageId = await sendFeishuText(Number(context.accountId), context, text);
      // 私聊出站文本回复记录归属映射：用户回复机器人消息时可凭此切换会话。
      if (messageId != null && sessionId != null && context.chatType === 'p2p') {
        await feishuMessageService.recordP2pMessage(context.accountId, messageId, sessionId, 'OUT');
      }
      return messageId;
    },
    harnessService: harness as never,
    createCancelFlag: (sessionId) => agentLoop.registerCancelFlag(sessionId),
    releaseCancelFlag: (sessionId) => agentLoop.removeCancelFlag(sessionId),
    createProgressCard: (context, sessionId) => createFeishuProgressCard(context, sessionId),
    onInterruptRunning: (sessionId) => {
      // 崩溃恢复续跑只把 flag 挂在 AgentLoop 上，飞书 handler 的 cancelFlags 是空的。
      agentLoop.requestCancel(sessionId);
      try { shellManager.closeByConversation(sessionId); } catch (error) {
        console.debug(`关闭飞书会话 Shell 失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      // 提问挂在 waitForAnswer 上，只置取消标志不会返回。先清表单再唤醒，循环才能收尾并把卡片上的表单刷掉。
      feishuAskFormStore.clearSession(sessionId);
      askUserQuestionsRegistry.failAllForSession(sessionId);
    },
    resolveIdleRunning: async (sessionId) => {
      // 已有 AgentLoop 执行（含崩溃恢复）：只置 flag，由执行收尾再 drain，避免与续跑并行。
      if (agentLoop.getCancelFlag(sessionId) != null) return;
      await persistCancelledIfActive(sessionId);
    },
    queueService: feishuTaskQueue,
    createQueueCard: async (context, _queueId, sessionId) => createFeishuQueueCard(context, _queueId, await queuePositionOf(sessionId), sessionId),
    resolveBotId: (accountId) => Number(accountId),
    downloadMedia: async (context, workspace) => {
      const botId = Number(context.accountId);
      const client = await getFeishuClient(botId);
      if (client == null) return null;
      // image：独立图片消息；post：图片+文字富文本，imageKeys 含全部内嵌图片。
      const inboundKeys = inboundImageKeys(context);
      const isMedia = inboundKeys.length > 0 || context.messageType === 'file' && context.fileKey != null;
      if (!isMedia || context.messageId == null) return null;
      const maxBytes = Math.max(1, cfg.feishu.bot.file.maxInboundFileMb) * 1024 * 1024;
      const images: string[] = [];
      const imagePaths: string[] = [];
      const filePaths: string[] = [];
      const errors: string[] = [];
      try {
        let imageIndex = 0;
        for (const imageKey of inboundKeys) {
          try {
            const { buffer, contentType } = await downloadFeishuMediaBuffer(client, context.messageId, imageKey, 'image', maxBytes);
            if (buffer.length === 0) {
              errors.push('图片（接收失败）');
              continue;
            }
            images.push(dataUriOf(contentType, buffer));
            // 图片同时落盘 chat-files/{日期}/（同微信）：模型视觉直传之外，Agent 仍可用工具读取原图。
            if (workspace != null && workspace !== '') {
              try {
                const ext = IMAGE_EXT_BY_CONTENT_TYPE[contentType] ?? '.jpg';
                const dir = chatFilesDirOf(workspace);
                mkdirSync(dir, { recursive: true });
                // 同一消息多图追加序号防覆盖；与群图片预下载命名一致。
                const name = imageIndex === 0 ? `feishu-image-${context.messageId}${ext}` : `feishu-image-${context.messageId}-${imageIndex + 1}${ext}`;
                const target = resolve(dir, name);
                await writeFile(target, buffer);
                imagePaths.push(target);
              } catch (error) {
                console.warn(`飞书图片落盘失败（不影响直传）, bot=${botId}, messageId=${context.messageId}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            imageIndex++;
          } catch (error) {
            console.error(`飞书图片下载失败, bot=${botId}, messageId=${context.messageId}`, error);
            errors.push('图片（接收失败）');
          }
        }
        if (context.messageType === 'file' && context.fileKey != null) {
          if (workspace == null || workspace === '') {
            errors.push(context.fileName ?? '文件（接收失败）');
          } else {
            try {
              const { buffer } = await downloadFeishuMediaBuffer(client, context.messageId, context.fileKey, 'file', maxBytes);
              if (buffer.length === 0) {
                errors.push(context.fileName ?? '文件（接收失败）');
              } else {
                const fileName = sanitizeFeishuFileName(context.fileName, `feishu-${context.fileKey}`);
                const dir = chatFilesDirOf(workspace);
                mkdirSync(dir, { recursive: true });
                const target = resolve(dir, fileName);
                await writeFile(target, buffer);
                filePaths.push(target);
              }
            } catch (error) {
              console.error(`飞书文件下载失败, bot=${botId}, messageId=${context.messageId}`, error);
              errors.push(context.fileName ?? '文件（接收失败）');
            }
          }
        }
      } finally { /* 下载失败已收集 errors */ }
      return { images, imagePaths, filePaths, errors };
    },
    listenerFactory: async (sessionId, context, executionId) => {
      const session = await sessionService.getSession(sessionId);
      const ownerUserId = session.userId!;
      return new WsStreamingEventListener({
        registry: wsRegistry,
        activityService: activityService as never,
        activityHeartbeat,
        sessionTodoMapper: todoMapper,
        sessionService: sessionService as never,
      }, sessionId, ownerUserId, executionId, session.modelId != null && (await modelService.getModel(session.modelId))?.supportsVision === 1);
    },
    onExecutionFinished: async (sessionId, _context, executionId, phase) => {
      const session = await sessionService.getSession(sessionId);
      await taskTerminal.finishExecution(sessionId, session.userId!, phase, executionId);
      // FAILED 保留映射：失败卡「重试」需凭映射定位 bot；COMPLETED/CANCELLED 清理，避免崩溃恢复误更旧卡。
      if (phase === 'FAILED') return;
      try { await feishuProgressCardRepo.deleteBySessionId(sessionId); } catch (error) {
        console.warn(`清理飞书进度卡片映射失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
  // 定时任务结果回流飞书通道：按会话反查 feishu_chat 定位 bot 与会话（群聊 chat_id / 私聊身份键），
  // 非飞书会话查不到 conversation，自然跳过；卡片复用进度卡片的 COMPLETED 终态样式。
  scheduledService.setFeishuResultPusher(async (sessionId, text) => {
    // 会话 → 通道绑定（创建时落行、不可变）：多会话并行下活跃指针行查不到非活跃会话，必须走绑定表。
    const channel = await feishuMessageService.findSessionChannel(sessionId);
    if (channel == null) return;
    const client = await getFeishuClient(Number(channel.appId));
    if (client == null) return;
    const target = feishuSendTargetOf(channel.appId, channel.chatId);
    const data = {
      msg_type: 'interactive',
      content: JSON.stringify(buildFeishuProgressCard('COMPLETED', 0, text, [], undefined, undefined, await resolveFeishuSessionDetailUrl(sessionId))),
    };
    // 话题会话回复话题根消息：message.create 到 chat_id 会在话题群另起新话题，reply 才落入当前话题。
    const threadRootMessageId = channel.chatType === 'group'
      ? await feishuMessageService.findThreadRootMessageId(sessionId)
      : null;
    const response = threadRootMessageId != null
      ? await client.im.v1.message.reply({ path: { message_id: threadRootMessageId }, data })
      : await client.im.v1.message.create({
        params: { receive_id_type: target.receiveIdType },
        data: { ...data, receive_id: target.receiveId },
      });
    // 私聊定时任务结果卡片可被回复/引用，记录卡片消息 → 会话映射供引用切换定位。
    const pushedMessageId = (response as { data?: { message_id?: string } }).data?.message_id ?? null;
    if (pushedMessageId != null && channel.chatType === 'p2p') {
      await feishuMessageService.recordP2pMessage(channel.appId, pushedMessageId, sessionId, 'OUT');
    }
  });
  const resolveFeishuSenderName = async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    const senderId = event.senderId;
    if (senderId == null) return null;
    // 机器人（应用）发送者：飞书无名称查询能力，直接用统一占位名，避免无谓的通讯录查询报错。
    if (isBotSender(event)) return botSenderLabel(event.senderId);
    const key = `${accountId}:${senderId}`;
    const cached = feishuSenderNames.get(key);
    if (cached != null) return cached;
    const lookup = (async (): Promise<string | null> => {
      try {
        const client = await getFeishuClient(Number(accountId));
        if (client == null) return null;
        // basicBatch 仅返回姓名且不受通讯录授权范围限制，适合群聊消息发送人展示。
        const response = await client.contact.v3.user.basicBatch({
          data: { user_ids: [senderId] }, params: { user_id_type: 'open_id' },
        });
        const user = (response as { data?: { users?: Array<{ name?: string }> } }).data?.users?.[0];
        return user?.name?.trim() || null;
      } catch (error) {
        // 失败不缓存（权限补开后自动恢复）；回退到已绑定 mao 账号的用户名。
        console.warn(`获取飞书发送人姓名失败, accountId=${accountId}, openId=${event.senderId}`, error);
        const unionId = event.senderUnionId ?? event.senderId;
        const userId = unionId == null ? null : await feishuBinding.findUserIdByUnionId(unionId);
        const bound = userId == null ? null : await userRepo.findById(userId);
        return bound?.displayName?.trim() || null;
      }
    })();
    const name = await lookup;
    // 仅缓存成功结果：失败（如通讯录权限未开通）不缓存，后续消息重试。
    if (name != null && name !== '') feishuSenderNames.set(key, Promise.resolve(name));
    return name;
  };
  // 群图片入站即下载（非懒加载）：落到群工作区，占位文本携带 @{路径}@ 引用，Agent 免工具直接读取；
  // 失败返回 null 由调用方保留 msg 占位符，仍可通过 feishu_download_file 懒加载兜底。
  const IMAGE_EXT_BY_CONTENT_TYPE: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
  };
  // 引用消息全文落盘的工作区定位：群会话此时已由 buildGroupContext 创建（直接查库）；
  // 私聊会话可能尚未创建，按绑定用户推导与建会话一致的 leaf。定位失败降级为纯截断。
  const QUOTED_INLINE_LIMIT = 100;
  const resolveQuotedWorkspace = async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    try {
      if (event.chatType === 'group') {
        if (event.chatId == null) return null;
        const conversation = await feishuMessageRepository.findGroupConversation(String(accountId), event.chatId);
        return conversation?.workspace ?? null;
      }
      const unionId = event.senderUnionId ?? event.senderId;
      const userId = unionId == null ? null : await feishuBinding.findUserIdByUnionId(unionId);
      if (userId == null) return null;
      return resolveFeishuChatWorkspace(cfg.app.harness.workspaceRoot, String(accountId), `private-${userId}`);
    } catch (error) {
      console.warn(`定位引用消息工作区失败, accountId=${accountId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const downloadFeishuGroupImage = async (accountId: string, event: FeishuNormalizedMessage, imageKey: string, index = 0): Promise<string | null> => {
    if (event.chatType !== 'group' || event.chatId == null || event.messageId == null) return null;
    const client = await getFeishuClient(Number(accountId));
    if (client == null) return null;
    const workspace = resolveFeishuChatWorkspace(cfg.app.harness.workspaceRoot, accountId, event.chatId);
    const maxBytes = Math.max(1, cfg.feishu.bot.file.maxInboundFileMb) * 1024 * 1024;
    const { buffer, contentType } = await downloadFeishuMediaBuffer(client, event.messageId, imageKey, 'image', maxBytes);
    if (buffer.length === 0) return null;
    const dir = chatFilesDirOf(workspace);
    mkdirSync(dir, { recursive: true });
    const ext = IMAGE_EXT_BY_CONTENT_TYPE[contentType] ?? '.jpg';
    // 同一 post 消息可能含多图：首图沿用原命名，其余追加序号防覆盖。
    const target = resolve(dir, index > 0 ? `feishu-image-${event.messageId}-${index + 1}${ext}` : `feishu-image-${event.messageId}${ext}`);
    await writeFile(target, buffer);
    return target;
  };
  const downloadFeishuGroupFile = async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    if (event.chatType !== 'group' || event.chatId == null || event.messageId == null || event.fileKey == null) return null;
    const client = await getFeishuClient(Number(accountId));
    if (client == null) return null;
    const workspace = resolveFeishuChatWorkspace(cfg.app.harness.workspaceRoot, accountId, event.chatId);
    const maxBytes = Math.max(1, cfg.feishu.bot.file.maxInboundFileMb) * 1024 * 1024;
    const { buffer } = await downloadFeishuMediaBuffer(client, event.messageId, event.fileKey, 'file', maxBytes);
    if (buffer.length === 0) return null;
    const dir = chatFilesDirOf(workspace);
    mkdirSync(dir, { recursive: true });
    const fileName = sanitizeFeishuFileName(event.fileName, `feishu-${event.fileKey}`);
    const target = resolve(dir, fileName);
    await writeFile(target, buffer);
    return target;
  };
  const feishuInboundProcessor = new FeishuInboundProcessor(feishuInboundHandler, {
    messageService: feishuMessageService,
    resolveSenderName: resolveFeishuSenderName,
    downloadGroupImage: downloadFeishuGroupImage,
    downloadGroupFile: downloadFeishuGroupFile,
    resolveThreadSession: async (accountId, event) => {
      const result = await feishuMessageService.findThreadSession(String(accountId), event.threadId);
      return result == null ? null : { sessionId: result.sessionId };
    },
    resolveQuotedMessage: async (accountId, event) => {
      if (event.parentId == null) return null;
      const persist = async (raw: string): Promise<string> => {
        if (raw.length <= QUOTED_INLINE_LIMIT) return raw;
        return buildQuotedInjection(raw, { parentMessageId: event.parentId!, workspace: await resolveQuotedWorkspace(accountId, event) });
      };
      // 群消息日志优先：免 API 调用，发送人姓名与占位符格式也和上下文一致。
      const fromLog = event.chatId != null
        ? await feishuMessageRepository.findGroupMessageByMessageId(String(accountId), event.chatId, event.parentId)
        : null;
      if (fromLog != null) {
        return persist(`[${formatGroupTime(fromLog.createdAt)}] ${fromLog.senderName}：${fromLog.content ?? ''}`);
      }
      // 日志未命中（引用机器人消息、超出日志窗口或私聊）：通过消息详情 API 兜底。
      const client = await getFeishuClient(Number(accountId));
      if (client == null) return null;
      const detail = await fetchFeishuMessageDetail(client, event.parentId);
      if (detail == null) return null;
      return persist(detail.text);
    },
    resolveMessageText: async (accountId, messageId) => {
      const client = await getFeishuClient(Number(accountId));
      if (client == null) return null;
      const detail = await fetchFeishuMessageDetail(client, messageId);
      return detail?.text ?? null;
    },
    resolveUserId: async (_accountId, event) => {
      const unionId = senderUnionIdOf(event);
      if (unionId == null) return null;
      return (await feishuBinding.findUserIdByUnionId(unionId)) ?? null;
    },
    authorizeSender: async (accountId, event) => {
      const unionId = senderUnionIdOf(event);
      if (unionId == null) return false;
      const userId = await feishuBinding.findUserIdByUnionId(unionId);
      if (userId == null) return false;
      if (await ecpAuth.isEnabled() && !(await hasUsableEcpSession(ecpSessionRepo, userId))) return false;
      if (event.chatType === 'group') {
        if (event.chatId == null) return false;
        // 已绑定用户在群内发言即登记为成员并放行（feishu_chat_member 是登记表，不是白名单门槛）。
        await feishuMessageRepository.addGroupMember(String(accountId), event.chatId, userId, event.senderId!, senderName(event));
        return true;
      }
      return true;
    },
    sendReply: async (accountId, event, text) => { await sendFeishuText(Number(accountId), event, text); },
    sendUnauthorizedCard: async (accountId, event) => {
      const client = await getFeishuClient(Number(accountId));
      if (client == null || event.messageId == null) return false;
      if (event.chatType === 'group' && event.chatId == null) return false;
      if (event.chatType === 'p2p' && event.senderId == null) return false;
      let auth: { authUrl: string; state: string } | null = null;
      try {
        auth = await startFeishuChannelAuthLink({
          ecpEnabled: await ecpAuth.isEnabled(),
          feishuEnabled: await feishu.isEnabled(),
          startEcp: () => ecpAuth.startFeishuLogin('desktop'),
          startFeishu: () => feishu.getQrCodeUrl(),
        });
      } catch (error) {
        console.error('飞书未授权引导获取登录链接失败', error);
        return false;
      }
      if (auth == null || auth.authUrl.trim() === '') return false;
      const inboundMessageId = event.messageId;
      const persisted = await persistFeishuPendingAuth(
        () => pendingBindingMessages.insert({ state: auth.state, appId: Number(accountId), messageId: inboundMessageId, event }),
        auth.state,
      );
      const ecpEnabled = await ecpAuth.isEnabled();
      const guide = feishuUnauthorizedGuide(ecpEnabled, event.chatType);
      const card = buildFeishuAuthGuideCard(guide, auth.authUrl);
      const data = { msg_type: 'interactive' as const, content: JSON.stringify(card) };
      let response;
      try {
        response = await (event.chatType === 'group'
          ? client.im.v1.message.reply({ path: { message_id: inboundMessageId }, data })
          : client.im.v1.message.create({
            params: { receive_id_type: 'open_id' },
            data: { ...data, receive_id: event.senderId! },
          }));
      } catch (error) {
        if (persisted) await pendingBindingMessages.fail(auth.state);
        throw error;
      }
      const cardMessageId = (response as { data?: { message_id?: string } }).data?.message_id;
      if (cardMessageId == null || cardMessageId === '') {
        if (persisted) await pendingBindingMessages.fail(auth.state);
        return false;
      }
      if (persisted) {
        try {
          await pendingBindingMessages.setCardMessageId(auth.state, cardMessageId);
        } catch (error) {
          console.error(`飞书登录引导卡片已发送但回写 card_message_id 失败, state=${auth.state}`, error);
        }
      }
      return true;
    },
    unauthorizedText: async (_accountId, event) => {
      const ecpEnabled = await ecpAuth.isEnabled();
      return feishuUnauthorizedFallbackText(feishuUnauthorizedGuide(ecpEnabled, event.chatType));
    },
  });
  pendingBindingProcessor = feishuInboundProcessor;
  const feishuCardActionService = new FeishuCardActionService({
    queuePort: feishuTaskQueue,
    interrupt: (sessionId) => feishuInboundHandler.interrupt(sessionId),
    // M-6：插队按钮「中断+接力」收敛为一条原子路径——空闲时由 interrupt 内部排空兜底，
    // 命中时中断后立即排空，避免与 onMessage 接力窗口相互踩踏/滞留。
    interruptAndDrain: (sessionId) => feishuInboundHandler.interruptAndDrain(sessionId),
    // 进度卡「取消任务」：置位 AgentLoop / 飞书 handler 取消标志 + 关闭 shell。
    // 已有执行（含崩溃恢复）只置 flag，等循环收尾再落 CANCELLED，避免提前终态后新消息与续跑并行。
    // 重启后续跑尚未挂 flag 时才补写 CANCELLED。用 cancel 而非 interrupt：interrupt 会标记「被下一条指令中断」。
    cancelRunning: async (sessionId) => {
      feishuInboundHandler.cancel(sessionId);
      return persistFeishuCancelIfIdle({
        sessionId,
        hadLoop: agentLoop.getCancelFlag(sessionId) != null,
        persistCancelledIfActive,
        drainNextIfPending: (id) => feishuInboundHandler.drainNextIfPending(id),
      });
    },
    // 失败卡「重试」：凭仍保留的进度卡片映射定位 bot，PATCH 点击的那张失败卡并基于历史续跑。
    retryFailed: async (sessionId, cardMessageId) => {
      const mapping = await feishuProgressCardRepo.findBySessionId(sessionId);
      if (mapping == null) return { ok: false, reason: 'NO_PROGRESS' };
      return feishuInboundHandler.retryExecution(sessionId, async () => {
        const client = await getFeishuClient(mapping.botId);
        if (client == null) return null;
        const sender = mapping.senderOpenId ?? '';
        const sessionDetailUrl = await resolveFeishuSessionDetailUrl(sessionId);
        const session = await sessionService.getSession(sessionId).catch(() => null);
        const startedAtMs = parseSqlTimeMs(session?.startedAt) ?? Date.now();
        // 点到哪张失败卡就续更哪张；映射刷新指向该卡，便于再次失败后仍可重试。
        try {
          await feishuProgressCardRepo.upsert({
            sessionId,
            botId: mapping.botId,
            cardMessageId,
            chatType: mapping.chatType,
            chatId: mapping.chatId,
            senderOpenId: mapping.senderOpenId,
          });
        } catch (error) {
          console.warn(`飞书重试进度卡片映射刷新失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return createPatchedProgress(
          client, cardMessageId, sessionId,
          { sessionId, sender, botId: mapping.botId },
          startedAtMs, sessionDetailUrl,
          { content: '正在重试，请稍候…' },
        );
      });
    },
    patchCard: async (botId, cardMessageId, card) => {
      const client = await getFeishuClient(botId);
      if (client == null) throw new Error(`飞书客户端不可用, botId=${botId}, cardMessageId=${cardMessageId}`);
      const response = await client.im.v1.message.patch({ path: { message_id: cardMessageId }, data: { content: JSON.stringify(card) } });
      if (response?.code !== 0) {
        throw new Error(`飞书卡片更新失败, code=${response?.code ?? 'missing'}, msg=${response?.msg ?? 'unknown'}`);
      }
    },
    sessionDetailUrl: (sessionId) => resolveFeishuSessionDetailUrl(sessionId),
    askForms: feishuAskFormStore,
    renderProgressCard: (sessionId) => feishuActiveProgress.render(sessionId),
    refreshProgress: (sessionId) => feishuActiveProgress.refresh(sessionId),
    completeAsk: (sessionId, requestId, resultJson) => askUserQuestionsRegistry.complete(sessionId, requestId, resultJson),
    notifyAskAnswered: (sessionId, requestId) => {
      treeSignalPublisher.publishForSession(sessionId);
      void localToolSessions.getUserIdForSession(sessionId).then((userId) => {
        if (userId != null) {
          wsRegistry.send(userId, wsEvent('ask_user_questions_cancelled', sessionId, { requestId }));
        }
      }).catch((error) => {
        console.warn(`飞书提问结果通知客户端失败, sessionId=${sessionId}`, error);
      });
    },
  });
  const dingtalk = createDingtalkRuntime({
    db,
    config: {
      enabled: cfg.dingtalk.enabled,
      appSecretKey: cfg.dingtalk.appSecretKey,
      reconcileIntervalMs: cfg.dingtalk.reconcileIntervalMs,
      reconnectBaseMs: cfg.dingtalk.reconnectBaseMs,
      reconnectMaxMs: cfg.dingtalk.reconnectMaxMs,
      maxConsecutiveFailures: cfg.dingtalk.maxConsecutiveFailures,
      oauth: cfg.dingtalk.oauth,
      progressCardTemplateId: cfg.dingtalk.progressCardTemplateId,
      queueCardTemplateId: cfg.dingtalk.queueCardTemplateId,
      replyMaxLength: cfg.dingtalk.replyMaxLength,
      groupContextMaxItems: cfg.dingtalk.groupContext.maxItems,
      groupContextMaxMinutes: cfg.dingtalk.groupContext.maxMinutes,
    },
    workspaceRoot: cfg.app.harness.workspaceRoot,
    jwt,
    permissionService,
    sessionService,
    sessionRepo,
    harness,
    agentLoop,
    wsRegistry,
    agentService,
    modelService,
    userRepo,
    settingService,
    taskTerminal,
    activityService,
    activityHeartbeat,
    todoMapper,
    shellManager,
  });
  dingtalkMediaHolder.current = dingtalk.mediaSend;
  const feishuMonitor = new FeishuMonitorService(cfg.feishu.bot, feishuBots, feishuInboundProcessor, async (data) => feishuCardActionService.handle(data, ''));

  const analyticsService = new AnalyticsService(new AnalyticsDbStore(db));
  const statisticsService = new StatisticsService(new StatisticsDbStore(db));
  const adminAnalytics = new AdminAnalyticsService(statisticsService, new AdminAnalyticsDbStore(db));
  const mcpValidator = new McpServerValidatorImpl(new MysqlMcpServerLookup(db));

  await app.register(async (api) => {
    api.get('/swagger-ui.html', async (_req, reply) => reply.redirect(`${apiPrefix}/swagger-ui`));
    api.get('/v3/api-docs', async (_req, reply) => {
      return reply.send(app.swagger());
    });
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
    registerAgentAvatarRoutes(api, fileService, permissionService);
    registerAgentRoutes(api, {
      agentService, experienceService, suggestedQuestionService, userRepo, mcpServerValidator: mcpValidator,
      permissionService,
    });
    registerModelRoutes(api, { modelService, permissionService });
    registerSystemSettingRoutes(api, { systemSettingService: settingService, permissionService });
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
    registerTerminalRoutes(api, {
      terminalManager,
      sessionService,
      permissionService,
      userLookup: { findById: (id: number) => userRepo.findById(id) as Promise<{ username: string } | null> },
    });
    registerFileRoutes(api, {
      fileService, sessionService, workspaceBrowseService: workspaceBrowse,
      workspaceGitService: workspaceGit, gitCommitMessageService: gitCommitMsg,
      gitWriteOperationService: gitWrite, pathSandbox, getUploadBaseUrl: async () => (await settingService.getUploadConfig()).baseUrl,
      runtimeDataResolver: runtimeResolver,
    });
    registerOssRoutes(api, { ossStsService: ossSts });
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
    registerAnalyticsRoutes(api, { analytics: analyticsService, jwt, permissionService });
    registerStatisticsRoutes(api, { statistics: statisticsService, jwt, permissionService });
    const adminDeps = {
      jwt, analytics: adminAnalytics,
      sessionLister: sessionService as never,
      permissionService,
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
      mcpServerService, mcpClientManager: mcpClient, userMcpPreferenceService: mcpPref, permissionService,
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

  const scheduler = new ScheduledTaskScheduler(scheduledStore, scheduledService);
  scheduler.start();
  const deliveryScheduler = new WebhookDeliveryScheduler(
    new DeliverySchedulerDbStore(db),
    () => settingService.getNotificationTuningConfig(),
    notifCipher,
    senderRegistry,
  );
  // 通知卡片上下文：本轮用户消息（决定「这次任务在干什么」）+ 网页端会话详情深链。
  // 任一查询失败都降级为 null，卡片对应段落/按钮不渲染，不阻断投递。
  deliveryScheduler.setContextProvider({
    latestUserMessage: async (sessionId) => {
      const message = await sessionService.getLastUserMessage(sessionId);
      return userMessagePreviewOf(message?.content ?? null) || null;
    },
    sessionDetailUrl: async (sessionId) => {
      const ecp = await settingService.getEcpConfig();
      return feishuSessionDetailUrl(ecp.desktopCallbackUrl, sessionId) ?? null;
    },
  });
  deliveryScheduler.start();
  const ecpRenewScheduler = new EcpRenewScheduler(
    ecpSessionRepo,
    () => settingService.getEcpConfig(),
    undefined,
    (token) => ecpSessionRepo.encryptToken(token),
  );
  ecpRenewScheduler.start();
  weixinMonitor.start();
  feishuMonitor.start();
  dingtalk.start();
  void pendingBindingMessages.listRecoverable().then(async (pending) => {
    for (const message of pending) {
      if (pendingBindingProcessor == null) return;
      const claimed = await pendingBindingMessages.claim(message.state);
      if (claimed == null) continue;
      try {
        await pendingBindingProcessor.process(String(claimed.appId), { ...claimed.event, progressCardMessageId: claimed.cardMessageId }, true);
        await pendingBindingMessages.complete(claimed.state);
      } catch (error) {
        await pendingBindingMessages.release(claimed.state);
        console.error(`恢复飞书待绑定消息失败, state=${claimed.state}`, error);
      }
    }
  }).catch((error) => console.error('恢复飞书待绑定消息列表失败', error));
  shellManager.startCleanup();
  terminalManager.startCleanup();
  const runtimeCleanup = new RuntimeCleanupScheduler(
    cfg.app.harness.runtimeDir,
    cfg.app.harness.cleanup,
    (userId, sessionId) => wsHandler.hasExecutionClaim(sessionId),
  );
  runtimeCleanup.start();
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
    async (sessionId, userId, phase) => {
      // 崩溃恢复续跑以 FAILED 结束：上一个任务实际未执行完成，不自动消费下一条消息。
      // 主队列与飞书队列均受此门禁约束；COMPLETED / CANCELLED 照常接力消费。
      if (phase !== 'FAILED') {
        void wsHandler.autoConsumeQueue(sessionId, userId);
        // 恢复终态后清理活跃进度卡片映射（FAILED 保留，供失败卡「重试」定位 bot）。
        await feishuProgressCardRepo.deleteBySessionId(sessionId).catch((error) => {
          console.warn(`清理飞书进度卡片映射失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        });
        // 崩溃恢复续跑结束后，若飞书队列仍有排队消息则接力消费（FAILED 时跳过）。
        await feishuInboundHandler.drainNextIfPending(sessionId).catch((error) => {
          console.error(`飞书崩溃恢复后队列接力消费失败, sessionId=${sessionId}`, error);
        });
        await dingtalk.onCrashFinished(sessionId, phase).catch((error) => {
          console.error(`钉钉崩溃恢复后队列接力消费失败, sessionId=${sessionId}`, error);
        });
      }
    },
    subagentCoordinator,
    // 恢复续跑时挂载飞书进度卡片续更：崩溃前在途任务的卡片不会停留在「正在处理」。
    async (sessionId) => {
      const dingtalkRecovered = await dingtalk.recoverProgress(sessionId);
      if (dingtalkRecovered != null) return new FeishuCardProgressListener(dingtalkRecovered.progress, dingtalkRecovered.roundOffset);
      const recovered = await createFeishuRecoveryProgress(sessionId);
      return recovered == null ? null : new FeishuCardProgressListener(recovered.progress, recovered.roundOffset);
    },
    // 延迟全库补扫排除本实例正在执行的会话（AgentLoop 已挂 flag）：其 phase 虽是 RUNNING，
    // 但属于正常运行而非崩溃遗留，纳入会与正在跑的执行并发重跑同一会话。
    (sessionId) => agentLoop.getCancelFlag(sessionId) != null,
  );
  void crash.run().catch((e) => console.error('Crash recovery failed', e)).then(async () => {
    // 等崩溃恢复初始扫描提交后再触发队列接力。hydrate 对崩溃时在途执行的 RUNNING 队列行按
    // 「消息是否已写入会话历史」分支：已落库→删除（其消息由崩溃恢复重放）；未落库→复位为 QUEUED（重新消费，不丢）。
    // 这里只消费真正的 QUEUED 排队行；若会话仍在被崩溃恢复续跑，drainNextIfPending 的
    // isBusyOrRecovering（DB phase RUNNING/RESUMING）会兜住不抢跑。
    await dingtalk.hydrate().catch((error) => console.error('钉钉入站队列启动恢复失败', error));
    const sessionIds = await feishuTaskQueue.hydrate();
    for (const sessionId of sessionIds) {
      await feishuInboundHandler.drainNextIfPending(sessionId).catch((error) => {
        console.error(`飞书队列启动恢复消费失败, sessionId=${sessionId}`, error);
      });
    }
  }).catch((error) => console.error('飞书入站队列启动恢复失败', error));

  return {
    app,
    async close() {
      scheduler.stop();
      deliveryScheduler.stop();
      ecpRenewScheduler.stop();
      shellManager.stopCleanup();
      terminalManager.stopCleanup();
      terminalManager.closeAll();
      runtimeCleanup.stop();
      weixinMonitor.shutdown();
      feishuMonitor.shutdown();
      dingtalk.shutdown();
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

/** 解析 MySQL datetime（`yyyy-MM-dd HH:mm:ss`）为毫秒时间戳；缺失或不可解析返回 null。 */
function parseSqlTimeMs(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

/** 会话删除时清理该会话 runtime 目录（incoming 上传、skills 同步副本、shell 输出等临时数据）。 */
function runtimeSessionCleanup(runtimeRoot: string): (userId: number, sessionId: number) => void {
  return (userId: number, sessionId: number): void => {
    try {
      const sessionDir = resolve(runtimeRoot, String(userId), String(sessionId));
      if (existsSync(sessionDir)) {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`Failed to clean runtime dir for session ${sessionId}`, e);
    }
  };
}
