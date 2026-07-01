<template>
  <div class="center-tab-container">
    <KeepAlive :max="20">
      <ChatPanel v-if="activeTabId === 'chat'" />
      <FileViewer
        v-else-if="activeFileTab"
        :key="activeTabId"
        :file-path="activeFileTab.filePath || ''"
        :provider="fileProvider"
      />
    </KeepAlive>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ChatPanel from '../chat/ChatPanel.vue'
import FileViewer from './FileViewer.vue'
import type { Tab } from '../../types/file-browser'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'

const props = defineProps<{
  tabs: Tab[]
  activeTabId: string
  sessionId: string
  fileProvider: WorkspaceFileProvider | null
}>()

const activeFileTab = computed(() => {
  if (props.activeTabId === 'chat') return null
  return props.tabs.find(t => t.id === props.activeTabId) || null
})
</script>

<style scoped>
.center-tab-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
</style>
