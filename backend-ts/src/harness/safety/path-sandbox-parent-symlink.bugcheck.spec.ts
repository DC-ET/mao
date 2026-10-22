import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PathSandbox, SecurityException } from './path-sandbox.js';

/**
 * 存在性证明：strict 模式（容器内）必须拦住「父目录是符号链接」的逃逸。
 *
 * assertNoSymlinkEscape 只对最终路径本身做 lstat，符号链接出现在中间目录时
 * 目标文件不是链接，直接放行：workspace/link -> /outside 后，link/secret.txt
 * 词法上仍在 workspace 下，实际读到 /outside/secret.txt。
 */
describe('PathSandbox strict 模式父目录符号链接逃逸', () => {
  const root = mkdtempSync(join(tmpdir(), 'mao-sandbox-parent-link-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
  symlinkSync(outside, join(workspace, 'link'), 'dir');
  const sandbox = new PathSandbox(workspace, { strict: true });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('中间目录符号链接指向工作区外时必须拒绝', () => {
    expect(() => sandbox.resolveLenient('link/secret.txt', workspace))
      .toThrow(SecurityException);
  });

  it('对照：普通工作区内相对路径仍可解析', () => {
    expect(sandbox.resolveLenient('normal.txt', workspace))
      .toBe(join(workspace, 'normal.txt'));
  });

  it('对照：最终路径本身是符号链接时已能拦住', () => {
    expect(() => sandbox.resolveLenient('link', workspace)).toThrow(SecurityException);
  });
});
