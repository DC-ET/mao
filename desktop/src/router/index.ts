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
    component: () => import('../components/common/Layout.vue'),
    children: [
      {
        path: '',
        name: 'Home',
        component: () => import('../views/task/TaskView.vue')
      },
      {
        path: 'tasks/:sessionId',
        name: 'Task',
        component: () => import('../views/task/TaskView.vue')
      },
      {
        path: 'hub',
        name: 'Hub',
        component: () => import('../views/hub/HubView.vue')
      },
      {
        path: 'agent/create',
        name: 'CreateAgent',
        component: () => import('../views/agent-create/CreateAgentView.vue')
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('../views/settings/SettingsView.vue')
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
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
