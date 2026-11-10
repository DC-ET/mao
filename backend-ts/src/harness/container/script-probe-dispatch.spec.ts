import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchScriptProbe } from './script-probe-dispatch.js';

const ENV_KEYS = ['MAO_CONTAINER_USER_ID', 'MAO_WORKSPACE_ROOT', 'MAO_USER_HOME_DIR', 'MAO_DEPS_DIR', 'MAO_CHANNEL_TOKEN'] as const;

describe('dispatchScriptProbe', () => {
  let root: string;
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  function layout(): { projects: string; home: string; depsBin: string } {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    root = mkdtempSync(join(tmpdir(), 'mao-probe-dispatch-'));
    const projects = join(root, 'workspace', '7', 'projects');
    const home = join(root, 'users', '7');
    const depsBin = join(root, 'deps', '7', 'npm', 'bin');
    mkdirSync(projects, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(depsBin, { recursive: true });
    process.env.MAO_CONTAINER_USER_ID = '7';
    process.env.MAO_WORKSPACE_ROOT = join(root, 'workspace');
    process.env.MAO_USER_HOME_DIR = join(root, 'users');
    process.env.MAO_DEPS_DIR = join(root, 'deps');
    process.env.MAO_CHANNEL_TOKEN = 'channel-secret';
    return { projects, home, depsBin };
  }

  function writeScript(dir: string, name: string, body: string): string {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  }

  it('执行本人项目内脚本，stdout 字节原样返回，且不继承通道 token', async () => {
    const { projects, home, depsBin } = layout();
    const script = writeScript(projects, 'check.sh', [
      'printf "PATH=%s\\n" "$PATH"',
      'printf "TOKEN=%s\\n" "${MAO_CHANNEL_TOKEN-unset}"',
      'printf "HOME=%s\\n" "${HOME-unset}"',
      'printf "ID=%s\\n" "$MAO_WATCHER_ID"',
      'printf "NPM=%s\\n" "${NPM_CONFIG_PREFIX-unset}"',
    ].join('\n'));
    const result = await dispatchScriptProbe({
      scriptPath: script,
      timeoutSeconds: 10,
      env: {
        HOME: home,
        TZ: 'Asia/Shanghai',
        MAO_WATCHER_ID: '42',
        MAO_WATCHER_NAME: '磁盘',
        PATH: '/evil',
      } as never,
      deps: {
        NPM_CONFIG_PREFIX: join(root, 'deps', '7', 'npm'),
        PIP_TARGET: join(root, 'deps', '7', 'py'),
        PIP_BREAK_SYSTEM_PACKAGES: '1',
        MAO_DEPS_BIN: depsBin,
      },
    });
    expect(result.failureClass).toBe('script');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const stdout = Buffer.from(result.stdoutBase64 ?? '', 'base64').toString('utf8');
    expect(stdout).toContain('TOKEN=unset');
    expect(stdout).toContain('ID=42');
    expect(stdout).toContain(`HOME=${realpathSync(home)}`);
    expect(stdout).toContain(`NPM=${realpathSync(join(root, 'deps', '7', 'npm'))}`);
    expect(stdout).not.toContain('PATH=/evil');
    expect(stdout.startsWith(`PATH=${realpathSync(depsBin)}:`)).toBe(true);
  });

  it('软链逃出项目工作区时判脚本失败，不执行', async () => {
    const { projects } = layout();
    const outside = mkdtempSync(join(tmpdir(), 'mao-probe-outside-'));
    try {
      const target = join(outside, 'evil.sh');
      writeFileSync(target, 'printf pwned\n');
      const link = join(projects, 'check.sh');
      symlinkSync(target, link);
      const result = await dispatchScriptProbe({
        scriptPath: link,
        timeoutSeconds: 10,
        env: { MAO_WATCHER_ID: '1', MAO_WATCHER_NAME: 'n' },
        deps: null,
      });
      expect(result.failureClass).toBe('script');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('越出项目工作区');
      expect(result.stdoutBase64).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('HOME 与 deps 前缀越出本人目录时丢掉，探针仍执行', async () => {
    const { projects } = layout();
    const outside = mkdtempSync(join(tmpdir(), 'mao-probe-home-'));
    try {
      mkdirSync(outside, { recursive: true });
      const script = writeScript(projects, 'check.sh', 'printf "HOME=%s NPM=%s\\n" "${HOME-unset}" "${NPM_CONFIG_PREFIX-unset}"\n');
      const result = await dispatchScriptProbe({
        scriptPath: script,
        timeoutSeconds: 10,
        env: { HOME: outside, MAO_WATCHER_ID: '1', MAO_WATCHER_NAME: 'n' },
        deps: {
          NPM_CONFIG_PREFIX: outside,
          PIP_TARGET: outside,
          PIP_BREAK_SYSTEM_PACKAGES: 'nope',
          MAO_DEPS_BIN: outside,
        },
      });
      expect(result.ok).toBe(true);
      const stdout = Buffer.from(result.stdoutBase64 ?? '', 'base64').toString('utf8');
      expect(stdout).toContain('HOME=unset');
      expect(stdout).toContain('NPM=unset');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('缺少容器身份或哨兵标识时不执行，记基础设施失败', async () => {
    layout();
    delete process.env.MAO_CONTAINER_USER_ID;
    const missingUser = await dispatchScriptProbe({
      scriptPath: '/tmp/nope.sh',
      timeoutSeconds: 10,
      env: { MAO_WATCHER_ID: '1', MAO_WATCHER_NAME: 'n' },
      deps: null,
    });
    expect(missingUser).toMatchObject({ failureClass: 'infrastructure', error: '容器身份缺失' });
    process.env.MAO_CONTAINER_USER_ID = '7';
    const missingName = await dispatchScriptProbe({
      scriptPath: '/tmp/nope.sh',
      timeoutSeconds: 10,
      env: { MAO_WATCHER_ID: '1' },
      deps: null,
    });
    expect(missingName).toMatchObject({ failureClass: 'infrastructure', error: '探针参数不完整' });
  });
});
