import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { IllegalArgumentException, PathSandbox, SecurityException } from './path-sandbox.js';

describe('PathSandbox', () => {
  it('resolvesRelativePathsUnderDefaultWorkspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-sandbox-'));
    const sandbox = new PathSandbox(dir);
    expect(sandbox.resolve('src/../README.md')).toBe(join(dir, 'README.md'));
    expect(sandbox.resolveAsFile('README.md')).toBe(join(dir, 'README.md'));
    expect(sandbox.getWorkspaceRoot()).toBe(dir);
  });

  it('resolvesRelativePathsUnderSessionWorkspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-sandbox-'));
    const sessionWorkspace = join(dir, 'sessions', '1');
    mkdirSync(sessionWorkspace, { recursive: true });
    const sandbox = new PathSandbox(join(dir, 'default'));
    expect(sandbox.resolve('notes.txt', sessionWorkspace)).toBe(join(sessionWorkspace, 'notes.txt'));
    expect(sandbox.getEffectiveWorkspaceRoot(sessionWorkspace)).toBe(sessionWorkspace);
  });

  it('allowsAbsolutePathsUnderSessionWorkspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-sandbox-'));
    const sessionWorkspace = join(dir, '2', 'projects', 'mao');
    mkdirSync(join(sessionWorkspace, 'backend'), { recursive: true });
    const sandbox = new PathSandbox(join(dir, 'default'));
    expect(sandbox.resolve(sessionWorkspace, sessionWorkspace)).toBe(sessionWorkspace);
    expect(sandbox.resolve(join(sessionWorkspace, 'backend'), sessionWorkspace)).toBe(join(sessionWorkspace, 'backend'));
  });

  it('allowsAbsolutePathsUnderDefaultWorkspaceRoot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-sandbox-'));
    const sandbox = new PathSandbox(dir);
    const nested = join(dir, 'projects', 'mao');
    expect(sandbox.resolve(nested)).toBe(nested);
  });

  it('rejectsEmptyTildeAndEscapingPaths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-sandbox-'));
    const sandbox = new PathSandbox(dir);
    expect(() => sandbox.resolve('')).toThrow(IllegalArgumentException);
    expect(() => sandbox.resolve('~/secret')).toThrow(SecurityException);
    expect(() => sandbox.resolve('../secret')).toThrow(SecurityException);
    expect(() => sandbox.resolve(join(dir, '..', 'secret'))).toThrow(SecurityException);
  });

  it('allowsRegisteredAbsoluteRoots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-sandbox-'));
    const allowed = dir + '-allowed';
    mkdirSync(allowed, { recursive: true });
    const file = join(allowed, 'skill.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'content');
    const sandbox = new PathSandbox(dir);
    sandbox.addAllowedRoot(allowed);
    expect(sandbox.resolve(file)).toBe(file);
  });
});
