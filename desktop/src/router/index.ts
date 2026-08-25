import { createRouter, createWebHistory, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { getToken } from '../utils/auth-storage'
import { readRedirectQuery } from '../utils/login-redirect'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/auth/LoginView.vue'),
    meta: { public: true }
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
        path: 'settings',
        component: () => import('../views/settings/SettingsView.vue'),
        children: [
          {
            path: '',
            redirect: '/settings/profile'
          },
          {
            path: 'profile',
            name: 'Profile',
            component: () => import('../views/settings/ProfileView.vue')
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
          },
          {
            path: 'weixin-bot',
            name: 'WeixinBot',
            component: () => import('../views/settings/WeixinBotView.vue')
          },
          {
            path: 'feishu-bot',
            name: 'FeishuBot',
            component: () => import('../views/settings/FeishuBotView.vue')
          },
          {
            path: 'mcp-servers',
            name: 'McpServers',
            component: () => import('../views/settings/McpServersView.vue')
          },
          {
            path: 'scheduled-tasks',
            name: 'ScheduledTasks',
            component: () => import('../components/ScheduledTaskPanel.vue')
          }
        ]
      }
    ]
  }
]

function isCapacitorLocalBundle(): boolean {
  try {
    const capacitor = (window as any).Capacitor
    if (capacitor?.isNativePlatform?.()) {
      const host = window.location.hostname || ''
      return /^(localhost|127\.0\.0\.1)$/i.test(host)
    }
  } catch {
    // ignore
  }
  // Capacitor 注入前的兜底：旧版内嵌包以 localhost 加载
  const host = window.location.hostname || ''
  return /Android/i.test(navigator.userAgent || '') && /^(localhost|127\.0\.0\.1)$/i.test(host)
}

function createAppHistory() {
  // Electron 打包后从本地 dist 加载（file://），需使用 hash 路由
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    return createWebHashHistory()
  }
  // 旧版安卓内嵌包（--base=./ + localhost）：History 刷新会使 ./assets 404
  if (typeof window !== 'undefined' && isCapacitorLocalBundle()) {
    return createWebHashHistory()
  }
  return createWebHistory()
}

const router = createRouter({
  history: createAppHistory(),
  routes
})

// Navigation guard — 未登录只能进公开页（/login），已登录访问 /login 时回跳目标页
router.beforeEach(async (to, _from, next) => {
  const token = getToken()
  const isPublic = to.meta.public === true

  if (!token) {
    if (isPublic) return next()
    return next({
      name: 'Login',
      query: to.fullPath && to.fullPath !== '/' ? { redirect: to.fullPath } : undefined,
      replace: true
    })
  }

  if (to.name === 'Login') {
    return next({ path: readRedirectQuery(to.query), replace: true })
  }

  const authStore = useAuthStore()
  if (!authStore.user) {
    try {
      await authStore.fetchUserInfo()
    } catch {
      // 401 由 API 拦截器处理（refresh → 失败强制下线）；其它错误不阻断导航，避免弱网被踢出
    }
  }
  next()
})

export default router
