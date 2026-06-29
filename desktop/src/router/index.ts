import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'

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
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// Navigation guard — hydrate user info if token exists
router.beforeEach(async (_to, _from, next) => {
  const token = localStorage.getItem('token')
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
