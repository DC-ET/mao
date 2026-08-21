import type { AskAnswer, AskQuestion } from '../ws/event-types';
import type { SessionRunner } from '../session/session-runner';
import type { InkTuiRenderer } from '../tui/ink-renderer';
import type { InkTuiHandle } from '../tui/types';
import { PromptQueue } from '../ui/prompt-queue';
import { formatContextPercent } from '../util/context';
import { copyToClipboard } from '../ui/clipboard';

export interface ReplOptions {
  runner: SessionRunner;
  renderer: InkTuiRenderer;
  tuiHandle: InkTuiHandle;
  modelId?: number;
  resolveModel: (spec: string) => Promise<number>;
  onExit: () => Promise<void>;
  firstPrompt?: string;
  queuedInput?: boolean;
  asciiOnly?: boolean;
  welcomeLines?: string[];
  historyLines?: string[];
  onInputReady?: () => void;
  modelNames?: string[];
}

const SLASH_HELP = `斜杠命令（本地拦截，不发给 Agent）:
  /cancel              中止当前执行
  /model <id|name>     切换当前会话模型（会持久写库）
  /todo                打印当前 Todo 快照
  /context             打印最近一次 context_window 用量
  /session             打印当前 sessionId、Agent、模型、workspace
  /verbose             切换工具输出详细度
  /queue               查看已排队的下一条；/queue clear 清空
  /clear               清屏（不删除服务端历史）
  /copy                复制上一回合回复到剪贴板
  /agent               如何换 Agent（需新开进程）
  /help                帮助
  /exit  /quit         退出（Ctrl+D 等效）

斜杠命令支持 Tab 补全；/model 可补全模型名。

多行输入：以 \\ 结尾续行；未闭合的 \`\`\` 代码块自动续行。
执行中可继续输入，回车后进入队列，本轮结束后自动发送。
Ctrl+C：有任务在跑时取消（并清空队列）；收尾中再按一次退出。无任务时连按两次退出。
`;

function fenceOpen(text: string): boolean {
  const matches = text.match(/```/g);
  return Boolean(matches && matches.length % 2 === 1);
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const queuedInput = opts.queuedInput !== false;
  let closing = false;
  let draining = false;
  let buffer = '';
  let lastSigint = 0;
  let cancelHint: ReturnType<typeof setTimeout> | null = null;
  const queue = new PromptQueue();

  const writeErr = (s: string) => {
    opts.renderer.announce(s);
  };

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
        writeErr('仍在收尾，可再等或再次 Ctrl+C 退出进程。');
      }
    }, 8000);
  };

  const requestExit = async () => {
    if (closing) return;
    closing = true;
    clearCancelHint();
    await opts.onExit();
    opts.tuiHandle.unmount();
  };

  const handleCancel = () => {
    if (closing) return;
    if (opts.runner.isRunning()) {
      if (opts.runner.cancelledByUser) {
        // 已发过 cancel 且仍在收尾：再次 Ctrl+C 强制退出（requestExit 内部置 closing）
        void requestExit();
        return;
      }
      queue.clear();
      void opts.runner.cancel();
      writeErr('已发送 cancel，等待任务结束…');
      armCancelHint();
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 2000) {
      void requestExit();
      return;
    }
    lastSigint = now;
    writeErr('再次 Ctrl+C 退出，或输入 /exit。');
  };

  const runOne = async (text: string) => {
    draining = true;
    opts.renderer.clearTransient();
    opts.renderer.noteUser(text);
    opts.renderer.startRound();
    try {
      await opts.runner.runPrompt(text, opts.modelId);
    } catch (err) {
      writeErr(err instanceof Error ? err.message : String(err));
    } finally {
      clearCancelHint();
      draining = false;
    }
  };

  const handleSubmit = async (raw: string) => {
    const trimmed = raw.replace(/\s+$/, '');
    if (trimmed.endsWith('\\') && !fenceOpen(buffer + trimmed.slice(0, -1))) {
      buffer += trimmed.slice(0, -1) + '\n';
      opts.tuiHandle.setContinuation(true);
      return;
    }
    buffer += (buffer ? '\n' : '') + raw;
    if (fenceOpen(buffer)) {
      opts.tuiHandle.setContinuation(true);
      return;
    }
    const text = buffer.trim();
    buffer = '';
    opts.tuiHandle.setContinuation(false);
    if (!text) {
      return;
    }
    if (text.startsWith('/')) {
      const handled = await handleSlash(text, opts, queue, writeErr);
      if (handled === 'exit') {
        await requestExit();
        return;
      }
      return;
    }
    if (opts.runner.isRunning() || draining) {
      if (!queuedInput) {
        writeErr('上一条还在跑。请等待结束或 /cancel。');
        return;
      }
      const n = queue.push(text);
      writeErr(`已排队（第 ${n} 条）。/queue 查看，Ctrl+C 清空。`);
      return;
    }
    await runOne(text);
    while (!closing && queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (next.startsWith('/')) {
        const handled = await handleSlash(next, opts, queue, writeErr);
        if (handled === 'exit') {
          await requestExit();
          return;
        }
        continue;
      }
      await runOne(next);
    }
  };

  // Wire up input callbacks to the renderer
  opts.renderer.setInputHandlers({
    onSubmit: (text: string) => {
      void handleSubmit(text).catch((err) => {
        writeErr(err instanceof Error ? err.message : String(err));
      });
    },
    onCancel: () => handleCancel(),
    onExit: () => { if (!closing) void requestExit(); },
    onAskResponse: (requestId: string, answers: AskAnswer[] | 'fail' | 'cancelled') => {
      opts.tuiHandle.setModal(null);
      // 用户 fail / 服务端 cancelled 都走 resolveAsk；cancelled 由 handleQuestions 静默收尾
      opts.renderer.resolveAsk(requestId, answers);
    },
    onApprovalResponse: (choice: 'allow' | 'deny' | 'always') => {
      // 通过 resolveApproval 关闭 modal 并 resolve requestApproval 的 Promise，
      // LocalExecutor 会继续处理 allow/deny/always。
      opts.renderer.resolveApproval(choice);
    },
  });

  opts.onInputReady?.();

  if (opts.firstPrompt) {
    if (opts.runner.snapshotIsActive) {
      writeErr('该会话仍在执行，先续接当前输出…');
      try {
        await opts.runner.waitForCurrentRun();
      } catch (err) {
        writeErr(err instanceof Error ? err.message : String(err));
      }
    }
    await handleSubmit(opts.firstPrompt);
  } else if (opts.runner.snapshotIsActive) {
    writeErr('该会话仍在执行，续接当前输出。可用 /cancel 中止。');
    try {
      await opts.runner.waitForCurrentRun();
    } catch (err) {
      writeErr(err instanceof Error ? err.message : String(err));
    }
  }

  // Keep the promise alive until closing
  return new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (closing) {
        clearInterval(check);
        resolve();
      }
    }, 200);
  });
}

async function handleSlash(
  text: string,
  opts: ReplOptions,
  queue: PromptQueue,
  writeErr: (s: string) => void,
): Promise<'exit' | void> {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case 'exit':
    case 'quit':
      if (opts.runner.isRunning()) await opts.runner.cancel();
      return 'exit';
    case 'help':
      writeErr(SLASH_HELP);
      return;
    case 'cancel':
      await opts.runner.cancel();
      queue.clear();
      writeErr('已发送 cancel。');
      return;
    case 'clear': {
      opts.tuiHandle.clearAll();
      return;
    }
    case 'verbose': {
      const next = !opts.renderer.getVerboseTools();
      opts.renderer.setVerboseTools(next);
      writeErr(next ? '已打开工具详细输出。' : '已折叠工具输出。');
      return;
    }
    case 'queue': {
      if (arg === 'clear') {
        queue.clear();
        writeErr('已清空队列。');
        return;
      }
      const items = queue.list();
      if (items.length === 0) {
        writeErr('(队列为空)');
        return;
      }
      writeErr(items.map((q, i) => `${i + 1}. ${q}`).join('\n'));
      return;
    }
    case 'copy': {
      const copyText = opts.renderer.getLastAssistantText().trim();
      if (!copyText) {
        writeErr('没有可复制的回复。');
        return;
      }
      const ok = await copyToClipboard(copyText);
      if (ok) writeErr('已复制上一回合回复。');
      else {
        writeErr('本机没有剪贴板命令（pbcopy / wl-copy / xclip），上一回合回复如下：');
        writeErr(copyText);
      }
      return;
    }
    case 'agent':
      writeErr('换 Agent 请新开进程: mao-agent --agent <id|name>\n当前进程只绑定一个会话。');
      return;
    case 'todo': {
      const todos = opts.runner.getTodos();
      if (todos.length === 0) {
        writeErr('(暂无 Todo)');
        return;
      }
      writeErr(todos.map((t) => `- [${t.status ?? ' '}] ${t.content ?? ''}`).join('\n'));
      return;
    }
    case 'context': {
      const ctx = opts.runner.getContext();
      const s = opts.runner.getSession();
      const pct = formatContextPercent(ctx.estimated, ctx.actual, s?.contextWindowTokens ?? undefined);
      const hint = pct && Number.parseInt(pct, 10) >= 80 ? '  接近上限时可新开会话。' : '';
      writeErr(
        `context_window estimated=${ctx.estimated ?? '-'} actual=${ctx.actual ?? '-'}` +
          (pct ? ` (${pct})` : '') +
          hint,
      );
      return;
    }
    case 'session': {
      const s = opts.runner.getSession();
      writeErr(
        `sessionId=${s?.id ?? '-'}  agent=${s?.agentName ?? s?.agentId ?? '-'}  model=${s?.modelName ?? s?.modelId ?? '-'}` +
          `  workspace=${s?.workspace ?? '-'}  phase=${s?.phase ?? '-'}\n` +
          '换会话: mao-agent resume | mao-agent ls',
      );
      return;
    }
    case 'model': {
      if (!arg) {
        const s = opts.runner.getSession();
        writeErr(`当前模型: ${s?.modelName ?? s?.modelId ?? '-'}`);
        return;
      }
      const id = await opts.resolveModel(arg);
      opts.modelId = id;
      writeErr(`下一条消息将切换到模型 id=${id}（会持久写库）。`);
      return;
    }
    default:
      writeErr(`未知命令 /${cmd}。输入 /help 查看列表。`);
  }
}

/** No-interactive fallback for ask_user_questions (print mode). */
export async function askQuestionsInTty(questions: AskQuestion[]): Promise<AskAnswer[]> {
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
      const nums = raw.split(/[,，\s]+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);
      const selectedLabels: string[] = [];
      let customInput: string | undefined;
      if (nums.length > 0) {
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

export { promptHidden } from '../ui/hidden-prompt';
