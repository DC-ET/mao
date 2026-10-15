import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerToolExecutor } from './container-tool-executor.js';
import type { RuntimeEnvelope } from './runtime-channel-protocol.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

const USER_ID = 7;

function envelopeOf(workspace: string | null, sessionId = 11, depsEnv: Record<string, string> = {}): RuntimeEnvelope {
  return {
    userId: USER_ID,
    sessionId,
    workspace,
    home: '/tmp',
    runtimeDir: '/tmp/rt',
    gitTokens: {},
    maoToken: null,
    ecpToken: null,
    larkUat: null,
    depsEnv,
  };
}

describe('container tool executor', () => {
  it('executesFileToolsInsideSandboxAndRejectsEscapes', async () => {
    const base = useTmpDir('mao-exec-');
    // roots 用生产口径的全局父目录（宿主机配置原值，绝对路径与容器内一致）
    const workspaceRoot = join(base, 'workspace');
    const runtimeDir = join(base, 'runtime');
    const userHomeDir = join(base, 'users');
    const userSkillsDir = join(base, 'userskills');
    const userWorkspace = join(workspaceRoot, '7', 'projects', 'demo');
    const otherUser = join(userHomeDir, '8');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(join(runtimeDir, '7'), { recursive: true });
    mkdirSync(otherUser, { recursive: true });
    writeFileSync(join(userWorkspace, 'a.txt'), 'hello container');
    writeFileSync(join(otherUser, 'secret.txt'), 'foreign');

    const executor = new ContainerToolExecutor({ workspaceRoot, runtimeDir, userHomeDir, userSkillsDir }, USER_ID);

    // read_file 工作区相对路径
    const read = await executor.handleToolCall('read_file', JSON.stringify({ path: 'a.txt' }), envelopeOf(userWorkspace));
    expect(JSON.parse(read).content).toBe('hello container');

    // write_file 工作区内（返回 success 结构而非 content）
    const write = await executor.handleToolCall('write_file', JSON.stringify({ path: 'b.txt', content: 'written' }), envelopeOf(userWorkspace));
    expect(JSON.parse(write).success).toBe(true);
    expect(readFileSync(join(userWorkspace, 'b.txt'), 'utf8')).toBe('written');

    // 越界绝对路径拒绝（容器内严格 resolve）
    const escape = await executor.handleToolCall('read_file', JSON.stringify({ path: join(otherUser, 'secret.txt') }), envelopeOf(userWorkspace));
    expect(JSON.parse(escape).error).toBeDefined();

    // 相对穿越拒绝
    const traverse = await executor.handleToolCall('read_file', JSON.stringify({ path: '../8/secret.txt' }), envelopeOf(userWorkspace));
    expect(JSON.parse(traverse).error).toBeDefined();

    // glob_search 越界拒绝
    const glob = await executor.handleToolCall('glob_search', JSON.stringify({ pattern: '**/*.txt', path: otherUser }), envelopeOf(userWorkspace));
    expect(JSON.parse(glob).error).toBeDefined();
  });

  it('allowsOnlyPerUserRootsNotGlobalParents', async () => {
    // BUG-11 回归：允许根必须是每用户子目录，全局父目录（users/8、runtime/8、userskills/8）一律拒绝
    const base = useTmpDir('mao-exec-peruser-');
    const workspaceRoot = join(base, 'workspace');
    const runtimeDir = join(base, 'runtime');
    const userHomeDir = join(base, 'users');
    const userSkillsDir = join(base, 'userskills');
    const userWorkspace = join(workspaceRoot, '7');
    mkdirSync(userWorkspace, { recursive: true });
    for (const dir of [join(runtimeDir, '8'), otherHome(userHomeDir), join(userSkillsDir, '8'), join(workspaceRoot, '8')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'secret.txt'), 'foreign');
    }
    const executor = new ContainerToolExecutor({ workspaceRoot, runtimeDir, userHomeDir, userSkillsDir }, USER_ID);
    const env = envelopeOf(userWorkspace);

    for (const path of [
      join(runtimeDir, '8', 'secret.txt'),
      join(userHomeDir, '8', 'secret.txt'),
      join(userSkillsDir, '8', 'secret.txt'),
      join(workspaceRoot, '8', 'secret.txt'),
    ]) {
      const read = await executor.handleToolCall('read_file', JSON.stringify({ path }), env);
      expect(JSON.parse(read).error, `expected rejection for ${path}`).toBeDefined();
    }

    // 自己的每用户根照常放行
    mkdirSync(join(userHomeDir, '7'), { recursive: true });
    writeFileSync(join(userHomeDir, '7', 'mine.txt'), 'mine');
    const own = await executor.handleToolCall('read_file', JSON.stringify({ path: join(userHomeDir, '7', 'mine.txt') }), env);
    expect(JSON.parse(own).content).toBe('mine');
  });

  it('readBytesEnforcesSandboxAndSizeLimit', () => {
    const base = useTmpDir('mao-exec-bytes-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    mkdirSync(userWorkspace, { recursive: true });
    writeFileSync(join(userWorkspace, 'pic.txt'), 'A'.repeat(100));
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
    }, USER_ID);
    const env = envelopeOf(userWorkspace);

    const ok = executor.handleReadBytes('pic.txt', 1000, env);
    expect(ok.ok).toBe(true);
    expect(Buffer.from((ok as { base64: string }).base64, 'base64').length).toBe(100);

    const tooBig = executor.handleReadBytes('pic.txt', 10, env);
    expect(tooBig.ok).toBe(false);

    const missing = executor.handleReadBytes('nope.txt', 1000, env);
    expect(missing.ok).toBe(false);

    // /tmp 在容器内允许根（§5.6）
    writeFileSync('/tmp/mao-exec-tmpfile', 'tmp-bytes');
    try {
      const tmp = executor.handleReadBytes('/tmp/mao-exec-tmpfile', 1000, env);
      expect(tmp.ok).toBe(true);
    } finally {
      rmSync('/tmp/mao-exec-tmpfile', { force: true });
    }
  });

  it('shellToolRejectsForeignWorkdirInStrictMode', async () => {
    const base = useTmpDir('mao-exec-shell-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    const otherUser = join(base, 'users', '8');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(otherUser, { recursive: true });
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
    }, USER_ID);
    // workdir 越界（他人目录）被严格 resolve 拒绝
    const result = await executor.handleToolCall('shell', JSON.stringify({
      action: 'exec', command: 'pwd', workdir: otherUser,
    }), envelopeOf(userWorkspace));
    expect(JSON.parse(result).error).toBeDefined();
  });

  it('handlesSymlinkEscapeInWorkspace', async () => {
    const base = useTmpDir('mao-exec-link-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    const outside = join(base, 'outside');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'note.txt'), 'secret');
    symlinkSync(join(outside, 'note.txt'), join(userWorkspace, 'leak.txt'));
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
    }, USER_ID);
    const read = await executor.handleToolCall('read_file', JSON.stringify({ path: 'leak.txt' }), envelopeOf(userWorkspace));
    expect(JSON.parse(read).error).toBeDefined();
  });

  it('injectsDepsEnvIntoShellSessions', async () => {
    // BUG-8 回归：§5.13 deps env 必须到达容器内 shell 子进程（npm/pip 安装落到 /deps 挂载）
    const base = useTmpDir('mao-exec-deps-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    const depsUserDir = join(base, 'deps', '7');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(join(depsUserDir, 'npm', 'bin'), { recursive: true });
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users'),
      userSkillsDir: join(base, 'userskills'),
    }, USER_ID);
    const depsEnv = {
      NPM_CONFIG_PREFIX: join(depsUserDir, 'npm'),
      PIP_TARGET: join(depsUserDir, 'py'),
      PIP_BREAK_SYSTEM_PACKAGES: '1',
      MAO_DEPS_BIN: join(depsUserDir, 'npm', 'bin'),
    };
    const result = await executor.handleToolCall('shell', JSON.stringify({
      action: 'exec',
      command: 'echo "NPM=[$NPM_CONFIG_PREFIX] PIP=[$PIP_TARGET] BRK=[$PIP_BREAK_SYSTEM_PACKAGES] BIN=[$MAO_DEPS_BIN] PATH=[$PATH]"',
      yield_time_ms: 8000,
    }), envelopeOf(userWorkspace, 11, depsEnv));
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeUndefined();
    expect(parsed.output).toContain(`NPM=[${depsEnv.NPM_CONFIG_PREFIX}]`);
    expect(parsed.output).toContain(`PIP=[${depsEnv.PIP_TARGET}]`);
    expect(parsed.output).toContain('BRK=[1]');
    // deps bin 前置进 PATH
    expect(parsed.output).toContain(`BIN=[${depsEnv.MAO_DEPS_BIN}]`);
    expect(parsed.output).toContain(`PATH=[${depsEnv.MAO_DEPS_BIN}:`);
  });
});

function otherHome(userHomeDir: string): string {
  return join(userHomeDir, '8');
}
