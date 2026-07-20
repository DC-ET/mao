<template>
  <div
    class="tab-bar"
    role="tablist"
    aria-label="页面标签"
    @keydown="onKeydown"
  >
    <div
      v-for="(tab, index) in tabStore.tabs"
      :key="tab.path"
      :ref="(el) => setTabRef(el, index)"
      role="tab"
      :aria-selected="tab.path === tabStore.activeTabPath"
      :tabindex="tab.path === tabStore.activeTabPath ? 0 : -1"
      :class="['tab-item', { active: tab.path === tabStore.activeTabPath }]"
      @click="tabStore.setActiveTab(tab.path)"
    >
      <span class="tab-title">{{ tab.title }}</span>
      <el-icon
        v-if="tab.closable"
        class="tab-close"
        role="button"
        tabindex="-1"
        aria-label="关闭标签"
        @click.stop="tabStore.removeTab(tab.path)"
      >
        <Close />
      </el-icon>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useTabStore } from '../stores/tabs'

const tabStore = useTabStore()
const tabEls = ref<(HTMLElement | null)[]>([])

function setTabRef(el: unknown, index: number) {
  tabEls.value[index] = (el as HTMLElement) || null
}

function focusTab(index: number) {
  const tabs = tabStore.tabs
  if (tabs.length === 0) return
  const i = ((index % tabs.length) + tabs.length) % tabs.length
  tabStore.setActiveTab(tabs[i].path)
  nextTick(() => tabEls.value[i]?.focus())
}

function activeIndex() {
  return tabStore.tabs.findIndex(t => t.path === tabStore.activeTabPath)
}

function onKeydown(e: KeyboardEvent) {
  const idx = activeIndex()
  if (idx < 0) return

  if (e.key === 'ArrowRight') {
    e.preventDefault()
    focusTab(idx + 1)
    return
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    focusTab(idx - 1)
    return
  }
  if (e.key === 'Home') {
    e.preventDefault()
    focusTab(0)
    return
  }
  if (e.key === 'End') {
    e.preventDefault()
    focusTab(tabStore.tabs.length - 1)
    return
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    tabStore.setActiveTab(tabStore.tabs[idx].path)
    return
  }
  // Close when focus is on the tab bar (avoids hijacking browser Ctrl+W globally).
  if ((e.ctrlKey || e.metaKey) && (e.key === 'w' || e.key === 'W' || e.key === 'F4')) {
    const tab = tabStore.tabs[idx]
    if (tab?.closable) {
      e.preventDefault()
      tabStore.removeTab(tab.path)
      nextTick(() => {
        const nextIdx = Math.max(0, Math.min(idx, tabStore.tabs.length - 1))
        tabEls.value[nextIdx]?.focus()
      })
    }
  }
}
</script>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  height: 40px;
  background: #fff;
  border-bottom: 1px solid #e6e6e6;
  padding: 0 8px;
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
}

.tab-bar::-webkit-scrollbar {
  height: 0;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  margin: 0 2px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  font-size: 13px;
  color: #606266;
  transition: all 0.2s;
  flex-shrink: 0;
  outline: none;
}

.tab-item:hover {
  background: #f5f7fa;
}

.tab-item.active {
  color: #409eff;
  background: #ecf5ff;
}

.tab-item:focus-visible {
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.45);
}

.tab-close {
  font-size: 12px;
  border-radius: 50%;
  transition: all 0.2s;
}

.tab-close:hover {
  background: #c0c4cc;
  color: #fff;
}
</style>
