import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fail } from './common/result.js';
import { harnessLog } from './harness/log.js';
import { ErrorCode } from './common/error-code.js';
import { fastifyLoggerOptions, redactCredentialQuery } from './common/structured-logger.js';
import { sendJson, sendOk, handleError } from './common/http-error.js';
import { loadConfig, type AppConfig } from './config/app-config.js';
import { corsForRequest } from './config/cors-policy.js';
import { loadTrustedProxyAddresses } from './config/trusted-proxy.js';
import { createPool, Db } from './db/db.js';
import { runFlywayIfEnabled } from './db/flyway.js';
import { JwtService } from './crypto/jwt.service.js';
import { hashPassword, matchesPassword } from './crypto/password.js';
import { authenticateRequest, autoDisabledTokenBlocksRequest, isPublicPath } from './auth/jwt-hook.js';
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
import { MysqlEnvVariableRepository } from './env/env-variable.repository.js';
import { EnvVariableService } from './env/env-variable.service.js';
import { registerAdminEnvVariableRoutes, registerEnvVariableRoutes } from './env/env-variable.routes.js';
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
import { AgentBundleService } from './agent/agent-bundle.service.js';
import { AgentImportOriginRepository } from './agent/agent-import-origin.repository.js';
import { SharedAgentEntryRepository } from './agent/shared-agent.repository.js';
import { SharedAgentService } from './agent/shared-agent.service.js';
import { registerAgentAvatarRoutes } from './agent/agent-avatar.js';
import { registerAgentRoutes } from './agent/agent.routes.js';
import { registerAgentBundleRoutes } from './agent/agent-bundle.routes.js';
import { registerSharedAgentRoutes } from './agent/shared-agent.routes.js';
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
import { registerEmbedRoutes } from './embed/embed.routes.js';
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
import { MessageCitationService } from './session/message-citations.js';
import { channelAssistantReply } from './session/util/citation-markers.js';
import { SessionTitleService } from './session/session-title.service.js';
import { ActivityService } from './session/activity.service.js';
import { RunTraceService } from './session/run-trace.service.js';
import { SessionActivityRepository, SessionTodoRepository, SubagentExecutionRepository } from './session/activity.repository.js';
import { MessageQueueService } from './session/message-queue.service.js';
import { MessageQueueRepository } from './session/message-queue.repository.js';
import { registerSessionRoutes } from './session/session.routes.js';
import { registerSessionShareRoutes } from './session/session-share.routes.js';
import { MysqlSessionShareRepository } from './session/session-share.repository.js';
import { SessionShareService } from './session/session-share.service.js';
import { SessionExportService } from './session/session-export.service.js';
import { registerAdminSessionRoutes } from './session/admin-session.routes.js';
import { registerAdminSessionFilesRoutes } from './session/admin-session-files.routes.js';
import { SessionActivityHeartbeat } from './session/session-activity-heartbeat.js';
import { TaskTerminalService } from './session/task-terminal.service.js';
import { MemoryRepository } from './memory/memory.repository.js';
import { MemoryService } from './memory/memory.service.js';
import { MemoryExtractionService } from './memory/memory-extraction.service.js';
import { registerMemoryRoutes } from './memory/memory.routes.js';
import { ApprovalRuleRepository } from './approval-rule/approval-rule.repository.js';
import { ApprovalRuleService } from './approval-rule/approval-rule.service.js';
import { registerApprovalRuleRoutes, type ApprovalRuleAuditInput } from './approval-rule/approval-rule.routes.js';
import { registerApprovalRuleAdminRoutes } from './approval-rule/approval-rule.admin.routes.js';
import { InboxRepository } from './inbox/inbox.repository.js';
import { InboxService } from './inbox/inbox.service.js';
import { InboxCleanupScheduler, type InboxCleanupStore } from './inbox/inbox.cleanup.js';
import { ScheduledTaskRunCleanupScheduler } from './schedule/run-cleanup.js';
import { registerInboxRoutes } from './inbox/inbox.routes.js';
import { EnvironmentInfoProvider } from './harness/core/environment-info-provider.js';
import { FileEntityRepository, FileService } from './file/file.service.js';
import { WorkspaceBrowseService } from './file/workspace-browse.service.js';
import { WorkspaceGitService } from './file/workspace-git.service.js';
import { GitWriteOperationService } from './file/git-write-operation.service.js';
import { GitCommitMessageService } from './file/git-commit-message.service.js';
import { registerFileRoutes } from './file/file.routes.js';
import { WorkspaceWriteService } from './file/workspace-write.service.js';
import { OssStsService, createAliyunAssumeRoleClient } from './oss/oss-sts.service.js';
import { registerOssRoutes } from './oss/oss.routes.js';
import { registerSkillRoutes } from './skill/skill.routes.js';
import { registerSkillBundleRoutes } from './skill/skill-bundle.routes.js';
import { SkillBundleService } from './skill/skill-bundle.service.js';
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
import { FEISHU_DISLIKE_SOURCE, FeedbackRepository } from './feedback/feedback.repository.js';
import { FeedbackDbLookup, FeedbackService } from './feedback/feedback.service.js';
import { registerFeedbackRoutes } from './feedback/feedback.routes.js';
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
import { UserMcpLoadModeMapper } from './harness/mcp/mapper/user-mcp-load-mode.mapper.js';
import { UserMcpLoadModeService } from './harness/mcp/preference/service/user-mcp-load-mode.service.js';
import { McpLoadModeResolver } from './harness/mcp/workingset/mcp-load-mode.js';
import { createMcpReadOnlyLookup } from './harness/mcp/workingset/mcp-read-only-lookup.js';
import { OpenAiLlmAdapter } from './harness/llm/openai-llm-adapter.js';
import { AnthropicLlmAdapter } from './harness/llm/anthropic-llm-adapter.js';
import { ResponsesLlmAdapter } from './harness/llm/responses-llm-adapter.js';
import { LlmAdapterFacade } from './harness/llm/llm-adapter-facade.js';
import type { LlmAdapter } from './harness/llm/chat-request.js';
import { createDefaultToolRegistry } from './harness/tool/tool-registry.js';
import { HttpApiExecutor } from './harness/tool/impl/http-api-executor.js';
import { ToolDispatcher } from './harness/tool/tool-dispatcher.js';
import { DangerAssessor } from './harness/tool/danger-assessor.js';
import { ProxyApprover } from './harness/tool/proxy-approver.js';
import { JevRiskAssessor } from './harness/tool/jev-risk-assessor.js';
import { ApprovalModelResolver } from './harness/tool/approval-model-resolver.js';
import { CompactionModelResolver } from './harness/tool/compaction-model-resolver.js';
import { BudgetRepository, BudgetSpendStore } from './budget/budget.repository.js';
import { BudgetService, type BudgetBlock } from './budget/budget.service.js';
import { registerBudgetRoutes } from './budget/budget.routes.js';
import { AskUserQuestionsRegistry } from './harness/tool/ask-user-questions-registry.js';
import { AgentLoop } from './harness/core/agent-loop.js';
import { HarnessService } from './harness/core/harness-service.js';
import { PromptEngine } from './harness/core/prompt-engine.js';
import { ContextManager } from './harness/core/context-manager.js';
import { CompactionService } from './harness/core/compaction-service.js';
import { CompactionArchiveService } from './harness/core/compaction-archive.service.js';
import { SessionCompactionOrchestrator } from './harness/core/session-compaction-orchestrator.js';
import { WorkspaceRulesSnapshotRepository } from './harness/core/workspace-rules-snapshot.repository.js';
import { WorkspaceRulesSnapshotService } from './harness/core/workspace-rules-snapshot.service.js';
import { CompactionSignalBus } from './harness/core/compaction-signal-bus.js';
import { SessionHistoryLoader } from './harness/core/session-history-loader.js';
import { TokenEstimator } from './harness/core/token-estimator.js';
import { ActiveContextCalculator } from './harness/core/active-context-calculator.js';
import { BackgroundTaskManager } from './harness/core/background-task-manager.js';
import { CompactionConfig } from './harness/core/compaction-config.js';
import { CrashRecoveryRunner } from './harness/core/crash-recovery-runner.js';
import { DeployDrainWatcher } from './harness/core/deploy-drain-watcher.js';
import { readActiveBackendPort, readDeployLock } from './harness/core/deploy-lock.js';
import { sumCostMicros, wallClockMs } from './session/run-window.js';
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
import { StreamingWsHandler, createScheduledLiveExecution, budgetBlockMessage } from './session/ws/streaming-ws-handler.js';
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
import { WeixinInboundMessageRepository } from './weixin/inbound-message.repository.js';
import { WeixinWebhookFallbackService } from './weixin/webhook-fallback.service.js';
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
import { EmailWebhookSender } from './notification/task/email-sender.js';
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
import { FeishuMessageService, formatGroupTime, senderName } from './feishu/message.service.js';
import { buildQuotedInjection } from './feishu/quoted-injection.js';
import { feishuSummarizerModelConfig, GroupContextSummarizer } from './feishu/group-context-summarizer.js';
import { FeishuInboundProcessor } from './feishu/inbound-processor.js';
import { MysqlFeishuPendingBindingRepository } from './feishu/pending-binding.repository.js';
import { replayFeishuPendingMessage } from './feishu/pending-replay.js';
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
import { MysqlFeishuCardSnapshotRepository } from './feishu/card-snapshot.repository.js';
import { FeishuTaskQueueService } from './feishu/inbound-queue.service.js';
import { FeishuCardActionService } from './feishu/card-action.service.js';
import { persistFeishuCancelIfIdle } from './feishu/cancel-running.js';
import { readFeishuDocMarkdown } from './feishu/doc-reader.js';
import { fetchFeishuMessageDetail } from './feishu/message-detail.js';
import { resolveFeishuQuotedText } from './feishu/merge-forward.js';
import { feishuSendTargetOf, sendFeishuFile, sendFeishuImage } from './feishu/media-sender.js';
import { FeishuCardProgressListener, type FeishuCardProgress } from './feishu/card-progress-listener.js';
import { createDingtalkRuntime } from './dingtalk/runtime.js';
import type { DingtalkMediaSendSupport } from './harness/tool/impl/dingtalk-tools.js';
import { buildFeishuProgressCard, feishuSessionDetailUrl } from './feishu/progress-card.js';
import { FeishuAskFormStore } from './feishu/ask-form-store.js';
import { FeishuActiveProgressRegistry } from './feishu/active-progress.js';
import { createFeishuAskMount } from './feishu/ask-mount.js';
import { wsEvent } from './session/ws/ws-event.js';
import { inboundImageKeys } from './feishu/event-normalizer.js';
import { chatFilesDirOf, resolveChatFileTarget } from './feishu/chat-files.js';
import { createFeishuMediaHelper, IMAGE_EXT_BY_CONTENT_TYPE } from './feishu-media-helpers.js';
import { createFeishuQueueCardHelper } from './feishu-queue-card.js';
import { createFeishuSessionUrlHelper } from './feishu-session-url.js';
import { createFeishuRoundOffsetHelper } from './feishu-round-offset.js';
import { createFeishuUserIdHelper } from './feishu-user-id.js';
import { createPersistCancelledHelper } from './persist-cancelled.js';
import { createPatchedProgressHelper } from './feishu-patched-progress.js';
import { createFeishuProgressCardHelper } from './feishu-progress-card.js';
import { createFeishuRecoveryProgressHelper } from './feishu-recovery-progress.js';
import type { FeishuInboundContext, FeishuNormalizedMessage } from './feishu/types.js';
import { WsStreamingEventListener } from './session/ws/ws-streaming-event-listener.js';
import { MysqlApiTokenRepository, MysqlOutboundDeliveryRepository, MysqlOutboundSubscriptionRepository, MysqlWebhookTriggerRepository } from './openapi/openapi.repository.js';
import { ApiTokenService } from './openapi/api-token.service.js';
import { ApiTokenCipher } from './openapi/api-token-cipher.js';
import { FixedWindowRateLimiter } from './openapi/rate-limiter.js';
import { OpenRunService, type OpenRunDeps } from './openapi/open-run.service.js';
import { WebhookTriggerService, type WebhookTriggerDeps } from './openapi/webhook-trigger.service.js';
import { OutboundSubscriptionService } from './openapi/outbound-subscription.service.js';
import { GenericHttpWebhookSender } from './openapi/generic-webhook-sender.js';
import { OutboundDeliveryScheduler } from './openapi/outbound-delivery.scheduler.js';
import { OPEN_HOOKS_PATH_PREFIX, registerOpenApiRoutes, type RawBodyRequest } from './openapi/open.routes.js';
import { OpenApiCallLogRepository } from './openapi/open-api-call-log.repository.js';
import { OpenApiCallLogService } from './openapi/open-api-call-log.service.js';
import { OpenApiCallLogCleanup } from './openapi/open-api-call-log.cleanup.js';
import { registerOpenApiCallLogRoutes } from './openapi/open-api-call-log.routes.js';
import { SignalSecretCipher } from './signal/signal-cipher.js';
import { MysqlUserToolRepository } from './user-tool/user-tool.repository.js';
import { UserToolService } from './user-tool/user-tool.service.js';
import { UserToolHeaderCipher } from './user-tool/user-tool-cipher.js';
import { registerUserToolRoutes } from './user-tool/user-tool.routes.js';
import { registerAdminUserToolRoutes } from './user-tool/user-tool-admin.routes.js';
import { MysqlSignalCheckRepository, MysqlSignalWatcherRepository } from './signal/signal.repository.js';
import { WatcherService } from './signal/watcher.service.js';
import { WatcherScheduler } from './signal/watcher-scheduler.js';
import { SignalCheckCleanup } from './signal/signal-check-cleanup.js';
import { registerSignalWatcherRoutes } from './signal/watcher.routes.js';
import { registerSignalAdminRoutes } from './signal/signal-admin.routes.js';
import { DigestRepository } from './digest/repository.js';
import { DigestService } from './digest/service.js';
import { DigestScheduler } from './digest/scheduler.js';
import { registerDigestRoutes } from './digest/routes.js';
import { RuntimeChannelServer } from './harness/container/runtime-channel-server.js';
import { ContainerRegistry } from './harness/container/container-registry.js';
import { DockerToolRouter } from './harness/container/docker-tool-router.js';
import { RuntimeModeResolver, RUNTIME_MODE_SETTING_KEY, validateRuntimeModeSave } from './harness/container/runtime-mode.js';
import { SessionEnvelopeBuilder, buildDepsEnv } from './harness/container/session-envelope-builder.js';
import { DockerSendBytesBridge } from './harness/container/read-bytes-bridge.js';
import { RoutingMcpClientManager } from './harness/container/routing-mcp-client-manager.js';
import { PtyChannelHub } from './harness/container/pty-bridge.js';
import { isChannelWorkspace } from './harness/container/channel-workspace.js';
import { nodePtyFactory, type PtyLike, type SpawnPtyOptions } from './harness/terminal/remote-terminal.js';
import {
  resolveFeishuChatWorkspace,
  sanitizeFeishuFileName,
  truncateQuoted,
  downloadFeishuMediaBuffer,
  dataUriOf,
} from './feishu-media.js';
import { registerUploadStatic } from './upload-static.js';
import { expandHome, parseSqlTimeMs, runtimeSessionCleanup } from './app-utils.js';
import { createShutdownHandler } from './app-shutdown.js';
import { createContainerPtyFactory } from './container-pty-factory.js';
import { createTerminalAudit } from './terminal-audit.js';
import { createFeishuSessionHelper } from './feishu-session.js';
import { createFeishuClientHelper } from './feishu-client.js';

export interface MaoApp {
  app: FastifyInstance;
  close(): Promise<void>;
}

/**
 * 装配期共享上下文：集中管理 createMaoApp 内部的延迟解引用变量。
 * 这些变量在构造顺序上晚于某些 service 的构造，通过 ctx 属性访问
 * 使依赖关系显式化，避免散落的 let + 闭包捕获。
 */
interface AppContext {
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

  const isOpenAgentRun = (request: { method: string; url: string }): boolean => {
    if (request.method !== 'POST') return false;
    const path = request.url.split('?')[0].replace(/^\/api/, '') || '/';
    return /^\/v1\/open\/agents\/[^/]+\/run$/.test(path);
  };
  const presentedMaoPrefix = (request: { headers: { authorization?: string | string[] }; query: unknown }): string => {
    const header = request.headers.authorization;
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (bearer != null && bearer.startsWith('mao_')) return bearer.slice(0, 12);
    const queryToken = (request.query as { token?: unknown } | null)?.token;
    if (typeof queryToken === 'string' && queryToken.startsWith('mao_')) return queryToken.slice(0, 12);
    return '';
  };

  app.addHook('preParsing', async (request, _reply, payload) => {
    // HMAC 验签以原始字节为准（决策 15）：Fastify 默认 JSON 解析后重序列化不保证
    // 还原发送方字节。仅对 hooks 公开路径做 tee 捕获，其余路径零开销直通。
    if (request.method !== 'POST' || !request.url.split('?')[0].replace(/^\/api/, '').startsWith(OPEN_HOOKS_PATH_PREFIX)) {
      return payload;
    }
    const chunks: Buffer[] = [];
    const tap = new Transform({
      transform(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback(null, chunk);
      },
      flush(callback) {
        (request as RawBodyRequest).rawBody = Buffer.concat(chunks);
        callback(null);
      },
    });
    payload.pipe(tap);
    return tap;
  });
  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url.split('?')[0] === ssoExchangePath) return;
    const auth = await authenticateRequest(request, jwt, (plain) => apiTokenService.resolveByToken(plain, {
      onReject: (rejected) => {
        if (!isOpenAgentRun(request)) return;
        void openCallLogHolder.current?.recordAuthReject({
          reason: rejected.reason,
          tokenPrefix: rejected.tokenPrefix,
          tokenId: 'tokenId' in rejected ? rejected.tokenId : undefined,
          userId: 'userId' in rejected ? rejected.userId : undefined,
          sourceIp: request.ip,
        });
      },
    }));
    if (auth.userId != null) request.userId = auth.userId;
    // 公开路径（含入站 Webhook）自验签，不能被请求头里已停用的 API Token 提前 403。
    if (auth.tokenAutoDisabled && autoDisabledTokenBlocksRequest(request.method, request.url)) {
      sendJson(reply, 403, fail(ErrorCode.TOKEN_AUTO_DISABLED.code, ErrorCode.TOKEN_AUTO_DISABLED.message));
      return;
    }
    if (!isPublicPath(request.method, request.url) && auth.userId == null) {
      if (isOpenAgentRun(request) && !auth.resolverRejected) {
        void openCallLogHolder.current?.recordAuthReject({
          reason: 'not_found',
          tokenPrefix: presentedMaoPrefix(request),
          sourceIp: request.ip,
        });
      }
      sendJson(reply, 401, fail(1001, '未登录或登录已过期'));
      return;
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
  // 团队共享目录条目仓储先于 AgentService 构造：deleteAgent 逻辑删除时服务层级联清条目（表无外键）
  const sharedAgentEntryRepo = new SharedAgentEntryRepository(db);
  const agentService = new AgentService(agentRepo, experienceService, suggestedQuestionService, modelRepo, sharedAgentEntryRepo);
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
  const userSkillService = new UserSkillService(userSkillsDir);
  const skillDocService = new SkillDocService(skillLoader);
  // 资产分发闭环 P3：mao-skill-bundle v1 导出/导入
  const skillBundleService = new SkillBundleService(skillLoader, userSkillService);

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
    mergeWindowMs: cfg.weixin.bot.mergeWindowMs,
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
  const userMcpLoadModeService = new UserMcpLoadModeService(new UserMcpLoadModeMapper(db));
  const mcpLoadModeResolver = new McpLoadModeResolver({
    userLoadMode: userMcpLoadModeService,
    systemSettingService: settingService,
  });
  const mcpSync = new McpSyncService(mcpMapper, mcpServerService, mcpToolsRegistry, mcpPref);
  // 会话删除路径要回收 CLOUD MCP 快照，而 mcpSync 晚于 sessionService 构造：先用引用占位。
  ctx.mcpSyncRef = mcpSync;

  // Agent 资产化：bundle 导出/导入（P1）+ 团队共享目录（P2）+ registry/URL 导入/检查更新（P2 分发闭环）
  const mcpServerLookup = new MysqlMcpServerLookup(db);
  const agentImportOriginRepo = new AgentImportOriginRepository(db);
  const agentBundleService = new AgentBundleService(
    agentRepo, experienceService, suggestedQuestionService, skillLoader, userSkillService,
    mcpServerService, mcpMapper, mcpCipher,
    agentImportOriginRepo, sharedAgentEntryRepo,
  );
  const sharedAgentService = new SharedAgentService(
    sharedAgentEntryRepo,
    { findById: (id) => agentRepo.findById(id) },
    skillLoader,
    userSkillService,
    {
      findById: (id) => mcpServerLookup.findById(id),
      // 与 PUT /v1/mcp-servers/:id/status 同一 service 方法（fix-deps 的 will-enable 动作）
      updateStatus: (id, status) => mcpServerService.updateStatus(id, status),
    },
    permissionService,
  );

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
  }, {
    autoCacheEnabled: harnessTuning.llm.anthropicAutoCache,
    cacheTtl: harnessTuning.llm.anthropicCacheTtl,
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
  const promptEngine = new PromptEngine(skillLoader, pathSandbox, runtimeResolver, commandService, skillSync, workspaceRulesSnapshotService);
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
  const compactionModelResolver = new CompactionModelResolver(
    (key) => settingService.getValue(key),
    (id) => modelRepo.findById(id),
  );
  const orchestrator = new SessionCompactionOrchestrator(
    compactionSvc, sessionCompactionEventService, historyLoader,
    contextManager, sessionSvc, activeContext, promptEngine, compactionArchiveService,
    compactionModelResolver, workspaceRulesSnapshotService,
  );
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
  const cloudRuntimeCfg = cfg.app.cloudRuntime;
  const containerChannelHolder: { registry: ContainerRegistry | null } = { registry: null };
  const channelServer = new RuntimeChannelServer({
    channelDir: cloudRuntimeCfg.container.channelDir,
    // 回调仅在连接建立后触发，此处引用 channelServer 自身无 TDZ 问题
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
    // 图片产物按用户隔离：容器挂 {uploadDir}/{userId}（nginx /uploads/ 静态出口同源）
    uploadDir,
    // 先 listen 再 docker run：容器 agent 启动即连 socket，宿主机没监听时只会无限重连
    ensureChannelListening: async (userId) => channelServer.ensureListening(userId),
    // token 随 docker run -e 注入（不再依赖容器读 .token 文件的隐式路径）
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
    // 通道会话（飞书/钉钉）工作区越出每用户根，需按用户会话并入挂载清单（N-2）。
    // 归属校验即 SQL 的 user_id 过滤：只可能拿到该用户自己的会话工作区
    sessionWorkspacesOf: async (userId) => {
      const all = await sessionRepo.listWorkspacesByUser(userId).catch((e) => {
        console.debug(`Session workspace lookup skipped for user ${userId}: ${(e as Error).message}`);
        return [] as string[];
      });
      // 只挂通道工作区：web 会话在 {workspaceRoot}/{userId} 之内已被标准清单覆盖，
      // 其余形态（null/异常路径）一律不挂，交由 ensureRunning 的明确报错兜底
      return all.filter((w) => isChannelWorkspace(w, cfg.app.harness.workspaceRoot));
    },
  });
  containerChannelHolder.registry = containerRegistry;
  // 全局运行时模式：管理后台「系统设置 → 运行环境」写 system_setting.runtime.mode，
  // 缺行/非法/查询失败回落 MAO_CLOUD_RUNTIME（app.cloudRuntime.mode，默认 host）。
  const runtimeModeResolver = new RuntimeModeResolver({
    systemSettingService: settingService,
    fallbackMode: cloudRuntimeCfg.mode,
  });
  /** 幂等激活容器运行时（预检 + 空闲回收巡检）；失败不置位，修复后可由后台再次保存触发。 */
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
  // MCP stdio 容器路由：容器用户的连接与 callTool 在容器内执行（§5.10），其余直通宿主机
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
  }) as never;
  // 终端 pty 容器桥：docker 用户经 channel 在容器内 spawn（§5.7.3），其余走宿主机 node-pty。
  // hub 按用户长生存期：agent 重连换连接时 bindConnection 迁移订阅（在飞终端不中断）；
  // 容器重建（startedAtMs 变化）时旧容器内的 pty 已不存在，旧 hub 全部收尾后换绑新连接。
  const ptyChannelHubs = new Map<number, PtyChannelHub>();
  const ptyHubGeneration = new Map<number, number>();
  const containerPtyFactory = createContainerPtyFactory({
    dockerRouter, containerRegistry, channelServer, ptyChannelHubs, ptyHubGeneration, nodePtyFactory,
  });
  // 容器预热：会话活跃（WS 连接/执行心跳）时确保该用户容器就绪（决策 15）
  activityHeartbeat.onActivity((sessionId) => {
    void (async () => {
      const session = await sessionRepo.findById(sessionId).catch(() => null);
      if (session?.userId == null) return;
      if (!(await dockerRouter.enabledFor(session.userId))) return;
      // 带上会话工作区：通道会话工作区未挂载时预热阶段就重建，避免首个工具调用才触发
      await containerRegistry.ensureRunning(session.userId, session.workspace ?? null);
    })().catch((e) => {
      console.debug(`Container prewarm skipped for session ${sessionId}: ${(e as Error).message}`);
    });
  });
  // 启动激活：env 显式 docker 时预检失败沿用「直接退出」语义；DB 覆盖为 docker 时
  // 只记 error 并继续启动，避免一条配置值让服务起不来（管理员可在后台切回 host）。
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

  const holder: { harness?: HarnessService; loop?: AgentLoop } = {};
  const scheduledStore = new ScheduledTaskDbStore(db);
  ctx.deleteScheduledTasksForSession = (sessionId) => scheduledStore.deleteBySessionId(sessionId);

  const senderRegistry = new WebhookSenderRegistry([
    new DingTalkWebhookSender(), new FeishuWebhookSender(),
    // 邮件渠道（V162）：发送时实时读 SMTP 配置（settingService），保存后即时生效
    new EmailWebhookSender(settingService),
  ]);
  const urlValidator = new WebhookUrlValidator();
  const notifPref = new TaskNotificationPreferenceService(
    new PreferenceDbStore(db), notifCipher, urlValidator, senderRegistry,
    // EMAIL 渠道依赖：收件地址取用户表 email；SMTP 开关用设置服务窄接口
    { findEmailById: (userId) => userRepo.findEmailById(userId) },
    settingService,
  );
  // 微信下行失败时的 webhook 降级推送：复用 notifPref 的 findEnabled，不重复读配置。
  const weixinWebhookFallback = new WeixinWebhookFallbackService(
    notifPref, notifCipher, senderRegistry,
  );
  const deliveryService = new TaskNotificationDeliveryService(
    new DeliveryDbStore(db), notifPref, messageQueueService as never,
  );
  const memoryRepo = new MemoryRepository(db);
  const memoryService = new MemoryService(memoryRepo, {
    listProjectKeyRows: (userId) => sessionRepo.listProjectKeyRows(userId),
  });
  const memoryExtraction = new MemoryExtractionService(
    messageRepo,
    memoryRepo,
    {
      isAutoCaptureEnabled: async (userId) => {
        // 默认关闭（无偏好行视为关闭）：未开启的用户不做自动抽取，现有功能零影响
        const row = await memoryRepo.findPreference(userId);
        return row?.autoCaptureEnabled === 1;
      },
    },
    { getValue: (key) => settingService.getValue(key) },
    {
      selectById: (id) => modelRepo.selectById(id),
      selectDefault: () => modelRepo.selectDefault(),
    },
    llmAdapter,
  );
  const messageCitationService = new MessageCitationService(sessionService);
  const taskTerminal = new TaskTerminalService(
    sessionService, wsRegistry, deliveryService, treeSignalPublisher, (fn) => agentExecutor.submit(fn),
    memoryExtraction, (fn) => agentExecutor.submit(fn),
    inboxService, 'MANUAL',
    // 出站订阅分发（task.completed / task.failed 泛化为用户可配置 HTTP 回调）
    { dispatchTaskTerminal: (input) => outboundSubscriptionService.dispatchTaskTerminal(input) },
    // 预算 WARN 结算（§5.8）：任务终态后比对 WARN 行，越线写 BUDGET_WARN 收件箱（fire-and-forget）
    {
      settleWarn: (target, notifyUserId) => budgetService.settleWarn(target, notifyUserId),
    },
    // 回复引用溯源（技术方案 2026-10-12）：任务完成时构建 URL 白名单并校验 [^n^] 标记（终态事件前内联 await）
    messageCitationService,
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
    inboxRecorder: inboxService,
    completionNoticeBroadcaster: {
      broadcastCompletionNotice: (userId, event) => {
        if (userId == null) return;
        // 关键帧通道：完成通知丢失后客户端要等下次 REST 重拉才补上，用户盯屏时完全看不到卡片。
        // 事件量极小（一次终态一帧），进关键队列不会挤占普通增量帧。
        wsRegistry.send(userId, wsEvent('assistant_message_saved', event.sessionId, event.data));
      },
    },
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
  scheduledService.setFailureNotifier((input) => inboxService.recordScheduledTaskPaused(input));
  // 24 小时窗口预检 + 窗口已关时的站内通知：定时任务在用户长时间未说话后触发时
  // context_token 必然已过期，不打 ilink 只收件箱指路（inbound repo 在下方创建，故后置注入）
  scheduledService.setWeixinInboundRepository({
    findLatestInboundAt: (accountId) => weixinInboundMessages.findLatestInboundAt(accountId),
  });
  scheduledService.setWeixinWindowNotifier(async (input) => {
    await inboxService.recordWeixinWindowClosed(input);
  });
  scheduledService.setWeixinWebhookFallback(weixinWebhookFallback);
  scheduledService.setRunWindowLoader(async (sessionId, messageId) => {
    const stamps = await messageRepo.selectUserStamps(sessionId);
    const anchor = stamps.find((stamp) => stamp.id === messageId);
    if (anchor?.createdAt == null) return { costMicros: null, wallClockMs: 0 };
    const upperId = stamps
      .map((stamp) => stamp.id)
      .filter((id): id is number => id != null && id > messageId)
      .sort((a, b) => a - b)[0];
    const upper = upperId == null ? null : (stamps.find((stamp) => stamp.id === upperId)?.createdAt ?? null);
    const calls = await llmCallRepo.selectBySessionWindow(sessionId, anchor.createdAt, upper);
    return {
      costMicros: sumCostMicros(calls),
      wallClockMs: wallClockMs(calls.map((call) => ({ createdAt: call.createdAt ?? null, durationMs: call.durationMs ?? null }))),
    };
  });

  const dingtalkMediaHolder: { current: DingtalkMediaSendSupport | null } = { current: null };

  // 自定义 HTTP 工具（V163）：定义域 + 执行内核。保留字校验要读内置工具名，
  // 而 registry 在下方创建，用惰性闭包打破循环（调用只发生在用户请求期）。
  const userToolRepo = new MysqlUserToolRepository(db);
  const userToolCipher = new UserToolHeaderCipher(cfg.app.userTool.secretKey);
  const userToolService = new UserToolService({
    repo: userToolRepo,
    cipher: userToolCipher,
    settings: settingService,
    builtinToolNames: () => toolRegistry.getAllTools().map((tool) => tool.getName()),
  });
  // 放行名单走系统设置（5s TTL 缓存由内核持有）；试运行与 http_call 共用同一实例。
  const httpApiExecutor = new HttpApiExecutor({
    allowlistProvider: () => settingService.getPrivateAllowlistCidrs(),
  });

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
    uploadContextPath: apiPrefix,
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
    sendBytesSupport: sendBytesBridge,
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
    mcpToolsRegistry,
    // 用可路由实例：CLOUD + docker 运行时下 mcp_call 需派发到容器内 bridge。
    mcpClientManager: routingMcpClient,
    // 自定义 HTTP 工具入口（http_describe / http_call）：依赖齐备才注册。
    userToolService,
    httpApiExecutor,
  });

  const toolDispatcher = new ToolDispatcher(
    toolRegistry, localToolExecutor, dangerAssessor, sessionMap,
    wsRegistry, askUserQuestionsRegistry, localToolSessions, treeSignalPublisher,
    backgroundTasks, deliveryService, feishuAskMount,
    proxyApprover, jevRiskAssessor, approvalModelResolver,
    inboxService,
    approvalRuleService,
    dockerRouter,
    // 工作集审批：LOCAL 会话从桌面上报的清单里取 readOnlyHint（未标注 → false，维持一律审批）。
    // 只在工作集模式免审：全量注入是「旧行为」开关，必须保持 MCP 一律审批（设计 §5.6）。
    createMcpReadOnlyLookup({
      sessionMapper: sessionMap,
      loadModeResolver: mcpLoadModeResolver,
      toolsRegistry: mcpToolsRegistry,
    }),
  );
  // 手动压缩信号总线：AgentLoop（工具轮边界消费）与 StreamingWsHandler（运行中置位）共享同一实例。
  const compactionSignalBus = new CompactionSignalBus();
  const agentLoop = new AgentLoop(
    llmAdapter, promptEngine, contextManager, toolDispatcher, backgroundTasks,
    shellManager, activityHeartbeat, sessionSvc, orchestrator, activeContext, routingMcpClient,
    () => backgroundSubagentManager,
    compactionSignalBus,
  );
  holder.loop = agentLoop;
  const harness = new HarnessService(
    agentLoop, toolRegistry, skillLoader, skillSync, localSkills, localAgentsMd,
    sessionMap, agentRepo as never, experienceService, modelRepo as never, fileChangeRepo as never,
    sessionSvc, compactionSvc, historyLoader, orchestrator,
    promptEngine, activeContext, compactionConfig, envInfo, db, routingMcpClient, mcpSync,
    {
      isEmbedSession: (sid: number) => embedPageToolRegistry.isEmbedSession(sid),
      isEmbedPageSession: (sid: number) => embedPageToolRegistry.isEmbedPageSession(sid),
    },
    memoryService,
    mcpLoadModeResolver,
    // 自定义 HTTP 工具装配（V163）：用户有启用工具时才注入两入口 + 目录分节。
    userToolService,
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
  const weixinInboundMessages = new WeixinInboundMessageRepository(db);
  const inboundProcessor = new InboundProcessor(
    weixinInboundHandler, weixinTokens, weixinSend, weixinMedia, voiceReply, weixinInboundMessages,
    weixinWebhookFallback, weixinAccounts, weixinConfig.mergeWindowMs,
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
    approvalRuleService,
    activityService,
    activityHeartbeat,
    sessionTodoMapper: todoMapper,
    agentLoop,
    compactionSignalBus,
    backgroundSubagentManager,
    shellSessionManager: shellManager,
    skillSyncService: skillSync,
    localSkillRegistry: localSkills,
    localAgentsMdRegistry: localAgentsMd,
    mcpSyncService: mcpSync,
    mcpClientManager: routingMcpClient,
    agentMapper: { selectById: (id: number) => agentRepo.findById(id) },
    llmModelMapper: {
      selectById: (id: number) => modelRepo.findById(id),
      selectDefault: () => modelRepo.findDefault(),
    },
    jwtService: jwt,
    agentExecutor: (fn: () => Promise<void>) => agentExecutor.submit(fn),
    mcpSyncTimeoutSeconds: cfg.app.mcp.syncTimeoutSeconds,
    // 预算 BLOCK 闸门（§5.7）：WS 侧必须显式 error 事件（外层 catch 只 console.error）
    budgetGate: {
      checkAdmission: async (target: { userId: number | null; agentId: number | null }) => {
        const block = await budgetService.checkAdmission(target);
        return block == null ? null : {
          budgetId: block.budgetId,
          scope: block.scope,
          spend: block.spend,
          limitValue: block.limitValue,
          limitType: block.limitType,
        };
      },
      noticeQueueBlocked: (block: BudgetBlock, notifyUserId: number | null) => budgetService.noticeQueueBlocked(block, notifyUserId),
    },
    // busy 入队的定时任务在队列真正执行到终态后回写。CANCELLED 会把一次性任务从完结状态放开。
    onScheduledTaskQueueConsumed: async (taskId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => {
      await scheduledService.settleQueuedExecution(taskId, status);
    },
    // busy 入队的 Webhook 触发器消息在队列真正执行到终态后回写连续失败计数
    //（webhookTriggerService 后构造，经 holder 晚绑定解循环依赖）
    onOpenTriggerQueueConsumed: async (triggerId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => {
      await openTriggerSettle.current?.(triggerId, status);
    },
    onOpenApiCallQueueSettled: async (callLogId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', queueWaitMs: number | null, messageId: number | null) => {
      await openCallSettle.current?.(callLogId, phase, queueWaitMs, messageId);
    },
  } as never);
  // 第 6 参 scheduledTaskId：收件箱条目据此前置「定时任务」来源徽标（方案 4.2 方案 A）。
  // 形参表必须与 ScheduledLiveExecution 对齐：TS 允许形参更少的 lambda 赋值给形参更多的
  // 函数类型，漏接实参不会报错，只会静默丢来源——因此用唯一工厂函数并由 spec 断言。
  scheduledService.setLiveExecution(createScheduledLiveExecution(wsHandler));
  scheduledService.setSessionBusyCheck((sessionId) => wsHandler.hasExecutionClaim(sessionId));
  // 定时任务准入预算检查（§5.7）：直跑分支 updatePhase 之前，命中本轮标记 FAILED
  scheduledService.setBudgetCheck(async (target) => {
    const block = await budgetService.checkAdmission(target);
    return block == null ? null : { message: budgetBlockMessage(block) };
  });

  // 开放接口执行流（P1/P2 共用）：与 schedule 域同锁（withSessionLock）、同 busy 判定、同 live 路径
  const openTriggerSettle: { current: ((triggerId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>) | null } = { current: null };
  const openCallSettle: { current: ((callLogId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', queueWaitMs: number | null, messageId: number | null) => Promise<void>) | null } = { current: null };
  const openRunService = new OpenRunService({
    // SessionService 的 Session（session/types）与本域引用的 domain/types 存在 isGit
    // 联合类型差异（同 schedule 域装配的既有情况），窄接口语义不变，此处显式断言
    sessionService: sessionService as unknown as OpenRunDeps['sessionService'],
    messageQueueService,
    harnessService: { executeFromEvent: (sessionId, executionId, listener) => holder.harness!.executeFromEvent(sessionId, executionId, listener as never) },
    taskTerminalService: taskTerminal,
    agentLookup: { findById: (id: number) => agentRepo.findById(id) },
    isSessionBusy: (sessionId) => wsHandler.hasExecutionClaim(sessionId),
    // 开放 API/Webhook 准入预算检查（§5.7）：withSessionLock 之前抛 BUDGET_EXCEEDED 信封
    budgetCheck: async (target) => {
      const block = await budgetService.checkAdmission(target);
      return block == null ? null : { message: budgetBlockMessage(block) };
    },
    liveExecution: createScheduledLiveExecution(wsHandler),
  });
  const callLogService = new OpenApiCallLogService({
    repo: new OpenApiCallLogRepository(db),
    tokens: apiTokenService,
    inbox: inboxService,
    openRun: openRunService,
  });
  openCallLogHolder.current = callLogService;
  openCallSettle.current = (callLogId, phase, queueWaitMs, messageId) => callLogService.settleQueued(callLogId, phase, queueWaitMs, messageId);
  apiTokenService.setOutcomePolicy({
    enabled: () => settingService.isOpenApiTokenAutoDisableEnabled(),
    threshold: () => settingService.getOpenApiTokenAutoDisableThreshold(),
    notifyDisabled: (input) => inboxService.recordTokenDisabled(input),
  });
  const callLogCleanup = new OpenApiCallLogCleanup(
    new OpenApiCallLogRepository(db),
    () => settingService.getOpenApiCallLogRetentionDays(),
  );
  const webhookTriggerService = new WebhookTriggerService({
    triggerRepo: new MysqlWebhookTriggerRepository(db),
    sessionService: sessionService as unknown as WebhookTriggerDeps['sessionService'],
    agentLookup: { findById: (id: number) => agentRepo.findById(id) },
    cipher: notifCipher,
    openRun: openRunService,
    rateLimiter: openApiRateLimiter,
    disableNotifier: {
      notifyTriggerDisabled: async (input) => {
        await inboxService.recordTriggerDisabled(input);
      },
    },
    callLog: callLogService,
  });
  openTriggerSettle.current = (triggerId, status) => webhookTriggerService.handleQueueSettled(triggerId, status);

  // 信号哨兵：探针执行 + 判定触发 + 失败退避自动停用（V148）
  const signalCipher = new SignalSecretCipher(cfg.app.signal.secretKey);
  const signalWatcherRepo = new MysqlSignalWatcherRepository(db);
  const signalCheckRepo = new MysqlSignalCheckRepository(db);
  const watcherService = new WatcherService({
    watcherRepo: signalWatcherRepo,
    checkRepo: signalCheckRepo,
    cipher: signalCipher,
    openRun: openRunService,
    disableNotifier: {
      notifyWatcherDisabled: async (input) => {
        await inboxService.recordWatcherDisabled(input);
      },
    },
  });
  const watcherScheduler = new WatcherScheduler({
    watcherRepo: signalWatcherRepo,
    runCheck: (id) => watcherService.runCheck(id),
    execute: (fn) => agentExecutor.submit(fn),
  });
  watcherScheduler.start();
  const signalCheckCleanup = new SignalCheckCleanup(
    signalCheckRepo,
    () => settingService.getSignalCheckRetentionDays(),
  );
  signalCheckCleanup.start();

  // 每日运营摘要：六板块聚合（V150 偏好表 + 既有表零事实新增）+ 收件箱/出站双路投递
  const digestRepo = new DigestRepository(db);
  const digestService = new DigestService({
    repo: digestRepo,
    inbox: {
      writeDigestEntry: (input) => inboxService.writeDigestEntry(input),
      hasDigestEntry: (userId, dedupTail) => inboxService.hasDigestEntry(userId, dedupTail),
    },
    outbound: {
      dispatchDigest: (input) => outboundSubscriptionService.dispatchDigest(input),
    },
  });
  const digestScheduler = new DigestScheduler({
    listEnabledUsers: () => digestRepo.listEnabledUsers(),
    processUser: (userId) => digestService.processUser(userId),
  });
  digestScheduler.start();

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
      return feishuSummarizerModelConfig(model);
    }),
    cfg.feishu.bot.groupContext.overflowItems,
  );
  const feishuSenderNames = new Map<string, Promise<string | null>>();
  const { getFeishuClient, getFeishuChatTitle, sendFeishuText } = createFeishuClientHelper({
    feishuBots,
    appSecretKey: cfg.feishu.bot.appSecretKey,
    replyMaxLength: cfg.feishu.bot.reply.maxLength,
  });
  const { applyFeishuBotConfig, ensureFeishuSessionTitle } = createFeishuSessionHelper({
    feishuBots, sessionService, sessionRepo, agentService, modelService, getFeishuChatTitle,
  });
  ctx.notifyFeishuPendingMismatch = async (pending) => {
    await sendFeishuText(pending.appId, pending.event, FEISHU_ECP_IDENTITY_MISMATCH_TEXT);
  };
  const feishuQueueCard = createFeishuQueueCardHelper({ getFeishuClient, feishuMessageService });
  const resolveFeishuSessionDetailUrl = createFeishuSessionUrlHelper({ settingService });
  const feishuCardSnapshotRepo = new MysqlFeishuCardSnapshotRepository(db);
  const feishuProgressCardRepo = new MysqlFeishuProgressCardRepository(db);
  const createPatchedProgress = createPatchedProgressHelper({
    feishuActiveProgress, feishuAskFormStore, feishuCardSnapshotRepo, backgroundSubagentManager, feedbackMessageLookup,
  });
  const createFeishuProgressCard = createFeishuProgressCardHelper({
    getFeishuClient, feishuMessageService, feishuProgressCardRepo, resolveFeishuSessionDetailUrl, createPatchedProgress,
  });
  const resolveFeishuRoundOffset = createFeishuRoundOffsetHelper({ sessionService });
  const createFeishuRecoveryProgress = createFeishuRecoveryProgressHelper({
    getFeishuClient, feishuProgressCardRepo, sessionService, resolveFeishuSessionDetailUrl, resolveFeishuRoundOffset, createPatchedProgress,
  });
  const resolveFeishuUserId = createFeishuUserIdHelper({ feishuBinding });
  const feishuInboundQueueRepo = new FeishuInboundQueueRepository(db);
  const feishuTaskQueue = new FeishuTaskQueueService(feishuInboundQueueRepo);
  /** 排队卡片展示位置：入队完成后队列中的 QUEUED 行数（含本条，插入语义=队尾第 N 位）。 */
  const queuePositionOf = async (sessionId: number): Promise<number> => (await feishuInboundQueueRepo.countPending(sessionId));
  const persistCancelledIfActive = createPersistCancelledHelper({ sessionService, taskTerminal, feishuProgressCardRepo });
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
      getLatestAssistantReplyWithId: async (sessionId) => {
        const messages = await sessionService.getMessages(sessionId);
        // 归属与正文同源：channelAssistantReply 取最后一条 ASSISTANT（不论 content 是否为空），
        // 其消息 id 即该卡终态归属；同批消息一次算出，避免二次全量拉取。
        // 不能改用「跳过空 content」的查询口径——终态回复为空时会静默绑定到更早的消息，点踩打错对象。
        let messageId: number | null = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'ASSISTANT') {
            messageId = messages[i].id ?? null;
            break;
          }
        }
        // 渠道不发桌面来源区，[^n^] 标记原样露出会像没渲染干净的模板变量，统一剥掉
        return { text: channelAssistantReply(messages, '抱歉，暂时无法生成回复。'), messageId };
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
        // 与桌面端命名一致：推 WS 让已打开该会话的客户端实时更新标题。
        wsRegistry.send(session.userId!, wsEvent('session_title_updated', sessionId, {
          title,
          parentSessionId: session.parentSessionId ?? null,
          sessionType: session.sessionType ?? 'NORMAL',
        }));
        return true;
      },
      isAwaitingFirstMessageTitle: async (sessionId) =>
        (await feishuMessageService.findSessionChannel(sessionId))?.awaitingFirstMessageTitle === 1,
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
    // 新会话（`---` 私聊新会话 / 话题群首条消息）标题改为 LLM 生成短标题，
    // 复用桌面端的标题模型配置（session.titleModelId）、30s 超时与本地启发式降级。
    titleGenerator: {
      generate: (sessionId, text) => sessionTitleService.generateExternalTitle(sessionId, text),
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
    createQueueCard: async (context, _queueId, sessionId) => feishuQueueCard(context, _queueId, await queuePositionOf(sessionId), sessionId),
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
                // 同日同名文件防覆盖：命中时改用带 messageId 的唯一名，历史引用不被篡改
                const target = resolveChatFileTarget(dir, fileName, context.messageId);
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
    onExecutionFinished: async (sessionId, _context, executionId, phase, failureReason) => {
      const session = await sessionService.getSession(sessionId);
      await taskTerminal.finishExecution(sessionId, session.userId!, phase, executionId, failureReason);
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
  const feishuMediaHelper = createFeishuMediaHelper({
    getFeishuClient,
    feishuSenderNames,
    feishuBinding,
    feishuMessageRepository,
    userRepo,
    workspaceRoot: cfg.app.harness.workspaceRoot,
    maxInboundFileMb: cfg.feishu.bot.file.maxInboundFileMb,
  });
  const { resolveFeishuSenderName, resolveFeishuUserNames, resolveMergeWorkspace, expandMergeForward, resolveQuotedWorkspace, downloadFeishuGroupImage, downloadFeishuImageTo, downloadFeishuGroupFile } = feishuMediaHelper;
  const feishuInboundProcessor = new FeishuInboundProcessor(feishuInboundHandler, {
    messageService: feishuMessageService,
    mergeWindowMs: cfg.feishu.bot.mergeWindowMs,
    resolveSenderName: resolveFeishuSenderName,
    downloadGroupImage: downloadFeishuGroupImage,
    downloadGroupFile: downloadFeishuGroupFile,
    resolveThreadSession: async (accountId, event) => {
      const result = await feishuMessageService.findThreadSession(String(accountId), event.threadId);
      return result == null ? null : { sessionId: result.sessionId };
    },
    ensureThreadSession: async (accountId, context) => {
      // 触发前先建话题会话行：水位线写在 feishu_thread_session 上，行不存在会让本次推进静默丢失。
      const result = await feishuMessageService.getOrCreateThreadSession(String(accountId), context);
      return result == null ? null : { sessionId: result.sessionId };
    },
    resolveQuotedMessage: async (accountId, event) => {
      if (event.parentId == null) return null;
      const persist = async (raw: string): Promise<string> => {
        return buildQuotedInjection(raw, { parentMessageId: event.parentId!, workspace: await resolveQuotedWorkspace(accountId, event) });
      };
      // 群消息日志优先：免 API 调用，发送人姓名与占位符格式也和上下文一致。
      // 合并转发日志若仍是固定英文，或私聊没有日志，则展开后再注入。
      const fromLog = event.chatId != null
        ? await feishuMessageRepository.findGroupMessageByMessageId(String(accountId), event.chatId, event.parentId)
        : null;
      return resolveFeishuQuotedText({
        log: fromLog == null ? null : {
          msgType: fromLog.msgType,
          content: fromLog.content,
          line: `[${formatGroupTime(fromLog.createdAt)}] ${fromLog.senderName}：${fromLog.content ?? ''}`,
        },
        fetchDetail: async () => {
          const client = await getFeishuClient(Number(accountId));
          if (client == null) return null;
          const detail = await fetchFeishuMessageDetail(client, event.parentId!);
          return detail == null ? null : { msgType: detail.msgType, text: detail.text };
        },
        expand: (workspace) => expandMergeForward(accountId, event.parentId!, workspace),
        resolveWorkspace: () => resolveQuotedWorkspace(accountId, event),
        persist,
      });
    },
    expandMergeForward,
    resolveMergeWorkspace,
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
  ctx.pendingBindingProcessor = feishuInboundProcessor;
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
    // 完成卡「点踩」toggle：写库/删库 message_feedback（source=feishu），并把点踩态同步给
    // 被点卡片的进度卡闭包，使回调返回的卡片渲染「已点踩 · 再点取消」。
    // 按卡归属：cardMessageId 为被点卡片身份（事件 context.open_message_id）——经快照表解析到
    // 该卡对应的 ASSISTANT 消息，反馈不再固定落到会话最后一条；无快照行（存量卡）才按最新消息兜底。
    // 与方案 5.2.6 一致：群内其他人只更新点击者视图，不做额外 PATCH。
    // user_id 取会话所属用户（飞书会话由绑定用户创建，发送者即会话所有者）。
    toggleDislike: async (sessionId, cardMessageId) => {
      const session = await sessionService.getSession(sessionId).catch(() => null);
      if (session == null) return null;
      let messageId: number | undefined;
      if (cardMessageId != null) {
        const snapshot = await feishuCardSnapshotRepo.findByCardMessageId(cardMessageId).catch((error) => {
          console.warn(`飞书点踩查询卡片快照失败, cardMessageId=${cardMessageId}, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        messageId = snapshot?.messageId;
      }
      const result = await feedbackService.toggleSessionDislike(session.userId, sessionId, FEISHU_DISLIKE_SOURCE, messageId);
      if (result == null) return null;
      // disliked 态按卡隔离：点旧卡不把态写到最新任务的句柄上；事件缺卡片身份才退回会话级。
      if (cardMessageId == null) {
        feishuActiveProgress.current(sessionId)?.setDisliked(result.disliked);
      } else {
        feishuActiveProgress.setDislikedByCard(cardMessageId, result.disliked);
      }
      return result;
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
          mapping.botId,
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
    // 点踩重绘一级降级：内存里被点卡片的句柄快照（进程重启后未命中，交快照表重建）。
    renderProgressCardByCard: (cardMessageId) => feishuActiveProgress.renderByCard(cardMessageId),
    // 点踩重绘二级降级：持久化快照行 → 按该卡终态（轮次/耗时/正文）重建，按钮按 toggle 后状态渲染。
    // sender 必须传被点卡片原发送者（handleProgressDislike 鉴权已保证点击者即原发送者）。
    rebuildCardFromSnapshot: async (sessionId, cardMessageId, disliked, sender) => {
      const snapshot = await feishuCardSnapshotRepo.findByCardMessageId(cardMessageId).catch((error) => {
        console.warn(`飞书点踩查询卡片快照失败, cardMessageId=${cardMessageId}, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (snapshot == null) return null;
      return buildFeishuProgressCard(
        'COMPLETED', snapshot.round, snapshot.content ?? '', [],
        { sessionId, sender }, snapshot.elapsedMs, await resolveFeishuSessionDetailUrl(sessionId), undefined, disliked,
      );
    },
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
      mergeWindowMs: cfg.dingtalk.mergeWindowMs,
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
  // 自定义 HTTP 工具调用统计（§9.4）：与 admin 分析共用同一 DbStore 实例。
  const userToolStatsStore = new AdminAnalyticsDbStore(db);
  const mcpValidator = new McpServerValidatorImpl(mcpServerLookup);

  await app.register(async (api) => {
    api.get('/swagger-ui.html', async (_req, reply) => reply.redirect(`${apiPrefix}/swagger-ui`));
    api.get('/v3/api-docs', async (_req, reply) => {
      return reply.send(app.swagger());
    });
    // 健康检查：免登录，供负载均衡/蓝绿部署探活使用（scripts/lib/blue-green.sh 亦可用其替代 swagger 探测）
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
    registerSharedAgentRoutes(api, { sharedAgentService, permissionService });
    registerModelRoutes(api, { modelService, permissionService });
    registerSystemSettingRoutes(api, {
      systemSettingService: settingService,
      permissionService,
      // test/smtp 测试信发当前管理员本人（user.email）
      adminEmailLookup: { findEmailById: (userId) => userRepo.findEmailById(userId) },
      beforeSave: async (items) => {
        await validateRuntimeModeSave(items, activateContainerRuntime);
      },
      afterSave: (keys) => {
        // 后台切换后立即按新模式判定，不等解析缓存 TTL
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
    // 管理后台会话工作区只读文件端点：复用 WorkspaceBrowseService，鉴权只认 session:read，
    // 不做出属主校验（admin 跨用户查看是本职）；审计由 /v1/admin 全局 onResponse 钩子承担，不注入 auditService
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
        // 规则管理动作走 service 级审计（规则放行本身不写 audit_log，见技术方案决策 7）
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

  const scheduler = new ScheduledTaskScheduler(scheduledStore, scheduledService, () => {
    const active = readActiveBackendPort(cfg.app.harness.runtimeDir);
    if (active != null) return active === cfg.server.port;
    const lock = readDeployLock(cfg.app.harness.runtimeDir);
    if (lock != null && lock.oldPort === cfg.server.port) return false;
    return true;
  });
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
  // 出站订阅投递调度（P3）：对齐任务通知投递的重试模型，FAILED 终态落审计
  const outboundDeliveryScheduler = new OutboundDeliveryScheduler({
    deliveryRepo: outboundDeliveryRepo,
    subscriptionRepo: outboundSubscriptionRepo,
    cipher: notifCipher,
    sender: new GenericHttpWebhookSender(),
    auditRecorder: {
      recordDeliveryFailed: async (input) => {
        let userId: number | null = null;
        if (input.subscriptionId != null) {
          const subscription = await outboundSubscriptionRepo.findById(input.subscriptionId).catch(() => null);
          userId = subscription?.userId ?? null;
        }
        await auditService.record({
          action: 'EXECUTE',
          objectType: 'outbound.subscription',
          objectId: input.subscriptionId == null ? null : String(input.subscriptionId),
          userId,
          username: null,
          method: 'POST',
          path: `/v1/open/subscriptions/${input.subscriptionId}/deliveries`,
          ip: null,
          status: 502,
          success: 0,
          errorMessage: `出站投递终态失败 event=${input.event} url=${input.targetUrl} error=${input.error ?? ''}`,
        }).catch(() => undefined);
      },
    },
    execute: (fn) => agentExecutor.submit(fn),
  });
  outboundDeliveryScheduler.start();
  const inboxCleanupScheduler = new InboxCleanupScheduler(inboxCleanupStore);
  inboxCleanupScheduler.start();
  const scheduledRunCleanup = new ScheduledTaskRunCleanupScheduler(scheduledStore);
  scheduledRunCleanup.start();
  callLogService.start();
  callLogCleanup.start();
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
      if (ctx.pendingBindingProcessor == null) return;
      const claimed = await pendingBindingMessages.claim(message.state);
      if (claimed == null) continue;
      try {
        await replayFeishuPendingMessage(ctx.pendingBindingProcessor, claimed);
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
      await scheduledService.reconcileRunsForSession(sessionId, phase).catch((error) => {
        console.warn(`定时任务运行记录在崩溃恢复后收敛失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      });
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
    // 孤儿会话巡检只在承接流量的实例上执行（对照 active-backend-port）。
    cfg.server.port,
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

  // 启动期恢复扫描只覆盖"那一瞬间已存在"的遗留会话；会话可能是扫描窗口之后才在旧实例上
  // 进入 RUNNING 的（消息落到待排空实例），必须靠周期巡检兜住。仅承接流量的实例执行。
  crash.startPeriodicSweep();

  const drainWatcher = new DeployDrainWatcher({
    runtimeDir: cfg.app.harness.runtimeDir,
    selfPort: cfg.server.port,
    // 只认"本进程启动之后开始的部署"：端口在 9080↔9081 之间来回切，
    // 历史残留的 switched 锁的 oldPort 可能正好等于本实例端口，不能据此自杀。
    startedAtSec: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
    shutdown: () => closeApp(),
  });

  const closeApp = createShutdownHandler({
    app, db, cfg, ctx,
    crash, drainWatcher,
    weixinMonitor, feishuMonitor, dingtalk, weixinInboundHandler, feishuInboundProcessor,
    scheduler, deliveryScheduler, callLogService, callLogCleanup,
    watcherScheduler, signalCheckCleanup, ecpRenewScheduler,
    shellManager, terminalManager, ptyChannelHubs, ptyHubGeneration,
    containerRegistry, channelServer, runtimeCleanup, activityHeartbeat, wsRegistry,
    agentLoop, wsHandler, sessionService,
  });
  drainWatcher.start();

  return {
    app,
    close: closeApp,
  };
}
