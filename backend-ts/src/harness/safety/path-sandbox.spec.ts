import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { IllegalArgumentException, PathSandbox, SecurityException } from './path-sandbox.js';

describe('PathSandbox', () => {
  it('resolvesRelativePathsUnderDefaultWorkspace', async () => {
    const dir = useTmpDir('mao-sandbox-');
    const sandbox = new PathSandbox(dir);
    expect(sandbox.resolve('src/../README.md')).toBe(join(dir, 'README.md'));
    expect(sandbox.resolveAsFile('README.md')).toBe(join(dir, 'README.md'));
    expect(sandbox.getWorkspaceRoot()).toBe(dir);
  });

  it('resolvesRelativePathsUnderSessionWorkspace', async () => {
    const dir = useTmpDir('mao-sandbox-');
    const sessionWorkspace = join(dir, 'sessions', '1');
    mkdirSync(sessionWorkspace, { recursive: true });
    const sandbox = new PathSandbox(join(dir, 'default'));
    expect(sandbox.resolve('notes.txt', sessionWorkspace)).toBe(join(sessionWorkspace, 'notes.txt'));
    expect(sandbox.getEffectiveWorkspaceRoot(sessionWorkspace)).toBe(sessionWorkspace);
  });

  it('allowsAbsolutePathsUnderSessionWorkspace', async () => {
    const dir = useTmpDir('mao-sandbox-');
    const sessionWorkspace = join(dir, '2', 'projects', 'mao');
    mkdirSync(join(sessionWorkspace, 'backend'), { recursive: true });
    const sandbox = new PathSandbox(join(dir, 'default'));
    expect(sandbox.resolve(sessionWorkspace, sessionWorkspace)).toBe(sessionWorkspace);
    expect(sandbox.resolve(join(sessionWorkspace, 'backend'), sessionWorkspace)).toBe(join(sessionWorkspace, 'backend'));
  });

  it('allowsAbsolutePathsUnderDefaultWorkspaceRoot', async () => {
    const dir = useTmpDir('mao-sandbox-');
    const sandbox = new PathSandbox(dir);
    const nested = join(dir, 'projects', 'mao');
    expect(sandbox.resolve(nested)).toBe(nested);
  });

  it('rejectsEmptyTildeAndEscapingPaths', async () => {
    const dir = useTmpDir('mao-sandbox-');
    const sandbox = new PathSandbox(dir);
    expect(() => sandbox.resolve('')).toThrow(IllegalArgumentException);
    expect(() => sandbox.resolve('~/secret')).toThrow(SecurityException);
    expect(() => sandbox.resolve('../secret')).toThrow(SecurityException);
    expect(() => sandbox.resolve(join(dir, '..', 'secret'))).toThrow(SecurityException);
  });

  it('allowsRegisteredAbsoluteRoots', async () => {
    const dir = useTmpDir('mao-sandbox-');
    // 必须位于 dir 内部，否则 useTmpDir 清理回调不会删除它
    const allowed = join(dir, 'allowed-root');
    mkdirSync(allowed, { recursive: true });
    const file = join(allowed, 'skill.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'content');
    const sandbox = new PathSandbox(dir);
    sandbox.addAllowedRoot(allowed);
    expect(sandbox.resolve(file)).toBe(file);
  });

  it('gives dedicated messages for another member runtime/uploads paths', () => {
    const dir = useTmpDir('mao-sandbox-');
    const runtimeRoot = join(dir, 'runtime');
    const uploadDir = join(dir, 'uploads');
    const workspace = join(dir, 'workspace', '67');
    mkdirSync(workspace, { recursive: true });
    const sandbox = new PathSandbox(workspace, {
      strict: true,
      identity: { runtimeRoot, uploadDir, userId: 67 },
    });
    expect(() => sandbox.resolve(join(runtimeRoot, '17', '1607', 'skills', 'x', 'SKILL.md')))
      .toThrow(/其他用户的会话运行目录（当前执行身份 67）/);
    expect(() => sandbox.resolve(join(uploadDir, '17', 'gen.png')))
      .toThrow(/其他成员的产物目录（当前执行身份 67）/);
    // 与身份无关的越界保持原文案；非 uid 首段（平台平坦文件 / releases 目录）不做跨成员归因
    expect(() => sandbox.resolve(join(dir, 'elsewhere', 'x.txt')))
      .toThrow(/^Path escape attempt: /);
    expect(() => sandbox.resolve(join(uploadDir, 'releases', 'latest.yml')))
      .toThrow(/^Path escape attempt: /);
    expect(() => sandbox.resolve(join(runtimeRoot, 'channels', 'x.sock')))
      .toThrow(/^Path escape attempt: /);
  });

  it('keeps the generic escape message when identity is absent', () => {
    const dir = useTmpDir('mao-sandbox-');
    const sandbox = new PathSandbox(join(dir, 'workspace', '67'), { strict: true });
    expect(() => sandbox.resolve(join(dir, 'runtime', '17', 'x')))
      .toThrow(/^Path escape attempt: /);
  });
});
