import { createRouter, createWebHistory, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { getToken } from '../utils/auth-storage'

const routes: RouteRecordRaw[] = [
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
        path: 'settings',
        component: () => import('../views/settings/SettingsView.vue'),
        children: [
          {
            path: '',
            redirect: '/settings/git-credentials'
          },
          {
            path: 'git-credentials',
            name: 'GitCredentials',
            component: () => import('../views/settings/GitCredentialsView.vue')
          },
          {
            path: 'notifications',
            name: 'NotificationSettings',
            component: () => import('../views/settings/NotificationSettingsView.vue')
          }
        ]
      }
    ]
  }
]

function createAppHistory() {
  // Electron 打包后从本地 dist 加载（file://），需使用 hash 路由
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    return createWebHashHistory()
  }
  return createWebHistory()
}

const router = createRouter({
  history: createAppHistory(),
  routes
})

// Navigation guard — hydrate user info if token exists
router.beforeEach(async (_to, _from, next) => {
  const token = getToken()
  if (token) {
    const authStore = useAuthStore()
    if (!authStore.user) {
      try {
        await authStore.fetchUserInfo()
      } catch {
        // Token expired — the API interceptor will show the login dialog
      }
    }
  }
  next()
})

export default router
