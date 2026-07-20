<template>
  <nav class="top-nav">
    <div class="nav-left">
      <div class="nav-left-actions">
        <el-tooltip v-if="isSettingsRoute" content="返回工作台" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
          <div class="theme-toggle" @click="goBackFromSettings">
            <el-icon :size="16"><ArrowLeft /></el-icon>
          </div>
        </el-tooltip>
        <el-tooltip content="左侧面板" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
          <div class="theme-toggle" :class="{ active: !leftCollapsed }" @click="toggleLeft">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </div>
        </el-tooltip>
      </div>
    </div>
    <div class="nav-right">
      <el-tooltip content="右侧面板" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
        <div class="theme-toggle" :class="{ active: !rightCollapsed }" @click="toggleRight">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </div>
      </el-tooltip>
      <el-tooltip content="终端 (Ctrl+`)" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
        <div class="theme-toggle" :class="{ active: terminalOpen }" @click="toggleTerminal">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </div>
      </el-tooltip>
      <el-tooltip content="我的技能/Skills" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
        <div class="theme-toggle" @click="toggleSkillDrawer()">
          <el-icon><MagicStick /></el-icon>
        </div>
      </el-tooltip>
      <el-tooltip content="我的指令/Commands" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
        <div class="theme-toggle" @click="toggleCommandDrawer()">
          <el-icon><Reading /></el-icon>
        </div>
      </el-tooltip>
      <el-tooltip :content="updateTooltip" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
        <div
          class="theme-toggle refresh-btn"
          :class="{ 'has-update': showUpdateIndicator }"
          @click="handleUpdateClick"
        >
          <el-icon :size="16"><Refresh /></el-icon>
          <span v-if="showUpdateIndicator" class="update-dot" />
        </div>
      </el-tooltip>
      <el-tooltip :content="themeTooltip" :show-after="100" placement="bottom" :disabled="isMobileDevice()">
        <div class="theme-toggle" @click="toggleTheme" role="button" :aria-label="themeTooltip">
          <el-icon :size="16">
            <Sunrise v-if="theme === 'auto'" />
            <Moon v-else-if="theme === 'light'" />
            <Sunny v-else />
          </el-icon>
        </div>
      </el-tooltip>
      <template v-if="authStore.user">
        <el-dropdown @command="handleCommand" trigger="click">
          <div class="nav-user">
            <el-avatar :size="24" icon="User" />
            <span class="nav-username">{{ authStore.user?.username }}</span>
            <el-icon :size="10"><ArrowDown /></el-icon>
          </div>
          <template #dropdown>
            <el-dropdown-menu class="nav-dropdown">
              <el-dropdown-item command="settings">
                <el-icon><Setting /></el-icon>
                设置
              </el-dropdown-item>
              <el-dropdown-item command="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>
      <template v-else>
        <div class="theme-toggle login-btn" @click="loginDialog.open()">
          <span>登录</span>
        </div>
      </template>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { ArrowDown, ArrowLeft, Sunrise, Moon, Refresh, Setting, Sunny } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import { useSessionStore } from '../../stores/session'
import { useTheme } from '../../utils/theme'
import { useTerminal } from '../../composables/useTerminal'
import { usePanelLayout, isMobileDevice } from '../../composables/usePanelLayout'
import { useSkillDrawer } from '../../composables/useSkillDrawer'
import { useCommandDrawer } from '../../composables/useCommandDrawer'
import { useLoginDialog } from '../../composables/useLoginDialog'
import { useVersionCheck } from '../../composables/useVersionCheck'

const { theme, toggleTheme } = useTheme()

const themeTooltip = computed(() => {
  if (theme.value === 'auto') return '跟随系统（点击切换浅色）'
  if (theme.value === 'light') return '浅色（点击切换深色）'
  return '深色（点击跟随系统）'
})
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

const authStore = useAuthStore()
const loginDialog = useLoginDialog()
const router = useRouter()
const route = useRoute()
const {
  hasUpdate,
  appUpdateStatus,
  appUpdateAvailable,
  appUpdateDownloaded,
  appUpdateVersion,
  appUpdateProgress,
  appUpdateError,
  reloadApp,
  startPolling,
  stopPolling,
  startAppUpdater,
  stopAppUpdater,
  checkAppUpdate,
  installAppUpdate
} = useVersionCheck()

const isSettingsRoute = computed(() => route.path.startsWith('/settings'))
const showUpdateIndicator = computed(() => hasUpdate.value || appUpdateAvailable.value)
const updateTooltip = computed(() => {
  if (appUpdateDownloaded.value) {
    return appUpdateVersion.value ? `客户端 ${appUpdateVersion.value} 已下载，点击安装` : '客户端更新已下载，点击安装'
  }
  if (appUpdateStatus.value === 'downloading') {
    const percent = appUpdateProgress.value == null ? '' : ` ${Math.round(appUpdateProgress.value)}%`
    return `正在下载客户端更新${percent}`
  }
  if (appUpdateStatus.value === 'available') {
    return appUpdateVersion.value ? `发现客户端 ${appUpdateVersion.value}，正在下载` : '发现客户端更新，正在下载'
  }
  if (hasUpdate.value) return '发现页面新版本，点击刷新'
  if (appUpdateStatus.value === 'checking') return '正在检查客户端更新'
  if (appUpdateStatus.value === 'error') return appUpdateError.value || '检查客户端更新失败'
  return '刷新页面'
})

function goBackFromSettings() {
  const active = sessionStore.activeSession
  if (active) {
    router.push(`/tasks/${active.id}`)
    return
  }
  const latest = sessionStore.sessions[0]
  if (latest) {
    router.push(`/tasks/${latest.id}`)
    return
  }
  router.push('/')
}

onMounted(() => {
  startPolling()
  startAppUpdater()
})

onUnmounted(() => {
  stopPolling()
  stopAppUpdater()
})

let installPromptVisible = false

watch(appUpdateDownloaded, (downloaded) => {
  if (downloaded) {
    void confirmInstallUpdate()
  }
})

async function confirmInstallUpdate() {
  if (installPromptVisible) return
  installPromptVisible = true
  try {
    await ElMessageBox.confirm(
      '客户端新版本已下载完成，重启 Mao 后将自动完成安装。',
      '客户端更新已就绪',
      {
        confirmButtonText: '重启安装',
        cancelButtonText: '稍后',
        customClass: 'app-update-message-box',
        type: 'success'
      }
    )
    const result = await installAppUpdate()
    if (result?.error) {
      ElMessage.error(result.error)
    }
  } catch {
    // 用户选择稍后安装
  } finally {
    installPromptVisible = false
  }
}

async function handleUpdateClick() {
  if (appUpdateDownloaded.value) {
    void confirmInstallUpdate()
    return
  }
  if (appUpdateStatus.value === 'downloading') {
    ElMessage.info(updateTooltip.value)
    return
  }
  if (appUpdateAvailable.value) {
    ElMessage.info('客户端更新正在下载，请稍候')
    return
  }
  if (hasUpdate.value) {
    reloadApp()
    return
  }
  await checkAppUpdate()
  // 检查发现客户端更新时保留当前页，让下载/安装流程继续；否则再刷新页面
  // appUpdateAvailable 在 update-available 时已为 true，覆盖 downloading 态
  if (appUpdateAvailable.value || appUpdateDownloaded.value) {
    return
  }
  reloadApp()
}

async function handleCommand(command: string) {
  if (command === 'settings') {
    router.push('/settings/git-credentials')
  } else if (command === 'logout') {
    await authStore.logout()
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
  margin-right: 5px;
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

.login-btn {
  width: auto;
  padding: 0 12px;
  font-size: var(--aw-text-caption);
}

.refresh-btn {
  position: relative;
}

.refresh-btn.has-update {
  color: var(--aw-warning, #e6a23c);
  animation: pulse-update 2s ease-in-out infinite;
}

.update-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aw-warning, #e6a23c);
}

@keyframes pulse-update {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

:global(.app-update-message-box) {
  width: 420px;
  max-width: calc(100vw - 48px);
  padding: 18px 20px 16px;
  border-radius: 8px;
}

:global(.app-update-message-box .el-message-box__header) {
  padding: 0 28px 12px 0;
}

:global(.app-update-message-box .el-message-box__title) {
  font-size: 18px;
  line-height: 1.35;
  font-weight: 600;
  letter-spacing: 0;
}

:global(.app-update-message-box .el-message-box__headerbtn) {
  top: 14px;
  right: 14px;
  width: 24px;
  height: 24px;
  font-size: 16px;
}

:global(.app-update-message-box .el-message-box__content) {
  padding: 4px 0 16px;
  min-height: 0;
}

:global(.app-update-message-box .el-message-box__status) {
  font-size: 22px !important;
}

:global(.app-update-message-box .el-message-box__message p) {
  margin: 0;
  font-size: 14px;
  line-height: 1.65;
  letter-spacing: 0;
}

:global(.app-update-message-box .el-message-box__btns) {
  padding: 0;
  gap: 8px;
}

:global(.app-update-message-box .el-message-box__btns .el-button) {
  min-width: 76px;
  height: 34px;
  padding: 0 16px;
  font-size: 14px;
  font-weight: 500;
  border-radius: 8px;
}
</style>
