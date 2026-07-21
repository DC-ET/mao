import { ref, watch, type Ref } from 'vue'
import type { FileNode } from '../types/file-browser'
import type { WorkspaceFileProvider } from './workspace-file-provider'

export function useFileBrowser(provider: Ref<WorkspaceFileProvider | null>) {
  const treeData = ref<FileNode[]>([])
  const loading = ref(false)
  const expandedPaths = ref<Set<string>>(new Set())

  async function loadRoot() {
    if (!provider.value) {
      treeData.value = []
      return
    }
    loading.value = true
    try {
      const result = await provider.value.listDirectory('')
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

  async function loadChildren(node: FileNode): Promise<void> {
    if (!provider.value) return
    try {
      const result = await provider.value.listDirectory(node.path)
      if (result.error) {
        node.children = [{ name: '', path: node.path, isDirectory: false, error: result.error }]
      } else {
        node.children = (result.entries || []).map(entryToNode)
      }
    } catch (e: any) {
      node.children = [{ name: '', path: node.path, isDirectory: false, error: e.message }]
    }
  }

  /**
   * Collapse chains of single-child directories into package-style names (a/b/c),
   * loading intermediate directories as needed.
   */
  async function compactSingleChildDirs(node: FileNode): Promise<void> {
    if (!node.isDirectory || node.isSymlink || !node.children) return

    while (node.children) {
      const kids: FileNode[] = node.children.filter((c) => !c.error)
      if (kids.length !== 1) break
      const only: FileNode = kids[0]
      if (!only.isDirectory || only.isSymlink) break

      if (!only.children) {
        await loadChildren(only)
      }

      const oldPath = node.path
      node.name = node.name ? `${node.name}/${only.name}` : only.name
      node.path = only.path
      node.children = only.children
      node.isSymlink = only.isSymlink

      if (expandedPaths.value.has(oldPath)) {
        expandedPaths.value.delete(oldPath)
        expandedPaths.value.add(node.path)
      }
    }
  }

  async function expandDir(node: FileNode) {
    if (!provider.value || !node.isDirectory || node.isSymlink) return
    if (node.expanded) {
      node.expanded = false
      expandedPaths.value.delete(node.path)
      return
    }

    if (node.children) {
      node.expanded = true
      expandedPaths.value.add(node.path)
      await compactSingleChildDirs(node)
      return
    }

    node.children = []
    node.expanded = true
    expandedPaths.value.add(node.path)

    await loadChildren(node)
    await compactSingleChildDirs(node)
  }

  /** Expand a directory without collapsing if already expanded. */
  async function forceExpand(node: FileNode) {
    if (!provider.value || !node.isDirectory || node.isSymlink) return
    if (!node.children) {
      node.children = []
      await loadChildren(node)
    }
    node.expanded = true
    expandedPaths.value.add(node.path)
    await compactSingleChildDirs(node)
  }

  function collapseDir(node: FileNode) {
    node.expanded = false
    expandedPaths.value.delete(node.path)
  }

  async function refresh() {
    if (!provider.value) return
    const pathsToRefresh = Array.from(expandedPaths.value)

    loading.value = true
    try {
      const result = await provider.value.listDirectory('')
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

    expandedPaths.value.clear()
    for (const relPath of pathsToRefresh) {
      await restoreExpandedPath(relPath)
    }
  }

  /**
   * Restore an expanded folder after refresh. Handles compacted package paths
   * by walking segments and re-running compaction on each expand.
   */
  async function restoreExpandedPath(relPath: string) {
    const parts = relPath.split('/').filter(Boolean)
    if (parts.length === 0) return

    let level = treeData.value
    let i = 0
    while (i < parts.length) {
      const target = parts.slice(0, i + 1).join('/')
      const node = level.find((n) =>
        n.isDirectory && (
          n.path === target
          || n.path.startsWith(target + '/')
          || n.name === parts[i]
          || n.path.split('/').pop() === parts[i]
        ),
      )
      if (!node) return

      await forceExpand(node)

      // Compaction may advance past several segments
      if (node.path === relPath || !relPath.startsWith(node.path + '/')) {
        return
      }
      const advanced = node.path.split('/').filter(Boolean).length
      i = Math.max(advanced, i + 1)
      level = node.children || []
    }
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

  watch(provider, () => {
    expandedPaths.value.clear()
    loadRoot()
  }, { immediate: true })

  async function loadAllDirectories(nodes: FileNode[], depth: number, maxDepth: number): Promise<void> {
    if (depth >= maxDepth) return
    const tasks: Promise<void>[] = []
    for (const node of nodes) {
      if (node.isDirectory && !node.isSymlink && !node.children) {
        const wasExpanded = !!node.expanded
        tasks.push(expandDir(node).then(async () => {
          if (!wasExpanded) {
            node.expanded = false
            expandedPaths.value.delete(node.path)
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
    loadAllDirectories,
    findNodeByPath,
  }
}
