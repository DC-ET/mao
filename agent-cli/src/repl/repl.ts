import type { AskAnswer, AskQuestion } from '../ws/event-types';
import type { SessionRunner } from '../session/session-runner';
import type { ReplRenderer } from '../render/repl-renderer';
import { formatContextPercent } from '../util/context';
import { InputController } from '../ui/input-controller';
import { formatWelcomeHints } from '../ui/welcome';
import { completeSlash } from '../ui/slash-complete';
import { copyToClipboard } from '../ui/clipboard';

export interface ReplOptions {
  runner: SessionRunner;
  renderer: ReplRenderer;
  modelId?: number;
  resolveModel: (spec: string) => Promise<number>;
  onExit: () => Promise<void>;
  firstPrompt?: string;
  queuedInput?: boolean;
  asciiOnly?: boolean;
  welcomeLines?: string[];
  historyLines?: string[];
  onInputReady?: (input: InputController) => void;
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
  let input: InputController;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

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

  const printWelcome = () => {
    const header = opts.welcomeLines?.length ? opts.welcomeLines : [formatWelcomeHints()];
    opts.renderer.printHeader(header);
    if (opts.historyLines && opts.historyLines.length > 0) {
      writeErr('');
      for (const line of opts.historyLines) writeErr(line);
    }
  };

  const requestExit = async () => {
    if (closing) return;
    closing = true;
    clearCancelHint();
    await input.stop();
    await opts.onExit();
    resolveClosed();
  };

  const handleCancel = () => {
    if (closing) return;
    if (opts.runner.isRunning()) {
      if (opts.runner.cancelledByUser) {
        closing = true;
        void requestExit();
        return;
      }
      input.queue.clear();
      input.clearDraft();
      opts.renderer.setDraft('');
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
    input.prompt();
  };

  const runOne = async (text: string) => {
    draining = true;
    opts.renderer.clearTransient();
    input.setRunning(true);
    if (!input.echoesSubmit) opts.renderer.noteUser(text);
    opts.renderer.startRound();
    try {
      await opts.runner.runPrompt(text, opts.modelId);
    } catch (err) {
      writeErr(err instanceof Error ? err.message : String(err));
    } finally {
      clearCancelHint();
      input.setRunning(false);
      draining = false;
    }
  };

  const handleSubmit = async (raw: string) => {
    const trimmed = raw.replace(/\s+$/, '');
    if (trimmed.endsWith('\\') && !fenceOpen(buffer + trimmed.slice(0, -1))) {
      buffer += trimmed.slice(0, -1) + '\n';
      input.setContinuationPrompt();
      return;
    }
    buffer += (buffer ? '\n' : '') + raw;
    if (fenceOpen(buffer)) {
      input.setContinuationPrompt();
      return;
    }
    const text = buffer.trim();
    buffer = '';
    if (!text) {
      if (!opts.runner.isRunning() && !draining) input.prompt();
      return;
    }
    if (text.startsWith('/')) {
      const handled = await handleSlash(text, opts, input, writeErr, printWelcome);
      if (handled === 'exit') {
        await requestExit();
        return;
      }
      if (!opts.runner.isRunning() && !draining && !closing) input.prompt();
      return;
    }
    if (opts.runner.isRunning() || draining) {
      if (!queuedInput) {
        writeErr('上一条还在跑。请等待结束或 /cancel。');
        return;
      }
      const n = input.queue.push(text);
      writeErr(`已排队（第 ${n} 条）。/queue 查看，Ctrl+C 清空。`);
      return;
    }
    await runOne(text);
    while (!closing && input.queue.length > 0) {
      const next = input.queue.shift();
      if (!next) break;
      if (next.startsWith('/')) {
        const handled = await handleSlash(next, opts, input, writeErr, printWelcome);
        if (handled === 'exit') {
          await requestExit();
          return;
        }
        continue;
      }
      await runOne(next);
    }
    if (!closing) input.prompt();
  };

  input = new InputController({
    onLine: (line) => handleSubmit(line),
    onCancel: () => handleCancel(),
    onExit: () => {
      if (!closing) void requestExit();
    },
    onDraftChange: (draft) => opts.renderer.setDraft(draft),
    completer: (line) => completeSlash(line, { models: opts.modelNames }),
    composer: opts.renderer.getComposer(),
  });
  opts.onInputReady?.(input);

  input.start();
  printWelcome();

  if (opts.firstPrompt) {
    if (opts.runner.snapshotIsActive) {
      writeErr('该会话仍在执行，先续接当前输出…');
      input.setRunning(true);
      try {
        await opts.runner.waitForCurrentRun();
      } catch (err) {
        writeErr(err instanceof Error ? err.message : String(err));
      } finally {
        input.setRunning(false);
      }
    }
    await handleSubmit(opts.firstPrompt);
  } else if (opts.runner.snapshotIsActive) {
    writeErr('该会话仍在执行，续接当前输出。可用 /cancel 中止。');
    input.setRunning(true);
    try {
      await opts.runner.waitForCurrentRun();
    } catch (err) {
      writeErr(err instanceof Error ? err.message : String(err));
    } finally {
      input.setRunning(false);
    }
    if (!closing) input.prompt();
  } else {
    input.prompt();
  }

  await closed;
}

async function handleSlash(
  text: string,
  opts: ReplOptions,
  input: InputController,
  writeErr: (s: string) => void,
  printWelcome: () => void,
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
      input.queue.clear();
      writeErr('已发送 cancel。');
      return;
    case 'clear': {
      opts.renderer.clearTransient();
      const composer = opts.renderer.getComposer();
      if (composer?.isActive()) {
        composer.wipe();
        printWelcome();
        composer.refresh();
      } else {
        process.stdout.write('\x1b[2J\x1b[H');
        for (const line of opts.welcomeLines ?? []) writeErr(line);
      }
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
        input.queue.clear();
        writeErr('已清空队列。');
        return;
      }
      const items = input.queue.list();
      if (items.length === 0) {
        writeErr('(队列为空)');
        return;
      }
      writeErr(items.map((q, i) => `${i + 1}. ${q}`).join('\n'));
      return;
    }
    case 'copy': {
      const text = opts.renderer.getLastAssistantText().trim();
      if (!text) {
        writeErr('没有可复制的回复。');
        return;
      }
      const ok = await copyToClipboard(text);
      if (ok) writeErr('已复制上一回合回复。');
      else {
        writeErr('本机没有剪贴板命令（pbcopy / wl-copy / xclip），上一回合回复如下：');
        writeErr(text);
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

/** 无 InputController 时的降级（打印模式不应走到这里）。 */
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
