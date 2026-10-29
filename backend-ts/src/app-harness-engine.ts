/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AppConfig } from './config/app-config.js';
import type { JwtService } from './crypto/jwt.service.js';
import type { PathSandbox } from './harness/safety/path-sandbox.js';
import type { SessionTodoMapper } from './harness/todo/session-todo.mapper.js';
import type { ScheduledTaskService } from './schedule/scheduled-task.service.js';
import type { SessionService } from './session/session.service.js';
import type { SessionRepository } from './session/session.repository.js';
import type { ShellSessionManager, OutputManager } from './harness/shell/shell-session-manager.js';
import type { BackgroundTaskManager } from './harness/core/background-task-manager.js';
import type { RuntimeDataResolver } from './harness/runtime/runtime-data-resolver.js';
import type { ModelService } from './model/model.service.js';
import type { SystemSettingService } from './settings/settings.service.js';
import type { FeishuMessageService } from './feishu/message.service.js';
import type { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import type { DockerSendBytesBridge } from './harness/container/read-bytes-bridge.js';
import type { DingtalkMediaSendSupport } from './harness/tool/impl/dingtalk-tools.js';
import type { AgentDefinitionRegistry } from './harness/delegate/agent-definition-registry.js';
import type { SubagentExecutionMapper } from './harness/delegate/subagent-execution.mapper.js';
import type { LocalToolSessionRegistry } from './harness/local/local-tool-session-registry.js';
import type { SubAgentVisibilityService } from './harness/delegate/subagent-visibility-service.js';
import type { BackgroundSubagentManager } from './harness/delegate/background-subagent-manager.js';
import type { MessageRepository } from './session/session.repository.js';
import type { SessionCompactionService } from './session/session-compaction.service.js';
import type { EmbedPageToolRegistry } from './harness/embed-page-tool-registry.js';
import type { McpToolsRegistry } from './harness/mcp/local/mcp-tools-registry.js';
import type { McpClientManager } from './harness/mcp/mcp-client-manager.js';
import type { HttpToolService } from './http-tool/http-tool.service.js';
import type { HttpApiExecutor } from './harness/tool/impl/http-api-executor.js';
import type { HarnessTuningSettings } from './settings/types.js';
import type { LlmAdapter } from './harness/llm/chat-request.js';
import type { PromptEngine } from './harness/core/prompt-engine.js';
import type { ContextManager } from './harness/core/context-manager.js';
import type { CompactionService } from './harness/core/compaction-service.js';
import type { CompactionArchiveService } from './harness/core/compaction-archive.service.js';
import type { CompactionConfig } from './harness/core/compaction-config.js';
import type { SessionHistoryLoader } from './harness/core/session-history-loader.js';
import type { ActiveContextCalculator } from './harness/core/active-context-calculator.js';
import type { SessionCompactionOrchestrator } from './harness/core/session-compaction-orchestrator.js';
import type { TokenEstimator } from './harness/core/token-estimator.js';
import type { CompactionModelResolver } from './harness/tool/compaction-model-resolver.js';
import type { LocalToolExecutor } from './harness/local/local-tool-executor.js';
import type { DangerAssessor } from './harness/tool/danger-assessor.js';
import type { ProxyApprover } from './harness/tool/proxy-approver.js';
import type { JevRiskAssessor } from './harness/tool/jev-risk-assessor.js';
import type { ApprovalModelResolver } from './harness/tool/approval-model-resolver.js';
import type { ApprovalRuleService } from './approval-rule/approval-rule.service.js';
import type { DockerToolRouter } from './harness/container/docker-tool-router.js';
import type { ApprovalRegistry } from './harness/approval/approval-registry.js';
import type { AskUserQuestionsRegistry } from './harness/tool/ask-user-questions-registry.js';
import type { InFlightToolRegistry } from './harness/core/in-flight-tool-registry.js';
import type { SessionTreeSignalPublisher } from './harness/approval/session-tree-signal-publisher.js';
import type { TaskNotificationDeliveryService } from './notification/task/delivery.service.js';
import type { InboxService } from './inbox/inbox.service.js';
import type { SkillLoader } from './harness/skill/skill-loader.js';
import type { SkillSyncService } from './harness/skill/skill-sync-service.js';
import type { LocalSkillRegistry } from './harness/skill/local-skill-registry.js';
import type { LocalAgentsMdRegistry } from './harness/core/local-agents-md-registry.js';
import type { AgentExperienceService } from './agent/agent-experience.service.js';
import type { EnvironmentInfoProvider } from './harness/core/environment-info-provider.js';
import type { FileChangeRepository } from './session/session.repository.js';
import type { MysqlAgentRepository } from './agent/agent.repository.js';
import type { MysqlLlmModelRepository } from './model/model.repository.js';
import type { SessionActivityHeartbeat } from './session/session-activity-heartbeat.js';
import type { MemoryService } from './memory/memory.service.js';
import type { McpLoadModeResolver } from './harness/mcp/workingset/mcp-load-mode.js';
import type { McpSyncService } from './harness/mcp/local/mcp-sync-service.js';
import type { RoutingMcpClientManager } from './harness/container/routing-mcp-client-manager.js';
import type { Db } from './db/db.js';

import { createDefaultToolRegistry } from './harness/tool/tool-registry.js';
import { ToolDispatcher } from './harness/tool/tool-dispatcher.js';
import { createMcpReadOnlyLookup } from './harness/mcp/workingset/mcp-read-only-lookup.js';
import { CompactionSignalBus } from './harness/core/compaction-signal-bus.js';
import { AgentLoop } from './harness/core/agent-loop.js';
import { HarnessService } from './harness/core/harness-service.js';
import type { ExperienceIndexService } from './harness/experience/experience-index.service.js';
import { downloadFeishuMediaBuffer } from './feishu-media.js';
import { fetchFeishuMessageDetail } from './feishu/message-detail.js';
import { feishuSendTargetOf, sendFeishuFile, sendFeishuImage } from './feishu/media-sender.js';

export interface HarnessEngineDeps {
  cfg: AppConfig;
  apiPrefix: string;
  uploadDir: string;
  harnessTuning: HarnessTuningSettings;
  pathSandbox: PathSandbox;
  todoMapper: SessionTodoMapper;
  scheduledService: ScheduledTaskService;
  sessionSvc: SessionService;
  sessionMap: SessionRepository;
  shellManager: ShellSessionManager;
  outputManager: OutputManager;
  backgroundTasks: BackgroundTaskManager;
  gitLookup: any;
  jwt: JwtService;
  userRepo: any;
  ecpInjector: any;
  larkUatInjector: any;
  settingService: SystemSettingService;
  runtimeResolver: RuntimeDataResolver;
  modelService: ModelService;
  wechatBridges: any;
  feishuMessageService: FeishuMessageService;
  feishuMessageRepository: MysqlFeishuMessageRepository;
  getFeishuClient: (botId: number) => Promise<any>;
  sendBytesBridge: DockerSendBytesBridge;
  dingtalkMediaHolder: { current: DingtalkMediaSendSupport | null };
  definitionRegistry: AgentDefinitionRegistry;
  holder: { harness?: HarnessService; loop?: AgentLoop };
  subagentMapper: SubagentExecutionMapper;
  localToolSessions: LocalToolSessionRegistry;
  visibility: SubAgentVisibilityService;
  backgroundSubagentManager: BackgroundSubagentManager;
  messageRepo: MessageRepository;
  compactionSvc: SessionCompactionService;
  embedPageToolRegistry: EmbedPageToolRegistry;
  mcpToolsRegistry: McpToolsRegistry;
  routingMcpClient: McpClientManager;
  httpToolService: HttpToolService;
  httpApiExecutor: HttpApiExecutor;
  llmAdapter: LlmAdapter;
  promptEngine: PromptEngine;
  contextManager: ContextManager;
  compactionService: CompactionService;
  compactionArchiveService: CompactionArchiveService;
  compactionConfig: CompactionConfig;
  historyLoader: SessionHistoryLoader;
  activeContext: ActiveContextCalculator;
  orchestrator: SessionCompactionOrchestrator;
  tokenEstimator: TokenEstimator;
  compactionModelResolver: CompactionModelResolver;
  localToolExecutor: LocalToolExecutor;
  dangerAssessor: DangerAssessor;
  proxyApprover: ProxyApprover;
  jevRiskAssessor: JevRiskAssessor;
  approvalModelResolver: ApprovalModelResolver;
  approvalRuleService: ApprovalRuleService;
  dockerRouter: DockerToolRouter;
  approvalRegistry: ApprovalRegistry;
  askUserQuestionsRegistry: AskUserQuestionsRegistry;
  inFlightToolRegistry: InFlightToolRegistry;
  treeSignalPublisher: SessionTreeSignalPublisher;
  deliveryService: TaskNotificationDeliveryService;
  feishuAskMount: any;
  inboxService: InboxService;
  skillLoader: SkillLoader;
  skillSync: SkillSyncService;
  localSkills: LocalSkillRegistry;
  localAgentsMd: LocalAgentsMdRegistry;
  agentRepo: MysqlAgentRepository;
  experienceService: AgentExperienceService;
  modelRepo: MysqlLlmModelRepository;
  fileChangeRepo: FileChangeRepository;
  envInfo: EnvironmentInfoProvider;
  db: Db;
  mcpSync: McpSyncService;
  mcpLoadModeResolver: McpLoadModeResolver;
  activityHeartbeat: SessionActivityHeartbeat;
  memoryService: MemoryService;
  wsRegistry: any;
  /** 团队经验库索引服务（技术方案 2026-10-24）：write_file/edit_file 落盘回调刷新索引。可选注入。 */
  experienceIndexService?: ExperienceIndexService | null;
  /** 团队经验库挂载服务：buildContext 每轮幂等补挂（存量会话兜底）。可选注入。 */
  experienceMountService?: { syncForSession(workspace: string, agentId: number, enabled: boolean, refreshIndex?: boolean): void } | null;
}

export interface HarnessEngineResult {
  toolRegistry: any;
  toolDispatcher: ToolDispatcher;
  compactionSignalBus: CompactionSignalBus;
  agentLoop: AgentLoop;
  harness: HarnessService;
}

export function assembleHarnessEngine(deps: HarnessEngineDeps): HarnessEngineResult {
  const d = deps as any;
  const { cfg, apiPrefix, uploadDir, harnessTuning } = d;

  const toolRegistry = createDefaultToolRegistry({
    pathSandbox: d.pathSandbox,
    sessionTodoMapper: d.todoMapper,
    scheduledTaskService: d.scheduledService,
    sessionService: d.sessionSvc,
    sessionMapper: d.sessionMap,
    shellSessionManager: d.shellManager,
    outputManager: d.outputManager,
    backgroundTaskManager: d.backgroundTasks,
    gitCredentialService: d.gitLookup,
    jwtService: d.jwt,
    shellUserLookup: { findById: (id: number) => d.userRepo.findById(id) },
    shellEcpInjector: d.ecpInjector,
    shellLarkUatInjector: d.larkUatInjector,
    webSearch: () => d.settingService.getWebSearchConfig(),
    webPage: harnessTuning.webPage,
    runtimeDataResolver: d.runtimeResolver,
    imageModelLookup: d.modelService,
    uploadDir,
    onFileChanged: d.experienceIndexService != null
      ? (absPath: string) => d.experienceIndexService!.refreshIfUnderRoot(absPath)
      : undefined,
    getUploadBaseUrl: async () => (await d.settingService.getUploadConfig()).baseUrl,
    uploadContextPath: apiPrefix,
    weixinToolSupport: d.wechatBridges.toolSupport,
    weixinUploadService: d.wechatBridges.uploadService,
    weixinSendService: d.wechatBridges.sendService,
    feishuToolSupport: {
      resolveBotAppId: async (sessionId: number | null) => {
        if (sessionId == null) return null;
        const channel = await d.feishuMessageService.findSessionChannel(sessionId);
        return channel?.appId ?? null;
      },
    },
    feishuMediaDownloader: {
      download: async (appId: string, messageId: string, fileKey: string, type: 'image' | 'file', maxBytes: number) => {
        const client = await d.getFeishuClient(Number(appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${appId}`);
        return downloadFeishuMediaBuffer(client, messageId, fileKey, type, maxBytes);
      },
    },
    feishuGroupMediaLookup: { findMediaByMessageId: (messageId: string) => d.feishuMessageRepository.findMediaByMessageId(messageId) } as never,
    feishuMessageDetailFetcher: {
      fetchMessageDetail: async (appId: string, messageId: string) => {
        const client = await d.getFeishuClient(Number(appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${appId}`);
        const detail = await fetchFeishuMessageDetail(client, messageId);
        return detail == null ? null : { fileKey: detail.fileKey ?? null, fileName: detail.fileName ?? null, msgType: detail.msgType };
      },
    },
    feishuMaxInboundFileBytes: Math.max(1, cfg.feishu.bot.file.maxInboundFileMb) * 1024 * 1024,
    feishuMediaSendSupport: {
      resolveSendTarget: async (sessionId: number | null) => {
        if (sessionId == null) return null;
        const channel = await d.feishuMessageService.findSessionChannel(sessionId);
        if (channel == null) return null;
        const target = feishuSendTargetOf(channel.appId, channel.chatId);
        const replyMessageId = await d.feishuMessageService.findLatestInboundMessageId(sessionId, channel);
        if (replyMessageId != null) target.replyMessageId = replyMessageId;
        return target;
      },
      sendImage: async (target: any, image: any, sessionId: number | null) => {
        const client = await d.getFeishuClient(Number(target.appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${target.appId}`);
        const messageId = await sendFeishuImage(client, target, image);
        if (messageId != null && sessionId != null && target.receiveIdType !== 'chat_id') {
          await d.feishuMessageService.recordP2pMessage(target.appId, messageId, sessionId, 'OUT');
        }
      },
      sendFile: async (target: any, fileName: string, file: any, sessionId: number | null) => {
        const client = await d.getFeishuClient(Number(target.appId));
        if (client == null) throw new Error(`飞书Bot不存在或未启用: ${target.appId}`);
        const messageId = await sendFeishuFile(client, target, fileName, file);
        if (messageId != null && sessionId != null && target.receiveIdType !== 'chat_id') {
          await d.feishuMessageService.recordP2pMessage(target.appId, messageId, sessionId, 'OUT');
        }
      },
    },
    sendBytesSupport: d.sendBytesBridge,
    dingtalkMediaSendSupport: {
      resolveSendTarget: (sessionId: number | null) => d.dingtalkMediaHolder.current?.resolveSendTarget(sessionId) ?? Promise.resolve(null),
      sendImage: async (target: any, bytes: any, fileName: string) => {
        if (d.dingtalkMediaHolder.current == null) throw new Error('钉钉通道未就绪');
        return d.dingtalkMediaHolder.current.sendImage(target, bytes, fileName);
      },
      sendFile: async (target: any, fileName: string, bytes: any) => {
        if (d.dingtalkMediaHolder.current == null) throw new Error('钉钉通道未就绪');
        return d.dingtalkMediaHolder.current.sendFile(target, fileName, bytes);
      },
    },
    definitionRegistry: d.definitionRegistry,
    get harnessService() { return d.holder.harness!; },
    get agentLoop() { return d.holder.loop!; },
    subagentExecutionMapper: d.subagentMapper,
    localToolSessionRegistry: d.localToolSessions,
    localToolExecutor: d.localToolExecutor,
    visibilityService: d.visibility,
    backgroundSubagentManager: d.backgroundSubagentManager,
    messageMapper: d.messageRepo as never,
    sessionCompactionService: d.compactionSvc,
    embedPageToolRegistry: d.embedPageToolRegistry,
    mcpToolsRegistry: d.mcpToolsRegistry,
    mcpClientManager: d.routingMcpClient,
    httpToolService: d.httpToolService,
    httpApiExecutor: d.httpApiExecutor,
    agentMapper: d.agentRepo as never,
  });

  const toolDispatcher = new ToolDispatcher(
    toolRegistry, d.localToolExecutor, d.dangerAssessor, d.sessionMap,
    d.wsRegistry, d.askUserQuestionsRegistry, d.localToolSessions, d.treeSignalPublisher,
    d.backgroundTasks, d.deliveryService, d.feishuAskMount,
    d.proxyApprover, d.jevRiskAssessor, d.approvalModelResolver,
    d.inboxService,
    d.approvalRuleService,
    d.dockerRouter,
    createMcpReadOnlyLookup({
      sessionMapper: d.sessionMap,
      loadModeResolver: d.mcpLoadModeResolver,
      toolsRegistry: d.mcpToolsRegistry,
    }),
  );
  const compactionSignalBus = new CompactionSignalBus();
  const agentLoop = new AgentLoop(
    d.llmAdapter, d.promptEngine, d.contextManager, toolDispatcher, d.backgroundTasks,
    d.shellManager, d.activityHeartbeat, d.sessionSvc, d.orchestrator, d.activeContext, d.routingMcpClient,
    () => d.backgroundSubagentManager,
    compactionSignalBus,
    d.inFlightToolRegistry,
  );
  d.holder.loop = agentLoop;
  d.holder.compactionSignalBus = compactionSignalBus;
  const harness = new HarnessService(
    agentLoop, toolRegistry, d.skillLoader, d.skillSync, d.localSkills, d.localAgentsMd,
    d.sessionMap, d.agentRepo as never, d.experienceService, d.modelRepo as never, d.fileChangeRepo as never,
    d.sessionSvc, d.compactionSvc, d.historyLoader, d.orchestrator,
    d.promptEngine, d.activeContext, d.compactionConfig, d.envInfo, d.db, d.routingMcpClient, d.mcpSync,
    {
      isEmbedSession: (sid: number) => d.embedPageToolRegistry.isEmbedSession(sid),
      isEmbedPageSession: (sid: number) => d.embedPageToolRegistry.isEmbedPageSession(sid),
    },
    d.memoryService,
    d.mcpLoadModeResolver,
    d.httpToolService,
    d.experienceMountService ?? null,
  );
  d.holder.harness = harness;

  return { toolRegistry, toolDispatcher, compactionSignalBus, agentLoop, harness };
}
