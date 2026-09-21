import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

/**
 * 测试专用临时目录：自动注册清理回调，测试结束（含失败）后递归删除，
 * 避免 /tmp 下 mao-* 目录随 CI 次数无限累积。
 *
 * 用法（替代 mkdtemp(join(tmpdir(), 'mao-xxx-'))）：
 *   const dir = useTmpDir('mao-file-tools-');
 *   // dir 已创建，测试结束后自动删除，无需手动 rmSync
 *
 * 实现说明：vitest 的 afterEach 必须在用例执行前注册才生效，
 * 而本函数是在用例体内调用的，因此使用 onTestFinished —— 它专为
 * 「测试运行中登记清理回调」设计，用例结束后立即执行。
 */
export function useTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
