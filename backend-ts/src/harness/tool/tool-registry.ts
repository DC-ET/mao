import { harnessLog } from '../log.js';
import type { Tool } from './tool.js';
import type { PathSandbox } from '../safety/path-sandbox.js';
import type { SessionTodoMapper } from '../todo/session-todo.mapper.js';
import type { MessageMapper, SessionCompactionService, SessionMapper, SessionService } from '../deps.js';
import type { ScheduledTaskService } from '../../schedule/scheduled-task.service.js';
import type { ShellSessionManager, OutputManager } from '../shell/shell-session-manager.js';
import type { BackgroundTaskManager } from '../core/background-task-manager.js';
import type { GitCredentialLookup } from '../../session/types.js';
import type { TavilyConfig } from './impl/web-search-tool.js';
import type { WebPageConfig } from './impl/open-web-page-tool.js';
import type { ImageModelLookup } from './impl/generate-image-tool.js';
import type { WeixinMediaToolSupport, WeixinMediaUploadService, WeixinSendService } from './impl/wechat-tools.js';
import type { AgentDefinitionRegistry } from '../delegate/agent-definition-registry.js';
import type { HarnessService } from '../core/harness-service.js';
import type { AgentLoop } from '../core/agent-loop.js';
import type { SubagentExecutionMapper } from '../delegate/subagent-execution.mapper.js';
import type { SubagentInvocationService } from '../delegate/subagent-invocation.service.js';
import type { LocalToolSessionRegistry } from '../local/local-tool-session-registry.js';
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
import { ShellSessionTool, type ShellTokenIssuer, type ShellUserLookup } from './impl/shell-session-tool.js';
import { WebSearchTool } from './impl/web-search-tool.js';
import { OpenWebPageTool } from './impl/open-web-page-tool.js';
import { GenerateImageTool } from './impl/generate-image-tool.js';
import { TaskCreateTool, TaskDeleteTool, TaskListTool, TaskUpdateTool } from './impl/task-tools.js';
import {
  CreateScheduledTaskTool, DeleteScheduledTaskTool, ListScheduledTasksTool, UpdateScheduledTaskTool,
} from './impl/scheduled-task-tools.js';
import { SendWechatFileTool, SendWechatImageTool } from './impl/wechat-tools.js';

export interface DefaultToolRegistryDeps {
  pathSandbox: PathSandbox;
  sessionTodoMapper: SessionTodoMapper;
  scheduledTaskService: ScheduledTaskService;
  sessionService: SessionService;
  sessionMapper: SessionMapper;
  shellSessionManager: ShellSessionManager;
  outputManager: OutputManager;
  backgroundTaskManager: BackgroundTaskManager;
  gitCredentialService?: GitCredentialLookup | null;
  jwtService?: ShellTokenIssuer | null;
  shellUserLookup?: ShellUserLookup | null;
  tavily: TavilyConfig;
  webPage: WebPageConfig;
  imageModelLookup: ImageModelLookup;
  uploadDir: string;
  imageBaseUrl?: string;
  weixinToolSupport: WeixinMediaToolSupport;
  weixinUploadService: WeixinMediaUploadService;
  weixinSendService: WeixinSendService;
  definitionRegistry: AgentDefinitionRegistry;
  harnessService: HarnessService;
  agentLoop: AgentLoop;
  subagentExecutionMapper: SubagentExecutionMapper;
  subagentInvocationService?: SubagentInvocationService;
  localToolSessionRegistry: LocalToolSessionRegistry;
  visibilityService: SubAgentVisibilityService;
  backgroundSubagentManager: BackgroundSubagentManager;
  messageMapper: MessageMapper;
  sessionCompactionService: SessionCompactionService;
}

/** Instantiates and registers all 22 built-in tools (mirrors Spring Tool bean auto-registration). */
export function createDefaultToolRegistry(deps: DefaultToolRegistryDeps): ToolRegistry {
  return new ToolRegistry([
    new AskUserQuestionsTool(),
    new ReadFileTool(deps.pathSandbox),
    new WriteFileTool(deps.pathSandbox),
    new EditFileTool(deps.pathSandbox),
    new GlobSearchTool(deps.pathSandbox),
    new GrepSearchTool(deps.pathSandbox),
    new ShellSessionTool(
      deps.pathSandbox, deps.shellSessionManager, deps.outputManager,
      deps.backgroundTaskManager, deps.gitCredentialService,
      deps.jwtService, deps.shellUserLookup,
    ),
    new WebSearchTool(deps.tavily),
    new OpenWebPageTool(deps.webPage),
    new GenerateImageTool(deps.imageModelLookup, deps.uploadDir, deps.imageBaseUrl ?? ''),
    new TaskCreateTool(deps.sessionTodoMapper),
    new TaskListTool(deps.sessionTodoMapper),
    new TaskUpdateTool(deps.sessionTodoMapper),
    new TaskDeleteTool(deps.sessionTodoMapper),
    new CreateScheduledTaskTool(deps.scheduledTaskService, deps.sessionService),
    new ListScheduledTasksTool(deps.scheduledTaskService),
    new UpdateScheduledTaskTool(deps.scheduledTaskService),
    new DeleteScheduledTaskTool(deps.scheduledTaskService),
    new SendWechatImageTool(deps.pathSandbox, deps.weixinToolSupport, deps.weixinUploadService, deps.weixinSendService),
    new SendWechatFileTool(deps.pathSandbox, deps.weixinToolSupport, deps.weixinUploadService, deps.weixinSendService),
    new SpawnSubagentTool(deps.backgroundSubagentManager),
    new SubagentFollowupTool(deps.backgroundSubagentManager),
    new CheckSubagentTool(deps.backgroundSubagentManager),
    new CancelSubagentTool(deps.backgroundSubagentManager),
    new WaitSubagentsTool(deps.backgroundSubagentManager),
  ]);
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
