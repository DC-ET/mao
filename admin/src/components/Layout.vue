<template>
  <el-container class="layout-container">
    <!-- Sidebar -->
    <el-aside width="200px" class="layout-aside">
      <div class="logo">
        <h3>Agent 工作台</h3>
      </div>

      <el-menu
        :default-active="activeMenu"
        router
        class="sidebar-menu"
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

      </el-menu>
    </el-aside>

    <!-- Main content -->
    <el-container>
      <el-header class="layout-header">
        <div class="header-left">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
            <el-breadcrumb-item>{{ currentTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>

        <div class="header-right">
          <el-dropdown @command="handleCommand">
            <span class="user-info">
              <el-avatar :size="32" icon="User" />
              <span class="username">{{ authStore.user?.displayName || '管理员' }}</span>
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
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useTabStore } from '../stores/tabs'
import TabBar from './TabBar.vue'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const tabStore = useTabStore()

const activeMenu = computed(() => route.path)
const currentTitle = computed(() => (route.meta?.title as string) || '')

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
}

.layout-aside {
  background: #304156;
  overflow: hidden;
}

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
