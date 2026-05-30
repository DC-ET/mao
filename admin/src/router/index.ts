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
        meta: { title: '数据概览' }
      },
      {
        path: 'agents',
        name: 'Agents',
        component: () => import('../views/agent/AgentListView.vue'),
        meta: { title: 'Agent 管理' }
      },
      {
        path: 'models',
        name: 'Models',
        component: () => import('../views/model/ModelListView.vue'),
        meta: { title: '模型管理' }
      },
      {
        path: 'users',
        name: 'Users',
        component: () => import('../views/user/UserListView.vue'),
        meta: { title: '用户管理' }
      },
      {
        path: 'skills',
        name: 'Skills',
        component: () => import('../views/skill/SkillListView.vue'),
        meta: { title: 'Skills 管理' }
      },
      {
        path: 'audit',
        name: 'Audit',
        component: () => import('../views/audit/AuditLogView.vue'),
        meta: { title: '审计日志' }
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
