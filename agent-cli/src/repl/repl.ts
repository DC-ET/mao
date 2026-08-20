import readline from 'node:readline';
import type { AskAnswer, AskQuestion } from '../ws/event-types';
import type { SessionRunner } from '../session/session-runner';
import type { ReplRenderer } from '../render/repl-renderer';
import { formatContextPercent } from '../util/context';

export interface ReplOptions {
  runner: SessionRunner;
  renderer: ReplRenderer;
  modelId?: number;
  resolveModel: (spec: string) => Promise<number>;
  onExit: () => Promise<void>;
  firstPrompt?: string;
}

const SLASH_HELP = `斜杠命令（本地拦截，不发给 Agent）:
  /cancel              中止当前执行
  /model <id|name>     切换当前会话模型（会持久写库）
  /todo                打印当前 Todo 快照
  /context             打印最近一次 context_window 用量
  /session             打印当前 sessionId、Agent、模型、workspace
  /help                帮助
  /exit  /quit         退出（Ctrl+D 等效）

多行输入：以 \\ 结尾续行；未闭合的 \`\`\` 代码块自动续行。
Ctrl+C：有任务在跑时第一次发 cancel；无任务或 2 秒内连按两次则退出。
`;

function fenceOpen(text: string): boolean {
  const matches = text.match(/```/g);
  return Boolean(matches && matches.length % 2 === 1);
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const prompt = () => {
    opts.renderer.clearTransient?.();
    rl.setPrompt('› ');
    rl.prompt();
  };

  let lastSigint = 0;
  let buffer = '';
  let closing = false;
  let inputLocked = false;

  const handleLine = async (line: string) => {
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed.endsWith('\\') && !fenceOpen(buffer + trimmed.slice(0, -1))) {
      buffer += trimmed.slice(0, -1) + '\n';
      rl.setPrompt('… ');
      rl.prompt();
      return;
    }
    buffer += (buffer ? '\n' : '') + line;
    if (fenceOpen(buffer)) {
      rl.setPrompt('… ');
      rl.prompt();
      return;
    }
    const text = buffer.trim();
    buffer = '';
    if (!text) {
      if (!inputLocked) prompt();
      return;
    }
    if (text.startsWith('/')) {
      const handled = await handleSlash(text, opts, rl);
      if (handled === 'exit') {
        closing = true;
        rl.close();
        return;
      }
      if (!inputLocked) prompt();
      return;
    }
    if (inputLocked || opts.runner.isRunning()) {
      process.stderr.write('当前任务仍在执行，请等待结束或 /cancel。\n');
      return;
    }
    inputLocked = true;
    rl.pause();
    opts.renderer.startRound();
    try {
      await opts.runner.runPrompt(text, opts.modelId);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      inputLocked = false;
      if (!closing) {
        rl.resume();
        prompt();
      }
    }
  };

  rl.on('line', (line) => {
    void handleLine(line);
  });
  rl.on('close', () => {
    if (!closing) void opts.onExit();
  });
  rl.on('SIGINT', () => {
    const now = Date.now();
    if (opts.runner.isRunning()) {
      void opts.runner.cancel();
      process.stderr.write('\n已发送 cancel，等待任务结束…\n');
      lastSigint = now;
      return;
    }
    if (now - lastSigint < 2000) {
      closing = true;
      rl.close();
      void opts.onExit();
      return;
    }
    lastSigint = now;
    process.stderr.write('\n再次 Ctrl+C 退出，或输入 /exit。\n');
    prompt();
  });

  if (opts.firstPrompt) {
    inputLocked = true;
    rl.pause();
    opts.renderer.startRound();
    try {
      if (opts.runner.snapshotIsActive) {
        process.stderr.write('该会话仍在执行，先续接当前输出…\n');
        await opts.runner.waitForCurrentRun();
      }
      await opts.runner.runPrompt(opts.firstPrompt, opts.modelId);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      inputLocked = false;
      rl.resume();
    }
  } else if (opts.runner.snapshotIsActive) {
    process.stderr.write('该会话仍在执行，续接当前输出。可用 /cancel 中止。\n');
    inputLocked = true;
    rl.pause();
    try {
      await opts.runner.waitForCurrentRun();
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      inputLocked = false;
      rl.resume();
    }
  }

  prompt();
  await new Promise<void>((resolve) => {
    rl.on('close', () => resolve());
  });
  if (!closing) await opts.onExit();
}

async function handleSlash(text: string, opts: ReplOptions, _rl: readline.Interface): Promise<'exit' | void> {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (cmd) {
    case 'exit':
    case 'quit':
      await opts.onExit();
      return 'exit';
    case 'help':
      process.stdout.write(SLASH_HELP);
      return;
    case 'cancel':
      await opts.runner.cancel();
      process.stdout.write('已发送 cancel。\n');
      return;
    case 'todo': {
      const todos = opts.runner.getTodos();
      if (todos.length === 0) {
        process.stdout.write('(暂无 Todo)\n');
        return;
      }
      for (const t of todos) {
        process.stdout.write(`- [${t.status ?? ' '}] ${t.content ?? ''}\n`);
      }
      return;
    }
    case 'context': {
      const ctx = opts.runner.getContext();
      const s = opts.runner.getSession();
      const pct = formatContextPercent(ctx.estimated, ctx.actual, s?.contextWindowTokens ?? undefined);
      process.stdout.write(
        `context_window estimated=${ctx.estimated ?? '-'} actual=${ctx.actual ?? '-'}` +
          (pct ? ` (${pct})` : '') +
          '\n',
      );
      return;
    }
    case 'session': {
      const s = opts.runner.getSession();
      process.stdout.write(
        `sessionId=${s?.id ?? '-'}  agent=${s?.agentName ?? s?.agentId ?? '-'}  model=${s?.modelName ?? s?.modelId ?? '-'}` +
          `  workspace=${s?.workspace ?? '-'}  phase=${s?.phase ?? '-'}\n`,
      );
      return;
    }
    case 'model': {
      if (!arg) {
        const s = opts.runner.getSession();
        process.stdout.write(`当前模型: ${s?.modelName ?? s?.modelId ?? '-'}\n`);
        return;
      }
      const id = await opts.resolveModel(arg);
      opts.modelId = id;
      process.stdout.write(`下一条消息将切换到模型 id=${id}（会持久写库）。\n`);
      return;
    }
    default:
      process.stderr.write(`未知斜杠命令: /${cmd}（输入 /help）\n`);
  }
}

export async function askQuestionsInTty(questions: AskQuestion[]): Promise<AskAnswer[]> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
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

export function promptHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    if (process.stdin.isTTY) {
      const stdin = process.stdin as NodeJS.ReadStream;
      const onData = (char: Buffer) => {
        const c = char.toString('utf8');
        if (c === '\n' || c === '\r' || c === '\u0004') {
          stdin.removeListener('data', onData);
        } else {
          // swallow
        }
      };
      stdin.on('data', onData);
    }
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
