<template>
  <nav class="top-nav">
    <div class="nav-left">
      <div class="nav-logo" @click="router.push('/')">
        <div class="logo-icon">
          <el-icon :size="16"><Monitor /></el-icon>
        </div>
        <span class="logo-text">Agent Workbench</span>
      </div>
      <div v-if="showNavLinks" class="nav-links">
        <router-link
          v-for="link in navLinks"
          :key="link.path"
          :to="link.path"
          :class="['nav-link', { active: isActive(link.path) }]"
        >
          {{ link.label }}
        </router-link>
      </div>
    </div>
    <div class="nav-right">
      <div class="theme-toggle" @click="toggleTheme">
        <el-icon :size="16">
          <Moon v-if="!isDark" />
          <Sunny v-else />
        </el-icon>
      </div>
      <el-dropdown @command="handleCommand" trigger="click">
        <div class="nav-user">
          <el-avatar :size="24" icon="User" />
          <span class="nav-username">{{ authStore.user?.username }}</span>
          <el-icon :size="10"><ArrowDown /></el-icon>
        </div>
        <template #dropdown>
          <el-dropdown-menu class="nav-dropdown">
            <el-dropdown-item command="logout">退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { Monitor, ArrowDown, Moon, Sunny } from '@element-plus/icons-vue'
import { useAuthStore } from '../../stores/auth'
import { useTheme } from '../../utils/theme'

const { isDark, toggleTheme } = useTheme()

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

const navLinks: { path: string; label: string }[] = []

const showNavLinks = computed(() => {
  if (navLinks.length === 0) return false
  if (route.path === '/') return true
  return !route.path.startsWith('/tasks/')
})

function isActive(path: string) {
  return route.path === path || route.path.startsWith(path + '/')
}

async function handleCommand(command: string) {
  if (command === 'logout') {
    await authStore.logout()
    router.push('/login')
  }
}
</script>

<style scoped>
.top-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--aw-nav-height);
  padding: 0 16px;
  background: var(--aw-nav-bg);
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
  -webkit-app-region: drag;
}

.nav-left {
  display: flex;
  align-items: center;
  gap: 24px;
  padding-left: 78px; /* space for macOS traffic lights */
  -webkit-app-region: no-drag;
}

.nav-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex-shrink: 0;
}

.logo-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  color: var(--aw-on-primary);
}

.logo-text {
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-fine);
  font-weight: 400;
  color: var(--aw-nav-text);
  letter-spacing: -0.12px;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 4px;
}

.nav-link {
  font-size: var(--aw-text-fine);
  font-weight: 400;
  color: var(--aw-nav-text-muted);
  letter-spacing: -0.12px;
  padding: 4px 10px;
  border-radius: var(--aw-radius-xs);
  text-decoration: none;
  transition: color 0.15s, background 0.15s;
  line-height: 1.4;
}

.nav-link:hover {
  color: var(--aw-nav-text);
  text-decoration: none;
  background: rgba(0, 0, 0, 0.06);
}

[data-theme="dark"] .nav-link:hover {
  background: rgba(255, 255, 255, 0.08);
}

.nav-link.active {
  color: var(--aw-nav-text);
}

.nav-right {
  display: flex;
  align-items: center;
  gap: 12px;
  -webkit-app-region: no-drag;
}

.nav-user {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: var(--aw-radius-xs);
  transition: background 0.15s;
  color: var(--aw-nav-text-muted);
}

.nav-user:hover {
  background: rgba(0, 0, 0, 0.06);
}

[data-theme="dark"] .nav-user:hover {
  background: rgba(255, 255, 255, 0.08);
}

.nav-user :deep(.el-avatar) {
  background: var(--aw-surface-chip);
  color: var(--aw-ink);
}

.nav-username {
  font-size: var(--aw-text-caption);
  color: var(--aw-nav-text-muted);
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1;
}

.nav-dropdown :deep(.el-dropdown-menu__item) {
  font-size: var(--aw-text-caption);
  padding: 4px 12px;
}

.theme-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-nav-text-muted);
  transition: color 0.15s, background 0.15s;
}

.theme-toggle:hover {
  color: var(--aw-nav-text);
  background: rgba(0, 0, 0, 0.06);
}

[data-theme="dark"] .theme-toggle:hover {
  background: rgba(255, 255, 255, 0.08);
}
</style>
