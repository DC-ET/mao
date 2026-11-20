import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

  // msys sh 的 env 变量跨边界翻译在 Windows 打印非原值：断言的是 Linux 部署语义
  it.skipIf(process.platform === 'win32')('执行本人项目内脚本，stdout 字节原样返回，且不继承通道 token', async () => {
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

  // msys sh 的 env 变量跨边界翻译在 Windows 打印非原值：断言的是 Linux 部署语义
  it.skipIf(process.platform === 'win32')('HOME 与 deps 前缀越出本人目录时丢掉，探针仍执行', async () => {
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

  // msys sh 的 env 变量跨边界翻译在 Windows 打印非原值：断言的是 Linux 部署语义
  it.skipIf(process.platform === 'win32')('帧凭据并入子进程 env（GIT_TOKEN_*/token/lark/envVars + askpass），envVars 保留键丢弃', async () => {
    const { projects } = layout();
    const script = writeScript(projects, 'check.sh', [
      'printf "MT=%s\\n" "${MAO_TOKEN-unset}"',
      'printf "ET=%s\\n" "${ECP_TOKEN-unset}"',
      'printf "BU=%s\\n" "${MAO_BASE_URL-unset}"',
      'printf "LU=%s\\n" "${LARKSUITE_CLI_USER_ACCESS_TOKEN-unset}"',
      'printf "LA=%s\\n" "${LARKSUITE_CLI_APP_ID-unset}"',
      'printf "GH=%s\\n" "${GIT_TOKEN_github_com-unset}"',
      'printf "CV=%s\\n" "${CUSTOM_VAR-unset}"',
      'printf "TP=%s\\n" "${GIT_TERMINAL_PROMPT-unset}"',
      'printf "AP=%s\\n" "${GIT_ASKPASS-unset}"',
      'printf "PATH=%s\\n" "$PATH"',
    ].join('\n'));
    const result = await dispatchScriptProbe({
      scriptPath: script,
      timeoutSeconds: 10,
      env: { MAO_WATCHER_ID: '9', MAO_WATCHER_NAME: '磁盘' },
      deps: null,
      credentials: {
        gitTokens: { 'github.com': 'gh-tok' },
        maoToken: 'mao-jwt',
        ecpToken: 'ecp-tok',
        maoBaseUrl: 'https://mao.example.com',
        larkUat: { appId: 'cli_x', uat: 'uat-1' },
        envVars: {
          CUSTOM_VAR: 'v1',
          PATH: '/evil',
          MAO_TOKEN: 'hack',
          'GIT_TOKEN_gitlab_com': 'hack',
        },
      },
    });
    try {
      expect(result.failureClass).toBe('script');
      expect(result.ok).toBe(true);
      const stdout = Buffer.from(result.stdoutBase64 ?? '', 'base64').toString('utf8');
      expect(stdout).toContain('MT=mao-jwt');
      expect(stdout).toContain('ET=ecp-tok');
      expect(stdout).toContain('BU=https://mao.example.com');
      expect(stdout).toContain('LU=uat-1');
      expect(stdout).toContain('LA=cli_x');
      expect(stdout).toContain('GH=gh-tok');
      expect(stdout).toContain('CV=v1');
      expect(stdout).toContain('TP=0');
      // askpass 写在容器私有 /tmp/askpass-{uid}/ 下，0700，内容含 GIT_TOKEN_ 反查逻辑
      const askpassPath = stdout.split('\n').find((line) => line.startsWith('AP='))!.slice(3);
      expect(askpassPath).toContain('/tmp/askpass-7/');
      expect(statSync(askpassPath).mode & 0o777).toBe(0o700);
      expect(readFileSync(askpassPath, 'utf8')).toContain('GIT_TOKEN_');
      // envVars 的保留键双保险：覆盖不了 PATH 与凭据键
      expect(stdout).not.toContain('PATH=/evil');
      expect(stdout).not.toContain('GH=hack');
      expect(stdout).not.toContain('MT=hack');
    } finally {
      rmSync('/tmp/askpass-7', { recursive: true, force: true });
    }
  });

  it('credentials 缺省（旧宿主帧）时不注入任何凭据，探针照常执行', async () => {
    const { projects } = layout();
    const script = writeScript(projects, 'check.sh', [
      'printf "MT=%s\\n" "${MAO_TOKEN-unset}"',
      'printf "ET=%s\\n" "${ECP_TOKEN-unset}"',
      'printf "AP=%s\\n" "${GIT_ASKPASS-unset}"',
      'printf "ID=%s\\n" "$MAO_WATCHER_ID"',
    ].join('\n'));
    const result = await dispatchScriptProbe({
      scriptPath: script,
      timeoutSeconds: 10,
      env: { MAO_WATCHER_ID: '9', MAO_WATCHER_NAME: '磁盘' },
      deps: null,
    });
    expect(result.ok).toBe(true);
    const stdout = Buffer.from(result.stdoutBase64 ?? '', 'base64').toString('utf8');
    expect(stdout).toContain('MT=unset');
    expect(stdout).toContain('ET=unset');
    expect(stdout).toContain('AP=unset');
    expect(stdout).toContain('ID=9');
  });
});
