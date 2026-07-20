<template>
  <div class="side-menu-wrap">
    <div v-if="showLogo" class="logo">
      <h3>Agent 工作台</h3>
    </div>

    <el-menu
      :default-active="activeMenu"
      router
      class="sidebar-menu"
      @select="onSelect"
    >
      <el-menu-item
        v-for="item in visibleMenus"
        :key="item.index"
        :index="item.index"
      >
        <el-icon><component :is="item.icon" /></el-icon>
        <span>{{ item.label }}</span>
      </el-menu-item>
    </el-menu>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
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
  TrendCharts,
  Setting
} from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'

withDefaults(
  defineProps<{
    showLogo?: boolean
  }>(),
  { showLogo: true }
)

const emit = defineEmits<{
  (e: 'select'): void
}>()

const route = useRoute()
const authStore = useAuthStore()

const menuItems = [
  { index: '/dashboard', label: '数据概览', icon: DataLine },
  { index: '/agents', label: 'Agent 管理', icon: Monitor, permission: 'agent:read' },
  { index: '/models', label: '模型管理', icon: Connection, permission: 'model:read' },
  { index: '/skills', label: 'Skills 管理', icon: MagicStick, permission: 'agent:read' },
  { index: '/sessions', label: '会话管理', icon: ChatDotRound, permission: 'session:read' },
  { index: '/users', label: '用户管理', icon: User, permission: 'user:read' },
  { index: '/roles', label: '角色权限', icon: Lock, permission: 'user:write' },
  { index: '/audit-logs', label: '审计日志', icon: DocumentChecked, permission: 'user:read' },
  { index: '/runtime', label: '运行监控', icon: Operation, permission: 'session:read' },
  { index: '/analytics', label: '用量分析', icon: TrendCharts, permission: 'session:read' },
  { index: '/settings', label: '系统设置', icon: Setting, permission: 'user:write' },
]

const visibleMenus = computed(() =>
  menuItems.filter(item => !item.permission || authStore.hasPermission(item.permission))
)

const activeMenu = computed(() => {
  // Match by top-level segment so detail routes (e.g. /sessions/:id) keep the
  // corresponding menu item (e.g. /sessions) highlighted.
  const seg = '/' + (route.path.split('/')[1] || '')
  return seg
})

function onSelect() {
  emit('select')
}
</script>

<style scoped>
.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.logo h3 {
  margin: 0;
  font-size: 16px;
}

.sidebar-menu {
  border-right: none;
  background: #304156;
}

.sidebar-menu .el-menu-item {
  color: #bfcbd9;
}

.sidebar-menu .el-menu-item:hover,
.sidebar-menu .el-menu-item.is-active {
  background: #263445;
  color: #409eff;
}
</style>
