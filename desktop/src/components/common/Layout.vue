<template>
  <div class="layout">
    <TopNav />
    <main class="layout-main">
      <router-view />
    </main>
    <TerminalPanel />
    <SkillDrawer />
    <CommandDrawer />
    <LoginDialog />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import TopNav from './TopNav.vue'
import TerminalPanel from '../terminal/TerminalPanel.vue'
import SkillDrawer from '../skill/SkillDrawer.vue'
import CommandDrawer from '../command/CommandDrawer.vue'
import LoginDialog from '../auth/LoginDialog.vue'
import { useLoginDialog } from '../../composables/useLoginDialog'

const { autoOpenIfNeeded } = useLoginDialog()

onMounted(() => {
  autoOpenIfNeeded()
})
</script>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.layout-main {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--aw-canvas);
}
</style>
