<template>
  <div class="settings-layout">
    <aside class="settings-sidebar">
      <button class="settings-back" @click="goBack">
        <el-icon :size="14"><ArrowLeft /></el-icon>
        返回工作台
      </button>
      <h2 class="settings-title">设置</h2>
      <nav class="settings-nav">
        <router-link to="/settings/git-credentials" class="settings-nav-item" active-class="active">
          Git 凭证
        </router-link>
        <router-link to="/settings/notifications" class="settings-nav-item" active-class="active">
          消息通知
        </router-link>
        <router-link to="/settings/weixin-bot" class="settings-nav-item" active-class="active">
          微信Bot
        </router-link>
      </nav>
    </aside>
    <section class="settings-content">
      <router-view />
    </section>
  </div>
</template>

<script setup lang="ts">
import { ArrowLeft } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '../../stores/session'

const router = useRouter()
const sessionStore = useSessionStore()

function goBack() {
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
</script>

<style scoped>
.settings-layout {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.settings-sidebar {
  width: 200px;
  flex-shrink: 0;
  padding: 24px 16px;
  border-right: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
}

.settings-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 0 16px 4px;
  padding: 4px 8px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-ink-muted);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.settings-back:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.settings-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--aw-ink);
  margin: 0 0 16px 8px;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-nav-item {
  display: block;
  padding: 8px 12px;
  border-radius: var(--aw-radius-xs);
  font-size: 13px;
  color: var(--aw-ink-muted);
  text-decoration: none;
  transition: color 0.15s, background 0.15s;
}

.settings-nav-item:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
  text-decoration: none;
}

.settings-nav-item.active {
  color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.08);
  font-weight: 500;
}

.settings-content {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 24px 32px;
}

@media (max-width: 640px) {
  .settings-layout {
    flex-direction: column;
    height: 100%;
    overflow: auto;
  }

  .settings-sidebar {
    width: 100%;
    padding: 14px 16px 10px;
    border-right: 0;
    border-bottom: 1px solid var(--aw-divider-soft);
  }

  .settings-back {
    margin: 0 0 10px;
  }

  .settings-title {
    margin: 0 0 10px;
  }

  .settings-nav {
    flex-direction: row;
    overflow-x: auto;
  }

  .settings-nav-item {
    flex: 0 0 auto;
  }

  .settings-content {
    flex: none;
    overflow: visible;
    padding: 20px 16px 28px;
  }
}
</style>
