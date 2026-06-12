<template>
  <nav class="top-nav">
    <div class="nav-left">
      <div class="nav-logo" @click="router.push('/')">
        <div class="logo-icon">
          <el-icon :size="16"><Monitor /></el-icon>
        </div>
        <span class="logo-text">Agent Workbench</span>
      </div>
      <div class="nav-left-actions">
        <el-tooltip content="左侧面板" :show-after="100" placement="bottom">
          <div class="theme-toggle" :class="{ active: !leftCollapsed }" @click="toggleLeft">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </div>
        </el-tooltip>
        <el-tooltip content="新任务" :show-after="100" placement="bottom">
          <div class="theme-toggle" @click="router.push('/')">
            <el-icon :size="16"><Plus /></el-icon>
          </div>
        </el-tooltip>
      </div>
    </div>
    <div class="nav-right">
      <el-tooltip content="右侧面板" :show-after="100" placement="bottom">
        <div class="theme-toggle" :class="{ active: !rightCollapsed }" @click="toggleRight">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </div>
      </el-tooltip>
      <el-tooltip content="终端 (Ctrl+`)" :show-after="100" placement="bottom">
        <div class="theme-toggle" :class="{ active: terminalOpen }" @click="toggleTerminal">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </div>
      </el-tooltip>
      <el-tooltip content="我的技能/Skills" :show-after="100" placement="bottom">
        <div class="theme-toggle" @click="toggleSkillDrawer()">
          <el-icon><MagicStick /></el-icon>
        </div>
      </el-tooltip>
      <el-tooltip content="我的指令/Commands" :show-after="100" placement="bottom">
        <div class="theme-toggle" @click="toggleCommandDrawer()">
          <el-icon><Flag /></el-icon>
        </div>
      </el-tooltip>
      <el-tooltip :content="isDark ? '切换为浅色' : '切换为深色'" :show-after="100" placement="bottom">
        <div class="theme-toggle" @click="toggleTheme">
          <el-icon :size="16">
            <Moon v-if="!isDark" />
            <Sunny v-else />
          </el-icon>
        </div>
      </el-tooltip>
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
import { useRouter } from 'vue-router'
import { Monitor, ArrowDown, Moon, Sunny, Plus } from '@element-plus/icons-vue'
import { useAuthStore } from '../../stores/auth'
import { useSessionStore } from '../../stores/session'
import { useTheme } from '../../utils/theme'
import { useTerminal } from '../../composables/useTerminal'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { useSkillDrawer } from '../../composables/useSkillDrawer'
import { useCommandDrawer } from '../../composables/useCommandDrawer'

const { isDark, toggleTheme } = useTheme()
const sessionStore = useSessionStore()
const { isOpen: terminalOpen, togglePanel } = useTerminal()
const { leftCollapsed, rightCollapsed, toggleLeft, toggleRight } = usePanelLayout()
const { toggle: toggleSkillDrawer } = useSkillDrawer()
const { toggle: toggleCommandDrawer } = useCommandDrawer()

function toggleTerminal() {
  const session = sessionStore.activeSession
  let cwd: string | undefined
  if (session?.executionMode === 'LOCAL' && session.workspace) {
    cwd = session.workspace
  }
  togglePanel(cwd)
}

const router = useRouter()
const authStore = useAuthStore()

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

.nav-left-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  -webkit-app-region: no-drag;
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
  gap: 5px;
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

.theme-toggle.active {
  color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.1);
}

[data-theme="dark"] .theme-toggle:hover {
  background: rgba(255, 255, 255, 0.08);
}
</style>
