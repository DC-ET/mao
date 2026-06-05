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
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// Navigation guard
router.beforeEach(async (to, _from, next) => {
  const token = localStorage.getItem('token')
  if (to.meta.requiresAuth !== false && !token) {
    next('/login')
  } else {
    if (token) {
      const authStore = useAuthStore()
      if (!authStore.user) {
        await authStore.fetchUserInfo()
      }
    }
    next()
  }
})

export default router
