import type { AskAnswer, AskQuestion } from '../ws/event-types';
import type { SessionRunner } from '../session/session-runner';
import type { SessionVO } from '../rest/types';
import type { InkTuiRenderer } from '../tui/ink-renderer';
import type { TuiHandle } from '../tui/types';
import { PromptQueue } from '../ui/prompt-queue';
import { formatContextPercent } from '../util/context';
import { copyToClipboard } from '../ui/clipboard';
import { findSlashItem, formatSlashHelp, SLASH_COMMANDS } from '../ui/slash-complete';

export interface ReplOptions {
  runner: SessionRunner;
  renderer: InkTuiRenderer;
  tuiHandle: TuiHandle;
  modelId?: number;
  resolveModel: (spec: string) => Promise<number>;
  onExit: () => Promise<void>;
  /**
   * 延迟创建的新会话：每条消息执行前调用（幂等）。
   * currentModelId 为当前生效模型（`/model` 可能已切换），创建时据此写库。
   * 恢复既有会话/打印模式不传——此时会话在进入 REPL 前已就绪。
   */
  ensureSession?: (currentModelId?: number) => Promise<void>;
  /** 可切换会话列表（已按模式/工作区过滤、按最近排序、已截断）。query 为空取最近。 */
  listSwitchableSessions?: (query?: string) => Promise<SessionVO[]>;
  /** 切换会话（chat.ts 内完成守卫、重挂与状态刷新）。失败抛 CliError。 */
  switchSession?: (id: number) => Promise<SessionVO>;
  /** 会话选择面板；缺省时 /resume 打印列表并提示 /resume <id>（非 TUI / 单测场景）。 */
  pickSession?: (items: SessionVO[]) => Promise<number | null>;
  firstPrompt?: string;
  queuedInput?: boolean;
  onInputReady?: () => void;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const queuedInput = opts.queuedInput !== false;
  let closing = false;
  let draining = false;
  let lastSigint = 0;
  let cancelHint: ReturnType<typeof setTimeout> | null = null;
  let resolveClosed: (() => void) | null = null;
  const queue = new PromptQueue();

  /** 转瞬提示（不进对话记录）。 */
  const hint = (s: string) => opts.renderer.announce(s);
  /** 需要留痕的输出（命令结果、错误）。 */
  const print = (s: string, tone: 'dim' | 'err' | 'ok' | 'warn' | 'info' = 'dim') => opts.renderer.print(s, tone);

  const clearCancelHint = () => {
    if (cancelHint) {
      clearTimeout(cancelHint);
      cancelHint = null;
    }
  };

  const armCancelHint = () => {
    clearCancelHint();
    cancelHint = setTimeout(() => {
      if (opts.runner.isRunning()) {
        hint('仍在收尾，可再等或再次 Ctrl+C 退出进程。');
      }
    }, 8000);
  };

  const requestExit = async () => {
    if (closing) return;
    closing = true;
    clearCancelHint();
    await opts.onExit();
    opts.tuiHandle.unmount();
    resolveClosed?.();
  };

  const handleCancel = () => {
    if (closing) return;
    if (opts.runner.isRunning()) {
      if (opts.runner.cancelledByUser) {
        // 已发过 cancel 且仍在收尾：再次 Ctrl+C 强制退出
        void requestExit();
        return;
      }
      queue.clear();
      void opts.runner.cancel();
      hint('已发送 cancel，等待任务结束…');
      armCancelHint();
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 2000) {
      void requestExit();
      return;
    }
    lastSigint = now;
    hint('再次 Ctrl+C 退出，或输入 /exit。');
  };

  const runOne = async (text: string) => {
    draining = true;
    opts.renderer.clearTransient();
    opts.renderer.noteUser(text);
    opts.renderer.startRound();
    try {
      await opts.ensureSession?.(opts.modelId);
      await opts.runner.runPrompt(text, opts.modelId);
    } catch (err) {
      print(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      clearCancelHint();
      draining = false;
    }
  };

  /**
   * 公共排水：消费排队输入。runOne 之后与 resumeActiveRun 之后共用。
   * 行为与原先 handleSubmit 尾部的 while 循环逐字一致（斜杠命令就地处理、遇 exit 收尾）。
   */
  const drainQueuedPrompts = async (): Promise<void> => {
    while (!closing && queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (next.startsWith('/')) {
        const handled = await handleSlash(next, opts, queue, { hint, print }, drainQueuedPrompts);
        if (handled === 'exit') {
          await requestExit();
          return;
        }
        continue;
      }
      await runOne(next);
    }
  };

  const handleSubmit = async (text: string) => {
    if (!text) return;
    if (text.startsWith('/')) {
      const handled = await handleSlash(text, opts, queue, { hint, print }, drainQueuedPrompts);
      if (handled === 'exit') await requestExit();
      return;
    }
    if (opts.runner.isRunning() || draining) {
      if (!queuedInput) {
        hint('上一条还在跑。请等待结束或 /cancel。');
        return;
      }
      const n = queue.push(text);
      hint(`已排队（第 ${n} 条）。/queue 查看，Ctrl+C 清空。`);
      return;
    }
    await runOne(text);
    await drainQueuedPrompts();
  };

  opts.renderer.setInputHandlers({
    onSubmit: (text: string) => {
      void handleSubmit(text).catch((err) => {
        print(err instanceof Error ? err.message : String(err), 'err');
      });
    },
    onCancel: () => handleCancel(),
    onEscape: () => {
      if (opts.runner.isRunning()) handleCancel();
    },
    onExit: () => {
      if (!closing) void requestExit();
    },
  });

  opts.onInputReady?.();

  if (opts.firstPrompt) {
    if (opts.runner.snapshotIsActive) {
      await resumeActiveRun(opts, { hint, print }, '该会话仍在执行，先续接当前输出…');
    }
    await handleSubmit(opts.firstPrompt);
  } else if (opts.runner.snapshotIsActive) {
    await resumeActiveRun(opts, { hint, print }, '该会话仍在执行，续接当前输出。可用 /cancel 中止。');
    // resumeActiveRun 在 handleSubmit/runOne 之外 await：排队承诺（「本轮结束自动发送」）
    // 必须在这条路径也兑现，否则等待期间入队的消息永不消费。
    await drainQueuedPrompts();
  }

  // 挂住直到退出：由 requestExit 直接 resolve，不做轮询
  return new Promise<void>((resolve) => {
    if (closing) {
      resolve();
      return;
    }
    resolveClosed = resolve;
  });
}

interface SlashIo {
  hint: (s: string) => void;
  print: (s: string, tone?: 'dim' | 'err' | 'ok' | 'warn' | 'info') => void;
}

/**
 * 续接一个正在执行的会话：等当前一轮跑完（不 cancel 对方）。
 * 启动段（firstPrompt / 进入即运行中）与 `/resume` 切换后共用。
 */
async function resumeActiveRun(opts: ReplOptions, io: SlashIo, tip: string): Promise<void> {
  io.hint(tip);
  opts.renderer.startRound();
  try {
    await opts.runner.waitForCurrentRun();
  } catch (err) {
    io.print(err instanceof Error ? err.message : String(err), 'err');
  }
}

export async function handleSlash(
  text: string,
  opts: ReplOptions,
  queue: PromptQueue,
  io: SlashIo,
  /**
   * 排水回调：handleSlash 在 handleSubmit / runOne 之外 await（`/resume` 续接运行中会话），
   * 排队承诺（「本轮结束自动发送」）必须由调用方在这条路径上兑现。
   * 直接调用（测试 / 打印模式兼容）可省略，此时不排水。
   */
  drainQueue?: () => Promise<void>,
): Promise<'exit' | void> {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  if (!findSlashItem(cmd)) {
    const near = SLASH_COMMANDS.filter((c) => c.startsWith(cmd)).slice(0, 3);
    io.print(`未知命令 /${cmd}。${near.length ? `是否想输入 ${near.map((c) => `/${c}`).join(' / ')}？` : '输入 /help 查看列表。'}`, 'warn');
    return;
  }
  switch (cmd) {
    case 'exit':
    case 'quit':
      if (opts.runner.isRunning()) await opts.runner.cancel();
      return 'exit';
    case 'help':
      io.print(formatSlashHelp());
      return;
    case 'cancel':
      if (!opts.runner.isRunning()) {
        io.hint('当前没有正在执行的任务。');
        return;
      }
      await opts.runner.cancel();
      queue.clear();
      io.hint('已发送 cancel。');
      return;
    case 'clear':
      opts.tuiHandle.clearAll();
      return;
    case 'verbose': {
      const next = !opts.renderer.getVerboseTools();
      opts.renderer.setVerboseTools(next);
      io.hint(next ? '已打开工具详细输出。' : '已折叠工具输出。');
      return;
    }
    case 'thinking': {
      const next = !opts.renderer.getThinking();
      opts.renderer.setThinking(next);
      io.hint(next ? '已展开思考内容。' : '已折叠思考内容。');
      return;
    }
    case 'queue': {
      if (arg === 'clear') {
        queue.clear();
        io.hint('已清空队列。');
        return;
      }
      if (arg) {
        io.print(`/queue 只支持 clear，收到: ${arg}`, 'warn');
        return;
      }
      const items = queue.list();
      if (items.length === 0) {
        io.hint('(队列为空)');
        return;
      }
      io.print(items.map((q, i) => `${i + 1}. ${q}`).join('\n'));
      return;
    }
    case 'copy': {
      const copyText = opts.renderer.getLastAssistantText().trim();
      if (!copyText) {
        io.hint('没有可复制的回复。');
        return;
      }
      const ok = await copyToClipboard(copyText);
      if (ok) io.hint('已复制上一回合回复。');
      else io.print(`本机没有剪贴板命令（pbcopy / wl-copy / xclip），上一回合回复如下：\n${copyText}`);
      return;
    }
    case 'agent':
      io.print('换 Agent 请新开进程: mao-agent --agent <id|name>\n当前进程只绑定一个会话。');
      return;
    case 'todo': {
      const todos = opts.runner.getTodos();
      if (todos.length === 0) {
        io.hint('(暂无 Todo)');
        return;
      }
      io.print(todos.map((t) => `- [${t.status ?? ' '}] ${t.content ?? ''}`).join('\n'));
      return;
    }
    case 'context': {
      const ctx = opts.runner.getContext();
      const s = opts.runner.getSession();
      const pct = formatContextPercent(ctx.estimated, ctx.actual, s?.contextWindowTokens ?? undefined);
      const tip = pct && Number.parseInt(pct, 10) >= 80 ? '  接近上限时可新开会话。' : '';
      io.print(
        `context_window estimated=${ctx.estimated ?? '-'} actual=${ctx.actual ?? '-'}` +
          (pct ? ` (${pct})` : '') +
          tip,
      );
      return;
    }
    case 'session': {
      const s = opts.runner.getSession();
      if (!s) {
        io.print('尚未创建会话：发送第一条消息时创建。\n换会话: /resume（本进程内切换） | mao-agent resume <id>');
        return;
      }
      io.print(
        `sessionId=${s?.id ?? '-'}  agent=${s?.agentName ?? s?.agentId ?? '-'}  model=${s?.modelName ?? s?.modelId ?? '-'}` +
          `  workspace=${s?.workspace ?? '-'}  phase=${s?.phase ?? '-'}\n` +
          '换会话: /resume（本进程内切换） | mao-agent resume <id>',
      );
      return;
    }
    case 'resume': {
      if (!opts.switchSession || !opts.listSwitchableSessions) {
        io.print('当前模式不支持在本进程内切换会话。', 'warn');
        return;
      }
      if (opts.runner.isRunning()) {
        io.hint('当前任务还在执行：等它结束或 /cancel 后再切换。');
        return;
      }

      const byId = /^\d+$/.test(arg);
      const items = byId ? [] : await opts.listSwitchableSessions(arg || undefined);
      let targetId: number | null = byId ? Number(arg) : null;

      if (!byId) {
        if (items.length === 1) {
          targetId = items[0].id!; // 关键词命中 1 条：直接切换
        } else if (items.length > 1) {
          if (!opts.pickSession) {
            io.print(
              items
                .map((s) => `  #${s.id}  ${(s.title ?? '未命名会话').slice(0, 40)}  ${s.agentName ?? ''}`)
                .join('\n'),
            );
            io.hint('用 /resume <id> 切换到指定会话。');
            return;
          }
          targetId = await opts.pickSession(items);
        }
      }

      if (targetId == null) {
        if (!byId && items.length === 0) {
          io.print(
            arg
              ? `没有匹配「${arg}」的会话（按标题匹配）。`
              : '没有可切换的会话。会话需与当前进程模式一致；LOCAL 还要求工作区在启动目录内。',
          );
        } else {
          io.hint('已取消。');
        }
        return;
      }

      try {
        const switched = await opts.switchSession(targetId);
        // 下一条消息必须带新会话的模型，否则会把新会话模型改回旧值。
        opts.modelId = switched.modelId ?? opts.modelId;
        io.hint(`已切换到会话 #${switched.id}${switched.title ? ` · ${switched.title}` : ''}`);
        if (opts.runner.snapshotIsActive) {
          await resumeActiveRun(opts, io, '该会话仍在执行，续接当前输出。可用 /cancel 中止。');
          // 切换发生在 handleSubmit 的斜杠分支里，续接结束后不会回到 runOne 的排水循环，
          // 由 drainQueue 兜底消费等待期间入队的消息。
          await drainQueue?.();
        }
      } catch (err) {
        io.print(err instanceof Error ? err.message : String(err), 'err');
      }
      return;
    }
    case 'model': {
      if (!arg) {
        const s = opts.runner.getSession();
        // 延迟创建的新会话：第二条消息前尚无服务端会话，回退到已选择的模型。
        const current = s?.modelName ?? s?.modelId ?? (opts.modelId != null ? `id=${opts.modelId}` : '-');
        io.print(`当前模型: ${current}`);
        return;
      }
      try {
        const id = await opts.resolveModel(arg);
        opts.modelId = id;
        io.hint(`下一条消息将切换到模型 id=${id}（会持久写库）。`);
      } catch (err) {
        io.print(err instanceof Error ? err.message : String(err), 'err');
      }
      return;
    }
    default:
      io.print(`/${cmd} 暂未实现。`, 'warn');
  }
}

/** No-interactive fallback for ask_user_questions (print mode). */export async function askQuestionsInTty(questions: AskQuestion[]): Promise<AskAnswer[]> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const question = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
  const answers: AskAnswer[] = [];
  try {
    for (const q of questions) {
      process.stderr.write(`\n? ${q.question}\n`);
      (q.options ?? []).forEach((opt, i) => {
        process.stderr.write(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}\n`);
      });
      process.stderr.write(q.multiSelect ? '请输入序号（逗号分隔）或自定义文本: ' : '请输入序号或自定义文本: ');
      const raw = (await question('')).trim();
      // M-12：仅当 raw 是「完全由合法序号」组成的输入才走序号分支；
      // 「1 补充说明」这类混合输入整段作为自定义文本（原实现 filter 掉 NaN 后把说明静默吞掉，
      // 单选纯数字也永远按选项 label 提交，用户想自定义回答时语义相反）。
      const tokens = raw.split(/[,，\s]+/).filter((s) => s !== '');
      const allValidSeq = tokens.length > 0 && tokens.every((s) => {
        const n = Number(s);
        return Number.isInteger(n) && n >= 1 && n <= (q.options?.length ?? 0);
      });
      const selectedLabels: string[] = [];
      let customInput: string | undefined;
      if (allValidSeq) {
        const nums = tokens.map(Number);
        for (const n of q.multiSelect ? nums : nums.slice(0, 1)) {
          const opt = q.options?.[n - 1];
          if (opt) selectedLabels.push(opt.label);
        }
      }
      if (selectedLabels.length === 0 && raw) customInput = raw;
      const ans: AskAnswer = { question: q.question, selectedLabels };
      if (customInput) ans.customInput = customInput;
      answers.push(ans);
    }
  } finally {
    rl.close();
  }
  return answers;
}
