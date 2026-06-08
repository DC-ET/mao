<template>
  <div v-show="isOpen" class="terminal-panel" :style="{ height: panelHeight + 'px' }">
    <div class="terminal-resize-handle" @mousedown="startResize" />
    <div class="terminal-header">
      <TerminalTabs
        :tabs="tabs"
        :active-id="activeTabId"
        @switch="handleSwitch"
        @close="closeTerminal"
        @create="handleCreate"
      />
      <button class="terminal-panel-close" @click="togglePanel()" title="关闭终端 (Ctrl+`)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <div class="terminal-container">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        v-show="tab.id === activeTabId"
        :ref="(el) => setContainerRef(tab.id, el as HTMLElement | null)"
        class="terminal-instance"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useTerminal } from '../../composables/useTerminal'
import { useSessionStore } from '../../stores/session'
import TerminalTabs from './TerminalTabs.vue'

const {
  tabs,
  activeTabId,
  isOpen,
  createTerminal,
  mountTerminal,
  fitTerminal,
  fitAllTerminals,
  switchTab,
  closeTerminal,
  togglePanel,
  getActiveInstance,
} = useTerminal()

const panelHeight = ref(300)
const MIN_HEIGHT = 100
const MAX_HEIGHT_RATIO = 0.7

const containerRefs = new Map<string, HTMLElement>()
const mountedTerminals = new Set<string>()

function setContainerRef(id: string, el: HTMLElement | null) {
  if (el) {
    containerRefs.set(id, el)
  } else {
    containerRefs.delete(id)
    mountedTerminals.delete(id)
  }
}

watch(activeTabId, (newId) => {
  if (!newId) return
  nextTick(() => {
    const container = containerRefs.get(newId)
    if (container && !mountedTerminals.has(newId)) {
      mountedTerminals.add(newId)
      mountTerminal(newId, container)
    } else {
      // Focus existing terminal when switching tabs
      const inst = getActiveInstance()
      if (inst) inst.terminal.focus()
    }
    fitTerminal(newId)
  })
})

watch(
  () => tabs.value.length,
  () => {
    nextTick(() => {
      if (activeTabId.value) {
        const container = containerRefs.get(activeTabId.value)
        if (container && !mountedTerminals.has(activeTabId.value)) {
          mountedTerminals.add(activeTabId.value)
          mountTerminal(activeTabId.value, container)
        }
      }
    })
  }
)

async function handleCreate() {
  const sessionStore = useSessionStore()
  const session = sessionStore.activeSession
  let cwd: string | undefined
  if (session?.executionMode === 'LOCAL' && session.workspace) {
    cwd = session.workspace
  }
  await createTerminal(cwd)
}

function handleSwitch(id: string) {
  switchTab(id)
}

function startResize(e: MouseEvent) {
  e.preventDefault()
  const startY = e.clientY
  const startHeight = panelHeight.value

  function onMove(e: MouseEvent) {
    const delta = startY - e.clientY
    const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO
    panelHeight.value = Math.max(MIN_HEIGHT, Math.min(maxHeight, startHeight + delta))
    if (activeTabId.value) {
      fitTerminal(activeTabId.value)
    }
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

function handleWindowResize() {
  fitAllTerminals()
}

onMounted(() => {
  window.addEventListener('resize', handleWindowResize)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleWindowResize)
})
</script>

<style scoped>
.terminal-panel {
  display: flex;
  flex-direction: column;
  background: var(--aw-canvas);
  border-top: 1px solid var(--aw-divider-soft);
  position: relative;
  flex-shrink: 0;
}

.terminal-resize-handle {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
  z-index: 10;
}

.terminal-resize-handle:hover {
  background: var(--aw-primary);
  opacity: 0.2;
}

.terminal-header {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.terminal-header .terminal-tabs {
  flex: 1;
  min-width: 0;
}

.terminal-panel-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 36px;
  border: none;
  background: var(--aw-terminal-header-bg);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}

.terminal-panel-close:hover {
  color: var(--aw-ink);
  background: var(--aw-divider-soft);
}

.terminal-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--aw-terminal-bg);
  padding: 4px 16px;
}

.terminal-instance {
  width: 100%;
  height: 100%;
}
</style>
