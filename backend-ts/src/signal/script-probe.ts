import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * 信号哨兵 Shell 脚本探针执行器（docs/plan/2026-11-10-shell-script-signal-watcher-technical-design.md §4 步骤 3）。
 *
 * 与 HTTP 探针（probe-client.ts）同构：任何 exit code 都是执行结果——0 视为取得判定值（ok=true，
 * stdout 进既有判定管线），非 0 / 超时 / 输出超限 / 启动失败为失败（ok=false，计连败走既有退避）。
 *
 * 执行模型：`bash <绝对路径>`（不要求 +x 位，工作区上传链路不保留执行权限）；stdin 关闭
 * （脚本不可交互读）；stderr 与 stdout 分开收集（判定值只吃 stdout）；`detached` 独立进程组，
 * `kill(-pid, 'SIGKILL')` 整组回收——超时 / 输出超限时击杀，脚本本体退出后也再兜底击杀一次，
 * 回收仍握着 stdio 管道的后代进程（否则后台驻留子进程会让 close 事件迟迟不到）。
 *
 * 落定时序双保险：正常路径 `close` 事件（进程退出 + stdio 全部闭合）数毫秒内到达；极端时序下
 * 进程组信号送达与管道闭合存在内核边缘窗口，`exit` 后 100ms 后备落定兜住——按已收集的
 * stdout / 退出码出结果，绝不让一次成功的脚本挂到硬超时被误判成失败。执行的是 spawn 时刻
 * 磁盘上的当前内容（「当前内容生效」语义；POSIX unlink 语义保证已打开的 fd 不受并发删除影响）。
 */

/** stdout 累计上限（与 HTTP 探针 MAX_BODY_BYTES 同量级），超限判失败。 */
export const SCRIPT_PROBE_MAX_STDOUT_BYTES = 1024 * 1024;
/** stderr 收集上限（错误信息本身不能爆炸）。 */
export const SCRIPT_PROBE_MAX_STDERR_BYTES = 8 * 1024;
/** exit 后等待 stdio 闭合（close 事件）的后备落定时长。 */
const EXIT_FALLBACK_SETTLE_MS = 100;
/** error 文本统一口径（与 probe-client safeError 一致）。 */
const ERROR_MAX_CHARS = 200;

export interface ScriptProbeRequest {
  /** 脚本绝对路径（调用方已完成属主校验与 realpath）。 */
  scriptPath: string;
  timeoutSeconds: number;
  /** 白名单环境变量（含 MAO_WATCHER_ID / MAO_WATCHER_NAME），不继承后端进程全量 env。 */
  env: Record<string, string>;
}

export interface ScriptProbeResult {
  /** exit code === 0 且未被超时 / 超限击杀。 */
  ok: boolean;
  /** 退出码；超时 / 超限被 SIGKILL 时为 null。 */
  exitCode: number | null;
  /** 成功时的 stdout（utf8 解码）；失败为 null（部分输出不可作稳定判定值）。 */
  stdout: string | null;
  /** 成功时的 stdout 原始字节（哈希用）；失败为 null。 */
  stdoutBytes: Buffer | null;
  /** 失败原因：stderr 尾部 200 字符 / 执行超时（Ns）/ 输出超限 / 无法启动脚本进程。 */
  error: string | null;
  durationMs: number;
}

export function executeScriptProbe(req: ScriptProbeRequest): Promise<ScriptProbeResult> {
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;

  return new Promise<ScriptProbeResult>((resolve) => {
    let settled = false;
    /** 超时 / 输出超限置位：置位后的退出一律判失败（SIGKILL 下的退出码与部分输出不可信）。 */
    let failureReason: string | null = null;
    let exitCode: number | null = null;
    let spawnFailed = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutTotal = 0;
    const stderrChunks: Buffer[] = [];
    let stderrTotal = 0;

    const timer = setTimeout(() => {
      failureReason = `执行超时（${req.timeoutSeconds}s）`;
      killGroup();
    }, req.timeoutSeconds * 1000);

    /** exit 后的后备落定定时器：exit 事件里才真正启用；close 正常先到时被清除。 */
    let exitFallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (exitFallbackTimer != null) clearTimeout(exitFallbackTimer);
    };

    const killGroup = (): void => {
      if (spawnFailed) return;
      try {
        // 独立进程组：负 pid 杀整组（bash 及其全部后代），与 shell-session-manager 同模式。
        // Windows（开发机）无负 pid 组语义：直接终止 leader，stdio 管道关闭后 settleNow
        // 的兜底再收尾（prod 部署为 Linux，组语义在那里生效）。
        if (child.pid != null) {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        /* 组已不存在（ESRCH）——leader 已退出且无残留成员，正常路径 */
      }
    };

    const finish = (result: Omit<ScriptProbeResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ ...result, durationMs: elapsed() });
    };

    const settleNow = (): void => {
      if (settled) return;
      // 落定前再兜底击杀一次进程组：回收任何仍握着 stdio 管道的残留成员
      //（正常路径组已空，ESRCH 无害）。
      killGroup();
      if (failureReason != null) {
        // 超时 / 超限：SIGKILL 击杀，退出码与部分输出都不可信，整体判失败。
        finish({ ok: false, exitCode: null, stdout: null, stdoutBytes: null, error: failureReason });
        return;
      }
      if (exitCode === 0) {
        const stdoutBytes = Buffer.concat(stdoutChunks);
        finish({ ok: true, exitCode: 0, stdout: stdoutBytes.toString('utf8'), stdoutBytes, error: null });
        return;
      }
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      const tail = stderrText.length > ERROR_MAX_CHARS ? stderrText.slice(-ERROR_MAX_CHARS) : stderrText;
      const trimmed = tail.trim();
      finish({
        ok: false,
        exitCode,
        stdout: null,
        stdoutBytes: null,
        error: trimmed !== '' ? trimmed : `脚本退出码 ${exitCode ?? '未知'}`,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bash', [req.scriptPath], {
        cwd: dirname(req.scriptPath),
        env: req.env,
        // stdin 关闭：无人值守脚本不该交互读；读 stdin 得到 EOF 而不是读到脚本自身源码。
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      spawnFailed = true;
      finish({ ok: false, exitCode: null, stdout: null, stdoutBytes: null, error: `无法启动脚本进程: ${errorMessage(e)}` });
      return;
    }

    child.on('error', (err) => {
      // bash 不存在 / cwd 目录缺失等启动失败；close 事件不会因 error 必然触发，这里自行落定。
      spawnFailed = true;
      finish({ ok: false, exitCode: null, stdout: null, stdoutBytes: null, error: `无法启动脚本进程: ${errorMessage(err)}` });
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || failureReason != null) return;
      stdoutTotal += chunk.length;
      if (stdoutTotal > SCRIPT_PROBE_MAX_STDOUT_BYTES) {
        failureReason = '输出超限';
        killGroup();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrTotal >= SCRIPT_PROBE_MAX_STDERR_BYTES) return;
      const room = SCRIPT_PROBE_MAX_STDERR_BYTES - stderrTotal;
      stderrChunks.push(chunk.subarray(0, room));
      stderrTotal += Math.min(chunk.length, room);
    });

    child.on('exit', (code) => {
      exitCode = code;
      // 脚本本体已退出：击杀进程组回收仍握着 stdio 管道的后代进程，让 close 立即可达。
      killGroup();
      // 后备落定：正常路径 close 先到（本定时器被 finish 清除）；极端时序下 close 迟到时
      // 按已收集状态出结果，不让成功脚本挂到硬超时被误判成失败。
      exitFallbackTimer = setTimeout(() => settleNow(), EXIT_FALLBACK_SETTLE_MS);
    });

    child.on('close', () => settleNow());
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && code !== '') return code;
    return err.message.slice(0, ERROR_MAX_CHARS);
  }
  return String(err).slice(0, ERROR_MAX_CHARS);
}
