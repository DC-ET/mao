<template>
  <div class="git-change-list">
    <div class="git-toolbar">
      <div class="git-toolbar-title">
        变更
        <span v-if="!loading" class="git-count">{{ files.length }}</span>
      </div>
      <button class="git-refresh-btn" :disabled="loading" title="刷新" @click="$emit('refresh')">
        <el-icon :size="14" :class="{ spinning: loading }"><Refresh /></el-icon>
      </button>
    </div>

    <div v-if="error" class="git-state git-error">
      <p>{{ error }}</p>
      <button class="git-retry" @click="$emit('refresh')">重试</button>
    </div>
    <div v-else-if="loading && files.length === 0" class="git-state">加载中…</div>
    <div v-else-if="files.length === 0" class="git-state">没有待提交的变更</div>
    <div v-else class="git-tree">
      <div class="git-tree-inner">
        <GitChangeTreeNode
          v-for="node in treeRoots"
          :key="node.path"
          :node="node"
          :depth="0"
          :collapsed="collapsed"
          @toggle="toggleDir"
          @open-diff="(file) => $emit('open-diff', file)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import type { GitChangedFile, GitTreeNode } from '../../types/git'
import GitChangeTreeNode from './GitChangeTreeNode.vue'

const props = defineProps<{
  files: GitChangedFile[]
  loading?: boolean
  error?: string
}>()

defineEmits<{
  refresh: []
  'open-diff': [file: GitChangedFile]
}>()

/** Paths of collapsed directories (default: all expanded) */
const collapsed = reactive(new Set<string>())

const treeRoots = computed(() => buildGitTree(props.files))

watch(
  () => props.files,
  () => {
    const valid = new Set<string>()
    collectDirPaths(treeRoots.value, valid)
    for (const path of [...collapsed]) {
      if (!valid.has(path)) collapsed.delete(path)
    }
  },
)

function toggleDir(path: string) {
  if (collapsed.has(path)) collapsed.delete(path)
  else collapsed.add(path)
}

function collectDirPaths(nodes: GitTreeNode[], out: Set<string>) {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      out.add(node.path)
      collectDirPaths(node.children, out)
    }
  }
}

function buildGitTree(files: GitChangedFile[]): GitTreeNode[] {
  type MutableDir = {
    kind: 'dir'
    name: string
    path: string
    dirs: Map<string, MutableDir>
    files: Map<string, GitChangedFile>
  }

  const root: MutableDir = {
    kind: 'dir',
    name: '',
    path: '',
    dirs: new Map(),
    files: new Map(),
  }

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))

  for (const file of sorted) {
    const parts = file.path.split('/').filter(Boolean)
    if (parts.length === 0) continue

    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      const dirPath = parts.slice(0, i + 1).join('/')
      let child = current.dirs.get(name)
      if (!child) {
        child = {
          kind: 'dir',
          name,
          path: dirPath,
          dirs: new Map(),
          files: new Map(),
        }
        current.dirs.set(name, child)
      }
      current = child
    }

    const fileName = parts[parts.length - 1]
    current.files.set(fileName, file)
  }

  function finalize(dir: MutableDir): GitTreeNode {
    const children: GitTreeNode[] = []

    const dirNames = [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of dirNames) {
      children.push(finalize(dir.dirs.get(name)!))
    }

    const fileNames = [...dir.files.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of fileNames) {
      const file = dir.files.get(name)!
      children.push({
        kind: 'file',
        name,
        path: file.path,
        file,
      })
    }

    return {
      kind: 'dir',
      name: dir.name,
      path: dir.path,
      children: compressChildren(children),
    }
  }

  /** Merge single-child directory chains into package-style names: a/b/c */
  function compressChildren(nodes: GitTreeNode[]): GitTreeNode[] {
    return nodes.map((node) => {
      if (node.kind !== 'dir') return node
      let current = node
      const parts = [current.name]
      while (
        current.children.length === 1
        && current.children[0].kind === 'dir'
      ) {
        current = current.children[0]
        parts.push(current.name)
      }
      return {
        kind: 'dir' as const,
        name: parts.filter(Boolean).join('/'),
        path: current.path,
        children: compressChildren(current.children),
      }
    })
  }

  const tree = finalize(root)
  return tree.kind === 'dir' ? tree.children : []
}
</script>

<style scoped>
.git-change-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.git-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
}

.git-toolbar-title {
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 6px;
}

.git-count {
  font-family: var(--aw-font-mono);
  font-weight: 500;
  color: var(--aw-ink-muted-48);
  text-transform: none;
  letter-spacing: 0;
}

.git-refresh-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-ink-muted-48);
  cursor: pointer;
}

.git-refresh-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
  color: var(--aw-primary);
}

.git-refresh-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.spinning {
  animation: git-spin 0.8s linear infinite;
}

@keyframes git-spin {
  to { transform: rotate(360deg); }
}

.git-state {
  padding: 24px 16px;
  text-align: center;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
}

.git-error p {
  margin: 0 0 8px;
}

.git-retry {
  border: none;
  background: transparent;
  color: var(--aw-primary);
  cursor: pointer;
  font-size: var(--aw-text-caption);
}

.git-tree {
  overflow: auto;
  flex: 1;
  min-height: 0;
  padding: 4px 0;
}

.git-tree-inner {
  width: max-content;
  min-width: 100%;
}

[data-theme="dark"] .git-toolbar {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .git-refresh-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}
</style>
