import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/auth/LoginView.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/',
    name: 'Layout',
    component: () => import('../components/Layout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('../views/dashboard/DashboardView.vue'),
        meta: { title: '数据概览', keepAlive: true }
      },
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
        path: 'runtime',
        name: 'RuntimeMonitor',
        component: () => import('../views/runtime/RuntimeMonitorView.vue'),
        meta: { title: '运行监控', keepAlive: true, permission: 'session:read' }
      },
      {
        path: 'analytics',
        name: 'Analytics',
        component: () => import('../views/analytics/AnalyticsView.vue'),
        meta: { title: '用量分析', keepAlive: true, permission: 'session:read' }
      },
      {
        path: 'settings',
        name: 'SystemSettings',
        component: () => import('../views/settings/SystemSettingsView.vue'),
        meta: { title: '系统设置', keepAlive: true, permission: 'user:write' }
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
  }
]

const router = createRouter({
  history: createWebHistory('/admin'),
  routes
})

// Navigation guard
router.beforeEach(async (to, _from, next) => {
  const token = localStorage.getItem('token')
  if (to.meta.requiresAuth !== false && !token) {
    next('/login')
    return
  }
  if (to.path === '/login' && token) {
    next('/')
    return
  }

  if (token && to.meta.requiresAuth !== false) {
    const authStore = useAuthStore()
    if (!authStore.user) {
      try {
        await authStore.fetchUserInfo()
      } catch {
        next('/login')
        return
      }
    }
    const permission = to.meta.permission as string | undefined
    if (permission && !authStore.hasPermission(permission)) {
      next('/forbidden')
      return
    }
  }

  next()
})

export default router
