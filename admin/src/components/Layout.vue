<template>
  <el-container class="layout-container">
    <!-- Sidebar (desktop only) -->
    <el-aside v-if="!isMobile" width="200px" class="layout-aside">
      <SideMenu :show-logo="true" />
    </el-aside>

    <!-- Mobile drawer menu -->
    <el-drawer
      v-model="drawerVisible"
      direction="ltr"
      size="70%"
      :with-header="false"
      class="mobile-side-drawer"
    >
      <SideMenu :show-logo="true" @select="drawerVisible = false" />
    </el-drawer>

    <!-- Main content -->
    <el-container>
      <el-header class="layout-header">
        <div class="header-left">
          <el-icon v-if="isMobile" class="menu-toggle" @click="drawerVisible = true">
            <Menu />
          </el-icon>
          <el-breadcrumb v-if="!isMobile" separator="/">
            <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item>{{ currentTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
          <span v-else class="mobile-title">{{ currentTitle }}</span>
        </div>

        <div class="header-right">
          <el-dropdown @command="handleCommand">
            <span class="user-info">
              <el-avatar :size="32" icon="User" />
              <span v-if="!isMobile" class="username">{{ authStore.user?.displayName || '管理员' }}</span>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <TabBar />

      <el-main class="layout-main">
        <div class="layout-content">
          <router-view v-slot="{ Component, route: viewRoute }">
            <keep-alive>
              <component :is="Component" :key="viewRoute.fullPath" />
            </keep-alive>
          </router-view>
        </div>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useTabStore } from '../stores/tabs'
import { useBreakpoint } from '../composables/useBreakpoint'
import TabBar from './TabBar.vue'
import SideMenu from './SideMenu.vue'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const tabStore = useTabStore()
const { isMobile } = useBreakpoint()

const drawerVisible = ref(false)

const currentTitle = computed(() => (route.meta?.title as string) || '')

// Close the drawer when leaving mobile size (e.g. rotating/resizing to desktop).
watch(isMobile, (mobile) => {
  if (!mobile) drawerVisible.value = false
})

watch(route, (newRoute) => {
  tabStore.addTab(newRoute)
}, { immediate: true })

async function handleCommand(command: string) {
  if (command === 'logout') {
    await authStore.logout()
    router.push('/login')
  }
}
</script>

<style scoped>
.layout-container {
  height: 100vh;
  height: 100dvh;
}

.layout-aside {
  background: #304156;
  overflow: hidden;
}

.layout-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #e6e6e6;
  background: #fff;
}

.header-right {
  display: flex;
  align-items: center;
}

.user-info {
  display: flex;
  align-items: center;
  cursor: pointer;
  gap: 8px;
}

.username {
  font-size: 14px;
  color: #606266;
}

.menu-toggle {
  font-size: 22px;
  cursor: pointer;
  color: #606266;
}

.mobile-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.layout-main {
  background: #f5f7fa;
  padding: 0;
  overflow: hidden;
}

.layout-content {
  height: 100%;
  padding: 20px;
  overflow-y: auto;
}
</style>
