import { describe, expect, it, vi } from 'vitest';
import { mcpWhitelistEnv } from '../../mcp/mcp-client-manager.js';
import { loadSendFileBytes, readLocalBytes } from './send-file-bytes.js';
import { StrictPathResolver } from '../../safety/strict-path.js';
import { SecurityException } from '../../safety/path-sandbox.js';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('mcp stdio env whitelist', () => {
  it('inheritsOnlyWhitelistedKeysAndMergesServerEnv', () => {
    const prev = { ...process.env };
    try {
      Object.assign(process.env, {
        MYSQL_URL: 'mysql://root:secret@127.0.0.1/mao',
        APP_GIT_CREDENTIAL_SECRET: 'k1',
        JWT_SECRET: 'k2',
        GIT_TOKEN_GITHUB_COM: 'ghp_x',
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
      });
      const env = mcpWhitelistEnv({ FOO: 'bar' });
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.LANG).toBe('en_US.UTF-8');
      expect(env.FOO).toBe('bar');
      expect(env.MYSQL_URL).toBeUndefined();
      expect(env.APP_GIT_CREDENTIAL_SECRET).toBeUndefined();
      expect(env.JWT_SECRET).toBeUndefined();
      expect(env.GIT_TOKEN_GITHUB_COM).toBeUndefined();
    } finally {
      for (const key of ['MYSQL_URL', 'APP_GIT_CREDENTIAL_SECRET', 'JWT_SECRET', 'GIT_TOKEN_GITHUB_COM', 'PATH', 'LANG']) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  });
});

describe('send-file bytes loading', () => {
  it('strictlyRejectsForeignPathsAndAllowsUserRoots', async () => {
    const base = useTmpDir('mao-sendbytes-');
    const workspace = join(base, 'workspace', '7');
    const foreign = join(base, 'users', '8');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(workspace, 'a.txt'), 'local');
    writeFileSync(join(foreign, 'secret.txt'), 'foreign');
    const sandbox = { getEffectiveWorkspaceRoot: () => workspace } as never;

    // 工作区内可读
    const ok = await readLocalBytes('a.txt', sandbox, [], workspace, 1024);
    expect(ok.toString()).toBe('local');

    // 他人目录拒绝
    await expect(readLocalBytes(join(foreign, 'secret.txt'), sandbox, [], workspace, 1024))
      .rejects.toThrow(SecurityException);
    // 相对穿越拒绝
    await expect(readLocalBytes('../8/secret.txt', sandbox, [], workspace, 1024))
      .rejects.toThrow(SecurityException);
    // 额外根（当前用户 runtime）可读
    const runtime = join(base, 'runtime', '7');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'out.bin'), 'rt');
    const rt = await readLocalBytes(join(runtime, 'out.bin'), sandbox, [runtime], workspace, 1024);
    expect(rt.toString()).toBe('rt');
  });

  it('跨成员预检先于容器分发：命中时不调用 readBytes（docker 用户也能拿到可执行文案）', async () => {
    const base = useTmpDir('mao-sendbytes-precheck-');
    const workspace = join(base, 'workspace', '7');
    mkdirSync(workspace, { recursive: true });
    const sandbox = { getEffectiveWorkspaceRoot: () => workspace } as never;
    const readBytes = vi.fn(async () => Buffer.from('should-not-be-read'));
    const support = {
      readBytes,
      extraRoots: vi.fn(() => []),
      foreignPathMessage: vi.fn(async () => 'FOREIGN-MEMBER-MESSAGE'),
    };
    const foreignPath = join(base, 'uploads', '17', 'gen.png');

    await expect(loadSendFileBytes(foreignPath, sandbox, support, { userId: 67, sessionId: 11, workspace }, 1024))
      .rejects.toThrow('FOREIGN-MEMBER-MESSAGE');
    // 关键不变量：命中预检时容器读取不得被调用（否则 docker 用户先拿容器通用错误）
    expect(readBytes).not.toHaveBeenCalled();
    expect(support.foreignPathMessage).toHaveBeenCalledWith(foreignPath, 67, null);

    // 预检不命中时才走容器读取
    support.foreignPathMessage.mockResolvedValue(null);
    const bytes = await loadSendFileBytes('a.txt', sandbox, support, { userId: 67, sessionId: 11, workspace }, 1024);
    expect(bytes.toString()).toBe('should-not-be-read');
    expect(readBytes).toHaveBeenCalled();
  });

  it('预检透传 pathPolicyHint（edit_image 的行为提示）', async () => {
    const base = useTmpDir('mao-sendbytes-hint-');
    const workspace = join(base, 'workspace', '7');
    mkdirSync(workspace, { recursive: true });
    const sandbox = { getEffectiveWorkspaceRoot: () => workspace } as never;
    const support = {
      readBytes: vi.fn(async () => Buffer.from('x')),
      extraRoots: vi.fn(() => []),
      foreignPathMessage: vi.fn(async () => 'MSG'),
    };
    await expect(loadSendFileBytes('/opt/mao-data/uploads/17/gen.png', sandbox, support, {
      userId: 67, sessionId: 11, workspace, pathPolicyHint: '改图请重新生成，或由该成员本人操作',
    }, 1024)).rejects.toThrow('MSG');
    expect(support.foreignPathMessage).toHaveBeenCalledWith(
      '/opt/mao-data/uploads/17/gen.png', 67, '改图请重新生成，或由该成员本人操作',
    );
  });

  it('loadSendFileBytesPrefersContainerAndKeepsUrlOnHost', async () => {
    const base = useTmpDir('mao-sendbytes-2-');
    const workspace = join(base, 'workspace', '7');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'a.txt'), 'container-bytes');
    const sandbox = { getEffectiveWorkspaceRoot: () => workspace } as never;

    // 容器分支命中：不落本地读取
    const support = {
      readBytes: vi.fn(async () => Buffer.from('container-bytes')),
      extraRoots: vi.fn(() => []),
    };
    const bytes = await loadSendFileBytes('a.txt', sandbox, support, { userId: 7, sessionId: 11, workspace }, 1024);
    expect(bytes.toString()).toBe('container-bytes');
    expect(support.readBytes).toHaveBeenCalled();

    // 非容器用户：readBytes 返回 null → 降级本地严格读
    const hostSupport = {
      readBytes: vi.fn(async () => null),
      extraRoots: vi.fn(() => []),
    };
    const local = await loadSendFileBytes('a.txt', sandbox, hostSupport, { userId: 7, sessionId: 11, workspace }, 1024);
    expect(local.toString()).toBe('container-bytes');

    // 容器分支抛错（容器内文件缺失）不静默降级
    const failingSupport = {
      readBytes: vi.fn(async () => { throw new Error('文件不存在：/tmp/none.txt'); }),
      extraRoots: vi.fn(() => []),
    };
    await expect(loadSendFileBytes('/tmp/none.txt', sandbox, failingSupport, { userId: 7, sessionId: 11, workspace }, 1024))
      .rejects.toThrow('文件不存在');
  });

  it('strictResolverRejectsSymlinkEscape', () => {
    const base = useTmpDir('mao-sendbytes-3-');
    const workspace = join(base, 'workspace', '7');
    const outside = join(base, 'outside');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'note.txt'), 'secret');
    symlinkSync(join(outside, 'note.txt'), join(workspace, 'leak.txt'));
    const resolver = new StrictPathResolver(workspace);
    expect(() => resolver.resolve('leak.txt')).toThrow(/symlink/);
  });
});
