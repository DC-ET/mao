import type { HarnessTuningSettings } from './settings/types.js';
import type { LlmCallService } from './usage/llm-call.service.js';
import type { SkillLoader } from './harness/skill/skill-loader.js';
import type { PathSandbox } from './harness/safety/path-sandbox.js';
import type { RuntimeDataResolver } from './harness/runtime/runtime-data-resolver.js';
import type { UserCommandService } from './command/command.service.js';
import type { SkillSyncService } from './harness/skill/skill-sync-service.js';
import type { WorkspaceRulesSnapshotService } from './harness/core/workspace-rules-snapshot.service.js';
import type { SessionService } from './session/session.service.js';
import type { SessionCompactionService } from './session/session-compaction.service.js';
import type { SessionCompactionEventService } from './session/session-compaction-event.service.js';
import type { SystemSettingService } from './settings/settings.service.js';
import type { MysqlLlmModelRepository } from './model/model.repository.js';
import type { LlmAdapter } from './harness/llm/chat-request.js';

import { OpenAiLlmAdapter } from './harness/llm/openai-llm-adapter.js';
import { AnthropicLlmAdapter } from './harness/llm/anthropic-llm-adapter.js';
import { ResponsesLlmAdapter } from './harness/llm/responses-llm-adapter.js';
import { LlmAdapterFacade } from './harness/llm/llm-adapter-facade.js';
import { RecordingLlmAdapter } from './usage/recording-llm-adapter.js';
import { PromptEngine } from './harness/core/prompt-engine.js';
import { TokenEstimator } from './harness/core/token-estimator.js';
import { CompactionService } from './harness/core/compaction-service.js';
import { ContextManager } from './harness/core/context-manager.js';
import { CompactionArchiveService } from './harness/core/compaction-archive.service.js';
import { CompactionConfig } from './harness/core/compaction-config.js';
import { SessionHistoryLoader } from './harness/core/session-history-loader.js';
import { ActiveContextCalculator } from './harness/core/active-context-calculator.js';
import { CompactionModelResolver } from './harness/tool/compaction-model-resolver.js';
import { SessionCompactionOrchestrator } from './harness/core/session-compaction-orchestrator.js';

export interface LlmEngineDeps {
  harnessTuning: HarnessTuningSettings;
  llmCallService: LlmCallService;
  skillLoader: SkillLoader;
  pathSandbox: PathSandbox;
  runtimeResolver: RuntimeDataResolver;
  commandService: UserCommandService;
  skillSync: SkillSyncService;
  workspaceRulesSnapshotService: WorkspaceRulesSnapshotService;
  sessionSvc: SessionService;
  compactionSvc: SessionCompactionService;
  sessionCompactionEventService: SessionCompactionEventService;
  settingService: SystemSettingService;
  modelRepo: MysqlLlmModelRepository;
}

export interface LlmEngineResult {
  openAiLlmAdapter: OpenAiLlmAdapter;
  anthropicLlmAdapter: AnthropicLlmAdapter;
  responsesLlmAdapter: ResponsesLlmAdapter;
  llmAdapter: LlmAdapter;
  promptEngine: PromptEngine;
  tokenEstimator: TokenEstimator;
  compactionService: CompactionService;
  contextManager: ContextManager;
  compactionArchiveService: CompactionArchiveService;
  compactionConfig: CompactionConfig;
  historyLoader: SessionHistoryLoader;
  activeContext: ActiveContextCalculator;
  compactionModelResolver: CompactionModelResolver;
  orchestrator: SessionCompactionOrchestrator;
}

export function assembleLlmEngine(deps: LlmEngineDeps): LlmEngineResult {
  const { harnessTuning, llmCallService, skillLoader, pathSandbox, runtimeResolver, commandService, skillSync, workspaceRulesSnapshotService, sessionSvc, compactionSvc, sessionCompactionEventService, settingService, modelRepo } = deps;

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
  compactionConfig.triggerPayloadBytes = harnessTuning.compaction.triggerPayloadBytes;
  compactionConfig.maxSummaryTokens = harnessTuning.compaction.maxSummaryTokens;
  compactionConfig.loopMidwayCompact = harnessTuning.compaction.loopMidwayCompact;
  const historyLoader = new SessionHistoryLoader(sessionSvc as never, contextManager, compactionArchiveService);
  const activeContext = new ActiveContextCalculator(tokenEstimator);
  const compactionModelResolver = new CompactionModelResolver(
    (key) => settingService.getValue(key),
    (id) => modelRepo.findById(id),
  );
  const orchestrator = new SessionCompactionOrchestrator(
    compactionSvc as never, sessionCompactionEventService, historyLoader,
    contextManager, sessionSvc as never, activeContext, promptEngine, compactionArchiveService,
    compactionModelResolver, workspaceRulesSnapshotService,
  );

  return {
    openAiLlmAdapter, anthropicLlmAdapter, responsesLlmAdapter, llmAdapter,
    promptEngine, tokenEstimator, compactionService, contextManager,
    compactionArchiveService, compactionConfig, historyLoader, activeContext,
    compactionModelResolver, orchestrator,
  };
}
