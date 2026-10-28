import { ref, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { WorkspaceGitProvider } from './workspace-git-provider'
import type { GitOperationResult, GitStashAction } from '../types/git'

/** 写操作集合：commit/pull/push 侧边栏与大 Tab 共用；fetch/switch/stash 仅大 Tab。 */
export type GitWriteOperation = 'commit' | 'pull' | 'push' | 'fetch' | 'switch' | 'stash'

/** 各写操作的入参元组（与 WorkspaceGitProvider 对应方法的签名一致）。 */
interface GitWriteOperationArgs {
  commit: [repoPath?: string]
  pull: [repoPath?: string]
  push: [repoPath?: string]
  fetch: [repoPath?: string]
  switch: [branch: string, opts?: { create?: boolean }, repoPath?: string]
  stash: [action: GitStashAction, ref: string, repoPath?: string]
}

const OPERATION_LABELS: Record<GitWriteOperation, string> = {
  commit: '提交',
  pull: '拉取',
  push: '推送',
  fetch: '获取远端更新',
  switch: '切换分支',
  stash: 'stash 操作',
}

function successMessage(operation: GitWriteOperation, result: GitOperationResult): string {
  if (operation === 'commit' && result.commitHash && result.commitTitle) {
    return `提交成功 ${result.commitHash}：${result.commitTitle}`
  }
  return result.message || `${OPERATION_LABELS[operation]}成功`
}

/**
 * Git 写操作的运行态与 toast 文案（从 TaskInspector.runGitOperation 抽取，侧边栏与大 Tab 共用）：
 * - 全局防重入（operation 非空时直接返回 null）；
 * - 成功 / 失败 toast 文案与侧边栏历史口径完全一致（提交成功含短哈希与标题）；
 * - 只负责运行与提示，不触发数据刷新——刷新时机由调用方决定（侧边栏 refreshAll、
 *   大 Tab refreshAll + 当前视图刷新），避免两处刷新策略漂移。
 */
export function useGitOperations(provider: Ref<WorkspaceGitProvider | null>) {
  const operation = ref<GitWriteOperation | null>(null)

  async function run<K extends GitWriteOperation>(
    op: K,
    ...args: GitWriteOperationArgs[K]
  ): Promise<GitOperationResult | null> {
    const p = provider.value
    if (!p || operation.value) return null
    operation.value = op
    try {
      let result: GitOperationResult
      if (op === 'commit') result = await p.commit(...(args as GitWriteOperationArgs['commit']))
      else if (op === 'pull') result = await p.pull(...(args as GitWriteOperationArgs['pull']))
      else if (op === 'push') result = await p.push(...(args as GitWriteOperationArgs['push']))
      else if (op === 'fetch') result = await p.fetchRemote(...(args as GitWriteOperationArgs['fetch']))
      else if (op === 'switch') result = await p.switchBranch(...(args as GitWriteOperationArgs['switch']))
      else result = await p.stashOp(...(args as GitWriteOperationArgs['stash']))
      if (result.success) {
        ElMessage.success(successMessage(op, result))
      } else {
        ElMessage.error(result.error || 'Git 操作失败')
      }
      return result
    } catch (error) {
      const err = error as Error & { toastShown?: boolean }
      if (!err.toastShown) ElMessage.error(err.message || 'Git 操作失败')
      return null
    } finally {
      operation.value = null
    }
  }

  return { operation, run }
}
