import type { CliConfig } from '../args';
import { normalizeBaseUrl } from '../args';
import { rememberLastSession, resolveConfig, type ResolvedConfig } from '../config/config-store';
import type { RestClient } from '../rest/rest-client';
import type { CreateSessionRequest, SessionVO } from '../rest/types';
import { WsClient } from '../ws/ws-client';
import { SessionRunner, exitCodeFor, pickLatestSession, resolveAgent, resolveModelId, summarizeMessages } from '../session/session-runner';
import { ReplRenderer } from '../render/repl-renderer';
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
  if (!(session.contextWindowTokens != null && session.contextWindowTokens > 0)) {
    try {
      const models = await rest.listActiveModels();
      contextWindowTokens = resolveContextWindowTokens(session, models, modelId);
    } catch {
      // 沿用默认 256000
    }
  }

  const replUi = new ReplRenderer({
    printMode: cfg.print,
    thinking: cfg.thinking,
    stdoutIsTty: cfg.stdoutIsTty,
    colorFlag: cfg.colorFlag,
    agentName: session.agentName,
    modelName: session.modelName,
    executionMode: session.executionMode ?? 'CLOUD',
    contextWindowTokens,
  });
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
  } else {
    renderers.push(replUi);
  }
  const renderer = new MultiRenderer(renderers);

  const localMode = session.executionMode === 'LOCAL' || (cfg.local && session.executionMode !== 'CLOUD');
  const ws = new WsClient({
    baseUrl: normalizeBaseUrl(resolved.baseUrl),
    getToken: ctx.getToken,
    localCapable: localMode,
    debug: cfg.debug ? (m, extra) => logger.debug(m, extra) : undefined,
    onConsecutiveReconnectFailures: (n) => {
      logger.warn(`WebSocket 连续重连失败 ${n} 次，请检查网络或重新 login。`);
    },
  });
  const localWorkspace = path.resolve(session.workspace || cfg.workspace || process.cwd());
  if (cfg.local && !localMode) {
    process.stderr.write(`⚠ 该会话是 ${session.executionMode ?? 'CLOUD'} 模式，忽略 --local，按会话原模式运行。\n`);
  }
  if (localMode) {
    await ensureWorkspaceTrusted(localWorkspace, cfg.stdoutIsTty && !cfg.print);
    replUi.setMeta({ executionMode: 'LOCAL' });
  }

  let localExecutor: LocalExecutor | undefined;
  const runnerHolder: { current?: SessionRunner } = {};
  if (localMode) {
    const policy: ApprovalPolicy = {
      yolo: cfg.yolo,
      force: cfg.force,
      onApproval: cfg.onApproval,
      approveRules: cfg.approveRules,
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
      ? async (_id, questions) => askQuestionsInTty(questions)
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
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  try {
    await runner.attach(session);

    if (!cfg.print && (cfg.replayFull || cfg.resumeSessionId || cfg.continueLast || cfg.command === 'resume')) {
      await replayHistory(rest, session.id!, cfg.replayFull, renderer);
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

    await runRepl({
      runner,
      renderer: replUi,
      modelId,
      resolveModel: async (spec) => {
        const id = await resolveModelId(rest, spec);
        if (id == null) throw new CliError(`找不到模型 ${spec}`);
        try {
          const models = await rest.listActiveModels();
          const found = models.find((m) => Number(m.id) === Number(id));
          replUi.setMeta({
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
    });
    return 0;
  } finally {
    process.off('SIGINT', onSig);
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
    if (!latest) throw new CliError('没有可恢复的 ACTIVE 会话');
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
    if (!latest) throw new CliError('没有可继续的会话');
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
  const name = session.agentName || agent.name || 'Agent';
  const model = session.modelName || String(session.modelId ?? '');
  const mode = local ? 'LOCAL' : 'CLOUD';
  if (!cfg.print) {
    process.stderr.write(`✔ 新建会话 #${session.id}（Agent: ${name} · Model: ${model} · ${mode}${local ? ` · ${workspace}` : ''}）\n`);
  }
  return session;
}

async function ensureWorkspaceTrusted(workspace: string, canPrompt: boolean): Promise<void> {
  if (!workspaceExists(workspace)) {
    throw new CliError(`LOCAL 工作区不存在或不是目录: ${workspace}`);
  }
  if (isWorkspaceTrusted(workspace)) return;
  if (!canPrompt) {
    throw new CliError(
      `工作区未信任: ${workspace}。请先在交互终端运行 mao-agent --local，或把该路径写入 ~/.mao/agent-cli/config.json 的 trustedWorkspaces。`,
      EXIT.APPROVAL,
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`此工作区尚未信任:\n  ${workspace}\n允许本机 Agent 在该目录执行 shell / 写文件？[y/N] `, resolve);
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

async function replayHistory(rest: RestClient, sessionId: number, full: boolean, _renderer: Renderer): Promise<void> {
  const page = await rest.listMessages(sessionId, { roundLimit: full ? 50 : 3 });
  const lines = summarizeMessages(page.messages ?? [], full);
  if (lines.length === 0) return;
  process.stderr.write('── 历史摘要 ──\n');
  for (const line of lines) process.stderr.write(line + '\n');
  process.stderr.write('──────────────\n');
}
