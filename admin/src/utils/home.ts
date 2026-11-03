/**
 * 登录后的落地页，也是 Logo / 「返回首页」的目标。有用量分析权限进该页，否则按已有权限落到首个可用页面。
 * isHidden：部署级被隐藏的菜单（menuStore.isHidden），降级链跳过隐藏项，避免落到菜单里不存在的页面。
 */
export function pickHomePath(
  hasPermission: (permission: string) => boolean,
  isHidden: (index: string) => boolean = () => false
): string {
  if (hasPermission('analytics:read') && !isHidden('/analytics')) return '/analytics'
  if (hasPermission('session:read') && !isHidden('/sessions')) return '/sessions'
  if (hasPermission('agent:read') && !isHidden('/agents')) return '/agents'
  if (hasPermission('user:read') && !isHidden('/users')) return '/users'
  if (hasPermission('settings:read') && !isHidden('/settings')) return '/settings'
  if (hasPermission('model:read') && !isHidden('/models')) return '/models'
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
