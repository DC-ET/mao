import type { CliConfig } from '../args';
import { normalizeBaseUrl } from '../args';
import { rememberLastSession, resolveConfig, type ResolvedConfig } from '../config/config-store';
import type { RestClient } from '../rest/rest-client';
import type { CreateSessionRequest, SessionVO } from '../rest/types';
import { WsClient } from '../ws/ws-client';
import { SessionRunner, exitCodeFor, pickLatestSession, resolveAgent, resolveModelId } from '../session/session-runner';
import { TextRenderer } from '../render/text-renderer';
import { JsonRenderer } from '../render/json-renderer';
import type { Renderer, RunResult } from '../render/types';
import { askQuestionsInTty, runRepl } from '../repl/repl';
import { CliError, EXIT } from '../util/exit-codes';
import { resolveContextWindowTokens } from '../util/context';
import { appendTrace } from '../config/config-store';
import type { CliEvent } from '../render/types';
import type { Logger } from '../util/logger';
import path from 'node:path';
import readline from 'node:readline';
import { LocalExecutor } from '../local/executor';
import { addTrustedWorkspace, isWorkspaceTrusted, workspaceExists } from '../local/trust';
import { collectLocalUnsyncedSkills, readAgentsMd } from '../local/local-skills';
import { buildOsVersion, detectShell, isGitWorkspace } from '../local/paths';
import type { ApprovalPolicy } from '../local/approval';
import { formatHistorySummary, formatSessionBanner, formatWelcomeHints } from '../ui/welcome';
import { InkTuiRenderer } from '../tui/ink-renderer';

export interface ChatContext {
  rest: RestClient;
  cfg: CliConfig;
  resolved: ResolvedConfig;
  getToken: () => Promise<string | null>;
  logger: Logger;
}

class MultiRenderer implements Renderer {
  constructor(private readonly inner: Renderer[]) {}
  onEvent(evt: CliEvent): void {
    for (const r of this.inner) r.onEvent(evt);
  }
  finish(result: RunResult): void {
    for (const r of this.inner) r.finish?.(result);
  }
  clearTransient(): void {
    for (const r of this.inner) r.clearTransient?.();
  }
}

class TraceRenderer implements Renderer {
  constructor(private readonly file: string) {}
  onEvent(evt: CliEvent): void {
    appendTrace(this.file, { ts: new Date().toISOString(), ...evt });
  }
  finish(result: RunResult): void {
    appendTrace(this.file, { ts: new Date().toISOString(), ...result });
  }
}

export async function cmdChat(ctx: ChatContext): Promise<number> {
  const { rest, cfg, resolved, logger } = ctx;
  const session = await resolveTargetSession(ctx);
  rememberLastSession(session.id!);

  const modelId = await resolveModelId(rest, cfg.model, resolved.defaultModelId);
  let contextWindowTokens = resolveContextWindowTokens(session, undefined, modelId);
  let modelNames: string[] = [];
  try {
    const models = await rest.listActiveModels();
    modelNames = models.flatMap((m) => [m.name, m.modelId].filter((n): n is string => Boolean(n)));
    if (!(session.contextWindowTokens != null && session.contextWindowTokens > 0)) {
      contextWindowTokens = resolveContextWindowTokens(session, models, modelId);
    }
  } catch {
    // 沿用默认窗口；Tab 补全没有模型名
  }

  let localExecutor: LocalExecutor | undefined;
  let inkRenderer: InkTuiRenderer | undefined;
  const runnerHolder: { current?: SessionRunner } = {};
  const tuiHolder: { ink?: InkTuiRenderer } = {};
  const tuiHandleHolder: { handle?: import('../tui/types').InkTuiHandle } = {};

  const localMode = session.executionMode === 'LOCAL' || (cfg.local && session.executionMode !== 'CLOUD');
  const ws = new WsClient({
    baseUrl: normalizeBaseUrl(resolved.baseUrl),
    getToken: ctx.getToken,
    localCapable: localMode,
    debug: cfg.debug ? (m, extra) => logger.debug(m, extra) : undefined,
    onConsecutiveReconnectFailures: (n) => {
      logger.warn(`连不上服务器（已重试 ${n} 次）。检查网络，或 mao-agent login 后重试。`);
    },
  });
  const localWorkspace = path.resolve(session.workspace || cfg.workspace || process.cwd());
  if (cfg.local && !localMode) {
    process.stderr.write(`⚠ 该会话是 ${session.executionMode ?? 'CLOUD'} 模式，忽略 --local，按会话原模式运行。\n`);
  }
  if (localMode) {
    await ensureWorkspaceTrusted(localWorkspace, cfg.stdoutIsTty && !cfg.print);
  }

  // 事件渲染链：trace（可选）+ 打印模式 renderer；交互模式会在 attach 前追加 inkRenderer
  const renderers: Renderer[] = [];
  if (cfg.traceFile) renderers.push(new TraceRenderer(cfg.traceFile));
  if (cfg.print) {
    if (cfg.outputFormat === 'text') renderers.push(new TextRenderer());
    else {
      renderers.push(new JsonRenderer({
        stream: cfg.outputFormat === 'stream-json',
        streamPartial: cfg.streamPartialOutput,
        includeToolIo: cfg.includeToolIo,
        stderr: (s) => process.stderr.write(s),
      }));
    }
  }
  const renderer = new MultiRenderer(renderers);

  if (localMode) {
    const policy: ApprovalPolicy = {
      yolo: cfg.yolo,
      force: cfg.force,
      onApproval: cfg.onApproval,
      approveRules: [...cfg.approveRules],
      strictDangerCheck: cfg.strictDangerCheck,
      iKnowWhatImDoing: cfg.iKnowWhatImDoing,
      stdoutIsTty: cfg.stdoutIsTty,
    };
    localExecutor = new LocalExecutor({
      ws,
      getToken: ctx.getToken,
      baseUrl: normalizeBaseUrl(resolved.baseUrl),
      workspace: localWorkspace,
      policy,
      askApproval: cfg.onApproval === 'ask' && cfg.stdoutIsTty
        ? async (req, reason) => {
            if (!cfg.print && tuiHolder.ink) {
              // 交互模式：通过 Ink approval modal 收集选择
              return tuiHolder.ink.requestApproval(req, reason);
            }
            // 打印模式 / 无 Ink：退化为 readline
            return (await fallbackAskApproval(req, reason)) ? 'allow' : 'deny';
          }
        : undefined,
      onApprovalDenied: () => runnerHolder.current?.markApprovalDenied(),
    });
  }

  const runner = new SessionRunner({
    rest,
    ws,
    renderer,
    printMode: cfg.print,
    ifRunning: cfg.ifRunning,
    onQuestion: cfg.onQuestion,
    askHandler: cfg.onQuestion === 'ask' && cfg.stdoutIsTty
      ? async (requestId, questions) => {
          if (!cfg.print && tuiHolder.ink) {
            // 交互模式：ask_user_questions 事件由 InkTuiRenderer 弹出 modal，
            // 通过 setAskResolver 注册的 resolver 等待用户回答。
            return new Promise<import('../ws/event-types').AskAnswer[] | 'fail' | 'cancelled'>((resolve) => {
              tuiHolder.ink!.setAskResolver(requestId, resolve);
            });
          }
          // 打印模式 / 无 Ink：退化到 readline 逐题提问
          return askQuestionsInTty(questions);
        }
      : undefined,
    maxDurationSec: cfg.maxDurationSec,
    includeToolIo: cfg.includeToolIo,
    localExecutor,
    localExtras: localMode
      ? () => ({
          localSkills: collectLocalUnsyncedSkills(),
          agentsMdContent: readAgentsMd(localWorkspace),
        })
      : undefined,
  });
  runnerHolder.current = runner;
  ws.setOnReconnect(() => runner.markReconnected());

  const interrupted = { value: false };
  const onSig = () => {
    interrupted.value = true;
    void runner.cancel();
    if (cfg.print) {
      setTimeout(() => process.exit(EXIT.CANCELLED), 5000);
    }
  };
  process.on('SIGTERM', onSig);
  if (cfg.print) process.on('SIGINT', onSig);

  try {
    // 交互模式：先创建并挂载 Ink renderer，确保 attach 期间（订阅会话快照 /
    // 重放 ask_user_questions）askHandler/审批回调能访问到 tuiHolder.ink。
    const resumed = Boolean(cfg.resumeSessionId || cfg.continueLast || cfg.command === 'resume');
    if (!cfg.print) {
      inkRenderer = new InkTuiRenderer({
        agentName: session.agentName,
        modelName: session.modelName,
        executionMode: localMode ? 'LOCAL' : (session.executionMode ?? 'CLOUD'),
        contextWindowTokens,
        verboseTools: resolved.ui.verboseTools,
        asciiOnly: resolved.ui.asciiOnly,
        welcomeLines: [formatSessionBanner(session, { resumed }), formatWelcomeHints()],
        historyLines: [],
        modelNames,
      });
      tuiHolder.ink = inkRenderer;
      // SessionRunner 事件 → MultiRenderer（TraceRenderer + inkRenderer），
      // 保证 --trace-file 在交互模式仍记录完整执行事件，同时 Ink 正常渲染。
      (runner as unknown as { opts: { renderer: Renderer } }).opts.renderer =
        new MultiRenderer([...renderers, inkRenderer]);
      tuiHandleHolder.handle = inkRenderer.mount();
    }

    await runner.attach(session);

    let historyLines: string[] = [];
    if (!cfg.print && (cfg.replayFull || cfg.resumeSessionId || cfg.continueLast || cfg.command === 'resume')) {
      historyLines = await loadHistory(rest, session.id!, cfg.replayFull);
      if (inkRenderer && historyLines.length > 0) {
        inkRenderer.setHistoryLines(historyLines);
      }
    }

    if (cfg.print) {
      if (!cfg.prompt) throw new CliError('打印模式需要 prompt（位置参数、-p 参数或 stdin）');
      if (runner.snapshotIsActive && cfg.ifRunning === 'fail') {
        throw new CliError('该会话仍在执行（--if-running=fail）', EXIT.GENERAL);
      }
      const result = await runner.runPrompt(cfg.prompt, modelId);
      await runner.shutdown();
      return exitCodeFor(result, {
        questionFailed: runner.questionFailed,
        timedOut: runner.timedOut,
        interrupted: interrupted.value || runner.cancelledByUser,
        approvalFailed: runner.approvalFailed,
      });
    }

    const resumed2 = Boolean(cfg.resumeSessionId || cfg.continueLast || cfg.command === 'resume');

    const tuiHandle = tuiHandleHolder.handle!;

    await runRepl({
      runner,
      renderer: inkRenderer!,
      tuiHandle,
      modelId,
      resolveModel: async (spec) => {
        const id = await resolveModelId(rest, spec);
        if (id == null) throw new CliError(`找不到模型 ${spec}`);
        try {
          const models = await rest.listActiveModels();
          const found = models.find((m) => Number(m.id) === Number(id));
          inkRenderer!.setMeta({
            modelName: found?.name || spec,
            contextWindowTokens: found?.contextWindowTokens ?? undefined,
          });
        } catch {
          // 窗口大小沿用当前值
        }
        return id;
      },
      onExit: async () => {
        await runner.shutdown();
      },
      firstPrompt: cfg.prompt || undefined,
      queuedInput: resolved.ui.queuedInput,
      asciiOnly: resolved.ui.asciiOnly,
      welcomeLines: [formatSessionBanner(session, { resumed: resumed2 }), formatWelcomeHints()],
      historyLines,
      modelNames,
    });
    return 0;
  } finally {
    if (cfg.print) process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

export async function cmdResume(ctx: ChatContext): Promise<number> {
  return cmdChat(ctx);
}

async function resolveTargetSession(ctx: ChatContext): Promise<SessionVO> {
  const { rest, cfg, resolved } = ctx;
  if (cfg.resumeSessionId && cfg.resumeSessionId !== 'latest') {
    return rest.getSession(cfg.resumeSessionId);
  }
  if (cfg.resumeSessionId === 'latest' || cfg.command === 'resume') {
    const list = await rest.listSessions({ status: 'ACTIVE' });
    const latest = pickLatestSession(list);
    if (!latest) throw new CliError('没有可恢复的会话。直接运行 mao-agent 新建一个。');
    return latest;
  }
  if (cfg.continueLast) {
    if (resolved.lastSessionId) {
      try {
        return await rest.getSession(resolved.lastSessionId);
      } catch {
        // fall through
      }
    }
    const list = await rest.listSessions({ status: 'ACTIVE' });
    const latest = pickLatestSession(list);
    if (!latest) throw new CliError('没有可继续的会话。直接运行 mao-agent 新建一个。');
    return latest;
  }

  const agent = await resolveAgent(rest, cfg.agent, resolved.defaultAgentId);
  const modelId = await resolveModelId(rest, cfg.model, resolved.defaultModelId);
  const local = cfg.local;
  const workspace = local ? path.resolve(cfg.workspace || process.cwd()) : cfg.workspace;
  const req: CreateSessionRequest = {
    agentId: agent.id,
    executionMode: local ? 'LOCAL' : 'CLOUD',
    permissionLevel: cfg.permissionLevel || resolved.permissionLevel,
  };
  if (modelId != null) req.modelId = modelId;
  if (workspace) req.workspace = workspace;
  if (!local && cfg.cloudProject) req.cloudProjectKey = cfg.cloudProject;
  if (!local && cfg.gitClone) {
    req.workspaceMode = 'git';
    req.gitCloneUrl = cfg.gitClone;
    if (cfg.gitBranch) req.gitBranch = cfg.gitBranch;
  }
  if (local) {
    req.platform = process.platform;
    req.shell = detectShell();
    req.osVersion = buildOsVersion();
    req.isGit = isGitWorkspace(workspace);
  }
  const session = await rest.createSession(req);
  return session;
}

async function ensureWorkspaceTrusted(workspace: string, canPrompt: boolean): Promise<void> {
  if (!workspaceExists(workspace)) {
    throw new CliError(`LOCAL 工作区不存在或不是目录: ${workspace}`);
  }
  if (isWorkspaceTrusted(workspace)) return;
  if (!canPrompt) {
    throw new CliError(
      `已拦截：工作区未信任\n  目录: ${workspace}\n  下一步: 先在交互终端运行 mao-agent --local 并输入 y，或把该路径写入 ~/.mao/agent-cli/config.json 的 trustedWorkspaces。`,
      EXIT.APPROVAL,
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `此工作区尚未信任:\n  ${workspace}\n允许本机 Agent 在该目录执行命令与写文件？[y/N] `,
        resolve,
      );
    });
    if (!/^\s*y(es)?\s*$/i.test(answer)) {
      throw new CliError('已拒绝信任该工作区', EXIT.APPROVAL);
    }
    addTrustedWorkspace(workspace);
    process.stderr.write(`✔ 已信任 ${workspace}\n`);
  } finally {
    rl.close();
  }
}

async function loadHistory(rest: RestClient, sessionId: number, full: boolean): Promise<string[]> {
  const page = await rest.listMessages(sessionId, { roundLimit: full ? 50 : 3 });
  return formatHistorySummary(page.messages ?? [], full);
}

async function fallbackAskApproval(req: { toolName: string; description: string }, reason: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${reason}\n⚠ 需要批准 · ${req.toolName}\n  ${req.description}\n[y] 允许  [n] 拒绝\n> `, resolve);
    });
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}
