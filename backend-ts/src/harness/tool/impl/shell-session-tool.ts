import { randomUUID } from 'node:crypto';
import { BaseTool } from '../tool.js';
import { asInt, asText, errorJson, parseObject, toJson } from '../json.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { SecurityException } from '../../safety/path-sandbox.js';
import type { ShellSession, ShellSessionManager, OutputManager, OutputResult } from '../../shell/shell-session-manager.js';
import type { BackgroundTaskManager } from '../../core/background-task-manager.js';
import type { GitCredentialLookup } from '../../../session/types.js';
import { matchShellDenyList } from '../../shell/command-deny-list.js';
import { harnessLog } from '../../log.js';

const MAX_COMMAND_LENGTH = 20000;
const MARKER_PREFIX = '__CMD_DONE_';
const MARKER_SUFFIX = '__';
const WORKDIR_TIMEOUT_MS = 5000;
const DEFAULT_EXEC_YIELD_MS = 300_000;
const DEFAULT_STDIN_YIELD_MS = 5000;
const DEFAULT_AWAIT_YIELD_MS = 60_000;
/** wait_for 由模型给出并在服务端执行匹配，限制长度以压缩灾难性回溯的空间。 */
const MAX_WAIT_FOR_LENGTH = 200;

/** 为 CLOUD shell 签发短效 token 所需的最小依赖。 */
export interface ShellTokenIssuer {
  generateShellToken(userId: number, username: string): string;
}

export interface ShellUserLookup {
  findById(userId: number): Promise<{ username?: string | null } | null>;
}

/** bash 单引号转义，避免 JWT 等特殊字符破坏命令 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class ShellSessionTool extends BaseTool {
  constructor(
    private readonly pathSandbox: PathSandbox,
    private readonly sessionManager: ShellSessionManager,
    private readonly outputManager: OutputManager,
    private readonly backgroundTaskManager: BackgroundTaskManager,
    private readonly gitCredentialService?: GitCredentialLookup | null,
    private readonly jwtService?: ShellTokenIssuer | null,
    private readonly userLookup?: ShellUserLookup | null,
  ) { super(); }

  getName(): string { return 'shell'; }
  getDescription(): string {
    return '执行 shell 命令，支持一次性执行和持久会话。\n'
      + '动作：\n'
      + '- exec：执行命令（如果省略 session_id，则创建新会话）\n'
      + '- write_stdin：向正在运行的会话 stdin 写入输入\n'
      + '- await_async：继续等待会话中未结束的命令（长时构建、后台任务）\n'
      + '- close：关闭 shell 会话\n'
      + '- list：列出活跃会话\n'
      + '参数：\n'
      + '- keep_session：是否保留会话（默认 false），执行后自动关闭会话以释放资源。\n'
      + '- wait_for：正则；命中输出即提前返回（completed=false），命令继续在后台运行。\n'
      + '返回 completed=false 时命令仍在运行，会话被保留，用 await_async + session_id 继续等待；'
      + '完整输出始终写入 output_file。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['exec', 'write_stdin', 'await_async', 'close', 'list'], description: '要执行的动作（默认：exec）' },
        command: { type: 'string', description: '要执行的命令（用于 exec 动作）' },
        session_id: { type: 'string', description: '会话 ID。省略时执行一次性命令；提供时复用已有会话。' },
        input: { type: 'string', description: '要写入 stdin 的输入（用于 write_stdin 动作）' },
        workdir: { type: 'string', description: '工作目录：支持相对路径和任意绝对路径' },
        yield_time_ms: { type: 'integer', description: '等待输出的最长时间，单位毫秒（exec 默认 300000，write_stdin 默认 5000，await_async 默认 60000）' },
        wait_for: { type: 'string', description: `正则，命中输出即提前返回（最长 ${MAX_WAIT_FOR_LENGTH} 字符）。例如等服务启动打印 "Listening on"。` },
        async: { type: 'boolean', description: '是否在后台运行并立即返回 task_id（默认 false，仅用于 exec 动作）' },
        task_id: { type: 'string', description: '后台任务 ID（用于 await_async 动作，等待 async 提交的任务）' },
        keep_session: { type: 'boolean', description: '是否保留会话（默认 false）。执行后自动关闭会话以释放资源。' },
      },
    };
  }
  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        exit_code: { type: 'integer' },
        session_id: { type: 'string' },
        output: { type: 'string' },
        current_workdir: { type: 'string' },
        truncated: { type: 'boolean' },
        completed: { type: 'boolean' },
        matched: { type: 'string' },
        output_file: { type: 'string' },
        async: { type: 'boolean' },
        task_id: { type: 'string' },
      },
    };
  }

  protected async executeWithUser(
    argumentsJson: string, sessionId: number | null, userId: number | null, workspace: string | null,
  ): Promise<string> {
    try {
      const args = parseObject(argumentsJson) ?? {};
      let action = asText(args.action) ?? 'exec';
      if (action.trim() === '') action = 'exec';
      switch (action) {
        case 'exec': return await this.handleExec(args, sessionId, userId, workspace);
        case 'write_stdin': return await this.handleWriteStdin(args, sessionId, userId);
        case 'await_async': return await this.handleAwaitAsync(args, sessionId);
        case 'close': return this.handleClose(args, sessionId);
        case 'list': return this.handleList(sessionId);
        default: return errorJson('未知动作：' + action);
      }
    } catch (e) {
      if (e instanceof SecurityException) harnessLog('warn', `ShellSessionTool blocked by sandbox: ${(e as Error).message}`);
      else harnessLog('error', 'ShellSessionTool execution failed', e);
      return errorJson('错误：' + (e as Error).message);
    }
  }

  /** wait_for 由模型提供，非法正则要作为参数错误反馈而不是抛异常。 */
  private parseWaitFor(args: Record<string, unknown>): RegExp | null | string {
    const raw = asText(args.wait_for);
    if (!raw || raw === '') return null;
    if (raw.length > MAX_WAIT_FOR_LENGTH) return `wait_for 过长（最多 ${MAX_WAIT_FOR_LENGTH} 个字符）`;
    try {
      return new RegExp(raw);
    } catch (e) {
      return `wait_for 不是合法正则：${(e as Error).message}`;
    }
  }

  private async handleExec(
    args: Record<string, unknown>, conversationId: number | null, userId: number | null, workspace: string | null,
  ): Promise<string> {
    const command = asText(args.command);
    if (!command || command.trim() === '') return errorJson('exec 动作必须提供 command');
    if (command.length > MAX_COMMAND_LENGTH) return errorJson(`命令过长（最多 ${MAX_COMMAND_LENGTH} 个字符）`);
    const denied = matchShellDenyList(command);
    if (denied) {
      harnessLog('warn', `Shell command blocked by deny-list [${denied.id}]: ${command}`);
      return errorJson(`命令被拒绝：${denied.reason}`);
    }
    const waitFor = this.parseWaitFor(args);
    if (typeof waitFor === 'string') return errorJson(waitFor);
    const keepSession = args.keep_session === true;
    const isAsync = args.async === true;
    const yieldTimeMs = args.yield_time_ms != null ? asInt(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS) : DEFAULT_EXEC_YIELD_MS;
    let workdir = workspace;
    const workdirArg = asText(args.workdir);
    if (workdirArg) workdir = this.pathSandbox.resolveLenient(workdirArg, workspace);
    const tokenMap = userId != null && this.gitCredentialService
      ? await this.gitCredentialService.getTokenMapByUser(userId) : {};
    const shellId = asText(args.session_id);
    const session = this.sessionManager.getOrCreate(conversationId ?? 0, shellId, userId, workdir, tokenMap);
    const releaseCommand = await session.acquireCommand?.() ?? (() => undefined);
    // 上一条命令未结束时再写新命令会让两条命令的输出交织，且新命令要排在它之后才执行
    if (session.pendingCommand) {
      releaseCommand();
      return errorJson(`会话仍有未结束的命令：${session.sessionId}。请先用 action:'await_async' 收取结果，或 close 该会话。`);
    }
    try {
      // 持久会话的用户环境不会自动更新，执行前按当前触发者刷新 Git/Home 环境。
      this.sessionManager.refreshUserEnvironment?.(session, userId, tokenMap);
      await this.injectMaoToken(session, userId);
      // 复用已有会话时 getOrCreate 不会改变 cwd，必须显式 cd
      if (workdirArg && workdir) {
        await this.executeWithMarker(session, 'cd ' + shellSingleQuote(workdir), WORKDIR_TIMEOUT_MS);
      }
      const marker = this.newMarker();
      if (isAsync) {
        let taskId: string;
        try {
          taskId = this.backgroundTaskManager.submit(conversationId, async () => {
            try {
              const r = await this.outputManager.readUntilMarker(session, marker, yieldTimeMs, waitFor);
              this.settleSession(session, r, keepSession);
              return toJson(this.formatResult(session, r, session.currentWorkdir));
            } finally {
              // 后台任务退出后读取权交还会话，后续 await_async 才能接着读
              if (session.pendingCommand) session.pendingCommand.taskId = null;
              releaseCommand();
            }
          });
        } catch (error) {
          releaseCommand();
          throw error;
        }
        this.writeCommand(session, command, marker, keepSession, taskId);
        return toJson({
          async: true,
          task_id: taskId,
          session_id: session.sessionId,
          output_file: session.outputFile,
          message: '命令已提交到后台执行。',
        });
      }
      this.writeCommand(session, command, marker, keepSession, null);
      const result = await this.outputManager.readUntilMarker(session, marker, yieldTimeMs, waitFor);
      const workdirNow = await this.resolveCurrentWorkdir(session, result);
      const payload = this.formatResult(session, result, workdirNow);
      this.settleSession(session, result, keepSession);
      return toJson(payload);
    } finally {
      if (!isAsync) releaseCommand();
    }
  }

  /** 写入命令并登记为等待中；提前返回后仍能凭 marker 继续读。 */
  private writeCommand(
    session: ShellSession, command: string, marker: string, keepSession: boolean, taskId: string | null,
  ): void {
    session.beginCommand(marker, keepSession, true, taskId);
    session.writeStdin(command + '\necho ' + marker + ' $?\n');
    session.incrementCommandCount();
    session.touch();
  }

  /**
   * 命令已结束才按 keep_session 决定是否回收；仍在运行时必须保留会话，
   * 否则关闭会 SIGKILL 掉进程组，模型再也拿不到剩余输出。
   */
  private settleSession(session: ShellSession, result: OutputResult, keepSession: boolean): void {
    if (result.completed && !keepSession) this.sessionManager.close(session.sessionId);
  }

  private formatResult(
    session: ShellSession, result: OutputResult, currentWorkdir: string,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      exit_code: this.resolveExitCode(result),
      session_id: session.sessionId,
      output: result.output,
      truncated: result.truncated,
      completed: result.completed,
      current_workdir: currentWorkdir,
      output_file: session.outputFile,
    };
    if (result.matched != null) payload.matched = result.matched;
    if (!result.completed) {
      payload.message = result.matched != null
        ? `wait_for 已命中，命令仍在运行。用 action:'await_async' + session_id:'${session.sessionId}' 继续等待。`
        : `等待超时，命令仍在运行。用 action:'await_async' + session_id:'${session.sessionId}' 继续等待。`;
    }
    return payload;
  }

  private async handleWriteStdin(args: Record<string, unknown>, conversationId: number | null, userId: number | null): Promise<string> {
    const shellId = asText(args.session_id);
    const input = asText(args.input) ?? '';
    if (!shellId) return errorJson('write_stdin 必须提供 session_id');
    const denied = matchShellDenyList(input);
    if (denied) {
      harnessLog('warn', `Shell stdin blocked by deny-list [${denied.id}]: ${input}`);
      return errorJson(`命令被拒绝：${denied.reason}`);
    }
    const waitFor = this.parseWaitFor(args);
    if (typeof waitFor === 'string') return errorJson(waitFor);
    const session = this.sessionManager.getSession(shellId);
    if (!session) return errorJson('会话不存在或已关闭：' + shellId);
    const pending = session.pendingCommand;
    if (pending?.taskId != null) {
      return errorJson(`会话的输出正由后台任务 ${pending.taskId} 读取，请先 await_async 该任务。`);
    }
    const releaseCommand = await session.acquireCommand?.() ?? (() => undefined);
    try {
      const yieldTimeMs = args.yield_time_ms != null ? asInt(args.yield_time_ms, DEFAULT_STDIN_YIELD_MS) : DEFAULT_STDIN_YIELD_MS;
      // 拿锁可能排队（后台任务/并行调用持有锁），必须以拿锁后的实时状态为准，进锁前的快照可能已过期
      const livePending = session.pendingCommand;
      if (livePending) {
        if (session.peekBuffer().includes(livePending.marker)) {
          // 命令已结束但结果尚未被收取：此时写入的输入会被 bash 当作新命令执行，
          // 而续读会立刻命中旧 marker，把旧输出误当成输入的应答
          return errorJson(`上一条命令已结束但结果尚未收取：${shellId}。请先 action:'await_async' 收取结果，再发送新输入。`);
        }
        // 有命令正在运行：输入交给它，不能再插入 marker（marker 只会排在该命令之后被执行）
        session.writeStdin(input.endsWith('\n') ? input : input + '\n');
        session.touch();
        const answered = await this.outputManager.readUntilMarker(session, livePending.marker, yieldTimeMs, waitFor);
        const workdirNow = await this.resolveCurrentWorkdir(session, answered);
        const payload = this.formatResult(session, answered, workdirNow);
        this.settleSession(session, answered, livePending.keepSession);
        return toJson(payload);
      }
      const tokenMap = userId != null && this.gitCredentialService
        ? await this.gitCredentialService.getTokenMapByUser(userId) : {};
      this.sessionManager.refreshUserEnvironment?.(session, userId, tokenMap);
      // 与 exec 一致：写命令前重新注入短效 MAO_TOKEN
      await this.injectMaoToken(session, userId);
      // 输入本身不带结束标记，必须额外回显 marker，否则只能空等到超时
      const marker = this.newMarker();
      this.writeCommand(session, input, marker, true, null);
      const result = await this.outputManager.readUntilMarker(session, marker, yieldTimeMs, waitFor);
      return toJson(this.formatResult(session, result, await this.resolveCurrentWorkdir(session, result)));
    } finally {
      releaseCommand();
    }
  }

  /** 继续等待未结束的命令：按 task_id 等后台任务，或按 session_id 直接续读会话。 */
  private async handleAwaitAsync(args: Record<string, unknown>, conversationId: number | null): Promise<string> {
    const waitFor = this.parseWaitFor(args);
    if (typeof waitFor === 'string') return errorJson(waitFor);
    const yieldTimeMs = args.yield_time_ms != null ? asInt(args.yield_time_ms, DEFAULT_AWAIT_YIELD_MS) : DEFAULT_AWAIT_YIELD_MS;
    const taskId = asText(args.task_id);
    if (taskId) {
      const awaited = await this.backgroundTaskManager.awaitResult(taskId, yieldTimeMs, conversationId);
      if (awaited.status === 'not_found') return errorJson('后台任务不存在或已被消费：' + taskId);
      if (awaited.status === 'pending') {
        return toJson({
          task_id: taskId,
          completed: false,
          message: `后台任务仍在执行（已等待 ${yieldTimeMs} ms），可继续 await_async 或等待结果自动注入。`,
        });
      }
      return awaited.result;
    }
    const shellId = asText(args.session_id);
    if (!shellId) return errorJson("await_async 必须提供 session_id 或 task_id");
    const session = this.sessionManager.getSession(shellId);
    if (!session) return errorJson('会话不存在或已关闭：' + shellId);
    const pending = session.pendingCommand;
    if (!pending) return errorJson('该会话没有未结束的命令：' + shellId);
    if (pending.taskId != null) {
      return errorJson(`会话的输出正由后台任务 ${pending.taskId} 读取，请用 task_id:'${pending.taskId}' 等待。`);
    }
    // 并行工具调用下两个 await_async 同时轮询同一缓冲区会互相吃掉输出，这里串行化
    const releaseCommand = await session.acquireCommand?.() ?? (() => undefined);
    try {
      // 拿锁可能排队，期间命令可能已被并行调用方收取完毕；按旧快照续读只会登记假 marker 卡死会话
      const livePending = session.pendingCommand;
      if (!livePending) return errorJson('该会话没有未结束的命令：' + shellId);
      const result = await this.outputManager.readUntilMarker(session, livePending.marker, yieldTimeMs, waitFor);
      const workdirNow = await this.resolveCurrentWorkdir(session, result);
      const payload = this.formatResult(session, result, workdirNow);
      this.settleSession(session, result, pending.keepSession);
      return toJson(payload);
    } finally {
      releaseCommand();
    }
  }

  private resolveExitCode(result: OutputResult): number {
    if (result.exitCode != null) return result.exitCode;
    return result.completed ? 0 : -1;
  }

  /**
   * 命令仍在运行时不能再向同一 shell 写 pwd：它会排在当前命令之后，
   * 读取过程反而会消费当前命令的后续输出并把日志末行误判为工作目录。
   */
  private async resolveCurrentWorkdir(session: ShellSession, result: OutputResult): Promise<string> {
    if (!result.completed) return session.currentWorkdir;
    try {
      const marker = this.newMarker();
      // pwd 属协议命令，输出不进 output_file
      session.beginCommand(marker, true, false);
      session.writeStdin('pwd\necho ' + marker + '\n');
      const pwd = await this.outputManager.readUntilMarker(session, marker, WORKDIR_TIMEOUT_MS);
      if (pwd.completed) {
        const lines = pwd.output.split('\n').map((l) => l.trim()).filter((l) => l !== '');
        const last = lines[lines.length - 1];
        if (last && last.startsWith('/')) {
          session.setCurrentWorkdir(last);
          return last;
        }
      }
    } catch (e) {
      harnessLog('debug', `Failed to refresh shell workdir: ${(e as Error).message}`);
    }
    return session.currentWorkdir;
  }

  private async executeWithMarker(session: ShellSession, command: string, timeoutMs: number): Promise<OutputResult> {
    const marker = this.newMarker();
    session.beginCommand(marker, true, false);
    session.writeStdin(command + '\necho ' + marker + ' $?\n');
    return this.outputManager.readUntilMarker(session, marker, timeoutMs);
  }

  /** 为 CLOUD shell 注入短效 JWT，供 mao-*-cli 使用。必须在写入命令前完成，否则 export 会排到命令之后。 */
  private async injectMaoToken(session: ShellSession, userId: number | null): Promise<void> {
    if (userId == null || !this.jwtService || !this.userLookup) return;
    try {
      const user = await this.userLookup.findById(userId);
      const username = user?.username;
      if (!username || username.trim() === '') {
        harnessLog('warn', `Skip MAO_TOKEN inject: user not found or username empty, userId=${userId}`);
        return;
      }
      const token = this.jwtService.generateShellToken(userId, username);
      session.writeStdin('export MAO_TOKEN=' + shellSingleQuote(token) + '\n');
    } catch (e) {
      harnessLog('warn', `Failed to inject MAO_TOKEN for userId=${userId}: ${(e as Error).message}`);
    }
  }

  private newMarker(): string {
    return MARKER_PREFIX + randomUUID().replace(/-/g, '').slice(0, 12) + MARKER_SUFFIX;
  }

  private handleClose(args: Record<string, unknown>, _conversationId: number | null): string {
    const shellId = asText(args.session_id);
    if (!shellId) return errorJson('close 必须提供 session_id');
    this.sessionManager.close(shellId);
    return toJson({ success: true, session_id: shellId });
  }

  private handleList(conversationId: number | null): string {
    const sessions = conversationId != null ? this.sessionManager.listByConversation(conversationId) : [];
    return toJson({
      sessions: sessions.map((s) => ({
        session_id: s.sessionId,
        current_workdir: s.currentWorkdir,
        alive: s.isAlive(),
      })),
    });
  }
}
