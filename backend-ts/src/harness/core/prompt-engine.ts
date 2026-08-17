import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { hasText } from '../../common/case.js';
import { WEIXIN_PROJECT_KEY } from '../../domain/types.js';
import type { ChatMessage, ChatRequest, LlmModelConfig, ToolDefinition } from '../llm/chat-request.js';
import type { PathSandbox } from '../safety/path-sandbox.js';
import type { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import type { SkillLoader } from '../skill/skill-loader.js';
import type { SkillSyncService } from '../skill/skill-sync-service.js';
import type { UserCommandService } from '../deps.js';
import { harnessLog } from '../log.js';
import type { AgentExecutionContext } from './agent-execution-context.js';
import { ToolMediaInjector } from './tool-media-injector.js';

const TASK_TOOL_NAMES = new Set(['task_create', 'task_update', 'task_list', 'task_delete']);
const WEIXIN_MEDIA_TOOL_NAMES = new Set(['send_wechat_image', 'send_wechat_file']);

const WEIXIN_DEFAULT_EXPERIENCES = [
  'AGENTS.md文件里面存储了当前用户最核心的信息，该文件的内容的前200行每次都会被加载至对话上下文的系统提示词中，一般情况在你无需主动读取该文件（除非文件已超出200行），你可以在必要的时候编辑或新增该文件的内容（如果文件不存在你可以新建这个文件），但一定要保持文件内容的精简，避免内容过长。',
  '你可以充分利用当前工作区目录配合文件读写能力，你可以以文件的形式记录用户的偏好，以及与用户长期交流下来所沉淀的信息（对于有时效的信息在记录时一定要标记时间信息）。你可以在任意对话时通过文件查阅来进行快速回忆。以便更好的长期的服务好用户。',
];

const TOOL_USAGE_GUIDANCE = `# 使用你的工具
 - 当提供相关专用工具时，不要使用shell运行命令。使用专用工具可以让用户更好地理解和审查你的工作。这对协助用户至关重要：
  - 要读取文件，使用read_file而不是cat、head、tail或sed
  - 要编辑文件，使用edit_file而不是sed或awk
  - 要创建文件，使用write_file而不是带heredoc的cat或echo重定向
  - 要搜索文件，使用glob_search而不是find或ls
  - 要搜索文件内容，使用grep_search而不是grep或rg
  - 将shell专门保留用于需要shell执行的系统命令和终端操作。如果你不确定并且有相关专用工具，默认使用专用工具，只有在绝对必要时才回退到使用shell工具。
 - 使用task_*工具分解和管理你的工作。这些工具有助于规划你的工作并帮助用户跟踪你的进度。完成任务后立即将其标记为已完成。不要在标记为已完成之前批量处理多个任务。
 - 使用ask_user_questions工具实现在不中断任务进行的情况下向用户获取信息、收集需求、请求授权等行为，尽量避免因为这些问题中断任务。
 - 你可以在单个响应中调用多个工具。如果你打算调用多个工具并且它们之间没有依赖关系，请并行执行所有独立的工具调用。尽可能最大化并行工具调用的使用以提高效率。但是，如果某些工具调用依赖于先前的调用来获取依赖值，请不要并行调用这些工具，而是按顺序调用它们。例如，如果一个操作必须在另一个操作开始之前完成，请按顺序运行这些操作。
`;

const SKILL_PATTERN = /\$\{([^}]+)\}\$/g;
const COMMAND_PATTERN = /#\{([^}]+)\}#/g;
const FILE_REF_PATTERN = /@\{([^}]+)\}@/g;
const AGENTS_MD_MAX_LINES = 200;

function isBenignTemplatePlaceholderName(name: string): boolean {
  return name === 'label';
}
const AGENTS_MD_TRUNCATED_HINT = '\n> 当前仅展示前200行规则，读取AGENTS.md文件以了解更多规则。\n';

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export class PromptEngine {
  constructor(
    private readonly skillLoader: SkillLoader,
    private readonly pathSandbox: PathSandbox,
    private readonly runtimeDataResolver: RuntimeDataResolver,
    private readonly userCommandService: UserCommandService,
    private readonly skillSyncService: SkillSyncService,
    private readonly toolMediaInjector = new ToolMediaInjector(),
  ) {}

  async buildRequest(context: AgentExecutionContext): Promise<ChatRequest> {
    const messages: ChatMessage[] = [];
    messages.push({ role: 'system', content: this.buildSystemPrompt(context) });
    const history = context.messages;
    await this.replaceQuickCommandMarkers(history, context);
    messages.push(...history);
    const injected = this.toolMediaInjector.inject(messages, context.toolAttachments, context.modelConfig) ?? messages;
    const tools = this.buildToolDefinitions(context);
    const request: ChatRequest = {
      messages: injected,
      tools: tools.length === 0 ? undefined : tools,
      stream: true,
    };
    if (isGptModel(context.modelConfig)) {
      request.reasoning = { effort: 'high' };
    }
    return request;
  }

  private async replaceQuickCommandMarkers(messages: ChatMessage[], context: AgentExecutionContext): Promise<void> {
    const userId = context.userId;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
      const content = msg.content;
      let replaced = content.replace(SKILL_PATTERN, (match, skillName: string) => {
        if (this.skillLoader.hasSkill(skillName) || this.hasUserSkill(skillName, userId)
          || this.hasLocalUnsyncedSkill(skillName, context)) {
          return '/' + skillName;
        }
        if (!isBenignTemplatePlaceholderName(skillName)) {
          harnessLog('warn', `Skill not found for marker: ${match}`);
        }
        return match;
      });
      const commandMatches = [...replaced.matchAll(COMMAND_PATTERN)];
      for (const m of commandMatches) {
        const commandName = m[1];
        let command: { content?: string } | null = null;
        if (userId != null) {
          command = await this.userCommandService.getByUserIdAndName(userId, commandName);
        }
        if (command?.content != null) {
          replaced = replaced.replace(m[0], command.content);
        } else {
          harnessLog('warn', `Command not found for marker: #{${commandName}}#`);
        }
      }
      replaced = replaced.replace(FILE_REF_PATTERN, (_match, filePath: string) => filePath);
      if (replaced !== content) {
        messages[i] = { role: 'user', content: replaced };
      }
    }
  }

  private hasUserSkill(skillName: string, userId: number | null | undefined): boolean {
    if (userId == null) return false;
    return this.skillSyncService.getUserSkillDocuments(userId).some((d) => d.name === skillName);
  }

  private hasLocalUnsyncedSkill(skillName: string, context: AgentExecutionContext): boolean {
    return context.localUnsyncedSkills?.some((s) => s.name === skillName) === true;
  }

  private buildSystemPrompt(context: AgentExecutionContext): string {
    let sb = '';
    if (hasText(context.systemPrompt)) {
      sb += context.systemPrompt + '\n\n';
    }
    const experiences = this.resolveExperiences(context);
    if (experiences.length > 0) {
      sb += '## 最佳实践经验\n\n';
      for (const exp of experiences) {
        if (hasText(exp)) sb += `- ${exp}\n`;
      }
      sb += '\n';
    }
    const effectiveWorkspace = hasText(context.workspace)
      ? context.workspace!
      : this.pathSandbox.getWorkspaceRoot();
    sb += '## 工作环境\n\n';
    sb += `你当前的工作目录是：\`${effectiveWorkspace}\`\n`;
    sb += '所有相对文件路径都会基于该目录解析。\n';
    sb += `- 是否为 git 仓库：${formatBoolean(context.isGit)}\n`;
    sb += `- 平台：${formatValue(context.platform)}\n`;
    sb += `- Shell：${formatValue(context.shellPath)}\n`;
    sb += `- 操作系统版本：${formatValue(context.osVersion)}\n`;
    sb += this.executionEnvironmentHint(context, effectiveWorkspace);
    if (context.currentTimestamp) {
      sb += '## 当前日期\n\n';
      sb += `当前日期：\`${context.currentTimestamp}\``;
      const weekday = formatChineseWeekday(context.currentTimestamp);
      if (weekday) sb += `（${weekday}）`;
      sb += '\n';
      sb += '如需精确到时分秒的时间，请使用 shell 执行 `date` 命令获取。\n\n';
    }
    sb += TOOL_USAGE_GUIDANCE + '\n';
    const skillNames = context.availableSkillNames;
    if (skillNames && skillNames.length > 0) {
      const catalog = this.buildSkillCatalog(context);
      if (hasText(catalog)) {
        sb += '## 可用技能\n\n';
        sb += '以下技能可用。每个技能都是一份知识文档，用于指导你在特定场景下高效使用工具。\n';
        sb += '技能副本位于会话运行时目录（不在用户项目目录内）。\n';
        sb += '如需阅读某个技能的完整内容，请使用 `read_file` 工具读取下方列出的文件路径。\n\n';
        sb += catalog + '\n\n';
      }
    }
    sb += this.toolBehaviorHints(context);
    sb += this.subagentToolHints(context);
    sb += this.weixinMediaToolHints(context);
    sb += this.workspaceRules(context, effectiveWorkspace);
    return sb;
  }

  private resolveExperiences(context: AgentExecutionContext): string[] {
    const merged: string[] = [];
    if (context.projectKey === WEIXIN_PROJECT_KEY) {
      merged.push(...WEIXIN_DEFAULT_EXPERIENCES);
    }
    for (const exp of context.experiences ?? []) {
      if (hasText(exp)) merged.push(exp);
    }
    return merged;
  }

  private buildSkillCatalog(context: AgentExecutionContext): string | null {
    let names = context.availableSkillNames;
    if (!names || names.length === 0) names = this.skillLoader.getAllNames();
    if (names.length === 0) return null;
    const isLocal = context.executionMode?.toUpperCase() === 'LOCAL';
    const userId = context.userId;
    const sessionId = context.sessionId;
    const localUnsyncedFolders = new Map<string, string>();
    for (const ref of context.localUnsyncedSkills ?? []) {
      if (ref.folderName) localUnsyncedFolders.set(ref.name, ref.folderName);
    }
    const skillDocs = context.availableSkillDocs;
    let sb = '';
    for (const name of names) {
      let description = '';
      let doc = skillDocs instanceof Map ? skillDocs.get(name) : undefined;
      if (!doc) {
        doc = this.skillLoader.getAllDocuments().find((d) => d.name === name);
      }
      if (doc?.description) description = doc.description;
      sb += `- **${name}**：${description}`;
      const localFolderName = localUnsyncedFolders.get(name);
      if (localFolderName) {
        sb += `\n  目录：\`${this.runtimeDataResolver.formatLocalUnsyncedSkillsDir(localFolderName)}\``;
        sb += `\n  文件：\`${this.runtimeDataResolver.formatLocalUnsyncedSkillsPath(localFolderName)}\``;
        sb += '\n  （本地未同步：该技能仅存在于用户本地电脑，仅可用于当前本地任务；若需在云端模式任务中使用，用户需先在技能管理中上传）';
      } else if (isLocal && sessionId != null) {
        sb += `\n  目录：\`${this.runtimeDataResolver.formatLocalSkillsDir(sessionId, name)}\``;
        sb += `\n  文件：\`${this.runtimeDataResolver.formatLocalSkillsPath(sessionId, name)}\``;
      } else if (userId != null && sessionId != null) {
        sb += `\n  目录：\`${this.runtimeDataResolver.formatCloudSkillsDir(userId, sessionId, name)}\``;
        sb += `\n  文件：\`${this.runtimeDataResolver.formatCloudSkillsPath(userId, sessionId, name)}\``;
      }
      sb += '\n';
    }
    return sb.trim();
  }

  private executionEnvironmentHint(context: AgentExecutionContext, effectiveWorkspace: string): string {
    if (context.executionMode?.toUpperCase() === 'LOCAL') {
      return `当前会话处于 LOCAL 本地模式。你调用的 shell、文件读取、文件写入和文件搜索等工具会委托给用户桌面客户端执行，`
        + `工作目录位于用户本地机器：\`${effectiveWorkspace}\`。\n`
        + '因此，工具看到的文件系统、命令、依赖和环境变量属于用户本地环境。'
        + '当描述执行过程或诊断异常时，请明确这是用户本地工作区中的情况。\n\n';
    }
    return '当前会话处于 CLOUD 云端模式。你调用的 shell、文件读取、文件写入和文件搜索等工具都在云端服务器执行，'
      + '工作目录是服务器上的临时/隔离目录，而不是用户电脑上的目录。\n'
      + '因此，工具看到的文件系统、命令、依赖和环境变量都属于云端执行环境。'
      + '当命令失败、文件不存在、依赖缺失或权限受限时，请先将其理解为云端工作区的问题，'
      + '不要默认归因于用户本地电脑，也不要要求用户在本地手动执行命令来规避异常，除非用户明确要求或任务确实需要本地操作。\n'
      + '文件类工具（`read_file`、`write_file`、`edit_file`、`glob_search`、`grep_search`）的路径参数不支持以 `~` 开头；'
      + '请使用工作区相对路径，或平台提供的绝对路径（如会话 runtime 目录、用户数据目录）。\n\n';
  }

  private buildToolDefinitions(context: AgentExecutionContext): ToolDefinition[] {
    return (context.tools ?? []).map((tool) => ({
      type: 'function',
      function: {
        name: tool.getName(),
        description: tool.getDescription(),
        parameters: tool.getInputSchema(),
      },
    }));
  }

  private toolBehaviorHints(context: AgentExecutionContext): string {
    if (!(context.tools ?? []).some((t) => TASK_TOOL_NAMES.has(t.getName()))) return '';
    return '## 任务管理\n\n'
      + '这些工具有助于规划你的工作，并帮助用户跟踪进展。\n'
      + '只有当请求包含 3 个或更多明确步骤时，才使用任务工具。\n'
      + '不要为简单、单步或直接明了的请求创建任务。\n'
      + '使用任务时：每完成一个任务，就立即将其标记为已完成。\n'
      + '不要等多个任务都做完后再批量标记完成。\n\n';
  }

  private subagentToolHints(context: AgentExecutionContext): string {
    const tools = context.tools ?? [];
    const hasSpawn = tools.some((t) => t.getName() === 'spawn_subagent');
    const hasFollowup = tools.some((t) => t.getName() === 'subagent_followup');
    if (!hasSpawn && !hasFollowup) return '';
    let sb = '';
    if (hasSpawn) {
      sb += '## 子代理委派\n\n'
        + '你可以使用 `spawn_subagent` 工具在后台启动专用子代理。子代理拥有独立会话，工具会立即返回 `task_id` 与 `child_session_id`。\n\n'
        + '**使用原则：**\n'
        + '1. 只有当子任务足够独立、可并行推进时才派发\n'
        + '2. 任务描述要具体，包含明确目标、输入数据和期望输出格式\n'
        + '3. 子代理无法与用户交互，不要派发需要用户确认的任务\n'
        + '4. 后续使用 `check_subagent` 查看进度，或使用 `wait_subagents` 等待全部后台子代理结束\n\n';
    }
    if (hasFollowup) {
      sb += '## 子代理追问 / 纠偏\n\n'
        + '你可以使用 `subagent_followup` 对既有子代理会话发起追问，复用其历史上下文。\n\n'
        + '**适用场景：**\n'
        + '1. 子代理空闲时：追加追问消息并启动新的后台执行\n'
        + '2. 子代理运行中时：该工具会被解释为纠偏，中断当前执行并以新的纠偏消息重新启动后台执行\n\n'
        + '**使用步骤：**\n'
        + '1. 从 `spawn_subagent` 或上一次 `subagent_followup` 结果中取 `child_session_id`\n'
        + '2. 在 `task` 中说明追问或纠偏内容，调用 `subagent_followup`\n\n'
        + '**注意：**\n'
        + '1. `subagent_followup` 立即返回新的 `task_id`，后续通过 `check_subagent` 或 `wait_subagents` 获取结果\n'
        + '2. 全新任务请使用 `spawn_subagent` 新建子代理，不要追问无关子代理\n\n';
    }
    return sb;
  }

  private weixinMediaToolHints(context: AgentExecutionContext): string {
    if (!(context.tools ?? []).some((t) => WEIXIN_MEDIA_TOOL_NAMES.has(t.getName()))) return '';
    return `## 微信媒体发送

- 当前会话为微信通道。用户请求"把这张图/照片发给我""生成一张图发我"时，使用 send_wechat_image；请求"发一份文件/PDF/报告"时使用 send_wechat_file。
- 工具只负责发送媒体本身；文字说明通过正常回复给出。
- 工具返回 {"error": ...} 时，如实向用户说明原因（如账号未绑定、需要先给机器人发一条消息建立会话、文件超限等），不要重复调用。

`;
  }

  private workspaceRules(context: AgentExecutionContext, effectiveWorkspace: string): string {
    let content: string | null = null;
    if (context.executionMode?.toUpperCase() === 'LOCAL') {
      content = context.agentsMdContent ?? null;
    } else {
      const agentsMdPath = path.join(effectiveWorkspace, 'AGENTS.md');
      if (existsSync(agentsMdPath) && statSync(agentsMdPath).isFile()) {
        try {
          content = readFileSync(agentsMdPath, 'utf8');
        } catch (e) {
          harnessLog('warn', `Failed to read AGENTS.md from workspace: ${agentsMdPath}`, e);
        }
      }
    }
    if (!hasText(content)) return '';
    const lines = content!.split(/\r?\n|\r/);
    const truncated = lines.length > AGENTS_MD_MAX_LINES;
    let ruleContent = '';
    for (let i = 0; i < Math.min(lines.length, AGENTS_MD_MAX_LINES); i++) {
      ruleContent += lines[i] + '\n';
    }
    if (truncated) ruleContent += AGENTS_MD_TRUNCATED_HINT;
    return '## 工作区规则\n\n' + ruleContent + '\n';
  }
}

function isGptModel(modelConfig: LlmModelConfig | null | undefined): boolean {
  return modelConfig?.modelId?.startsWith('gpt-') === true;
}

function formatChineseWeekday(isoDate: string | null | undefined): string | null {
  if (!hasText(isoDate)) return null;
  try {
    const [y, m, d] = isoDate!.split('-').map(Number);
    if (!y || !m || !d) return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    return WEEKDAYS[date.getUTCDay()];
  } catch {
    harnessLog('warn', `Failed to parse current date for weekday: ${isoDate}`);
    return null;
  }
}

function formatBoolean(value: boolean | null | undefined): string {
  if (value == null) return '未知';
  return value ? '是' : '否';
}

function formatValue(value: string | null | undefined): string {
  return hasText(value) ? value! : '未知';
}
