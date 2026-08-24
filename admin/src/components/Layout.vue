<template>
  <el-container class="layout-container">
    <el-aside v-if="!isMobile" :width="asideWidth" class="layout-aside">
      <SideMenu :show-logo="true" :collapsed="collapsed" />
    </el-aside>

    <el-drawer
      v-model="drawerVisible"
      direction="ltr"
      size="72%"
      :with-header="false"
      class="mobile-side-drawer"
    >
      <SideMenu :show-logo="true" @select="drawerVisible = false" />
    </el-drawer>

    <el-container>
      <el-header class="layout-header">
        <div class="header-left">
          <el-icon v-if="isMobile" class="menu-toggle" @click="drawerVisible = true">
            <Menu />
          </el-icon>
          <el-icon v-else class="menu-toggle" :title="collapsed ? '展开菜单' : '收起菜单'" @click="toggleCollapsed">
            <Fold v-if="!collapsed" />
            <Expand v-else />
          </el-icon>
          <nav v-if="crumbs.length > 1" class="page-crumb" aria-label="面包屑">
            <template v-for="(crumb, idx) in crumbs" :key="crumb.title">
              <router-link v-if="crumb.path" class="page-crumb-link" :to="crumb.path">{{ crumb.title }}</router-link>
              <span v-else class="page-title">{{ crumb.title }}</span>
              <span v-if="idx < crumbs.length - 1" class="page-crumb-sep">/</span>
            </template>
          </nav>
          <span v-else class="page-title">{{ currentTitle }}</span>
        </div>

        <div class="header-right">
          <el-dropdown @command="handleCommand">
            <span class="user-info">
              <el-avatar :size="28" icon="User" />
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

      <TabBar v-if="!isMobile" />

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

const SIDEBAR_KEY = 'admin-sidebar-collapsed'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const tabStore = useTabStore()
const { isMobile } = useBreakpoint()

const drawerVisible = ref(false)
const collapsed = ref(localStorage.getItem(SIDEBAR_KEY) === '1')

const asideWidth = computed(() => (collapsed.value ? '64px' : '232px'))
const currentTitle = computed(() => (route.meta?.title as string) || '')

const crumbs = computed(() => {
  if (route.name === 'SessionDetail') {
    return [
      { title: '会话管理', path: '/sessions' },
      { title: currentTitle.value }
    ]
  }
  return [{ title: currentTitle.value }]
})

function toggleCollapsed() {
  collapsed.value = !collapsed.value
  localStorage.setItem(SIDEBAR_KEY, collapsed.value ? '1' : '0')
}

watch(
  currentTitle,
  (title) => {
    document.title = title ? `${title} · Mao 管理后台` : 'Mao 管理后台'
  },
  { immediate: true }
)

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
  background: var(--mao-surface);
  border-right: 1px solid var(--mao-border);
  overflow: hidden;
  transition: width 0.2s ease;
}

.layout-header {
  box-sizing: border-box;
  min-height: 56px;
  height: calc(56px + env(safe-area-inset-top));
  padding-top: env(safe-area-inset-top);
  padding-left: max(16px, env(safe-area-inset-left));
  padding-right: max(16px, env(safe-area-inset-right));
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--mao-border);
  background: var(--mao-surface);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.page-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--mao-ink);
}

.page-crumb {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.page-crumb-link {
  font-size: 15px;
  color: var(--mao-accent);
  text-decoration: none;
}

.page-crumb-link:hover {
  text-decoration: underline;
}

.page-crumb-sep {
  color: var(--mao-muted);
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
  font-size: 13px;
  color: var(--mao-muted);
}

.menu-toggle {
  font-size: 20px;
  cursor: pointer;
  color: var(--mao-muted);
}

.menu-toggle:hover {
  color: var(--mao-ink);
}

.layout-main {
  background: var(--mao-canvas);
  padding: 0;
  overflow: hidden;
}

.layout-content {
  height: 100%;
  padding: 20px;
  padding-bottom: calc(20px + env(safe-area-inset-bottom));
  overflow-y: auto;
}
</style>
