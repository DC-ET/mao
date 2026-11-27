import { harnessLog } from '../log.js';
import type { Tool } from './tool.js';
import type { PathSandbox } from '../safety/path-sandbox.js';
import type { SessionTodoMapper } from '../todo/session-todo.mapper.js';
import type { AgentMapper, MessageMapper, SessionCompactionService, SessionMapper, SessionService } from '../deps.js';
import type { ScheduledTaskService } from '../../schedule/scheduled-task.service.js';
import type { ShellSessionManager, OutputManager } from '../shell/shell-session-manager.js';
import type { BackgroundTaskManager } from '../core/background-task-manager.js';
import type { GitTokenResolver } from '../../session/types.js';
import type { WebSearchConfig } from '../../settings/types.js';
import type { WebPageConfig } from './impl/open-web-page-tool.js';
import type { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import type { ImageCallRecorder, ImageModelLookup } from './impl/generate-image-tool.js';
import type { LlmAuthResolver } from '../llm/llm-auth.js';
import type { WeixinMediaToolSupport, WeixinMediaUploadService, WeixinSendService } from './impl/wechat-tools.js';
import type {
  FeishuChannelToolSupport, FeishuGroupMediaLookup, FeishuMediaDownloader, FeishuMessageDetailFetcher,
  FeishuMediaSendSupport,
} from './impl/feishu-tools.js';
import type { AgentDefinitionRegistry } from '../delegate/agent-definition-registry.js';
import type { HarnessService } from '../core/harness-service.js';
import type { AgentLoop } from '../core/agent-loop.js';
import type { SubagentExecutionMapper } from '../delegate/subagent-execution.mapper.js';
import type { LocalToolSessionRegistry } from '../local/local-tool-session-registry.js';
import type { LocalToolExecutor } from '../local/local-tool-executor.js';
import type { SubAgentVisibilityService } from '../delegate/subagent-visibility-service.js';
import type { BackgroundSubagentManager } from '../delegate/background-subagent-manager.js';
import {
  CancelSubagentTool, CheckSubagentTool, SpawnSubagentTool, SubagentFollowupTool, WaitSubagentsTool,
} from './impl/background-subagent-tools.js';
import { AskUserQuestionsTool } from './impl/ask-user-questions-tool.js';
import { ReadFileTool } from './impl/read-file-tool.js';
import { WriteFileTool } from './impl/write-file-tool.js';
import { EditFileTool } from './impl/edit-file-tool.js';
import { GlobSearchTool } from './impl/glob-search-tool.js';
import { GrepSearchTool } from './impl/grep-search-tool.js';
import type { CompanySsoTokenInjector } from '../../auth/company-sso-token-injector.js';
import { ShellSessionTool, type ShellBaseUrlProvider, type ShellEcpInjector, type ShellLarkUatInjector, type ShellTokenIssuer, type ShellUserLookup } from './impl/shell-session-tool.js';
import { WebSearchTool } from './impl/web-search-tool.js';
import { OpenWebPageTool } from './impl/open-web-page-tool.js';
import { DumpUserMessagesTool } from './impl/dump-user-messages-tool.js';
import { GenerateImageTool } from './impl/generate-image-tool.js';
import { EditImageTool } from './impl/edit-image-tool.js';
import { TextToSpeechTool, type AudioModelLookup } from './impl/text-to-speech-tool.js';
import type { LlmAdapter } from '../llm/chat-request.js';
import { TaskCreateTool, TaskDeleteTool, TaskListTool, TaskUpdateTool } from './impl/task-tools.js';
import {
  CreateScheduledTaskTool, DeleteScheduledTaskTool, ListScheduledTasksTool, UpdateScheduledTaskTool,
} from './impl/scheduled-task-tools.js';
import { CreateSignalWatcherTool, ListSignalWatchersTool, type SignalWatcherServiceRef } from './impl/signal-watcher-tools.js';
import { FeishuDownloadFileTool } from './impl/feishu-tools.js';
import { SendImageTool, SendFileTool, WechatSendStrategy, FeishuSendStrategy, DingtalkSendStrategy, type SendFileStore, type SendDownloadLinkIssuer } from './impl/send-media-tool.js';
import type { LocalDeliveryFetchService } from '../local/delivery-fetch.service.js';
import type { DingtalkMediaSendSupport } from './impl/dingtalk-tools.js';
import type { SendBytesSupport } from './impl/send-file-bytes.js';
import { createPageTools } from './impl/page-tools.js';
import type { EmbedPageToolRegistry } from '../embed-page-tool-registry.js';
import { McpCallTool, type McpToolCaller } from '../mcp/workingset/impl/mcp-call-tool.js';
import { McpDescribeTool } from '../mcp/workingset/impl/mcp-describe-tool.js';
import type { McpToolsRegistry } from '../mcp/local/mcp-tools-registry.js';
import {
  HttpCallTool, HttpDescribeTool, type HttpApiToolServicePort,
} from './impl/http-api-tools.js';
import type { HttpApiExecutor } from './impl/http-api-executor.js';

/**
 * 自定义 HTTP 工具的两个入口（技术方案 2026-10-19 §5.3）：默认工具集中先剔除，
 * 仅当用户有启用工具时按会话推入（装配见 harness-service buildContext）。
 * 顺序即推入顺序：先 describe 后 call。
 */
export const HTTP_TOOL_NAMES = ['http_describe', 'http_call'] as const;

export interface DefaultToolRegistryDeps {
  pathSandbox: PathSandbox;
  sessionTodoMapper: SessionTodoMapper;
  scheduledTaskService: ScheduledTaskService;
  /** 信号哨兵服务晚绑定（V189）：harness 装配先于 openapi 装配，运行期经 thunk 取实例。 */
  getSignalWatcherService?: SignalWatcherServiceRef;
  sessionService: SessionService;
  sessionMapper: SessionMapper;
  shellSessionManager: ShellSessionManager;
  outputManager: OutputManager;
  backgroundTaskManager: BackgroundTaskManager;
  gitTokenResolver?: GitTokenResolver | null;
  jwtService?: ShellTokenIssuer | null;
  shellUserLookup?: ShellUserLookup | null;
  shellEcpInjector?: ShellEcpInjector | null;
  shellLarkUatInjector?: ShellLarkUatInjector | null;
  /** 公司 SSO 换票凭证（注入 shell 的 COMPANY_SSO_TOKEN）；未注入时不写该变量。 */
  shellCompanySsoInjector?: CompanySsoTokenInjector | null;
  /** 站点地址（注入 shell 的 MAO_BASE_URL）；未注入时 shell 行为与改造前一致（不注入该变量）。 */
  shellBaseUrlProvider?: ShellBaseUrlProvider | null;
  webSearch: () => Promise<WebSearchConfig>;
  webPage: WebPageConfig;
  runtimeDataResolver: RuntimeDataResolver;
  imageModelLookup: ImageModelLookup;
  /** 语音模型查询（text_to_speech 用）；与 imageModelLookup 同口径。 */
  audioModelLookup: AudioModelLookup;
  /** LLM 适配器（text_to_speech 直连音频模型；由 RecordingLlmAdapter 自动记 llm_call）。 */
  llmAdapter: LlmAdapter;
  /**
   * 图片调用流水记录器（技术方案 2026-11-24 D7）。可选依赖：未注入（精简单测 /
   * 精简装配）时 generate_image / edit_image 不记账，行为与改造前完全一致。
   */
  imageCallRecorder?: ImageCallRecorder | null;
  /** 图片出口凭证解析器（ecp 模式解析当前用户 ECP Token）；缺省时只用模型配置的固定 Key。 */
  authResolver?: LlmAuthResolver;
  uploadDir: string;
  getUploadBaseUrl?: () => Promise<string>;
  /** servlet contextPath（默认 /api）：图片产物 image_url 派生静态 origin 用。 */
  uploadContextPath?: string;
  /** 微信通道策略（统一发送工具，2026-11-18-unified-send-media）；测试装配可缺省。 */
  weixinToolSupport?: WeixinMediaToolSupport | null;
  weixinUploadService?: WeixinMediaUploadService | null;
  weixinSendService?: WeixinSendService | null;
  feishuToolSupport: FeishuChannelToolSupport;
  feishuMediaDownloader: FeishuMediaDownloader;
  feishuGroupMediaLookup: FeishuGroupMediaLookup;
  feishuMessageDetailFetcher: FeishuMessageDetailFetcher;
  feishuMaxInboundFileBytes: number;
  feishuMediaSendSupport: FeishuMediaSendSupport;
  dingtalkMediaSendSupport: DingtalkMediaSendSupport;
  /** 外部发送工具的容器读字节支持（docker 模式下本地路径经容器读取，§5.8）。可选注入。 */
  sendBytesSupport?: SendBytesSupport | null;
  /** LOCAL 发送字节委托读取（2026-11-18-unified-send-media §6）；未装配时 LOCAL 本机路径发送直接失败。 */
  localDeliveryFetchService?: LocalDeliveryFetchService | null;
  /** 发送附件快照存储（2026-11-24-send-file-snapshot D3）：本地 / 多云分流与插表在实现里。必填。 */
  sendFileStore: SendFileStore;
  /**
   * 通道发送失败时的兜底下载链接签发（2026-11-25）：外部通道有硬上限（微信 / 钉钉 20MB、
   * 飞书 30MB），超限时给用户一条带短时票据的下载地址。未注入 = 不给链接（行为同旧版）。
   */
  sendDownloadLink?: SendDownloadLinkIssuer | null;
  definitionRegistry: AgentDefinitionRegistry;
  harnessService: HarnessService;
  agentLoop: AgentLoop;
  subagentExecutionMapper: SubagentExecutionMapper;
  localToolSessionRegistry: LocalToolSessionRegistry;
  /** LOCAL 工具委托入口（dump_user_messages 的 LOCAL 落盘经它走 WS 委托桌面端）。 */
  localToolExecutor: LocalToolExecutor;
  visibilityService: SubAgentVisibilityService;
  backgroundSubagentManager: BackgroundSubagentManager;
  messageMapper: MessageMapper;
  sessionCompactionService: SessionCompactionService;
  embedPageToolRegistry: EmbedPageToolRegistry;
  /**
   * MCP 工作集工具（mcp_call / mcp_describe）。两者都依赖会话工具清单；
   * 未注入时（部分单测/精简装配）不注册，全量模式行为不受影响。
   */
  mcpToolsRegistry?: McpToolsRegistry | null;
  mcpClientManager?: McpToolCaller | null;
  /**
   * 自定义 HTTP 工具（http_describe / http_call，技术方案 2026-10-21 §5.3）。
   * 与 MCP 工作集同款条件注册：未注入时（精简装配/单测）不注册，全量模式行为不受影响。
   * 执行解析按 Agent 维度：sessionId → agentId → agent.httpToolIds。
   */
  httpToolService?: HttpApiToolServicePort | null;
  httpApiExecutor?: HttpApiExecutor | null;
  agentMapper?: AgentMapper | null;
  /**
   * 文件落盘成功回调（团队经验库索引刷新，技术方案 2026-10-24 §3.5 触发点 2）：
   * 注入给 write_file / edit_file。回调自身判断路径是否位于经验根下，非经验文件零开销。
   * 未注入时（精简装配/单测）两工具行为与改造前完全一致。
   */
  onFileChanged?: (absPath: string) => void;
}

/** Instantiates and registers all built-in tools (mirrors Spring Tool bean auto-registration). */
export function createDefaultToolRegistry(deps: DefaultToolRegistryDeps): ToolRegistry {
  const tools: Tool[] = [
    new AskUserQuestionsTool(),
    new ReadFileTool(deps.pathSandbox),
    new WriteFileTool(deps.pathSandbox, deps.onFileChanged),
    new EditFileTool(deps.pathSandbox, deps.onFileChanged),
    new GlobSearchTool(deps.pathSandbox),
    new GrepSearchTool(deps.pathSandbox),
    new ShellSessionTool(
      deps.pathSandbox, deps.shellSessionManager, deps.outputManager,
      deps.backgroundTaskManager, deps.gitTokenResolver,
      deps.jwtService, deps.shellUserLookup, deps.shellEcpInjector,
      deps.shellLarkUatInjector, deps.shellBaseUrlProvider, deps.shellCompanySsoInjector,
    ),
    new WebSearchTool(deps.webSearch),
    new OpenWebPageTool(
      deps.webPage,
      deps.runtimeDataResolver,
      async (sessionId) => {
        // LOCAL 会话的 read_file 在桌面端执行，服务端落盘路径不可达，截断全文不落盘。
        if (sessionId == null) return false;
        const session = await deps.sessionMapper.selectById(sessionId);
        return session?.executionMode === 'LOCAL';
      },
    ),
    new DumpUserMessagesTool(
      deps.sessionService,
      deps.runtimeDataResolver,
      deps.localToolExecutor,
      deps.sessionMapper,
    ),
    new GenerateImageTool(deps.imageModelLookup, deps.uploadDir, deps.getUploadBaseUrl ?? (async () => ''), deps.uploadContextPath, deps.authResolver, deps.imageCallRecorder ?? null),
    new EditImageTool(deps.imageModelLookup, deps.pathSandbox, deps.uploadDir, deps.getUploadBaseUrl ?? (async () => ''), deps.sendBytesSupport, deps.uploadContextPath, deps.authResolver, deps.imageCallRecorder ?? null),
    new TextToSpeechTool(deps.audioModelLookup, deps.llmAdapter, deps.uploadDir, deps.getUploadBaseUrl ?? (async () => ''), deps.uploadContextPath),
    new TaskCreateTool(deps.sessionTodoMapper),
    new TaskListTool(deps.sessionTodoMapper),
    new TaskUpdateTool(deps.sessionTodoMapper),
    new TaskDeleteTool(deps.sessionTodoMapper),
    new CreateScheduledTaskTool(deps.scheduledTaskService, deps.sessionService),
    new ListScheduledTasksTool(deps.scheduledTaskService),
    new UpdateScheduledTaskTool(deps.scheduledTaskService),
    new DeleteScheduledTaskTool(deps.scheduledTaskService),
    // 信号哨兵两件套（V189）：仅装配了晚绑定 ref 时注册（缺省装配工具集不变）
    ...(deps.getSignalWatcherService != null ? [
      new ListSignalWatchersTool(deps.getSignalWatcherService, deps.sessionService),
      new CreateSignalWatcherTool(deps.getSignalWatcherService, deps.sessionService),
    ] : []),
    // 统一发送图片 / 文件（技术方案 2026-11-18-unified-send-media）：六个通道发送工具收编为
    // send_image / send_file，通道推送逻辑移进策略（send-media-tool.ts），旧类删除。
    new SendImageTool(
      deps.pathSandbox, deps.sessionService,
      { uploadDir: deps.uploadDir, getUploadBaseUrl: deps.getUploadBaseUrl ?? (async () => ''), uploadContextPath: deps.uploadContextPath },
      deps.weixinToolSupport != null && deps.weixinUploadService != null && deps.weixinSendService != null
        ? new WechatSendStrategy(deps.weixinToolSupport, deps.weixinUploadService, deps.weixinSendService) : null,
      deps.feishuMediaSendSupport != null ? new FeishuSendStrategy(deps.feishuMediaSendSupport) : null,
      deps.dingtalkMediaSendSupport != null ? new DingtalkSendStrategy(deps.dingtalkMediaSendSupport) : null,
      deps.sendFileStore,
      deps.sendBytesSupport,
      deps.localDeliveryFetchService ?? null,
      deps.sendDownloadLink ?? null,
    ),
    new SendFileTool(
      deps.pathSandbox, deps.sessionService,
      { uploadDir: deps.uploadDir, getUploadBaseUrl: deps.getUploadBaseUrl ?? (async () => ''), uploadContextPath: deps.uploadContextPath },
      deps.weixinToolSupport != null && deps.weixinUploadService != null && deps.weixinSendService != null
        ? new WechatSendStrategy(deps.weixinToolSupport, deps.weixinUploadService, deps.weixinSendService) : null,
      deps.feishuMediaSendSupport != null ? new FeishuSendStrategy(deps.feishuMediaSendSupport) : null,
      deps.dingtalkMediaSendSupport != null ? new DingtalkSendStrategy(deps.dingtalkMediaSendSupport) : null,
      deps.sendFileStore,
      deps.sendBytesSupport,
      deps.localDeliveryFetchService ?? null,
      deps.sendDownloadLink ?? null,
    ),
    new FeishuDownloadFileTool(deps.feishuToolSupport, deps.feishuGroupMediaLookup, deps.feishuMediaDownloader, deps.feishuMaxInboundFileBytes, deps.feishuMessageDetailFetcher),
    new SpawnSubagentTool(deps.backgroundSubagentManager, deps.definitionRegistry),
    new SubagentFollowupTool(deps.backgroundSubagentManager),
    new CheckSubagentTool(deps.backgroundSubagentManager),
    new CancelSubagentTool(deps.backgroundSubagentManager),
    new WaitSubagentsTool(deps.backgroundSubagentManager, (sid) => deps.agentLoop.getCancelFlag(sid)),
    ...createPageTools(deps.embedPageToolRegistry),
  ];
  // 工作集模式的两个入口工具：只在依赖齐备时注册，未注入的装配保持原工具集不变。
  if (deps.mcpToolsRegistry != null && deps.mcpClientManager != null) {
    tools.push(
      new McpCallTool({
        sessionMapper: deps.sessionMapper,
        toolsRegistry: deps.mcpToolsRegistry,
        clientManager: deps.mcpClientManager,
      }),
      new McpDescribeTool({
        sessionMapper: deps.sessionMapper,
        toolsRegistry: deps.mcpToolsRegistry,
      }),
    );
  }
  // 自定义 HTTP 工具的两个入口：同样条件注册（执行内核与定义域齐备时才可用）。
  if (deps.httpToolService != null && deps.httpApiExecutor != null && deps.agentMapper != null) {
    tools.push(
      new HttpDescribeTool({
        sessionMapper: deps.sessionMapper,
        agentMapper: deps.agentMapper,
        httpToolService: deps.httpToolService,
      }),
      new HttpCallTool({
        sessionMapper: deps.sessionMapper,
        agentMapper: deps.agentMapper,
        httpToolService: deps.httpToolService,
        executor: deps.httpApiExecutor,
      }),
    );
  }
  return new ToolRegistry(tools);
}


export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(toolBeans: Tool[] = []) {
    for (const tool of toolBeans) {
      this.register(tool);
    }
    harnessLog('info', `ToolRegistry initialized with ${this.tools.size} built-in tools: ${[...this.tools.keys()].join(',')}`);
  }

  register(tool: Tool): void {
    this.tools.set(tool.getName(), tool);
    harnessLog('info', `Registered tool: ${tool.getName()}`);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAllTools(): Tool[] {
    return [...this.tools.values()];
  }

  getToolsByNames(names: string[]): Tool[] {
    const result: Tool[] = [];
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) result.push(tool);
    }
    return result;
  }
}
