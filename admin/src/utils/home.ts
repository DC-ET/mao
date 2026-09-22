/** 登录后的落地页，也是 Logo / 「返回首页」的目标。管理员进用量分析，其余按已有权限落到首个可用页面。 */
export function pickHomePath(isAdmin: boolean, hasPermission: (permission: string) => boolean): string {
  if (isAdmin) return '/analytics'
  if (hasPermission('session:read')) return '/sessions'
  if (hasPermission('agent:read')) return '/agents'
  if (hasPermission('user:read')) return '/users'
  if (hasPermission('settings:read')) return '/settings'
  if (hasPermission('model:read')) return '/models'
  return '/forbidden'
}

export function homeTitle(path: string): string {
  switch (path) {
    case '/analytics': return '用量分析'
    case '/sessions': return '会话管理'
    case '/agents': return 'Agent 管理'
    case '/users': return '用户管理'
    case '/settings': return '系统设置'
    case '/models': return '模型管理'
    default: return '首页'
  }
}
