import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
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
import { MysqlAgentExperienceRepository, MysqlAgentRepository } from './agent/agent.repository.js';
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
import { TaskNotificationDeliveryService } from './notification/task/delivery.service.js';
import { WebhookSenderRegistry, DingTalkWebhookSender, FeishuWebhookSender } from './notification/task/webhook-sender.js';
import { WebhookUrlValidator } from './notification/task/webhook-url-validator.js';
import { LlmUsageRepository, LlmUsageService } from './usage/llm-usage.service.js';
import * as Lark from '@larksuiteoapi/node-sdk';
import { decryptAesGcm } from './crypto/aes-gcm.js';
import { MysqlFeishuBotRepository } from './feishu/feishu_bot.repository.js';
import { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';
import { registerFeishuBotRoutes } from './feishu/admin.routes.js';
import { registerFeishuBindingRoutes } from './feishu/binding.routes.js';
import { FeishuMonitorService } from './feishu/monitor.service.js';
import { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import { FeishuMessageService } from './feishu/message.service.js';
import { formatGroupTime, senderName } from './feishu/message.service.js';
import { FeishuInboundProcessor } from './feishu/inbound-processor.js';
import { MysqlFeishuPendingBindingRepository } from './feishu/pending-binding.repository.js';
import { AgentFeishuInboundHandler } from './feishu/agent-inbound-handler.js';
import { FeishuInboundQueueRepository } from './feishu/inbound-queue.repository.js';
import { FeishuTaskQueueService } from './feishu/inbound-queue.service.js';
import { FeishuCardActionService } from './feishu/card-action.service.js';
import { readFeishuDocMarkdown } from './feishu/doc-reader.js';
import { fetchFeishuMessageDetail } from './feishu/message-detail.js';
import { feishuSendTargetOf, sendFeishuFile, sendFeishuImage } from './feishu/media-sender.js';
import type { FeishuCardProgress } from './feishu/card-progress-listener.js';
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
  const earlyFeishuBinding = new MysqlFeishuBindingRepository(db);
  const pendingBindingMessages = new MysqlFeishuPendingBindingRepository(db);
  let pendingBindingProcessor: FeishuInboundProcessor | undefined;
  const feishu = new FeishuAuthService(
    userRepo, userRoleRepo, new MysqlFeishuOauthStateRepository(db), jwt, cfg.feishu,
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
  const agentService = new AgentService(agentRepo, experienceService);
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
  const sessionService = new SessionService(
    sessionRepo, messageRepo, fileChangeRepo,
    {
      findById: (id) => agentRepo.findById(id) as never,
      findByIds: (ids) => agentRepo.findByIds(ids) as never,
      requireDefaultAgent: () => agentService.requireDefaultAgent() as never,
      listOptions: async () => (await agentRepo.selectList()).map((a) => ({ id: a.id!, name: a.name })),
    },
    pathSandbox, envInfo, commandService, gitOps, sessionCompactionService, sessionCompactionEventService, todoRepo,
    runtimeSessionCleanup(runtimeRoot),
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
    feishuToolSupport: {
      resolveBotAppId: async (sessionId) => {
        if (sessionId == null) return null;
        const conversation = await feishuMessageRepository.findConversationBySessionId(sessionId);
        return conversation?.appId ?? null;
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
        const conversation = await feishuMessageRepository.findConversationBySessionId(sessionId);
        return conversation == null ? null : feishuSendTargetOf(conversation.appId, conversation.chatId);
      },
      sendImage: async (target, image) => {
        const client = await getFeishuClient(Number(target.appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${target.appId}`);
        await sendFeishuImage(client, target, image);
      },
      sendFile: async (target, fileName, file) => {
        const client = await getFeishuClient(Number(target.appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${target.appId}`);
        await sendFeishuFile(client, target, fileName, file);
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
  });

  const toolDispatcher = new ToolDispatcher(
    toolRegistry, localToolExecutor, dangerAssessor, sessionMap,
    wsRegistry, askUserQuestionsRegistry, localToolSessions, treeSignalPublisher,
    backgroundTasks,
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
        const title = isGroup ? (await getFeishuChatTitle(Number(accountId), context.chatId!)) || '飞书Bot会话' : '飞书Bot会话';
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
  const sendFeishuText = async (botId: number, event: FeishuNormalizedMessage, text: string): Promise<void> => {
    const client = await getFeishuClient(botId);
    if (client == null) return;
    const maxReplyLength = Math.max(100, Math.min(10000, cfg.feishu.bot.reply.maxLength));
    const limited = text.length > maxReplyLength ? `${text.slice(0, maxReplyLength)}…（回复过长已截断）` : text;
    if (event.chatType === 'group' && event.messageId != null) {
      await client.im.v1.message.reply({
        path: { message_id: event.messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: limited }) },
      });
    } else {
      const receiveId = event.chatType === 'group' ? event.chatId : event.senderId;
      const receiveIdType = event.chatType === 'group' ? 'chat_id' : 'open_id';
      if (receiveId == null) return;
      await client.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: limited }) },
      });
    }
  };
  const buildFeishuProgressCard = (
    status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED', round: number, content: string, tools: string[],
  ): Record<string, unknown> => {
    const title = status === 'RUNNING' ? '正在处理' : status === 'COMPLETED' ? '处理完成' : status === 'CANCELLED' ? '任务已取消' : '处理失败';
    const sections: Array<Record<string, unknown>> = [
      { tag: 'markdown', content: `**状态：${title}**${round > 0 ? ` · 第 ${round} 轮` : ''}`, text_align: 'left', text_size: 'normal_v2' },
    ];
    if (content.trim() !== '') sections.push({ tag: 'markdown', content: content.slice(0, 6000), text_align: 'left', text_size: 'normal_v2' });
    if (tools.length > 0) sections.push({ tag: 'markdown', content: `**本轮工具**\n${tools.map((tool) => `- ${tool}`).join('\n').slice(0, 3000)}`, text_align: 'left', text_size: 'normal_v2' });
    return {
      schema: '2.0',
      config: { update_multi: true },
      body: { direction: 'vertical', padding: '12px 12px 12px 12px', elements: sections },
    };
  };
  // 排队交互卡片：提示当前任务执行中、新消息已入队，并提供「立即发送/取消本次任务」两个按钮。
  const buildFeishuQueueCard = (context: FeishuInboundContext, queueId: number, position: number): Record<string, unknown> => {
    const senderLabel = context.senderLabel?.trim() || '未知用户';
    const summary = context.text.length > 60 ? `${context.text.slice(0, 60)}…` : context.text;
    const actionValue = (act: 'run' | 'cancel'): string => JSON.stringify({ kind: 'feishu_queue', queueId, act });
    return {
      schema: '2.0',
      config: { update_multi: true },
      body: {
        direction: 'vertical', padding: '12px 12px 12px 12px',
        elements: [
          { tag: 'markdown', content: '**⏳ 任务排队中**', text_align: 'left', text_size: 'normal_v2' },
          { tag: 'markdown', content: `当前任务正在执行中，这条消息已进入队列（第 ${position} 位），将在当前任务完成后自动开始处理。`, text_align: 'left', text_size: 'normal_v2' },
          { tag: 'markdown', content: `${senderLabel}：${summary}`, text_align: 'left', text_size: 'normal_v2' },
          {
            tag: 'action', actions: [
              { tag: 'button', text: { tag: 'plain_text', content: '立即发送' }, type: 'primary_primary', value: actionValue('run') },
              { tag: 'button', text: { tag: 'plain_text', content: '取消本次任务' }, type: 'default', value: actionValue('cancel') },
            ],
          },
        ],
      },
    };
  };
  const createFeishuQueueCard = async (context: FeishuInboundContext, queueId: number, position: number): Promise<string | null> => {
    const client = await getFeishuClient(Number(context.accountId));
    if (client == null) return null;
    const data = { msg_type: 'interactive', content: JSON.stringify(buildFeishuQueueCard(context, queueId, position)) };
    const response = await (context.chatType === 'group' && context.chatId != null
      ? client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: context.chatId } })
      : client.im.v1.message.create({ params: { receive_id_type: 'open_id' }, data: { ...data, receive_id: context.senderId! } }));
    return (response as { data?: { message_id?: string } }).data?.message_id ?? null;
  };
  const createFeishuProgressCard = async (context: FeishuInboundContext): Promise<FeishuCardProgress | null> => {
    const client = await getFeishuClient(Number(context.accountId));
    if (client == null) return null;
    const existingMessageId = context.progressCardMessageId;
    const card = buildFeishuProgressCard('RUNNING', 0, '任务已接收，正在准备执行。', []);
    const data = { msg_type: 'interactive', content: JSON.stringify(card) };
    if (existingMessageId != null) {
      await client.im.v1.message.patch({ path: { message_id: existingMessageId }, data: { content: data.content } });
    }
    if (existingMessageId != null) {
      let nextUpdateAt = 0;
      return {
        update: async (status, round, content, tools) => {
          const wait = nextUpdateAt - Date.now();
          if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
          nextUpdateAt = Date.now() + 250;
          await client.im.v1.message.patch({
            path: { message_id: existingMessageId },
            data: { content: JSON.stringify(buildFeishuProgressCard(status, round, content, tools)) },
          });
        },
      };
    }
    const response = await (context.chatType === 'group' && context.messageId != null
      ? client.im.v1.message.reply({ path: { message_id: context.messageId }, data })
      : client.im.v1.message.create({
        params: { receive_id_type: context.chatType === 'group' ? 'chat_id' : 'open_id' },
        data: { ...data, receive_id: context.chatType === 'group' ? context.chatId! : context.senderId! },
      }));
    const messageId = (response as { data?: { message_id?: string } }).data?.message_id;
    if (messageId == null || messageId === '') throw new Error('飞书处理中卡片发送失败：未返回 message_id');
    let nextUpdateAt = 0;
    return {
      update: async (status, round, content, tools) => {
        const wait = nextUpdateAt - Date.now();
        if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
        nextUpdateAt = Date.now() + 250;
        await client.im.v1.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(buildFeishuProgressCard(status, round, content, tools)) },
        });
      },
    };
  };
  // 私聊会话按当前绑定用户隔离：同一 union_id 换绑到其他用户时不复用原会话/工作区。
  const resolveFeishuUserId = async (accountId: string, context: FeishuInboundContext): Promise<number | undefined> => {
    const unionId = context.senderUnionId ?? context.senderId;
    if (unionId == null) return undefined;
    return (await feishuBinding.findUserIdByUnionId(unionId)) ?? undefined;
  };
  const feishuInboundQueueRepo = new FeishuInboundQueueRepository(db);
  const feishuTaskQueue = new FeishuTaskQueueService(feishuInboundQueueRepo);
  /** 排队卡片展示位置：入队完成后队列中的 QUEUED 行数（含本条，插入语义=队尾第 N 位）。 */
  const queuePositionOf = async (sessionId: number): Promise<number> => (await feishuInboundQueueRepo.countPending(sessionId));
  const feishuInboundHandler = new AgentFeishuInboundHandler({
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
    },
    harnessService: harness as never,
    createCancelFlag: (sessionId) => agentLoop.registerCancelFlag(sessionId),
    releaseCancelFlag: (sessionId) => agentLoop.removeCancelFlag(sessionId),
    createProgressCard: createFeishuProgressCard,
    onInterruptRunning: (sessionId) => {
      try { shellManager.closeByConversation(sessionId); } catch (error) {
        console.debug(`关闭飞书会话 Shell 失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    queueService: feishuTaskQueue,
    createQueueCard: async (context, _queueId, sessionId) => createFeishuQueueCard(context, _queueId, await queuePositionOf(sessionId)),
    resolveBotId: (accountId) => Number(accountId),
    onReply: async (context, text) => { await sendFeishuText(Number(context.accountId), context, text); },
    downloadMedia: async (context, workspace) => {
      const botId = Number(context.accountId);
      const client = await getFeishuClient(botId);
      if (client == null) return null;
      const isMedia = context.messageType === 'image' && context.imageKey != null
        || context.messageType === 'file' && context.fileKey != null;
      if (!isMedia || context.messageId == null) return null;
      const maxBytes = Math.max(1, cfg.feishu.bot.file.maxInboundFileMb) * 1024 * 1024;
      const images: string[] = [];
      const filePaths: string[] = [];
      const errors: string[] = [];
      try {
        if (context.messageType === 'image' && context.imageKey != null) {
          try {
            const { buffer, contentType } = await downloadFeishuMediaBuffer(client, context.messageId, context.imageKey, 'image', maxBytes);
            if (buffer.length === 0) errors.push('图片（接收失败）');
            else images.push(dataUriOf(contentType, buffer));
          } catch (error) {
            console.error(`飞书图片下载失败, bot=${botId}, messageId=${context.messageId}`, error);
            errors.push('图片（接收失败）');
          }
        } else if (context.messageType === 'file' && context.fileKey != null) {
          if (workspace == null || workspace === '') {
            errors.push(context.fileName ?? '文件（接收失败）');
          } else {
            try {
              const { buffer } = await downloadFeishuMediaBuffer(client, context.messageId, context.fileKey, 'file', maxBytes);
              if (buffer.length === 0) {
                errors.push(context.fileName ?? '文件（接收失败）');
              } else {
                const fileName = sanitizeFeishuFileName(context.fileName, `feishu-${context.fileKey}`);
                mkdirSync(workspace, { recursive: true });
                const target = resolve(workspace, fileName);
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
      return { images, filePaths, errors };
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
    },
  });
  const resolveFeishuSenderName = async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    const senderId = event.senderId;
    if (senderId == null) return null;
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
  const downloadFeishuGroupImage = async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    if (event.chatType !== 'group' || event.chatId == null || event.messageId == null || event.imageKey == null) return null;
    const client = await getFeishuClient(Number(accountId));
    if (client == null) return null;
    const workspace = resolveFeishuChatWorkspace(cfg.app.harness.workspaceRoot, accountId, event.chatId);
    const maxBytes = Math.max(1, cfg.feishu.bot.file.maxInboundFileMb) * 1024 * 1024;
    const { buffer, contentType } = await downloadFeishuMediaBuffer(client, event.messageId, event.imageKey, 'image', maxBytes);
    if (buffer.length === 0) return null;
    mkdirSync(workspace, { recursive: true });
    const ext = IMAGE_EXT_BY_CONTENT_TYPE[contentType] ?? '.jpg';
    const target = resolve(workspace, `feishu-image-${event.messageId}${ext}`);
    await writeFile(target, buffer);
    return target;
  };
  const feishuInboundProcessor = new FeishuInboundProcessor(feishuInboundHandler, {
    messageService: feishuMessageService,
    resolveSenderName: resolveFeishuSenderName,
    downloadGroupImage: downloadFeishuGroupImage,
    resolveQuotedMessage: async (accountId, event) => {
      if (event.parentId == null) return null;
      // 群消息日志优先：免 API 调用，发送人姓名与占位符格式也和上下文一致。
      const fromLog = event.chatId != null
        ? await feishuMessageRepository.findGroupMessageByMessageId(String(accountId), event.chatId, event.parentId)
        : null;
      if (fromLog != null) {
        return truncateQuoted(`[${formatGroupTime(fromLog.createdAt)}] ${fromLog.senderName}：${fromLog.content ?? ''}`);
      }
      // 日志未命中（引用机器人消息、超出日志窗口或私聊）：通过消息详情 API 兜底。
      const client = await getFeishuClient(Number(accountId));
      if (client == null) return null;
      const detail = await fetchFeishuMessageDetail(client, event.parentId);
      if (detail == null) return null;
      return truncateQuoted(detail.text);
    },
    resolveUserId: async (accountId, event) => {
      const unionId = event.senderUnionId ?? event.senderId;
      if (unionId == null) return null;
      return (await feishuBinding.findUserIdByUnionId(unionId)) ?? null;
    },
    authorizeSender: async (accountId, event) => {
      const unionId = event.senderUnionId ?? event.senderId;
      if (unionId == null) return false;
      const userId = await feishuBinding.findUserIdByUnionId(unionId);
      if (userId == null) return false;
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
      if (client == null || event.chatType !== 'group' || event.chatId == null || event.messageId == null) return false;
      let auth;
      try {
        auth = await feishu.getQrCodeUrl();
      } catch { return false; }
      await pendingBindingMessages.insert({ state: auth.state, appId: Number(accountId), messageId: event.messageId, event });
      const card = {
        schema: '2.0', config: { update_multi: true },
        header: { template: 'orange', title: { tag: 'plain_text', content: '需要完成飞书绑定' } },
        body: { direction: 'vertical', padding: '12px 12px 12px 12px', elements: [
          { tag: 'markdown', content: '请先完成飞书账号绑定，获得群内使用权限后再试。' },
          { tag: 'markdown', content: `[点击完成绑定](${auth.authUrl})` },
        ] },
      };
      let response;
      try {
        response = await client.im.v1.message.reply({
          path: { message_id: event.messageId },
          data: { msg_type: 'interactive', content: JSON.stringify(card) },
        });
      } catch (error) {
        await pendingBindingMessages.fail(auth.state);
        throw error;
      }
      const cardMessageId = (response as { data?: { message_id?: string } }).data?.message_id;
      if (cardMessageId == null || cardMessageId === '') {
        await pendingBindingMessages.fail(auth.state);
        return false;
      }
      try {
        await pendingBindingMessages.setCardMessageId(auth.state, cardMessageId);
      } catch (error) {
        await pendingBindingMessages.fail(auth.state);
        throw error;
      }
      return true;
    },
    unauthorizedText: async (_accountId, event) => {
      const base = event.chatType === 'group'
        ? '请先完成飞书账号绑定，获得群内使用权限后再试。'
        : '请先完成飞书账号绑定后再试。';
      let link = '';
      try {
        if (feishu.isEnabled()) {
          const qr = await feishu.getQrCodeUrl();
          link = qr.authUrl ?? '';
        }
      } catch { link = ''; }
      return link ? `${base}\n点击完成绑定：${link}` : base;
    },
  });
  pendingBindingProcessor = feishuInboundProcessor;
  const feishuCardActionService = new FeishuCardActionService({
    queuePort: feishuTaskQueue,
    interrupt: (sessionId) => feishuInboundHandler.interrupt(sessionId),
    patchCard: async (botId, cardMessageId, card) => {
      const client = await getFeishuClient(botId);
      if (client == null) throw new Error(`飞书客户端不可用, botId=${botId}, cardMessageId=${cardMessageId}`);
      await client.im.v1.message.patch({ path: { message_id: cardMessageId }, data: { content: JSON.stringify(card) } });
    },
  });
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
    registerAuthRoutes(api, authService, feishu);
    registerUserRoutes(api, userService, userRepo, permissionService);
    registerPermissionRoutes(api, permissionService);
    registerGitCredentialRoutes(api, gitCredentials);
    registerAgentRoutes(api, {
      agentService, experienceService, userRepo, mcpServerValidator: mcpValidator,
      permissionService,
    });
    registerModelRoutes(api, { modelService, permissionService });
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
      permissionService,
    });
    registerFileRoutes(api, {
      fileService, sessionService, workspaceBrowseService: workspaceBrowse,
      workspaceGitService: workspaceGit, gitCommitMessageService: gitCommitMsg,
      gitWriteOperationService: gitWrite, pathSandbox, uploadBaseUrl: cfg.app.upload.baseUrl,
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
        listOptions: async () => (await agentRepo.selectList()).map((a) => ({ id: a.id!, name: a.name })),
      } as never,
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
    registerAdminSystemCommandRoutes(api, { commandRepo, permissionService });
    registerMcpServerRoutes(api, {
      mcpServerService, mcpClientManager: mcpClient, userMcpPreferenceService: mcpPref, permissionService,
    });
    registerWeixinBotRoutes(api, { jwt, qrLogin, accountRepository: weixinAccounts, monitorService: weixinMonitor });
    registerFeishuBotRoutes(api, {
      repository: feishuBots,
      secretKey: cfg.feishu.bot.appSecretKey,
      permissionService,
    });
    registerFeishuBindingRoutes(api, { jwt, repository: feishuBinding, auth: feishu });
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
  feishuMonitor.start();
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
    async (sessionId, userId) => {
      void wsHandler.autoConsumeQueue(sessionId, userId);
      // 崩溃恢复续跑结束后，若飞书队列仍有排队消息则接力消费。
      await feishuInboundHandler.drainNextIfPending(sessionId).catch((error) => {
        console.error(`飞书崩溃恢复后队列接力消费失败, sessionId=${sessionId}`, error);
      });
    },
    subagentCoordinator,
  );
  void crash.run().catch((e) => console.error('Crash recovery failed', e)).then(async () => {
    // 等崩溃恢复初始扫描提交后再触发队列接力。hydrate 对崩溃时在途执行的 RUNNING 队列行按
    // 「消息是否已写入会话历史」分支：已落库→删除（其消息由崩溃恢复重放）；未落库→复位为 QUEUED（重新消费，不丢）。
    // 这里只消费真正的 QUEUED 排队行；若会话仍在被崩溃恢复续跑，drainNextIfPending 的
    // isBusyOrRecovering（DB phase RUNNING/RESUMING）会兜住不抢跑。
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
      shellManager.stopCleanup();
      weixinMonitor.shutdown();
      feishuMonitor.shutdown();
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
