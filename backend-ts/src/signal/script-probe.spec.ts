import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeScriptProbe,
  SCRIPT_PROBE_MAX_STDOUT_BYTES,
} from './script-probe.js';

/**
 * 真实 bash 执行的脚本探针用例（技术方案 §4 步骤 9.1）。
 * 每个用例建独立临时目录放脚本，cwd 即脚本所在目录。
 */

let workDir: string | null = null;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mao-script-probe-'));
});

afterEach(() => {
  if (workDir != null) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function writeScript(name: string, body: string): string {
  const dir = workDir;
  if (dir == null) throw new Error('workDir 未初始化');
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function run(path: string, timeoutSeconds = 10, watcherId = '42'): ReturnType<typeof executeScriptProbe> {
  return executeScriptProbe({
    scriptPath: path,
    timeoutSeconds,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: workDir ?? '/tmp',
      TZ: 'Asia/Shanghai',
      MAO_WATCHER_ID: watcherId,
      MAO_WATCHER_NAME: '演示哨兵',
    },
  });
}

describe('executeScriptProbe', () => {
  it('exit 0：ok=true，stdout 为判定值，exitCode=0', async () => {
    const result = await run(writeScript('ok.sh', "echo 'hello world'\n"));
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
    expect(result.stdoutBytes?.toString('utf8')).toBe('hello world\n');
    expect(result.error).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('非零退出：ok=false，exitCode 照实，error 取 stderr（trim 后）', async () => {
    const result = await run(writeScript('fail.sh', "echo '上游拒绝' >&2\nexit 3\n"));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBeNull();
    expect(result.error).toBe('上游拒绝');
  });

  it('非零退出且无 stderr：error 回落「脚本退出码 N」', async () => {
    const result = await run(writeScript('silent.sh', 'exit 7\n'));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.error).toBe('脚本退出码 7');
  });

  it('超时：SIGKILL 击杀，error 含「执行超时」，exitCode 为 null', async () => {
    const result = await run(writeScript('slow.sh', 'sleep 30\n'), 1);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('执行超时（1s）');
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(900);
  });

  it('stdout 超限：判失败 error=输出超限，不产出部分输出', async () => {
    // 2MB 零字节流，超 1MB 上限即击杀
    const result = await run(
      writeScript('flood.sh', `head -c ${SCRIPT_PROBE_MAX_STDOUT_BYTES * 2} /dev/zero\n`),
      15,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('输出超限');
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBeNull();
    expect(result.stdoutBytes).toBeNull();
  });

  it('stderr 只收集上限字节，error 取收集窗口的尾部且不超 200 字符口径', async () => {
    // stderr 总量约 8.6KB（> 8KB 收集上限）：前 7000 字节是 uniform 的 'a'，
    // 之后是编号 marker 行。error 若取的是收集窗口**头部**会全是 'a'；
    // 取**尾部**则必然含 marker 行——两条断言分别锁住「≤200 字符」与「尾部语义」。
    const body = [
      "head -c 7000 /dev/zero | tr '\\0' 'a' >&2",
      'for i in $(seq 1 60); do echo "mark-line-$i-abcdefghij" >&2; done',
      'exit 1',
      '',
    ].join('\n');
    const result = await run(writeScript('stderr-flood.sh', body), 20);
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    expect((result.error ?? '').length).toBeLessThanOrEqual(200);
    expect(result.error).toContain('mark-line-');
  });

  it('env 白名单注入：脚本能读到 MAO_WATCHER_ID / MAO_WATCHER_NAME', async () => {
    const result = await run(writeScript('env.sh', 'printenv MAO_WATCHER_ID; printenv MAO_WATCHER_NAME\n'));
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('42\n演示哨兵\n');
  });

  it('env 白名单不透传后端进程敏感变量（如 APP_SIGNAL_SECRET 若存在）', async () => {
    const result = await run(writeScript('noenv.sh', 'printenv APP_SIGNAL_SECRET; printenv NODE_ENV; echo done\n'));
    expect(result.ok).toBe(true);
    // 白名单 env 只含 PATH/HOME/TZ/MAO_WATCHER_*：其余变量（含调用方进程自身的）一律为空
    expect(result.stdout).toBe('done\n');
  });

  it('cwd 为脚本所在目录', async () => {
    const result = await run(writeScript('pwd.sh', 'pwd\n'));
    expect(result.ok).toBe(true);
    const cwdOut = result.stdout?.trim() ?? '';
    if (process.platform === 'win32') {
      // msys/git-bash 的 sh 把 Windows 路径打印为 /c/... 或 /tmp/... 形态：比对目录名
      expect(cwdOut.endsWith(basename(workDir!))).toBe(true);
    } else {
      expect(cwdOut).toBe(realpathSync(workDir!));
    }
  });

  it('stdin 关闭：脚本读 stdin 立即得 EOF 而非挂起', async () => {
    const result = await run(
      writeScript('stdin.sh', "if read -t 2 line; then echo \"GOT:$line\"; else echo EOF; fi\n"),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('EOF\n');
  });

  it('脚本本体退出但有后代进程握着 stdio 管道：进程组回收让结果立即返回', async () => {
    // 脚本派生 60s 后台进程再退出；若不整组回收，close 会被管道握住拖到硬超时
    const result = await run(writeScript('stray.sh', '(sleep 60; echo late) &\nexit 0\n'), 3);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    // 未整组回收时会逼近 3s 超时；整组回收下应在 ~1s 内返回
    expect(result.durationMs).toBeLessThan(2500);
  });

  it('脚本文件缺失：bash 以非零退出，判失败', async () => {
    const dir = workDir;
    if (dir == null) throw new Error('workDir 未初始化');
    const result = await run(join(dir, 'missing.sh'));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
  });

  it('脚本路径是目录：bash 非零退出判失败', async () => {
    const dir = workDir;
    if (dir == null) throw new Error('workDir 未初始化');
    const result = await run(dir);
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });
});
