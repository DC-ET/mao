import type { Db } from './db/db.js';
import type { SessionService } from './session/session.service.js';
import type { SessionRepository } from './session/session.repository.js';
import type { AgentService } from './agent/agent.service.js';
import type { ModelService } from './model/model.service.js';
import type { SystemSettingService } from './settings/settings.service.js';
import type { WeixinBotConfig } from './weixin/types.js';
import type { WeixinAccountRepository } from './weixin/account.repository.js';
import type { ContextTokenRepository } from './weixin/context-token.repository.js';
import type { WeixinSendService } from './weixin/send.service.js';
import type { WeixinMediaUploadService } from './weixin/media-upload.service.js';
import type { WeixinMediaService } from './weixin/media.service.js';
import type { UserWeixinPreferenceService } from './preference/weixin-preference.service.js';
import type { HarnessService } from './harness/core/harness-service.js';
import type { AgentLoop } from './harness/core/agent-loop.js';
import type { ShellSessionManager } from './harness/shell/shell-session-manager.js';
import type { StreamingWsRegistry } from './session/ws/streaming-ws-registry.js';
import type { TaskTerminalService } from './session/task-terminal.service.js';
import type { ActivityService } from './session/activity.service.js';
import type { SessionActivityHeartbeat } from './session/session-activity-heartbeat.js';
import type { SessionTodoMapper } from './harness/todo/session-todo.mapper.js';
import type { WeixinWebhookFallbackService } from './weixin/webhook-fallback.service.js';
import type { LlmAdapter } from './harness/llm/chat-request.js';
import { createAgentExecutor } from './harness/core/agent-executor.js';

import { WeixinSessionService } from './weixin/session.service.js';
import { WeixinVoiceSynthesisService } from './weixin/voice-synthesis.service.js';
import { WeixinVoiceCodecService } from './weixin/voice-codec.service.js';
import { WeixinVoiceReplyService } from './weixin/voice-reply.service.js';
import { WeixinFileStorageService } from './weixin/file-storage.service.js';
import { AgentWeixinInboundHandler } from './weixin/agent-inbound-handler.js';
import { WeixinInboundMessageRepository } from './weixin/inbound-message.repository.js';
import { InboundProcessor } from './weixin/inbound-processor.js';
import { WeixinMonitorService } from './weixin/monitor.service.js';
import { QrLoginService } from './weixin/qr-login.service.js';

export interface WeixinServicesDeps {
  db: Db;
  sessionService: SessionService;
  sessionRepo: SessionRepository;
  agentService: AgentService;
  modelService: ModelService;
  settingService: SystemSettingService;
  weixinConfig: WeixinBotConfig;
  weixinAccounts: WeixinAccountRepository;
  weixinTokens: ContextTokenRepository;
  weixinSend: WeixinSendService;
  weixinUpload: WeixinMediaUploadService;
  weixinMedia: WeixinMediaService;
  weixinPref: UserWeixinPreferenceService;
  harness: HarnessService;
  agentLoop: AgentLoop;
  shellManager: ShellSessionManager;
  wsRegistry: StreamingWsRegistry;
  taskTerminal: TaskTerminalService;
  activityService: ActivityService;
  activityHeartbeat: SessionActivityHeartbeat;
  todoMapper: SessionTodoMapper;
  weixinWebhookFallback: WeixinWebhookFallbackService;
  llmAdapter: LlmAdapter;
  agentExecutor: ReturnType<typeof createAgentExecutor>;
}

export interface WeixinServicesResult {
  weixinSession: WeixinSessionService;
  voiceSynthesis: WeixinVoiceSynthesisService;
  voiceCodec: WeixinVoiceCodecService;
  voiceReply: WeixinVoiceReplyService;
  weixinFiles: WeixinFileStorageService;
  weixinInboundHandler: AgentWeixinInboundHandler;
  weixinInboundMessages: WeixinInboundMessageRepository;
  inboundProcessor: InboundProcessor;
  weixinMonitor: WeixinMonitorService;
  qrLogin: QrLoginService;
}

export function assembleWeixinServices(deps: WeixinServicesDeps): WeixinServicesResult {
  const { db, sessionService, sessionRepo, agentService, modelService, settingService, weixinConfig, weixinAccounts, weixinTokens, weixinSend, weixinUpload, weixinMedia, weixinPref, harness, agentLoop, shellManager, wsRegistry, taskTerminal, activityService, activityHeartbeat, todoMapper, weixinWebhookFallback, llmAdapter, agentExecutor } = deps;

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

  return {
    weixinSession, voiceSynthesis, voiceCodec, voiceReply, weixinFiles,
    weixinInboundHandler, weixinInboundMessages, inboundProcessor, weixinMonitor, qrLogin,
  };
}
