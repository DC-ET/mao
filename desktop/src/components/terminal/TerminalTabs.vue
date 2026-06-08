<template>
  <div class="terminal-tabs">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="terminal-tab"
      :class="{ active: tab.id === activeId }"
      @click="$emit('switch', tab.id)"
    >
      <svg class="terminal-tab-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
      </svg>
      <span class="terminal-tab-title">{{ formatTabTitle(tab) }}</span>
      <button class="terminal-tab-close" @click.stop="$emit('close', tab.id)">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <button class="terminal-tab-add" @click="$emit('create')" title="新建终端">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { TerminalTab } from '../../composables/useTerminal'

defineProps<{
  tabs: TerminalTab[]
  activeId: string | null
}>()

defineEmits<{
  switch: [id: string]
  close: [id: string]
  create: []
}>()

function formatTabTitle(tab: TerminalTab): string {
  const parts: string[] = []
  if (tab.cwd && tab.cwd !== '~') {
    const folderName = tab.cwd.split('/').filter(Boolean).pop()
    if (folderName) parts.push(folderName)
  }
  if (parts.length === 0) {
    parts.push(tab.title)
  }
  return parts.join(' ')
}
</script>

<style scoped>
.terminal-tabs {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 8px;
  gap: 2px;
  background: var(--aw-terminal-header-bg);
  flex-shrink: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.terminal-tabs::-webkit-scrollbar {
  display: none;
}

.terminal-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 28px;
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.terminal-tab:hover {
  background: var(--aw-divider-soft);
  color: var(--aw-ink);
}

.terminal-tab.active {
  background: var(--aw-canvas);
  color: var(--aw-ink);
}

.terminal-tab-icon {
  flex-shrink: 0;
  color: var(--aw-ink-muted-48);
  transition: color 0.15s;
}

.terminal-tab.active .terminal-tab-icon {
  color: var(--aw-primary);
}

.terminal-tab-title {
  font-family: var(--aw-font-mono);
  font-size: 12px;
}

.terminal-tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  border-radius: 3px;
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  padding: 0;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}

.terminal-tab:hover .terminal-tab-close {
  opacity: 1;
}

.terminal-tab-close:hover {
  background: var(--aw-hairline);
  color: var(--aw-ink);
}

.terminal-tab-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  padding: 0;
  margin-left: 2px;
  transition: background 0.15s, color 0.15s;
}

.terminal-tab-add:hover {
  background: var(--aw-divider-soft);
  color: var(--aw-ink);
}
</style>
