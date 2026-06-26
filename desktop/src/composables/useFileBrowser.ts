import { ref, watch, type Ref } from 'vue'
import type { FileNode } from '../types/file-browser'

export function useFileBrowser(workspace: Ref<string>) {
  const treeData = ref<FileNode[]>([])
  const loading = ref(false)
  const expandedPaths = ref<Set<string>>(new Set())

  async function loadRoot() {
    if (!workspace.value) {
      treeData.value = []
      return
    }
    loading.value = true
    try {
      const result = await window.electronAPI.listDirectory(workspace.value, workspace.value)
      if (result.error) {
        treeData.value = [{ name: '', path: '', isDirectory: false, error: result.error }]
      } else {
        treeData.value = (result.entries || []).map(entryToNode)
      }
    } catch (e: any) {
      treeData.value = [{ name: '', path: '', isDirectory: false, error: e.message }]
    } finally {
      loading.value = false
    }
  }

  async function expandDir(node: FileNode) {
    if (!node.isDirectory || node.isSymlink) return
    if (node.expanded) {
      node.expanded = false
      expandedPaths.value.delete(node.path)
      return
    }

    // If already loaded, just expand
    if (node.children) {
      node.expanded = true
      expandedPaths.value.add(node.path)
      return
    }

    const absolutePath = getAbsolutePath(node.path)
    node.children = [] // show empty while loading
    node.expanded = true
    expandedPaths.value.add(node.path)

    try {
      const result = await window.electronAPI.listDirectory(absolutePath, workspace.value)
      if (result.error) {
        node.children = [{ name: '', path: node.path, isDirectory: false, error: result.error }]
      } else {
        node.children = (result.entries || []).map(entryToNode)
      }
    } catch (e: any) {
      node.children = [{ name: '', path: node.path, isDirectory: false, error: e.message }]
    }
  }

  function collapseDir(node: FileNode) {
    node.expanded = false
    expandedPaths.value.delete(node.path)
  }

  async function refresh() {
    if (!workspace.value) return
    const pathsToRefresh = Array.from(expandedPaths.value)

    // Reload root
    loading.value = true
    try {
      const result = await window.electronAPI.listDirectory(workspace.value, workspace.value)
      if (result.error) {
        treeData.value = [{ name: '', path: '', isDirectory: false, error: result.error }]
        return
      }
      treeData.value = (result.entries || []).map(entryToNode)
    } catch (e: any) {
      treeData.value = [{ name: '', path: '', isDirectory: false, error: e.message }]
      return
    } finally {
      loading.value = false
    }

    // Re-expand previously expanded directories
    for (const relPath of pathsToRefresh) {
      const node = findNodeByPath(treeData.value, relPath)
      if (node && node.isDirectory) {
        await expandDir(node)
      }
    }
  }

  function getAbsolutePath(relPath: string): string {
    if (!workspace.value) return relPath
    // Normalize: workspace + '/' + relPath
    const sep = workspace.value.includes('\\') ? '\\' : '/'
    return workspace.value.replace(/[\\/]+$/, '') + sep + relPath
  }

  function entryToNode(entry: { name: string; path: string; isDirectory: boolean; size: number; isSymlink: boolean }): FileNode {
    return {
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
      size: entry.size,
    }
  }

  function findNodeByPath(nodes: FileNode[], relPath: string): FileNode | null {
    for (const node of nodes) {
      if (node.path === relPath) return node
      if (node.children) {
        const found = findNodeByPath(node.children, relPath)
        if (found) return found
      }
    }
    return null
  }

  // Reload when workspace changes
  watch(workspace, () => {
    expandedPaths.value.clear()
    loadRoot()
  }, { immediate: true })

  async function loadAllDirectories(nodes: FileNode[], depth: number, maxDepth: number): Promise<void> {
    if (depth >= maxDepth) return
    const tasks: Promise<void>[] = []
    for (const node of nodes) {
      if (node.isDirectory && !node.isSymlink && !node.children) {
        // Save original expanded state to restore later
        const wasExpanded = !!node.expanded
        tasks.push(expandDir(node).then(async () => {
          if (!wasExpanded) {
            // Restore collapsed state — we only loaded to check for matches
            node.expanded = false
          }
          if (node.children) {
            await loadAllDirectories(node.children, depth + 1, maxDepth)
          }
        }))
      } else if (node.isDirectory && node.children) {
        tasks.push(loadAllDirectories(node.children, depth + 1, maxDepth))
      }
    }
    await Promise.all(tasks)
  }

  return {
    treeData,
    loading,
    expandedPaths,
    expandDir,
    collapseDir,
    refresh,
    getAbsolutePath,
    loadAllDirectories,
  }
}
