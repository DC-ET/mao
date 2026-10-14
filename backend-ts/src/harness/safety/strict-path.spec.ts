import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StrictPathResolver } from './strict-path.js';
import { SecurityException } from './path-sandbox.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

describe('StrictPathResolver', () => {
  it('resolvesRelativePathsInsideRoot', () => {
    const base = useTmpDir('mao-strict-');
    const workspace = join(base, 'workspace');
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    writeFileSync(join(workspace, 'sub', 'a.txt'), 'a');
    const resolver = new StrictPathResolver(workspace);
    expect(resolver.resolve('sub/a.txt')).toBe(join(workspace, 'sub', 'a.txt'));
    expect(resolver.resolve('./sub/a.txt')).toBe(join(workspace, 'sub', 'a.txt'));
  });

  it('rejectsRelativeTraversalAndForeignAbsolutePaths', () => {
    const base = useTmpDir('mao-strict-2-');
    const workspace = join(base, 'workspace');
    const outside = join(base, 'outside');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'note.txt'), 'secret');
    const resolver = new StrictPathResolver(workspace);
    expect(() => resolver.resolve('../outside/note.txt')).toThrow(SecurityException);
    expect(() => resolver.resolve(join(outside, 'note.txt'))).toThrow(SecurityException);
    expect(() => resolver.resolve('/etc/passwd')).toThrow(SecurityException);
    expect(() => resolver.resolve('~/secret')).toThrow(SecurityException);
    expect(() => resolver.resolve('')).toThrow(SecurityException);
  });

  it('allowsExtraRootsButNotBeyond', () => {
    const base = useTmpDir('mao-strict-3-');
    const workspace = join(base, 'workspace');
    const userRuntime = join(base, 'runtime', '7');
    const otherRuntime = join(base, 'runtime', '8');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(userRuntime, { recursive: true });
    mkdirSync(otherRuntime, { recursive: true });
    writeFileSync(join(userRuntime, 'own.txt'), 'own');
    writeFileSync(join(otherRuntime, 'foreign.txt'), 'foreign');
    const resolver = new StrictPathResolver(workspace, [userRuntime, '/tmp']);
    expect(resolver.resolve(join(userRuntime, 'own.txt'))).toBe(join(userRuntime, 'own.txt'));
    expect(() => resolver.resolve(join(otherRuntime, 'foreign.txt'))).toThrow(SecurityException);
  });

  it('rejectsSymlinkEscapeInsideWorkspace', () => {
    const base = useTmpDir('mao-strict-4-');
    const workspace = join(base, 'workspace');
    const outside = join(base, 'outside');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'note.txt'), 'secret');
    symlinkSync(join(outside, 'note.txt'), join(workspace, 'leak.txt'));
    const resolver = new StrictPathResolver(workspace);
    expect(() => resolver.resolve('leak.txt')).toThrow(/symlink/);
    // 目录级链接穿越同样拒绝
    symlinkSync(outside, join(workspace, 'dirlink'));
    expect(() => resolver.resolve(join('dirlink', 'note.txt'))).toThrow(/symlink|escape/);
  });

  it('rejectsWorkspaceDirectorySymlinkEscape', () => {
    const base = useTmpDir('mao-strict-5-');
    const realWs = join(base, 'real-workspace');
    const workspace = join(base, 'workspace');
    mkdirSync(realWs, { recursive: true });
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'note.txt'), 'secret');
    symlinkSync(realWs, workspace);
    // 工作区自身是符号链接：primary root realpath 后可达的部分仍放行
    const resolver = new StrictPathResolver(workspace);
    writeFileSync(join(realWs, 'ok.txt'), 'ok');
    expect(resolver.resolve('ok.txt')).toBe(join(workspace, 'ok.txt'));
    // 工作区内符号链接指向外部 → 拒绝
    symlinkSync(outside, join(realWs, 'leak'));
    expect(() => resolver.resolve(join('leak', 'note.txt'))).toThrow(/symlink|escape/);
  });
});

describe('PathSandbox strict mode', () => {
  it('resolveLenientBehavesLikeResolveAndBlocksSymlinkEscape', async () => {
    const { PathSandbox } = await import('./path-sandbox.js');
    const base = useTmpDir('mao-sandbox-');
    const workspace = join(base, 'workspace');
    const runtimeRoot = join(base, 'runtime');
    mkdirSync(join(workspace, 'ws'), { recursive: true });
    mkdirSync(join(runtimeRoot, '7'), { recursive: true });
    const sandbox = new PathSandbox(workspace, { strict: true });
    sandbox.addAllowedRoot(runtimeRoot);
    // 工作区相对路径放行
    expect(sandbox.resolveLenient('ws/a', null)).toBe(join(workspace, 'ws', 'a'));
    // 允许根内绝对路径放行
    expect(sandbox.resolveLenient(join(runtimeRoot, '7', 'x'), null)).toBe(join(runtimeRoot, '7', 'x'));
    // 越界绝对路径拒绝（lenient 在 strict 模式下不再放行）
    expect(() => sandbox.resolveLenient(join(base, 'users', '8', 'secret'), null)).toThrow(SecurityException);
    // 符号链接逃逸拒绝
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'note.txt'), 'secret');
    symlinkSync(join(outside, 'note.txt'), join(workspace, 'leak.txt'));
    expect(() => sandbox.resolveLenient('leak.txt', null)).toThrow(/symlink/);
  });

  it('nonStrictLenientKeepsHostBehavior', async () => {
    const { PathSandbox } = await import('./path-sandbox.js');
    const base = useTmpDir('mao-sandbox-2-');
    const workspace = join(base, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const sandbox = new PathSandbox(workspace);
    // 宿主机模式：resolveLenient 仍放行绝对路径（现状行为零变化）
    expect(sandbox.resolveLenient('/tmp/anything', null)).toBe('/tmp/anything');
  });
});
