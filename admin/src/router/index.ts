import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

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
        meta: { title: 'Agent 管理', keepAlive: true }
      },
      {
        path: 'models',
        name: 'Models',
        component: () => import('../views/model/ModelListView.vue'),
        meta: { title: '模型管理', keepAlive: true }
      },
      {
        path: 'users',
        name: 'Users',
        component: () => import('../views/user/UserListView.vue'),
        meta: { title: '用户管理', keepAlive: true }
      },
      {
        path: 'skills',
        name: 'Skills',
        component: () => import('../views/skill/SkillListView.vue'),
        meta: { title: 'Skills 管理', keepAlive: true }
      },
      {
        path: 'sessions',
        name: 'Sessions',
        component: () => import('../views/session/SessionListView.vue'),
        meta: { title: '会话管理', keepAlive: true }
      },
      {
        path: 'roles',
        name: 'Roles',
        component: () => import('../views/permission/RolePermissionView.vue'),
        meta: { title: '角色权限', keepAlive: true }
      },
      {
        path: 'audit-logs',
        name: 'AuditLogs',
        component: () => import('../views/audit/AuditLogView.vue'),
        meta: { title: '审计日志', keepAlive: true }
      },
      {
        path: 'runtime',
        name: 'RuntimeMonitor',
        component: () => import('../views/runtime/RuntimeMonitorView.vue'),
        meta: { title: '运行监控', keepAlive: true }
      },
      {
        path: 'analytics',
        name: 'Analytics',
        component: () => import('../views/analytics/AnalyticsView.vue'),
        meta: { title: '用量分析', keepAlive: true }
      },
      {
        path: 'settings',
        name: 'SystemSettings',
        component: () => import('../views/settings/SystemSettingsView.vue'),
        meta: { title: '系统设置', keepAlive: true }
      },
      {
        path: 'notifications',
        name: 'Notifications',
        component: () => import('../views/notification/NotificationListView.vue'),
        meta: { title: '通知管理', keepAlive: true }
      },
      {
        path: 'sessions/:id',
        name: 'SessionDetail',
        component: () => import('../views/session/SessionDetailView.vue'),
        meta: { title: '会话详情', keepAlive: true }
      },
    ]
  }
]

const router = createRouter({
  history: createWebHistory('/admin'),
  routes
})

// Navigation guard
router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('token')
  if (to.meta.requiresAuth !== false && !token) {
    next('/login')
  } else {
    next()
  }
})

export default router
