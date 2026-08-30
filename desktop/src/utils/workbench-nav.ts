import type { Router } from 'vue-router'

/**
 * 返回工作台。必须用 vue-router（file:// hash 路由下写死 window.location.href 会打错地址）。
 */
export function goBackToWorkbench(router: Router, taskId?: string): void {
  void router.push(taskId ? `/tasks/${taskId}` : '/')
}
