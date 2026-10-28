<template>
  <div class="center-tab-container">
    <KeepAlive :max="20">
      <ChatPanel v-if="activeTabId === 'chat'" />
      <FileViewer
        v-else-if="activeTab?.type === 'file'"
        :key="`${activeTabId}-${activeTab?.version ?? 0}`"
        :file-path="activeTab.filePath || ''"
        :provider="fileProvider"
      />
      <FileDiffViewer
        v-else-if="activeTab?.type === 'diff' && activeTab.fileChange"
        :key="activeTabId"
        :change="activeTab.fileChange"
        :quote-enabled="activeTabId.startsWith('diff:')"
        :quote-revision="activeTab.quoteRevision ?? 0"
      />
      <SideChatPanel
        v-else-if="activeTab?.type === 'side_task' && activeTab.sideSessionId != null"
        :key="activeTabId"
        :tab-id="activeTabId"
        :side-session-id="activeTab.sideSessionId"
        :context-mode="activeTab.contextMode"
        :fork-from-message-id="activeTab.forkFrom?.messageId"
        :fork-from-label="activeTab.forkFrom?.label"
        :source-session-id="activeTab.sourceSessionId"
      />
      <SubagentChatPanel
        v-else-if="activeTab?.type === 'subagent' && activeTab.sideSessionId != null && activeTab.sideSessionId > 0"
        :key="activeTabId"
        :child-session-id="activeTab.sideSessionId"
      />
      <RunTracePanel
        v-else-if="activeTab?.type === 'trace'"
        :key="`trace-${activeTab.traceSessionId ?? props.sessionId}`"
        :session-id="activeTab.traceSessionId ?? props.sessionId"
      />
      <!-- key 带会话 id：KeepAlive 下同 id 分支会跨会话复用实例，按会话分 key 让切换会话即换新面板 -->
      <FileManagerPanel
        v-else-if="activeTab?.type === 'file_manager'"
        :key="`file-manager-${props.sessionId}`"
        :session-id="props.sessionId"
        :provider="fileProvider"
        @open-file="emit('open-file', $event)"
        @add-file-to-chat="emit('add-file-to-chat', $event)"
        @paths-changed="emit('paths-changed', $event)"
        @tree-refresh="emit('tree-refresh')"
        @locate-in-tree="emit('locate-in-tree', $event)"
      />
      <!-- key 带会话 id：同 FileManagerPanel，多会话同时开 Git Tab 时避免内部状态跨会话串扰 -->
      <GitManagerPanel
        v-else-if="activeTab?.type === 'git'"
        :key="`git-${props.sessionId}`"
        :session-id="props.sessionId"
        :git-provider="gitProvider ?? null"
        :file-provider="fileProvider"
        :execution-mode="executionMode"
        :workspace="workspace"
        @open-git-diff="(file, repoPath) => emit('open-git-diff', file, repoPath)"
        @open-commit-diff="emit('open-commit-diff', $event)"
        @add-file-to-chat="emit('add-file-to-chat', $event)"
      />
    </KeepAlive>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ChatPanel from '../chat/ChatPanel.vue'
import FileViewer from './FileViewer.vue'
import FileDiffViewer from './FileDiffViewer.vue'
import SideChatPanel from '../chat/SideChatPanel.vue'
import SubagentChatPanel from '../chat/SubagentChatPanel.vue'
import RunTracePanel from './RunTracePanel.vue'
import FileManagerPanel from '../file-browser/FileManagerPanel.vue'
import GitManagerPanel from '../git/GitManagerPanel.vue'
import type { Tab } from '../../types/file-browser'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import type { WorkspaceGitProvider } from '../../composables/workspace-git-provider'
import type { WorkspacePathChange } from '../../utils/workspace-tab-paths'
import type { GitChangedFile } from '../../types/git'

const props = defineProps<{
  tabs: Tab[]
  activeTabId: string
  sessionId: string
  fileProvider: WorkspaceFileProvider | null
  gitProvider: WorkspaceGitProvider | null
  executionMode?: string
  workspace?: string
}>()

const emit = defineEmits<{
  'open-file': [payload: { path: string; title: string }]
  'add-file-to-chat': [filePath: string]
  'paths-changed': [change: WorkspacePathChange]
  'tree-refresh': []
  'locate-in-tree': [relPath: string]
  'open-git-diff': [file: GitChangedFile, repoPath?: string]
  'open-commit-diff': [payload: { hash: string; file: GitChangedFile; repoPath?: string }]
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
