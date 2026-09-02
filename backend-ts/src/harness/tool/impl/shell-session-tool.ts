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

const MAX_COMMAND_LENGTH = 10000;
const MARKER_PREFIX = '__CMD_DONE_';
const MARKER_SUFFIX = '__';
const WORKDIR_TIMEOUT_MS = 5000;

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
      + '- close：关闭 shell 会话\n'
      + '- list：列出活跃会话\n'
      + '参数：\n'
      + '- keep_session：是否保留会话（默认 false），执行后自动关闭会话以释放资源。';
  }
  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['exec', 'write_stdin', 'close', 'list'], description: '要执行的动作（默认：exec）' },
        command: { type: 'string', description: '要执行的命令（用于 exec 动作）' },
        session_id: { type: 'string', description: '会话 ID。省略时执行一次性命令；提供时复用已有会话。' },
        input: { type: 'string', description: '要写入 stdin 的输入（用于 write_stdin 动作）' },
        workdir: { type: 'string', description: '工作目录：支持相对路径和任意绝对路径' },
        yield_time_ms: { type: 'integer', description: '等待输出的最长时间，单位毫秒（默认 300000）' },
        async: { type: 'boolean', description: '是否在后台运行并立即返回 task_id（默认 false，仅用于 exec 动作）' },
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
    const keepSession = args.keep_session === true;
    const isAsync = args.async === true;
    const yieldTimeMs = args.yield_time_ms != null ? asInt(args.yield_time_ms, 300_000) : 300_000;
    let workdir = workspace;
    const workdirArg = asText(args.workdir);
    if (workdirArg) workdir = this.pathSandbox.resolveLenient(workdirArg, workspace);
    const tokenMap = userId != null && this.gitCredentialService
      ? await this.gitCredentialService.getTokenMapByUser(userId) : {};
    const shellId = asText(args.session_id);
    const session = this.sessionManager.getOrCreate(conversationId ?? 0, shellId, userId, workdir, tokenMap);
    const releaseCommand = await session.acquireCommand?.() ?? (() => undefined);
    try {
      // 持久会话的用户环境不会自动更新，执行前按当前触发者刷新 Git/Home 环境。
      this.sessionManager.refreshUserEnvironment?.(session, userId, tokenMap);
      await this.injectMaoToken(session, userId);
      // 复用已有会话时 getOrCreate 不会改变 cwd，必须显式 cd
      if (workdirArg && workdir) {
        await this.executeWithMarker(session, 'cd ' + shellSingleQuote(workdir), WORKDIR_TIMEOUT_MS);
      }
      const marker = this.newMarker();
      session.writeStdin(command + '\necho ' + marker + ' $?\n');
      session.incrementCommandCount();
      session.touch();
      if (isAsync) {
        let taskId: string;
        try {
          taskId = this.backgroundTaskManager.submit(conversationId, async () => {
            try {
              const r = await this.outputManager.readUntilMarker(session, marker, yieldTimeMs);
              if (!keepSession) this.sessionManager.close(session.sessionId);
              return toJson({
                exit_code: this.resolveExitCode(r),
                completed: r.completed,
                output: r.output,
                truncated: r.truncated,
              });
            } finally {
              releaseCommand();
            }
          });
        } catch (error) {
          releaseCommand();
          throw error;
        }
        return toJson({
          async: true,
          task_id: taskId,
          session_id: session.sessionId,
          output_file: session.outputFile,
          message: '命令已提交到后台执行。',
        });
      }
      const result = await this.outputManager.readUntilMarker(session, marker, yieldTimeMs);
      const payload: Record<string, unknown> = {
        exit_code: this.resolveExitCode(result),
        session_id: session.sessionId,
        output: result.output,
        truncated: result.truncated,
        completed: result.completed,
        current_workdir: await this.resolveCurrentWorkdir(session, result),
        output_file: session.outputFile,
      };
      if (!keepSession) this.sessionManager.close(session.sessionId);
      return toJson(payload);
    } finally {
      if (!isAsync) releaseCommand();
    }
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
    const session = this.sessionManager.getSession(shellId);
    if (!session) return errorJson('会话不存在或已关闭：' + shellId);
    const releaseCommand = await session.acquireCommand?.() ?? (() => undefined);
    try {
      const tokenMap = userId != null && this.gitCredentialService
        ? await this.gitCredentialService.getTokenMapByUser(userId) : {};
      this.sessionManager.refreshUserEnvironment?.(session, userId, tokenMap);
      // 与 exec 一致：写命令前重新注入短效 MAO_TOKEN
      await this.injectMaoToken(session, userId);
      const yieldTimeMs = args.yield_time_ms != null ? asInt(args.yield_time_ms, 5000) : 5000;
      // 输入本身不带结束标记，必须额外回显 marker，否则只能空等到超时
      const marker = this.newMarker();
      session.writeStdin(input + '\necho ' + marker + ' $?\n');
      session.touch();
      const result = await this.outputManager.readUntilMarker(session, marker, yieldTimeMs);
      return toJson({
        exit_code: this.resolveExitCode(result),
        session_id: session.sessionId,
        output: result.output,
        truncated: result.truncated,
        completed: result.completed,
        current_workdir: await this.resolveCurrentWorkdir(session, result),
        output_file: session.outputFile,
      });
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
      session.writeStdin('pwd\necho ' + marker + '\n');
      const pwd = await this.outputManager.readUntilMarker(session, marker, WORKDIR_TIMEOUT_MS, false);
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
