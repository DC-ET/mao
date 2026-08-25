<template>
  <div class="side-menu-wrap" :class="{ 'is-collapsed': collapsed }">
    <div v-if="showLogo" class="logo" @click="goHome">
      <img class="logo-img" :src="logoSrc" alt="" />
      <div v-if="!collapsed" class="logo-text">
        <strong>Mao</strong>
        <span>管理后台</span>
      </div>
    </div>

    <el-menu
      :default-active="activeMenu"
      :collapse="collapsed"
      :collapse-transition="false"
      router
      class="sidebar-menu"
      @select="onSelect"
    >
      <template v-for="group in visibleGroups" :key="group.id">
        <el-menu-item
          v-if="group.items.length === 1 && !group.label"
          :index="group.items[0].index"
        >
          <el-icon><component :is="group.items[0].icon" /></el-icon>
          <template #title>{{ group.items[0].label }}</template>
        </el-menu-item>
        <el-menu-item-group v-else :title="collapsed ? '' : group.label">
          <el-menu-item
            v-for="item in group.items"
            :key="item.index"
            :index="item.index"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <template #title>{{ item.label }}</template>
          </el-menu-item>
        </el-menu-item-group>
      </template>
    </el-menu>
  </div>
</template>

<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DataLine,
  Monitor,
  Connection,
  MagicStick,
  ChatDotRound,
  User,
  Lock,
  DocumentChecked,
  Operation,
  Timer,
  TrendCharts,
  Setting,
  Link,
  Promotion
} from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'

withDefaults(
  defineProps<{
    showLogo?: boolean
    collapsed?: boolean
  }>(),
  { showLogo: true, collapsed: false }
)

const emit = defineEmits<{
  (e: 'select'): void
}>()

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const logoSrc = `${import.meta.env.BASE_URL}app-icon-small.png`

interface MenuItem {
  index: string
  label: string
  icon: Component
  permission?: string
  adminOnly?: boolean
}

interface MenuGroup {
  id: string
  label: string
  items: MenuItem[]
}

const menuGroups: MenuGroup[] = [
  {
    id: 'overview',
    label: '',
    items: [
      { index: '/dashboard', label: '数据概览', icon: DataLine }
    ]
  },
  {
    id: 'capability',
    label: '能力',
    items: [
      { index: '/agents', label: 'Agent 管理', icon: Monitor, permission: 'agent:read' },
      { index: '/models', label: '模型管理', icon: Connection, permission: 'model:read' },
      { index: '/skills', label: 'Skills 管理', icon: MagicStick, permission: 'agent:read' },
      { index: '/mcp-servers', label: 'MCP 服务器', icon: Link, adminOnly: true }
    ]
  },
  {
    id: 'runtime',
    label: '运行',
    items: [
      { index: '/sessions', label: '会话管理', icon: ChatDotRound, permission: 'session:read' },
      { index: '/runtime', label: '运行监控', icon: Operation, permission: 'session:read' },
      { index: '/scheduled-tasks', label: '定时任务', icon: Timer, permission: 'session:read' },
      { index: '/analytics', label: '用量分析', icon: TrendCharts, permission: 'session:read' }
    ]
  },
  {
    id: 'security',
    label: '安全',
    items: [
      { index: '/users', label: '用户管理', icon: User, permission: 'user:read' },
      { index: '/roles', label: '角色权限', icon: Lock, permission: 'user:write' },
      { index: '/audit-logs', label: '审计日志', icon: DocumentChecked, permission: 'user:read' }
    ]
  },
  {
    id: 'system',
    label: '系统',
    items: [
      { index: '/system-commands', label: '系统指令', icon: Promotion, permission: 'user:write' },
      { index: '/settings', label: '系统设置', icon: Setting, permission: 'user:write' }
    ]
  }
]

function canSee(item: MenuItem) {
  if (item.adminOnly) return authStore.isAdmin
  return !item.permission || authStore.hasPermission(item.permission)
}

const visibleGroups = computed(() =>
  menuGroups
    .map(group => ({ ...group, items: group.items.filter(canSee) }))
    .filter(group => group.items.length > 0)
)

const activeMenu = computed(() => {
  const seg = '/' + (route.path.split('/')[1] || '')
  return seg
})

function goHome() {
  router.push('/dashboard')
  emit('select')
}

function onSelect() {
  emit('select')
}
</script>

<style scoped>
.side-menu-wrap {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--mao-surface);
}

.logo {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  color: var(--mao-ink);
  cursor: pointer;
  flex-shrink: 0;
}

.is-collapsed .logo {
  justify-content: center;
  padding: 0;
}

.logo-img {
  width: 28px;
  height: 28px;
  border-radius: 7px;
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.logo-text strong {
  font-size: 15px;
  font-weight: 600;
}

.logo-text span {
  font-size: 11px;
  color: var(--mao-muted);
}

.sidebar-menu {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  border-right: none;
  background: var(--mao-surface);
}

.sidebar-menu:not(.el-menu--collapse) {
  width: 100%;
}

.sidebar-menu :deep(.el-menu-item-group__title) {
  color: var(--mao-muted);
  font-size: 11px;
  letter-spacing: 0.04em;
  padding: 16px 20px 6px;
  line-height: 1;
}

.is-collapsed .sidebar-menu :deep(.el-menu-item-group__title) {
  display: none;
}

.sidebar-menu .el-menu-item {
  color: var(--mao-ink);
  margin: 0 8px;
  width: calc(100% - 16px);
  border-radius: 8px;
}

.sidebar-menu .el-menu-item:hover {
  background: var(--mao-canvas);
}

.sidebar-menu .el-menu-item.is-active {
  background: var(--mao-accent-bg);
  color: var(--mao-accent);
}

.is-collapsed .sidebar-menu .el-menu-item {
  margin: 0 8px;
  width: calc(100% - 16px);
  padding: 0 !important;
  justify-content: center;
}
</style>
