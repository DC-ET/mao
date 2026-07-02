<template>
  <div class="center-tab-container">
    <KeepAlive :max="20">
      <ChatPanel v-if="activeTabId === 'chat'" />
      <FileViewer
        v-else-if="activeTab?.type === 'file'"
        :key="activeTabId"
        :file-path="activeTab.filePath || ''"
        :provider="fileProvider"
      />
      <FileDiffViewer
        v-else-if="activeTab?.type === 'diff' && activeTab.fileChange"
        :key="activeTabId"
        :change="activeTab.fileChange"
      />
    </KeepAlive>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ChatPanel from '../chat/ChatPanel.vue'
import FileViewer from './FileViewer.vue'
import FileDiffViewer from './FileDiffViewer.vue'
import type { Tab } from '../../types/file-browser'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'

const props = defineProps<{
  tabs: Tab[]
  activeTabId: string
  sessionId: string
  fileProvider: WorkspaceFileProvider | null
}>()

const activeTab = computed(() => {
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
