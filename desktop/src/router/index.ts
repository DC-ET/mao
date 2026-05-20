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
    redirect: '/workbench',
    children: [
      {
        path: 'workbench',
        name: 'Workbench',
        component: () => import('../views/workbench/WorkbenchView.vue'),
        meta: { title: '工作台' }
      },
      {
        path: 'chat/:agentId',
        name: 'Chat',
        component: () => import('../views/chat/ChatView.vue'),
        meta: { title: '对话' }
      },
      {
        path: 'hub',
        name: 'Hub',
        component: () => import('../views/hub/HubView.vue'),
        meta: { title: 'Agent Hub' }
      },
      {
        path: 'agent/create',
        name: 'CreateAgent',
        component: () => import('../views/agent-create/CreateAgentView.vue'),
        meta: { title: '创建 Agent' }
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('../views/settings/SettingsView.vue'),
        meta: { title: '设置' }
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
