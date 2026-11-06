import type { CliConfig } from '../args';
import { rememberLastSession, resolveConfig, type ResolvedConfig } from '../config/config-store';
import type { RestClient } from '../rest/rest-client';
import type { CreateSessionRequest, SafeModelVO, SessionVO } from '../rest/types';
import { WsClient } from '../ws/ws-client';
import { SessionRunner, exitCodeFor, pickLatestSession, resolveAgent, resolveModelId } from '../session/session-runner';
import { filterSwitchableSessions, isLocalWorkspaceAllowed } from '../session/session-filter';
import { isRunningPhase } from '../ws/event-filter';
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
import { resolveDeviceIdentity } from '../local/device-identity';
import type { ApprovalPolicy } from '../local/approval';
import { formatHistorySummary, formatSessionBanner, formatWelcomeHints } from '../ui/welcome';
import type { InkTuiRenderer } from '../tui/ink-renderer';
import type { TuiHandle } from '../tui/types';

export interface ChatContext {
  rest: RestClient;
  cfg: CliConfig;
  resolved: ResolvedConfig;
  /** 最终生效的站点地址（main 已保证非空并归一化）。 */
  baseUrl: string;
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
  const { rest, cfg, resolved, baseUrl, logger } = ctx;
  // 交互 REPL 的新建会话延迟到第一条消息再落库：只打开看看/直接退出不应留下空白会话。
  const target = await resolveSessionTarget(ctx, { deferCreate: !cfg.print });
  const session: SessionVO = target.kind === 'existing' ? target.session : target.draft;
  if (target.kind === 'existing') rememberLastSession(session.id!);

  let modelId = await resolveModelId(rest, cfg.model, resolved.defaultModelId);
  let contextWindowTokens = resolveContextWindowTokens(session, undefined, modelId);
  let modelNames: string[] = [];
  let modelsCache: SafeModelVO[] = [];
  try {
    modelsCache = await rest.listActiveModels();
    // 只放显示名：同一厂商串常对应多条配置，混进补全会让用户选到无法唯一定位的候选。
    // 同时 trim，库里有带尾随空格的显示名，补全填进去会与解析侧的归一化不一致。
    modelNames = [...new Set(modelsCache.map((m) => (m.name ?? '').trim()).filter((n) => n !== ''))];
    if (!(session.contextWindowTokens != null && session.contextWindowTokens > 0)) {
      contextWindowTokens = resolveContextWindowTokens(session, modelsCache, modelId);
    }
    // 延迟创建的草稿只有 modelId：补上显示名，banner / 状态栏与真实会话一致。
    if (session.modelName == null && session.modelId != null) {
      const found = modelsCache.find((m) => Number(m.id) === Number(session.modelId));
      if (found?.name) session.modelName = found.name;
    }
  } catch {
    // 沿用默认窗口；Tab 补全没有模型名
  }

  let localExecutor: LocalExecutor | undefined;
  let inkRenderer: InkTuiRenderer | undefined;
  const runnerHolder: { current?: SessionRunner } = {};
  const tuiHolder: { ink?: InkTuiRenderer } = {};
  const tuiHandleHolder: { handle?: TuiHandle } = {};

  const localMode = session.executionMode === 'LOCAL' || (cfg.local && session.executionMode !== 'CLOUD');
  const localWorkspace = path.resolve(session.workspace || cfg.workspace || process.cwd());
  const ws = new WsClient({
    baseUrl,
    getToken: ctx.getToken,
    debug: cfg.debug ? (m, extra) => logger.debug(m, extra) : undefined,
    onConsecutiveReconnectFailures: (n) => {
      logger.warn(`连不上服务器（已重试 ${n} 次）。检查网络，或 mao-agent login 后重试。`);
    },
  });
  if (cfg.local && !localMode) {
    process.stderr.write(`⚠ 该会话是 ${session.executionMode ?? 'CLOUD'} 模式，忽略 --local，按会话原模式运行。\n`);
  }
  if (localMode) {
    await ensureWorkspaceTrusted(localWorkspace, cfg.stdoutIsTty && cfg.stdinIsTty && !cfg.print);
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
      stdinIsTty: cfg.stdinIsTty,
    };
    localExecutor = new LocalExecutor({
      ws,
      getToken: ctx.getToken,
      baseUrl,
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
      // 多端审批：本地按键后由 TUI 交出选择，executor 负责上行投票并等回声；收尾关模态也走这里
      deliverApproval: (requestId, choice) => {
        tuiHolder.ink?.deliverApproval(requestId, choice);
      },
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
    // 多端审批能力位：只跟本次连接（旧后端不带 approvalRelay → false，投票后立即本地放行）
    onApprovalRelaySupported: (supported) => {
      localExecutor?.setApprovalRelaySupported(supported);
    },
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
      // 交互模式才加载 TUI：它会拉起 React + Ink，打印模式与子命令不必付这笔启动成本
      const { InkTuiRenderer } = await import('../tui/ink-renderer');
      inkRenderer = new InkTuiRenderer({
        agentName: session.agentName,
        modelName: session.modelName,
        executionMode: localMode ? 'LOCAL' : (session.executionMode ?? 'CLOUD'),
        contextWindowTokens,
        verboseTools: resolved.ui.verboseTools,
        asciiOnly: resolved.ui.asciiOnly,
        showTurnDividers: resolved.ui.showTurnDividers,
        colorFlag: cfg.colorFlag,
        thinking: cfg.thinking,
        welcomeLines: [formatSessionBanner(session, { resumed }), formatWelcomeHints()],
        modelNames,
      });
      tuiHolder.ink = inkRenderer;
      // 多端审批：审批模态的本地按键交给 executor 去上行投票（模态保持在「已提交」状态）
      inkRenderer.setApprovalSubmitHandler((requestId, choice) => {
        void localExecutor?.submitApprovalVote(requestId, choice);
      });
      // SessionRunner 事件 → MultiRenderer（TraceRenderer + inkRenderer），
      // 保证 --trace-file 在交互模式仍记录完整执行事件，同时 Ink 正常渲染。
      runner.setRenderer(new MultiRenderer([...renderers, inkRenderer]));
      tuiHandleHolder.handle = inkRenderer.mount();
    }

    // 已有会话（resume/continue）与打印模式：立即挂载；新建的交互会话延迟到第一条消息（ensureSession）。
    let attached = target.kind === 'existing';
    if (attached) await runner.attach(session);

    let historyLines: string[] = [];
    if (attached && !cfg.print && (cfg.replayFull || resumed)) {
      historyLines = await loadHistory(rest, session.id!, cfg.replayFull);
    }
    inkRenderer?.seedChrome(historyLines);

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

    const tuiHandle = tuiHandleHolder.handle!;

    /**
     * 延迟创建（新建的交互会话）：第一条消息前落库并 attach。
     * 创建成功但 attach 失败时下一条消息复用同一会话重试，不会重复建会话。
     */
    let createdSession: SessionVO | undefined;
    const ensureSession = async (currentModelId?: number): Promise<void> => {
      if (attached || target.kind !== 'new') return;
      if (!createdSession) {
        // `/model` 可能在第一条消息前切换过模型：创建时以当前生效模型为准。
        createdSession = await rest.createSession(
          currentModelId != null ? { ...target.request, modelId: currentModelId } : target.request,
        );
        rememberLastSession(createdSession.id!);
      }
      await runner.attach(createdSession);
      attached = true;
      inkRenderer?.announce(`已创建会话 #${createdSession.id}`);
    };

    /** 可切换会话：拉全量活跃会话，按模式 / 工作区过滤，按最近更新排序并截断。 */
    const listSwitchableSessions = async (query?: string): Promise<SessionVO[]> => {
      const all = await rest.listSessions({ status: 'ACTIVE', keyword: query || undefined });
      return filterSwitchableSessions(all, {
        currentId: runner.getSession()?.id,
        localMode,
        localWorkspace,
      });
    };

    /**
     * 切换到已有会话（供 REPL `/resume` 调用）：只换会话、不关进程。
     * 任一步失败都保持当前会话不变（runner.switchTo 内部负责回挂）。
     */
    const switchSession = async (id: number): Promise<SessionVO> => {
      // 1. 本进程忙 → 拒绝（REPL 层已先拦一道，这里兜底）
      if (runner.isRunning()) {
        throw new CliError('当前任务仍在执行：等它结束或 /cancel 后再切换会话。');
      }
      // 2. 目标 = 当前会话
      if (runner.getSession()?.id === id) {
        throw new CliError(`已经是当前会话 #${id}`);
      }
      // 3. 取会话（不存在 / 非本人 → 后端 3002）
      const next = await rest.getSession(id);

      // 4. 模式必须一致：LOCAL 进程只能切 LOCAL 会话，反之亦然
      const nextLocal = next.executionMode === 'LOCAL';
      if (nextLocal !== localMode) {
        throw new CliError(
          `无法切换：该会话是 ${next.executionMode ?? 'CLOUD'} 模式，当前进程是 ${localMode ? 'LOCAL' : 'CLOUD'} 模式。\n` +
            `请退出后用 mao-agent resume ${id} 打开。`,
        );
      }

      // 5. LOCAL 会话的 workspace 必须落在启动工作区内（与本地执行器信任边界一致）
      if (nextLocal && !isLocalWorkspaceAllowed(next.workspace, localWorkspace)) {
        throw new CliError(
          `无法切换：该会话的本地工作区是 ${next.workspace ?? '(空)'}，不在当前工作区 ${localWorkspace} 内。\n` +
            `请退出后用 mao-agent resume ${id} 打开。`,
        );
      }

      // 6. --if-running=fail 时尊重显式选择（默认 wait：切进去续接输出）
      if (cfg.ifRunning === 'fail' && (next.running || isRunningPhase(next.phase))) {
        throw new CliError(`该会话仍在执行（--if-running=fail）：#${id}`);
      }

      // 7. 真正切换（旧会话退订 + 标记已读；失败回挂）
      try {
        await runner.switchTo(next);
      } catch (err) {
        // 回挂也失败时 runner 已解除挂载：回到「未挂载」状态，避免后续消息发往无效会话。
        if (!runner.getSession()) attached = false;
        throw err;
      }
      attached = true;
      createdSession = undefined;

      // 8. 会话级外部状态同步
      rememberLastSession(id);
      modelId = next.modelId ?? modelId;
      contextWindowTokens = resolveContextWindowTokens(next, modelsCache, modelId);
      inkRenderer?.setMeta({
        agentName: next.agentName,
        modelName: next.modelName,
        executionMode: nextLocal ? 'LOCAL' : 'CLOUD',
        contextWindowTokens,
      });
      // footer 的 Todo / 上下文占用与 /copy 的上一回合文本都属于旧会话，必须复位。
      inkRenderer?.resetSessionMetrics();

      // 9. 留痕输出：分隔行 + 最近 3 轮摘要（摘要失败不影响切换结果）
      const recent = await loadHistory(rest, id, false).catch(() => [] as string[]);
      inkRenderer?.print(
        `── 已切换到会话 #${id}${next.title ? ` · ${next.title}` : ''} ──` +
          (recent.length > 0 ? `\n${recent.join('\n')}` : ''),
      );

      return next;
    };

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
      ensureSession,
      listSwitchableSessions,
      switchSession,
      pickSession: (items) =>
        inkRenderer!.pickSession(
          items.map((s) => ({
            id: s.id!,
            title: s.title,
            agentName: s.agentName,
            updatedAt: s.updatedAt,
            running: s.running,
            unread: s.unread,
          })),
        ),
      firstPrompt: cfg.prompt || undefined,
      queuedInput: resolved.ui.queuedInput,
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

/** 打开 REPL 时的目标会话：已有会话，或「延迟创建」的草稿（第一条消息前才落库）。 */
export type SessionTarget =
  | { kind: 'existing'; session: SessionVO }
  | { kind: 'new'; draft: SessionVO; request: CreateSessionRequest };

export async function resolveSessionTarget(
  ctx: ChatContext,
  opts: { deferCreate: boolean },
): Promise<SessionTarget> {
  const { rest, cfg, resolved } = ctx;
  if (cfg.resumeSessionId && cfg.resumeSessionId !== 'latest') {
    return { kind: 'existing', session: await rest.getSession(cfg.resumeSessionId) };
  }
  if (cfg.resumeSessionId === 'latest' || cfg.command === 'resume') {
    const list = await rest.listSessions({ status: 'ACTIVE' });
    const latest = pickLatestSession(list);
    if (!latest) throw new CliError('没有可恢复的会话。直接运行 mao-agent 新建一个。');
    return { kind: 'existing', session: latest };
  }
  if (cfg.continueLast) {
    if (resolved.lastSessionId) {
      try {
        return { kind: 'existing', session: await rest.getSession(resolved.lastSessionId) };
      } catch {
        // fall through
      }
    }
    const list = await rest.listSessions({ status: 'ACTIVE' });
    const latest = pickLatestSession(list);
    if (!latest) throw new CliError('没有可继续的会话。直接运行 mao-agent 新建一个。');
    return { kind: 'existing', session: latest };
  }

  const agent = await resolveAgent(rest, cfg.agent, resolved.defaultAgentId);
  const modelId = await resolveModelId(rest, cfg.model, resolved.defaultModelId);
  const local = cfg.local;
  const workspace = local ? path.resolve(cfg.workspace || process.cwd()) : cfg.workspace;
  const request: CreateSessionRequest = {
    agentId: agent.id,
    executionMode: local ? 'LOCAL' : 'CLOUD',
    permissionLevel: cfg.permissionLevel || resolved.permissionLevel,
    // 终端 CLI 固定自报来源 'cli'：admin「来源」列可筛出 CLI 会话（技术方案 D11）。
    source: 'cli',
  };
  if (modelId != null) request.modelId = modelId;
  if (workspace) request.workspace = workspace;
  if (!local && cfg.cloudProject) request.cloudProjectKey = cfg.cloudProject;
  if (!local && cfg.gitClone) {
    request.workspaceMode = 'git';
    request.gitCloneUrl = cfg.gitClone;
    if (cfg.gitBranch) request.gitBranch = cfg.gitBranch;
  }
  if (local) {
    request.platform = process.platform;
    request.shell = detectShell();
    request.osVersion = buildOsVersion();
    request.isGit = isGitWorkspace(workspace);
    // LOCAL 创建即绑定本机执行端（技术方案 2026-11-05 D5）：CLI 进程与 WS 连接同源设备。
    const device = resolveDeviceIdentity();
    request.targetDeviceId = device.id;
    request.targetDeviceName = device.name;
  }
  if (opts.deferCreate) {
    // 交互新建：先给草稿（banner / 状态栏据此展示），第一条消息前才真正落库。
    const draft: SessionVO = {
      agentId: agent.id,
      agentName: agent.name,
      modelId: modelId ?? undefined,
      executionMode: request.executionMode,
      workspace: request.workspace ?? null,
      permissionLevel: request.permissionLevel,
    };
    return { kind: 'new', draft, request };
  }
  return { kind: 'existing', session: await rest.createSession(request) };
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
