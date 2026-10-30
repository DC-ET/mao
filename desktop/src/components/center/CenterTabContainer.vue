<template>
  <div class="center-tab-container">
    <KeepAlive :max="20">
      <ChatPanel v-if="activeTabId === 'chat'" />
      <FileViewer
        v-else-if="activeTab?.type === 'file'"
        :key="`${activeTabId}-${activeTab?.version ?? 0}`"
        :file-path="activeTab.filePath || ''"
        :provider="activeProvider"
        :workspace-root="activeTab.workspaceRoot"
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
        :key="`file-manager-${props.sessionId}-${activeTab.workspaceRoot ?? 'session'}`"
        :session-id="activeTab.workspaceRoot ? '' : props.sessionId"
        :workspace-root="activeTab.workspaceRoot"
        :provider="activeProvider"
        @open-file="onOpenFile"
        @add-file-to-chat="onAddFileToChat"
        @paths-changed="onPathsChanged"
        @tree-refresh="onTreeRefresh"
        @locate-in-tree="onLocateInTree"
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
        @open-branch-diff="emit('open-branch-diff', $event)"
        @add-file-to-chat="emit('add-file-to-chat', $event)"
      />
      <!-- 我的工作区：全局资产视图，不随会话切换（key 固定） -->
      <WorkspaceOverviewPanel
        v-else-if="activeTab?.type === 'workspace_overview'"
        @use-for-new-task="emit('use-for-new-task', $event)"
        @open-file-manager="emit('open-file-manager', $event)"
      />
    </KeepAlive>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { createOwnedWorkspaceProvider } from '../../composables/workspace-file-provider'
import ChatPanel from '../chat/ChatPanel.vue'
import FileViewer from './FileViewer.vue'
import FileDiffViewer from './FileDiffViewer.vue'
import SideChatPanel from '../chat/SideChatPanel.vue'
import SubagentChatPanel from '../chat/SubagentChatPanel.vue'
import RunTracePanel from './RunTracePanel.vue'
import FileManagerPanel from '../file-browser/FileManagerPanel.vue'
import GitManagerPanel from '../git/GitManagerPanel.vue'
import WorkspaceOverviewPanel from '../workspace/WorkspaceOverviewPanel.vue'
import type { Tab } from '../../types/file-browser'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import type { WorkspaceGitProvider } from '../../composables/workspace-git-provider'
import type { WorkspacePathChange } from '../../utils/workspace-tab-paths'
import type { GitChangedFile } from '../../types/git'
import type { WorkspaceOverviewEntry } from '../../types/workspace-overview'

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
  'open-file': [payload: { path: string; title: string; workspaceRoot?: string }]
  'add-file-to-chat': [filePath: string]
  'paths-changed': [change: WorkspacePathChange]
  'tree-refresh': []
  'locate-in-tree': [relPath: string]
  'open-git-diff': [file: GitChangedFile, repoPath?: string]
  'open-commit-diff': [payload: { hash: string; file: GitChangedFile; repoPath?: string }]
  'open-branch-diff': [payload: { base: string; target: string; file: GitChangedFile; repoPath?: string }]
  'use-for-new-task': [entry: WorkspaceOverviewEntry]
  'open-file-manager': [entry: WorkspaceOverviewEntry]
}>()

const activeTab = computed(() => {
  if (props.activeTabId === 'chat') return null
  return props.tabs.find(t => t.id === props.activeTabId) || null
})

const ownedProviders = new Map<string, WorkspaceFileProvider>()

const activeProvider = computed(() => {
  const root = activeTab.value?.workspaceRoot
  if (!root) return props.fileProvider
  let provider = ownedProviders.get(root)
  if (!provider) {
    provider = createOwnedWorkspaceProvider(root)
    ownedProviders.set(root, provider)
  }
  return provider
})

/** 总览打开的目录不是当前会话工作区时，不要改当前会话的文件树和已打开文件。 */
function affectsCurrentSession(tab: Tab | null): boolean {
  if (!tab?.workspaceRoot) return true
  return tab.workspaceRoot === props.workspace
}

function onOpenFile(payload: { path: string; title: string }) {
  emit('open-file', { ...payload, workspaceRoot: activeTab.value?.workspaceRoot })
}

function onAddFileToChat(filePath: string) {
  if (!affectsCurrentSession(activeTab.value)) return
  emit('add-file-to-chat', filePath)
}

function onPathsChanged(change: WorkspacePathChange) {
  if (!affectsCurrentSession(activeTab.value)) return
  emit('paths-changed', change)
}

function onTreeRefresh() {
  if (!affectsCurrentSession(activeTab.value)) return
  emit('tree-refresh')
}

function onLocateInTree(relPath: string) {
  if (!affectsCurrentSession(activeTab.value)) return
  emit('locate-in-tree', relPath)
}
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
