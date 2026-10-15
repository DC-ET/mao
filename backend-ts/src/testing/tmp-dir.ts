import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';

/**
 * 测试专用临时目录：自动注册清理回调，测试结束（含失败）后递归删除，
 * 避免 .tmp-test 下 mao-* 目录随 CI 次数无限累积。
 *
 * 用法（替代 mkdtemp(join(tmpdir(), 'mao-xxx-'))）：
 *   const dir = useTmpDir('mao-file-tools-');
 *   // dir 已创建，测试结束后自动删除，无需手动 rmSync
 *
 * 为什么默认不放 os.tmpdir()（/tmp）：/tmp 是严格路径解析的允许根
 * （StrictPathResolver 的 extraRoots、ContainerToolExecutor 构造时
 * addAllowedRoot('/tmp')、DockerSendBytesBridge.extraRoots() 第一个根），
 * 夹具落在 /tmp 会让「必须拒绝越界」的断言恒不成立。
 *
 * 实现说明：vitest 的 afterEach 必须在用例执行前注册才生效，而本函数是在
 * 用例体内调用的，因此使用 onTestFinished —— 它专为「测试运行中登记清理
 * 回调」设计，用例结束后立即执行。
 */
const IN_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp-test');

function withAutoCleanup(dir: string): string {
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 默认夹具：仓库内 backend-ts/.tmp-test/<prefix>xxxx（MAO_TEST_TMP_DIR 可覆盖根目录）。 */
export function useTmpDir(prefix: string): string {
  const root = process.env.MAO_TEST_TMP_DIR ?? IN_REPO_ROOT;
  mkdirSync(root, { recursive: true });
  return withAutoCleanup(mkdtempSync(join(root, prefix)));
}

/**
 * 仓库外夹具：仅供「目录不能落在任何 git 仓库内」的用例（git 状态探测、
 * 环境信息探测）使用 —— 这类断言只看版本库边界，与路径沙箱允许根无关，
 * 因此放系统临时目录即可；放进仓库内会向上发现 .git 使断言翻转。
 */
export function useTmpDirOutsideRepo(prefix: string): string {
  return withAutoCleanup(mkdtempSync(join(tmpdir(), prefix)));
}
