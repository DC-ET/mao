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
      <el-menu-item index="/dashboard">
        <el-icon><DataLine /></el-icon>
        <span>数据概览</span>
      </el-menu-item>

      <el-menu-item index="/agents">
        <el-icon><Monitor /></el-icon>
        <span>Agent 管理</span>
      </el-menu-item>

      <el-menu-item index="/models">
        <el-icon><Connection /></el-icon>
        <span>模型管理</span>
      </el-menu-item>

      <el-menu-item index="/skills">
        <el-icon><MagicStick /></el-icon>
        <span>Skills 管理</span>
      </el-menu-item>

      <el-menu-item index="/sessions">
        <el-icon><ChatDotRound /></el-icon>
        <span>会话管理</span>
      </el-menu-item>

      <el-menu-item index="/users">
        <el-icon><User /></el-icon>
        <span>用户管理</span>
      </el-menu-item>

      <el-menu-item index="/roles">
        <el-icon><Lock /></el-icon>
        <span>角色权限</span>
      </el-menu-item>

      <el-menu-item index="/audit-logs">
        <el-icon><DocumentChecked /></el-icon>
        <span>审计日志</span>
      </el-menu-item>

      <el-menu-item index="/runtime">
        <el-icon><Operation /></el-icon>
        <span>运行监控</span>
      </el-menu-item>

      <el-menu-item index="/analytics">
        <el-icon><TrendCharts /></el-icon>
        <span>用量分析</span>
      </el-menu-item>

      <el-menu-item index="/settings">
        <el-icon><Setting /></el-icon>
        <span>系统设置</span>
      </el-menu-item>

      <el-menu-item index="/notifications">
        <el-icon><Bell /></el-icon>
        <span>通知管理</span>
      </el-menu-item>
    </el-menu>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const props = withDefaults(
  defineProps<{
    showLogo?: boolean
  }>(),
  { showLogo: true }
)

const emit = defineEmits<{
  (e: 'select'): void
}>()

const route = useRoute()

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
