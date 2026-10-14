import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerToolExecutor } from './container-tool-executor.js';
import type { RuntimeEnvelope } from './runtime-channel-protocol.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

function envelopeOf(workspace: string | null, sessionId = 11): RuntimeEnvelope {
  return {
    userId: 7,
    sessionId,
    workspace,
    home: '/tmp',
    runtimeDir: '/tmp/rt',
    gitTokens: {},
    maoToken: null,
    ecpToken: null,
    larkUat: null,
    depsEnv: {},
  };
}

describe('container tool executor', () => {
  it('executesFileToolsInsideSandboxAndRejectsEscapes', async () => {
    const base = useTmpDir('mao-exec-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7', 'projects', 'demo');
    const runtimeDir = join(base, 'runtime');
    const otherUser = join(base, 'users', '8');
    mkdirSync(userWorkspace, { recursive: true });
    mkdirSync(join(runtimeDir, '7'), { recursive: true });
    mkdirSync(otherUser, { recursive: true });
    writeFileSync(join(userWorkspace, 'a.txt'), 'hello container');
    writeFileSync(join(otherUser, 'secret.txt'), 'foreign');

    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir,
      userHomeDir: join(base, 'users', '7'),
      userSkillsDir: join(base, 'userskills', '7'),
    });

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

  it('readBytesEnforcesSandboxAndSizeLimit', () => {
    const base = useTmpDir('mao-exec-bytes-');
    const workspaceRoot = join(base, 'workspace');
    const userWorkspace = join(workspaceRoot, '7');
    mkdirSync(userWorkspace, { recursive: true });
    writeFileSync(join(userWorkspace, 'pic.txt'), 'A'.repeat(100));
    const executor = new ContainerToolExecutor({
      workspaceRoot,
      runtimeDir: join(base, 'runtime'),
      userHomeDir: join(base, 'users', '7'),
      userSkillsDir: join(base, 'userskills', '7'),
    });
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
      userHomeDir: join(base, 'users', '7'),
      userSkillsDir: join(base, 'userskills', '7'),
    });
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
      userHomeDir: join(base, 'users', '7'),
      userSkillsDir: join(base, 'userskills', '7'),
    });
    const read = await executor.handleToolCall('read_file', JSON.stringify({ path: 'leak.txt' }), envelopeOf(userWorkspace));
    expect(JSON.parse(read).error).toBeDefined();
  });
});
