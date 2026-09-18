import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'

/** 首页：管理员进用量分析；非管理员按已有权限落到首个可用页面 */
function pickHomePath(isAdmin: boolean, hasPermission: (p: string) => boolean): string {
  if (isAdmin) return '/analytics'
  if (hasPermission('session:read')) return '/sessions'
  if (hasPermission('agent:read')) return '/agents'
  if (hasPermission('user:read')) return '/users'
  if (hasPermission('settings:read')) return '/settings'
  return '/forbidden'
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/auth/LoginView.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/auth/ecp/feishu-callback',
    name: 'EcpFeishuCallback',
    component: () => import('../views/auth/EcpFeishuCallbackView.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/',
    name: 'Layout',
    component: () => import('../components/Layout.vue'),
    redirect: '/analytics',
    children: [
      {
        path: 'agents',
        name: 'Agents',
        component: () => import('../views/agent/AgentListView.vue'),
        meta: { title: 'Agent 管理', keepAlive: true, permission: 'agent:read' }
      },
      {
        path: 'models',
        name: 'Models',
        component: () => import('../views/model/ModelListView.vue'),
        meta: { title: '模型管理', keepAlive: true, permission: 'model:read' }
      },
      {
        path: 'users',
        name: 'Users',
        component: () => import('../views/user/UserListView.vue'),
        meta: { title: '用户管理', keepAlive: true, permission: 'user:read' }
      },
      {
        path: 'skills',
        name: 'Skills',
        component: () => import('../views/skill/SkillListView.vue'),
        meta: { title: 'Skills 管理', keepAlive: true, permission: 'agent:read' }
      },
      {
        path: 'mcp-servers',
        name: 'McpServers',
        component: () => import('../views/mcp/McpServerListView.vue'),
        meta: { title: 'MCP 服务器', keepAlive: true, adminOnly: true }
      },
      {
        path: 'sessions',
        name: 'Sessions',
        component: () => import('../views/session/SessionListView.vue'),
        meta: { title: '会话管理', keepAlive: true, permission: 'session:read' }
      },
      {
        path: 'roles',
        name: 'Roles',
        component: () => import('../views/permission/RolePermissionView.vue'),
        meta: { title: '角色权限', keepAlive: true, permission: 'user:write' }
      },
      {
        path: 'audit-logs',
        name: 'AuditLogs',
        component: () => import('../views/audit/AuditLogView.vue'),
        meta: { title: '审计日志', keepAlive: true, permission: 'user:read' }
      },
      {
        path: 'analytics',
        name: 'Analytics',
        component: () => import('../views/analytics/AnalyticsView.vue'),
        meta: { title: '用量分析', keepAlive: true, adminOnly: true }
      },
      {
        path: 'llm-calls',
        name: 'LlmCalls',
        component: () => import('../views/llm-call/LlmCallView.vue'),
        meta: { title: '调用流水', keepAlive: true, adminOnly: true }
      },
      {
        path: 'scheduled-tasks',
        name: 'ScheduledTasks',
        component: () => import('../views/scheduled-tasks/index.vue'),
        meta: { title: '定时任务', keepAlive: true, permission: 'session:read' }
      },
      {
        path: 'system-commands',
        name: 'SystemCommands',
        component: () => import('../views/system-commands/SystemCommandListView.vue'),
        meta: { title: '指令管理', keepAlive: true, adminOnly: true }
      },
      {
        path: 'feishu-bots',
        name: 'FeishuBots',
        component: () => import('../views/feishu-bot/FeishuBotListView.vue'),
        meta: { title: '飞书机器人', keepAlive: true, adminOnly: true }
      },
      {
        path: 'settings',
        name: 'SystemSettings',
        component: () => import('../views/settings/SystemSettingsView.vue'),
        meta: { title: '系统设置', keepAlive: true, permission: 'settings:read' }
      },
      {
        path: 'sessions/:id',
        name: 'SessionDetail',
        component: () => import('../views/session/SessionDetailView.vue'),
        meta: { title: '会话详情', keepAlive: true, permission: 'session:read' }
      },
      {
        path: 'forbidden',
        name: 'Forbidden',
        component: () => import('../views/auth/ForbiddenView.vue'),
        meta: { title: '无权限' }
      },
    ]
  },
  {
    // 404 兜底：未知路径回用量分析首页，避免白屏
    path: '/:pathMatch(.*)*',
    redirect: '/analytics'
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

// Navigation guard
router.beforeEach(async (to, _from, next) => {
  const token = localStorage.getItem('token')
  if (to.meta.requiresAuth !== false && !token) {
    next('/login')
    return
  }

  if (token && to.meta.requiresAuth !== false) {
    const authStore = useAuthStore()
    if (!authStore.user) {
      try {
        await authStore.fetchUserInfo()
      } catch (error: any) {
        // 401/403：token 失效，清理后进登录页
        if (error?.response?.status === 401 || error?.response?.status === 403) {
          authStore.clearAuth()
          next('/login')
          return
        }
        // 其他异常（网络抖动等）：用户信息不可得则无法校验权限，
        // 受保护路由一律 fail-closed 进登录页，避免跳过权限检查
        authStore.clearAuth()
        next('/login')
        return
      }
    }
    const permission = to.meta.permission as string | undefined
    if (permission && !authStore.hasPermission(permission)) {
      next('/forbidden')
      return
    }
    // 管理员专属页面（MCP 服务器等）：权限维度已移除，改为管理员角色控制
    if (to.meta.adminOnly && !authStore.isAdmin) {
      // 首页（用量分析）对非管理员软回退到其有权限的首个页面，避免登录即无权限
      if (to.path === '/analytics') {
        next(pickHomePath(authStore.isAdmin, (p) => authStore.hasPermission(p)))
        return
      }
      next('/forbidden')
      return
    }
    next()
    return
  }

  // 已登录访问 /login：仅在用户信息可用时回工作台，避免拉取失败时与守卫互相踢
  if (to.path === '/login' && token) {
    const authStore = useAuthStore()
    if (!authStore.user) {
      try {
        await authStore.fetchUserInfo()
      } catch {
        next()
        return
      }
    }
    next('/')
    return
  }

  next()
})

export default router
