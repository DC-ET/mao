# 「文件管理」页签未提交改动代码审查（2026-10-12）

- **日期**：2026-10-12
- **基线**：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/file-manager-tab`（分支 `feature/file-manager-tab`，HEAD `42429edf`），审查对象为该工作区未提交的功能改动（10 个 modified + 8 个新增前端文件 + 后端 1 处 additive 字段）。所有行号以审查时源码实测核对。
- **范围**：`backend-ts/src/file/workspace-browse.service.ts`(+spec)、`desktop/src/components/file-browser/FileManager{Panel,Grid,List,ContextMenu}.vue`、`desktop/src/composables/useFileManager.ts`、`desktop/src/utils/file-manager.ts` 及接线文件（`useCenterTabs.ts` / `CenterTabContainer.vue` / `FileTree.vue` / `TaskInspector.vue` / `TaskView.vue` / `useFileBrowser.ts` / `workspace-file-provider.ts` / `types/file-browser.ts`）。
- **方法**：每条 BUG 均附带可运行测试（断言一律写「正确行为」，对当前代码必然失败），在 worktree 的 `desktop/` 下 `npx vitest run <file>` 实测复现；测试文件验证后已从仓库移除，全文粘贴于各 BUG 小节。审查中途（12:47）工作区出现了 `CHANGELOG.md` / `README.md` / `desktop/package.json`(0.0.281) / `skills/mao-cli/reference/desktop.md` 的发布配套改动，属文档与版本号范畴，按约定不审查。
- **环境说明**：desktop vitest 为 `environment: 'node'`、`include: ['src/**/*.test.ts']`，未装 `@vue/test-utils` / jsdom，组件无法挂载。涉及组件内联处理器的 BUG，其验证测试用**真实 composable / 真实纯函数**驱动，并逐字复刻面板中的表达式（测试内有注释标明复刻来源），状态结论与组件内行为一致。
- **结论**：确认 **6 个 BUG**（2 高 / 3 中 / 1 低）。既有测试（`useFileManager.test.ts`、`file-manager.test.ts`、后端 spec）全部通过，说明上述问题均在现有用例覆盖盲区。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 高 | desktop/workspace-file-provider | CLOUD `listDirectory` 未把后端 `mtimeMs` 映射为 `FileNode.mtime`，文件管理器仅 CLOUD 可用，「修改时间」列恒为 "—"、按修改时间排序完全失效 |
| BUG-2 | 中 | desktop/useFileManager | 清空搜索词 / 导航时不递增 `searchSeq`，迟到的搜索响应把已取消的搜索结果面板重新点亮，盖住目录列表 |
| BUG-3 | 高 | desktop/FileManagerPanel | 右键菜单不校正选区：删除/剪切/复制/下载/复制路径/添加到聊天作用于陈旧选区（可删错文件）；未选中任何条目时这些菜单项静默无响应 |
| BUG-4 | 中 | desktop/useFileManager | 新建草稿不随导航取消：在 A 目录开始新建、切到 B 目录提交，文件实际建到 A，B 目录刷新后看不到 |
| BUG-5 | 中 | desktop/FileManagerPanel | 拖内部路径到内容区空白处时 `canDropTarget` 预检要求 target 出现在 `entries` 里，而 `currentDir` 永远不在自己的子列表中，空白处移动是静默死路径（侧边栏拖入失效） |
| BUG-6 | 低 | desktop/FileManagerPanel | 剪切粘贴中途失败/用户取消后仍无条件 `clipboard.clear()`，未处理的剩余路径从剪贴板丢失，无法重试 |

---

## BUG-1【高】CLOUD 目录列表丢失 mtime：时间列恒 "—"、按修改时间排序失效

### 位置

- `backend-ts/src/file/workspace-browse.service.ts:33-35`（DTO 新增 `mtimeMs?: number`）、`:114`（`entry.mtimeMs = lst.mtimeMs`）
- `backend-ts/src/file/file.routes.ts:123-127`（`sendOk` 原样透传 DTO）
- `desktop/src/composables/workspace-file-provider.ts:181-193`（`createCloudProvider.listDirectory` 直接 `entries: data?.entries ?? []`，**无字段映射**）
- `desktop/src/types/file-browser.ts:9`（`FileNode.mtime?: number`）、`desktop/src/utils/file-manager.ts:49`（`sortEntries` 读 `a.mtime`）、`FileManagerGrid.vue:118-119` / `FileManagerList.vue:55`（`formatTime(entry.mtime)`）

### 代码事实

后端新增字段名是 `mtimeMs`，前端 `FileNode` / `DirectoryEntry` 的字段名是 `mtime`。CLOUD provider 的 `listDirectory` 把 HTTP 响应条目原样返回，没有任何 `mtimeMs → mtime` 的转换：

```ts
// workspace-file-provider.ts:181-193
async listDirectory(relativeDir: string) {
  try {
    const { data } = await api.get('/files/workspace-directory', { ... })
    return { entries: data?.entries ?? [], truncated: data?.truncated ?? false }  // mtimeMs 原样带出
  } catch (e: any) { return { error: e.message || '读取目录失败' } }
}
```

本地 IPC 路径（`electron/main.cjs:1730`）返回的字段名恰好是 `mtime`，所以 LOCAL 侧边栏不受影响；而文件管理器按需求**仅 CLOUD 模式可用**，等于该维度全量失效。`types/file-browser.ts:9` 的注释「CLOUD 由后端 mtimeMs 提供」也只走到了「提供」，没走「贯通」。

### 期望 vs 实际

- 期望：CLOUD 条目 `mtime` = 后端 `mtimeMs`；列表/图标视图「修改时间」列显示真实时间；按修改时间排序按时间先后排列。
- 实际：`entry.mtime` 恒 `undefined` → `formatTime` 返回 "—"；`sortEntries` 的 mtime 比较全部并列 0，退化为按名称 tie-break，「按修改时间」排序与「按名称」无异。

### 验证测试（实测失败）

`desktop/src/composables/zz-verify-bug1-mtime.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'

/** 复现 BUG-1：CLOUD provider 未把后端 mtimeMs 映射为 FileNode.mtime */
vi.mock('../api', () => ({
  api: {
    // 响应拦截器会把 body 作为 api.get 的返回值（见 src/api/index.ts L62-82），
    // 因此这里直接返回 Result body：{ code, data: { entries, truncated } }
    get: vi.fn(async () => ({
      code: 0,
      data: {
        entries: [
          // 形状与后端 DirectoryEntryDTO 完全一致（workspace-browse.service.ts L27-35）
          { name: 'b.txt', path: 'b.txt', isDirectory: false, size: 10, isSymlink: false, mtimeMs: 100 },
          { name: 'a.txt', path: 'a.txt', isDirectory: false, size: 10, isSymlink: false, mtimeMs: 200 },
        ],
        truncated: false,
      },
    })),
  },
}))

import { createCloudProvider } from './workspace-file-provider'
import { formatTime, sortEntries } from '../utils/file-manager'
import type { FileNode } from '../types/file-browser'

describe('BUG-1 CLOUD listDirectory 丢失 mtime', () => {
  it('后端返回 mtimeMs，前端条目上只有 mtimeMs 没有 mtime', async () => {
    const provider = createCloudProvider('42')
    const result = await provider.listDirectory('')
    const file = result.entries![0]
    expect((file as unknown as { mtimeMs?: number }).mtimeMs).toBe(100)
    // 期望：provider 把 mtimeMs 映射为 mtime；实际：mtime 恒 undefined
    expect(file.mtime).toBe(100)
  })

  it('按修改时间排序退化为按名称，「修改时间」列显示占位符', async () => {
    const provider = createCloudProvider('42')
    const result = await provider.listDirectory('')
    const nodes = result.entries as FileNode[]
    // mtime 升序应为 b.txt(100) → a.txt(200)；mtime 缺失时全部并列 0，tie-break 成名称序
    expect(sortEntries(nodes, 'mtime', 'asc').map((e) => e.name)).toEqual(['b.txt', 'a.txt'])
    expect(formatTime(nodes[0].mtime)).toMatch(/^\d{4}-/)
  })
})
```

实测输出（`npx vitest run src/composables/zz-verify-bug1-mtime.test.ts`）：

```
 FAIL  src/composables/zz-verify-bug1-mtime.test.ts > BUG-1 CLOUD listDirectory 丢失 mtime > 后端返回 mtimeMs，前端条目上只有 mtimeMs 没有 mtime
AssertionError: expected undefined to be 100
 FAIL  src/composables/zz-verify-bug1-mtime.test.ts > BUG-1 CLOUD listDirectory 丢失 mtime > 按修改时间排序退化为按名称，「修改时间」列显示占位符
AssertionError: expected [ 'a.txt', 'b.txt' ] to deeply equal [ 'b.txt', 'a.txt' ]
```

---

## BUG-2【中】搜索竞态：迟到响应复活已取消的搜索结果，盖住目录列表

### 位置

- `desktop/src/composables/useFileManager.ts:214-232`（`watch(searchQuery)`：清空时只重置 `searchResults/searching`，**不递增 `searchSeq`**）
- `desktop/src/composables/useFileManager.ts:234-259`（`runSearch`：`if (seq !== searchSeq) return` 是唯一竞态防线）
- `desktop/src/composables/useFileManager.ts:114-122`（`navigateTo`，同样不动 `searchSeq`）
- `desktop/src/components/file-browser/FileManagerPanel.vue:73`（模板 `<template v-if="searchResults">` 优先于目录列表渲染）

### 代码事实

`runSearch` 的在飞请求只靠 `seq === searchSeq` 判断是否过期。清空搜索词（Escape / 清除按钮）或导航到别的目录时，`searchSeq` 不变，迟到的响应依旧满足 `seq === searchSeq`，把 `searchResults` 重新写回：

```ts
// useFileManager.ts:243-251
const result = await providerValue.searchFiles(pattern, SEARCH_RESULT_LIMIT)
if (seq !== searchSeq) return          // 清空/导航没有递增 searchSeq，这道防线形同虚设
...
searchResults.value = result.entries ?? []
```

由于模板里 `v-if="searchResults"` 优先于目录列表，用户按 Escape 退出搜索、或点面包屑切换到某目录后，界面会突然重新显示上一轮搜索结果，且此时点击这些「陈旧结果」还会跳转到对应目录。

### 期望 vs 实际

- 期望：Escape / 清空 / 导航之后，`searchResults` 保持 `null`，界面显示当前目录列表。
- 实际：在飞搜索返回后 `searchResults` 被重新写回，搜索结果面板盖住目录列表，直到用户再次清空搜索框。

### 验证测试（实测失败）

`desktop/src/composables/zz-verify-bug2-search-race.test.ts`：

```ts
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryResult, WorkspaceFileProvider } from './workspace-file-provider'
import type { FileNode } from '../types/file-browser'
import { useFileManager } from './useFileManager'

const localStorageStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStorageStore.set(k, v),
  removeItem: (k: string) => void localStorageStore.delete(k),
  clear: () => void localStorageStore.clear(),
})

function node(name: string, path: string, extra: Partial<FileNode> = {}): FileNode {
  return { name, path, isDirectory: false, size: 0, ...extra }
}

function toEntry(n: FileNode) {
  return {
    name: n.name, path: n.path, isDirectory: n.isDirectory,
    size: n.size ?? 0, isSymlink: n.isSymlink ?? false,
    ...(n.mtime != null ? { mtime: n.mtime } : {}),
  }
}

beforeEach(() => localStorageStore.clear())
afterEach(() => vi.useRealTimers())

/** 复现 BUG-2：查询进行中清空搜索词 / 导航，迟到的搜索响应会把结果面板重新点亮 */
describe('BUG-2 搜索竞态：迟到响应复活搜索结果', () => {
  it('Escape 清空后，在飞请求返回仍写回 searchResults', async () => {
    vi.useFakeTimers()
    let resolveSearch: (v: { entries: FileNode[] }) => void = () => {}
    const provider = ref({
      async listDirectory(): Promise<DirectoryResult> {
        return { entries: [toEntry(node('src', 'src', { isDirectory: true }))] }
      },
      searchFiles: () => new Promise((resolve) => { resolveSearch = resolve }),
    } as unknown as WorkspaceFileProvider)
    const fm = useFileManager(provider, ref('42'))
    await vi.advanceTimersByTimeAsync(0)

    fm.searchQuery.value = 'read'
    await vi.advanceTimersByTimeAsync(300) // 防抖结束，searchFiles 已发出、尚未返回

    // 用户按 Escape（或点清空键）取消搜索
    fm.searchQuery.value = ''
    await vi.advanceTimersByTimeAsync(0)
    expect(fm.searchResults.value).toBeNull()

    // 迟到响应到达：searchSeq 未被 navigateTo/清空逻辑递增，seq === searchSeq 仍然成立
    resolveSearch({ entries: [node('README.md', 'README.md')] })
    await vi.advanceTimersByTimeAsync(0)

    // 期望：保持 null（结果已取消）；实际：被迟到响应重新写回，模板 v-if="searchResults"
    // 会重新渲染搜索结果面板，盖住目录列表
    expect(fm.searchResults.value).toBeNull()
  })

  it('搜索在飞时跳转目录，迟到响应同样盖住新目录列表', async () => {
    vi.useFakeTimers()
    let resolveSearch: (v: { entries: FileNode[] }) => void = () => {}
    const files: Record<string, FileNode[]> = {
      '': [node('src', 'src', { isDirectory: true }), node('docs', 'docs', { isDirectory: true })],
      src: [node('a.ts', 'src/a.ts')],
    }
    const provider = ref({
      async listDirectory(dir: string): Promise<DirectoryResult> {
        return { entries: (files[dir] ?? []).map(toEntry) }
      },
      searchFiles: () => new Promise((resolve) => { resolveSearch = resolve }),
    } as unknown as WorkspaceFileProvider)
    const fm = useFileManager(provider, ref('42'))
    await vi.advanceTimersByTimeAsync(0)

    fm.searchQuery.value = 'a'
    await vi.advanceTimersByTimeAsync(300)
    // 用户点击面包屑/文件夹导航到 src
    fm.navigateTo('src')
    await vi.advanceTimersByTimeAsync(0)
    expect(fm.currentDir.value).toBe('src')
    expect(fm.entries.value.map((e) => e.name)).toEqual(['a.ts'])

    resolveSearch({ entries: [node('README.md', 'README.md')] })
    await vi.advanceTimersByTimeAsync(0)

    // 期望：searchResults 仍为 null，界面显示 src 目录；实际：陈旧搜索结果重新出现
    expect(fm.searchResults.value).toBeNull()
    await nextTick()
  })
})
```

实测输出（`npx vitest run src/composables/zz-verify-bug2-search-race.test.ts`）：

```
 FAIL ... Escape 清空后，在飞请求返回仍写回 searchResults
AssertionError: expected [ { name: 'README.md', …(3) } ] to be null
 FAIL ... 搜索在飞时跳转目录，迟到响应同样盖住新目录列表
AssertionError: expected [ { name: 'README.md', …(3) } ] to be null
```

---

## BUG-3【高】右键菜单不校正选区：操作作用于陈旧选区，可删错文件 / 静默无响应

### 位置

- `desktop/src/components/file-browser/FileManagerPanel.vue:264-266`（`selectedEntries()` 只认选区）
- `desktop/src/components/file-browser/FileManagerPanel.vue:555-560`（`openContextMenu` 只记录 `ctxMenu.entry`，**不动选区**）
- 受影响处理器：`handleDelete`（L338-340）、`handleClipboard`（L373-377）、`handleDownload`（L503-505）、`handleCopyPath`（L532-536）、`handleAddToChat`（L539-544）——全部读 `selectedList` / `selectedEntries()`
- 对照实现：侧边栏 `FileTree.vue:306-311` 的 `actionPaths()` 就是「右键项优先，多选时带整个选集」的正确范式，管理器没有复用

### 代码事实

网格/列表的右键只 `emit('contextmenu', { entry, x, y })`，不改变 `selectedPaths`；而菜单里除「打开 / 重命名 / 定位 / 目录 zip」外的写操作全部走选区。`FileManagerContextMenu.vue:86` 的 `isMulti = selectedCount > 1` 还让菜单形态跟随选区而非右键项。两类错位：

1. **已选中 A，右键未选中的 B**：菜单按 B 展示（如「重命名」针对 B），但「删除 / 剪切 / 复制 / 下载 / 复制绝对路径 / 添加到聊天」作用于 A。删除有强确认框能看见路径不对，其余操作无声无息作用在错误文件上。
2. **未选中任何条目，右键 B**：`selectedEntries()` 为 `[]`，`handleDelete` 在 L339-340 直接 `return`——右键「删除 / 剪切 / 复制 / 下载 / 复制路径 / 添加到聊天」全部静默无响应（连提示都没有）。这是文件管理器最常规的操作路径。

### 期望 vs 实际

- 期望：右键未选中条目时先把选区校正为 `[该条目]`（或在各处理器里回退到 `ctxMenu.entry`），与侧边栏 `actionPaths()` 一致。
- 实际：操作作用于陈旧选区；选区为空时静默跳过。

### 验证测试（实测失败）

`desktop/src/composables/zz-verify-bug5-ctx-selection.test.ts`（用真实 `useFileManager` 驱动，逐字复刻面板 L264-266 的 `selectedEntries()` 表达式）：

```ts
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryResult, WorkspaceFileProvider } from './workspace-file-provider'
import type { FileNode } from '../types/file-browser'
import { useFileManager } from './useFileManager'

const localStorageStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStorageStore.set(k, v),
  removeItem: (k: string) => void localStorageStore.delete(k),
  clear: () => void localStorageStore.clear(),
})

function node(name: string, path: string, extra: Partial<FileNode> = {}): FileNode {
  return { name, path, isDirectory: false, size: 0, ...extra }
}

function toEntry(n: FileNode) {
  return {
    name: n.name, path: n.path, isDirectory: n.isDirectory,
    size: n.size ?? 0, isSymlink: n.isSymlink ?? false,
    ...(n.mtime != null ? { mtime: n.mtime } : {}),
  }
}

function makeProvider(files: Record<string, FileNode[]>): WorkspaceFileProvider {
  return {
    async listDirectory(dir: string): Promise<DirectoryResult> {
      return { entries: (files[dir] ?? []).map(toEntry) }
    },
  } as unknown as WorkspaceFileProvider
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => localStorageStore.clear())
afterEach(() => vi.useRealTimers())

/**
 * 复现 BUG-3：右键菜单不校正选区。
 * FileManagerPanel.vue 的 selectedEntries() = entries.filter(e => selectedList.includes(e.path))，
 * 删除/剪切/复制/下载/复制路径/添加到聊天全部走选区（L264-266 / L339 / L373-377 / L503-545），
 * 而 openContextMenu（L555-560）只记录 ctxMenu.entry、不动选区——右键未选中的条目时，
 * 这些操作作用于陈旧选区（或对整个选区空转）。
 */
describe('BUG-3 右键菜单作用于陈旧选区', () => {
  it('右键未选中条目时，删除/复制拿到的是旧选区而不是右键项', async () => {
    const provider = ref(makeProvider({
      '': [node('a.txt', 'a.txt'), node('b.txt', 'b.txt')],
    }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    // 左击选中 a.txt，然后右键 b.txt（右键不改变选区，见 FileManagerGrid/List 的 contextmenu 处理）
    fm.toggleSelect('a.txt', { meta: false, shift: false })
    const rightClicked: FileNode = node('b.txt', 'b.txt')
    expect(fm.selectedList.value).toEqual(['a.txt'])

    // 面板 selectedEntries() 的原样表达式
    const selectedEntries = () => fm.entries.value.filter((e) => fm.selectedList.value.includes(e.path))
    // 期望：删除/复制的目标是右键项 b.txt；实际：仍是 a.txt
    expect(selectedEntries().map((e) => e.path)).toEqual(['b.txt'])
    expect(fm.selectedList.value).toEqual(['b.txt'])
    // rightClicked 仅用于验证「用户意图」
    expect(rightClicked.path).toBe('b.txt')
  })

  it('未选中任何条目时右键删除，选区为空 → 操作静默跳过', async () => {
    const provider = ref(makeProvider({
      '': [node('a.txt', 'a.txt')],
    }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    const selectedEntries = () => fm.entries.value.filter((e) => fm.selectedList.value.includes(e.path))
    // 右键 a.txt → 菜单显示「删除」；期望 targets = [a.txt]；
    // 实际 selectedEntries() 为 []，handleDelete 在 L339-340 静默 return（无对话框、无提示）
    expect(selectedEntries().map((e) => e.path)).toEqual(['a.txt'])
    expect(fm.selectedCount.value).toBe(0)
  })
})
```

实测输出（`npx vitest run src/composables/zz-verify-bug5-ctx-selection.test.ts`）：

```
 FAIL ... 右键未选中条目时，删除/复制拿到的是旧选区而不是右键项
AssertionError: expected [ 'a.txt' ] to deeply equal [ 'b.txt' ]
 FAIL ... 未选中任何条目时右键删除，选区为空 → 操作静默跳过
AssertionError: expected [] to deeply equal [ 'a.txt' ]
```

---

## BUG-4【中】新建草稿不随导航取消：文件建到旧目录，当前目录看不到

### 位置

- `desktop/src/composables/useFileManager.ts:186-189`（`beginCreate` 把 `currentDir` 快照进 `creating.dir`）
- `desktop/src/composables/useFileManager.ts:114-144`（`navigateTo` / `goBack` / `goForward` 都不 `cancelDraft()`；只有会话/ provider 变化的 watch（L269-286）会重置）
- `desktop/src/components/file-browser/FileManagerPanel.vue:294-316`（`commitCreate` 用 `draft.dir` 拼路径，L302 `joinRel(draft.dir, name)`）
- `desktop/src/components/file-browser/FileManagerGrid.vue:42-58` / `FileManagerList.vue:57-76`（新建输入行只认 `creating` 非空，与所在目录无关，永远渲染）

### 代码事实

`beginCreate('file')` 后 `creating = { dir: '', kind: 'file' }`。此时用户点面包屑 / 双击文件夹 / 后退前进切到 `src`：草稿不取消，输入框仍挂在 `src` 的列表底部，用户输入名称回车，`joinRel('', 'note.txt')` → 文件建在工作区根，而面板 `refresh()` 重载的是 `src`——新文件在当前目录看不见，用户会反复新建。`jumpToSearchResult`（L262-267）内部也走 `navigateTo`，同样触发。

### 期望 vs 实际

- 期望：导航（含前进/后退/搜索跳转）时取消新建草稿，或 `creating.dir` 跟随新目录。
- 实际：草稿残留且 `dir` 陈旧，落点与用户所见目录不一致。

### 验证测试（实测失败）

`desktop/src/composables/zz-verify-bug3-create-draft.test.ts`：

```ts
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryResult, WorkspaceFileProvider } from './workspace-file-provider'
import type { FileNode } from '../types/file-browser'
import { useFileManager } from './useFileManager'
import { joinRel } from '../utils/file-manager'

const localStorageStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStorageStore.set(k, v),
  removeItem: (k: string) => void localStorageStore.delete(k),
  clear: () => void localStorageStore.clear(),
})

function node(name: string, path: string, extra: Partial<FileNode> = {}): FileNode {
  return { name, path, isDirectory: false, size: 0, ...extra }
}

function toEntry(n: FileNode) {
  return {
    name: n.name, path: n.path, isDirectory: n.isDirectory,
    size: n.size ?? 0, isSymlink: n.isSymlink ?? false,
    ...(n.mtime != null ? { mtime: n.mtime } : {}),
  }
}

function makeProvider(files: Record<string, FileNode[]>): WorkspaceFileProvider {
  return {
    async listDirectory(dir: string): Promise<DirectoryResult> {
      return { entries: (files[dir] ?? []).map(toEntry) }
    },
  } as unknown as WorkspaceFileProvider
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => localStorageStore.clear())
afterEach(() => vi.useRealTimers())

/** 复现 BUG-4：新建草稿不随导航取消，commitCreate 仍写到旧目录 */
describe('BUG-4 新建草稿跨目录导航后落点陈旧', () => {
  it('navigateTo 后 creating.dir 仍是旧目录', async () => {
    const files: Record<string, FileNode[]> = {
      '': [node('src', 'src', { isDirectory: true })],
      src: [],
    }
    const provider = ref(makeProvider(files))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    // 在工作区根目录开始「新建文件」，用户还没输名字
    fm.beginCreate('file')
    expect(fm.creating.value).toEqual({ dir: '', kind: 'file' })

    // 用户切到 src（点面包屑 / 双击文件夹 / 后退前进）
    fm.navigateTo('src')
    await flush()
    expect(fm.currentDir.value).toBe('src')

    // 期望：草稿随导航取消（creating === null）或 dir 跟随为 'src'；
    // 实际：残留 { dir: '' }，输入框还挂在 src 的列表里
    expect(fm.creating.value).toBeNull()

    // 面板 commitCreate 用 draft.dir 拼路径（FileManagerPanel.vue L302）
    const draft = fm.creating.value
    expect(joinRel(draft?.dir ?? '', 'note.txt')).toBe('src/note.txt')
  })

  it('goBack 后草稿同样残留', async () => {
    const files: Record<string, FileNode[]> = {
      '': [node('src', 'src', { isDirectory: true })],
      src: [],
    }
    const provider = ref(makeProvider(files))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    fm.navigateTo('src')
    await flush()
    fm.beginCreate('dir')
    fm.goBack()
    await flush()
    expect(fm.currentDir.value).toBe('')
    expect(fm.creating.value).toBeNull()
  })
})
```

实测输出（`npx vitest run src/composables/zz-verify-bug3-create-draft.test.ts`）：

```
 FAIL ... navigateTo 后 creating.dir 仍是旧目录
AssertionError: expected { dir: '', kind: 'file' } to be null
 FAIL ... goBack 后草稿同样残留
AssertionError: expected { dir: 'src', kind: 'dir' } to be null
```

---

## BUG-5【中】空白处拖入内部路径被预检静默拦截，侧边栏→管理器移动失效

### 位置

- `desktop/src/components/file-browser/FileManagerPanel.vue:446-459`（`onBodyDrop` → `moveSourcesTo(paths, currentDir.value)`）
- `desktop/src/components/file-browser/FileManagerPanel.vue:410-425`（`moveSourcesTo`：`sources.filter((src) => canDropTarget([src], dir, entries.value))`）
- `desktop/src/utils/file-manager.ts:79-89`（`canDropTarget` 要求 `entries.find(e => e.path === targetPath)` 存在且是目录）
- 跨组件拖拽来源：`desktop/src/components/file-browser/FileTreeNode.vue:186`（侧边栏拖出时写 `application/x-mao-paths`，与 `DRAG_PATHS_MIME` 一致，`utils/file-manager.ts:7` 注释明示「便于互通」）

### 代码事实

`canDropTarget` 的语义是「在**包含 target 的列表**里预检」，而面板把 `currentDir` 当 target 传进去——一个目录永远不在自己的子列表里，`entries.find(...)` 返回 `undefined`，预检恒 false，`movable` 为空后静默 `return`：

```ts
// FileManagerPanel.vue:413
const movable = sources.filter((src) => canDropTarget([src], dir, entries.value))
// dir === currentDir 时：entries 是 currentDir 的子项，find(e => e.path === currentDir) 恒为 undefined
if (movable.length === 0) return   // 静默 no-op：无提示、无移动
```

受影响场景：从侧边栏文件树拖文件/文件夹到管理器内容区空白处（期望移入 `currentDir`）——完全无反应。拖到文件夹格（`onFolderDrop` → `moveSourcesTo(paths, entry.path)`，target 在 `entries` 里）不受影响，因此容易被漏测。

### 期望 vs 实际

- 期望：空白处放置内部路径时移入 `currentDir`（侧边栏的对应实现 `FileTree.vue:547-563` 就是移到 `.`，无此预检问题）。
- 实际：预检恒 false，静默无操作。

### 验证测试（实测失败）

`desktop/src/utils/zz-verify-bug4-blank-drop.test.ts`（用真实 `canDropTarget` / `parseDragPaths` 复刻面板 L413 的过滤表达式）：

```ts
import { describe, expect, it } from 'vitest'
import type { FileNode } from '../types/file-browser'
import { canDropTarget, parseDragPaths } from '../utils/file-manager'

function node(name: string, path: string, extra: Partial<FileNode> = {}): FileNode {
  return { name, path, isDirectory: false, size: 0, ...extra }
}

/**
 * 复现 BUG-5：把内部路径拖到内容区空白处时，面板走
 * onBodyDrop → moveSourcesTo(paths, currentDir)（FileManagerPanel.vue L446-459 / L410-425），
 * 预检 canDropTarget([src], currentDir, entries) 要求 target 出现在 entries 里，
 * 而 currentDir 是自己的子列表，永远查不到 → movable 为空 → 静默 no-op。
 */
describe('BUG-5 空白处拖入内部路径被预检静默拦截', () => {
  const srcEntries: FileNode[] = [
    node('a.ts', 'src/a.ts'),
    node('sub', 'src/sub', { isDirectory: true }),
  ]

  it('target 为 currentDir 时永远过不了预检（空白处移动是死路径）', () => {
    // 从侧边栏文件树拖 src/a.ts 到管理器 src 目录的空白处
    const paths = parseDragPaths(JSON.stringify(['src/a.ts']))
    expect(paths).toEqual(['src/a.ts'])
    // 面板 L413：sources.filter((src) => canDropTarget([src], dir, entries.value))
    const movable = paths.filter((src) => canDropTarget([src], 'src', srcEntries))
    // 期望：允许移入 src（源在 src 外时）；实际：恒为 []
    expect(movable).toEqual(['src/a.ts'])
  })

  it('对照组：拖到文件夹格上预检可以通过', () => {
    const movable = ['src/a.ts'].filter((src) => canDropTarget([src], 'src/sub', srcEntries))
    expect(movable).toEqual(['src/a.ts'])
  })
})
```

实测输出（`npx vitest run src/utils/zz-verify-bug4-blank-drop.test.ts`）：

```
 FAIL ... target 为 currentDir 时永远过不了预检（空白处移动是死路径）
AssertionError: expected [] to deeply equal [ 'src/a.ts' ]
 ✓ 对照组：拖到文件夹格上预检可以通过   ← 对照组通过，证明纯函数本身无误，问题在面板调用方
```

---

## BUG-6【低】剪切粘贴中途失败仍清空剪贴板，剩余路径丢失

### 位置

- `desktop/src/components/file-browser/FileManagerPanel.vue:379-402`（`handlePaste`：循环内 `catch { break }`，循环后 `if (clip.op === 'cut') clipboard.clear()` 无条件执行）

### 代码事实

剪切 3 项后粘贴，若第 2 项目标已存在、用户在 3045 覆盖询问里点「取消」（或任何失败），循环 `break`，但剪贴板仍被清空——第 2、3 项并未移动，却从剪贴板消失，用户想重试只能重新剪切。与本次需求自查项「写操作失败或被用户取消后的状态校正、事件发射与已成功部分的账实一致」相悖。已成功部分的 `paths-changed` 发射是准确的，问题仅在剪贴板账实。

### 期望 vs 实际

- 期望：仅把已成功移动的路径从剪贴板移除，剩余路径保留可重试（或全部保留）。
- 实际：无论成败一律清空。

### 验证测试（实测失败）

`desktop/src/composables/zz-verify-bug6-paste-clipboard.test.ts`（用真实 `useFileClipboard` / `dedupeMoveSources`，复刻面板 L386-399 的循环与清空逻辑）：

```ts
import { describe, expect, it } from 'vitest'
import { useFileClipboard } from './useFileClipboard'
import { dedupeMoveSources } from '../utils/file-manager'

/**
 * 复现 BUG-6：剪切后粘贴中途失败，剪贴板仍被无条件清空，
 * 未处理的剩余路径丢失（FileManagerPanel.vue L379-402 handlePaste）。
 * 与需求「失败或被用户取消后的状态校正、事件发射与已成功部分的账实一致」相悖。
 */
describe('BUG-6 剪切粘贴部分失败后剪贴板被清空', () => {
  it('第 2 项失败即 break，但 cut 剪贴板仍被 clear，剩余项无法再粘贴', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['a.txt', 'b.txt', 'c.txt'])

    // 复刻面板 handlePaste 的循环（b.txt 目标已存在，用户在覆盖询问里点了取消）
    const moved: string[] = []
    const moveWorkspacePath = async (from: string) => {
      if (from === 'b.txt') throw new Error('目标已存在')
      moved.push(from)
    }
    const clip = clipboard.current!
    const sources = dedupeMoveSources(clip.paths)
    for (const src of sources) {
      try {
        await moveWorkspacePath(src)
      } catch {
        break
      }
    }
    if (clip.op === 'cut') clipboard.clear()

    expect(moved).toEqual(['a.txt'])
    // 期望：仅清理已成功移动的路径，b.txt/c.txt 保留在剪贴板可重试；
    // 实际：clipboard.current === null，b.txt/c.txt 从剪贴板丢失
    expect(clipboard.current?.paths).toEqual(['b.txt', 'c.txt'])
  })
})
```

实测输出（`npx vitest run src/composables/zz-verify-bug6-paste-clipboard.test.ts`）：

```
 FAIL ... 第 2 项失败即 break，但 cut 剪贴板仍被 clear，剩余项无法再粘贴
AssertionError: expected undefined to deeply equal [ 'b.txt', 'c.txt' ]
```

---

## 附录 A：排查后确认不构成 BUG 的候选

| 候选 | 结论 |
| --- | --- |
| `loadDir` 目录列表竞态（`listSeq`） | 正确：`++listSeq` 在 await 前，迟到响应被丢弃；既有测试 `discardsStaleListResponses` 覆盖 |
| 两次搜索之间的竞态（`searchSeq`） | 正确：后发请求同样递增 `searchSeq`；缺口仅在「清空/导航不递增」，即 BUG-2 |
| `watch([provider, sessionId])` 重置 + KeepAlive key | 完备：`CenterTabContainer.vue:37-38` 的 key 已含 sessionId，双保险；即使同实例复用，provider/sessionId 变化也整体重置（既有测试 `resetsStateWhenSessionChanges` 覆盖）。注：`useFileManager.ts:31-32` 注释称 key 恒为 `'file-manager'`，与实际（含 sessionId）不符，仅注释陈旧，行为安全 |
| Shift 范围选择在排序变化/目录切换/搜索跳转后的正确性 | 正确：`toggleSelect` 基于 `sortedEntries` 计算范围；导航/会话切换均 `clearSelection()` 重置 `lastClicked`；`jumpToSearchResult` 显式重设选区 |
| `effectiveDragSources` / `dedupeMoveSources` 语义 | 正确：拖已选项带整个选集并剔除子孙；未选中则只带自己；有既有测试 |
| `canDropTarget` 纯函数本身（自身/子孙/祖先/文件/符号链接） | 正确：有既有测试；问题在面板把 `currentDir` 当 target 传入（BUG-5） |
| `handleDelete` 部分失败 | 账实一致：逐条删除、失败即止，`paths-changed` 只含已删路径，`refresh()` 顺带清空选区 |
| 事件契约（子组件 emits ↔ 面板监听 ↔ TaskView 监听） | 一致：`open-file`/`add-file-to-chat`/`paths-changed`(WorkspacePathChange)/`tree-refresh`/`locate-in-tree` 五事件形状两端匹配；`WorkspacePathChange` 与 `applyWorkspacePathChange`/`retargetTabPath` 兼容 |
| `openFileManagerTab` 单例与激活态恢复 | 正确：与 file/diff/trace 同构；刷新后 Tab 不重建，`restoreActiveTab` 匹配不到回落 chat，符合设计 |
| 「在文件树中显示」链路（面板 → TaskView → TaskInspector → FileTree.reveal） | 可达：CLOUD 下 `showFileTreeTab` 恒真；`reveal` 会按需先 refresh 再逐级展开 |
| 快捷键与输入框焦点 | Ctrl/Cmd+A/C/X/V 在 INPUT/TEXTAREA 聚焦时正确让位；重命名/新建输入框 Enter/Esc `stop` 防止面板劫持。仅 Esc 清空搜索在搜索框聚焦时失效，见附录 B-O1 |
| 上传进度与失败处理 | 一致：`finally` 复位进度条，仅成功才 `refresh()` + `tree-refresh`；3044/3045 询问由 `withPrompts` 既有处理 |
| 后端 `mtimeMs` 边界（符号链接/目录/lstat 失败/搜索不返回） | 自洽：符号链接 `isDirectory=false` 但仍带 `mtimeMs`；lstat 失败保持 0，前端 `formatTime(0)` 显示 "—"；搜索接口不返回该字段，前端搜索行不显示时间 |
| 后端新 spec 两个用例 | 均通过（`npx vitest run src/file/workspace-browse.service.spec.ts` → 7 passed）；但第二个用例名不副实，见附录 B-O6 |

## 附录 B：观察项（未经测试验证，不计入 BUG）

- **O1**：`FileManagerPanel.vue:580-581` 的 INPUT/TEXTAREA 守卫位于 Escape 分支之前，搜索框聚焦时按 Esc 无法清空搜索（设计 §5.9 要求 Esc 清空搜索），只能点清除按钮。
- **O2**：右键文件夹的「新建文件 / 新建文件夹 / 上传到此处」落点是 `currentDir` 而非该文件夹（`beginCreate`/`pickUpload` 不读 `ctxMenu.entry`；侧边栏用右键节点目录，菜单文案「此处」也与行为不符）。
- **O3**：`handleDelete` 的 Git 提示只匹配顶层 `.git`（`FileManagerPanel.vue:343`），漏 `sub/.git` 等嵌套；侧边栏 `touchesGit`（`FileTree.vue:344-346`）覆盖更全。
- **O4**：`searchTruncated` 用 `entries.length >= 100` 推断（`useFileManager.ts:250`），未使用后端已返回、provider 已映射的 `truncated` 标志。
- **O5**：`onBodyDragOver` 对操作系统文件拖拽也设 `dropEffect='move'`（`FileManagerPanel.vue:443`），语义上应为 `copy`，仅观感问题。
- **O6**：后端 spec 用例 `keepsSymlinkFlagAndSortsDirectoriesFirst` 名不副实——用例体并未创建符号链接，只验证了目录优先排序。

## 附录 C：验证测试运行方式

```bash
cd /Users/yangjiayi/AiProjects/mao/.worktrees/file-manager-tab/desktop
npx vitest run src/composables/zz-verify-bug1-mtime.test.ts        # BUG-1（2 失败）
npx vitest run src/composables/zz-verify-bug2-search-race.test.ts  # BUG-2（2 失败）
npx vitest run src/composables/zz-verify-bug3-create-draft.test.ts # BUG-4（2 失败）
npx vitest run src/composables/zz-verify-bug5-ctx-selection.test.ts# BUG-3（2 失败）
npx vitest run src/composables/zz-verify-bug6-paste-clipboard.test.ts # BUG-6（1 失败）
npx vitest run src/utils/zz-verify-bug4-blank-drop.test.ts         # BUG-5（1 失败 + 1 对照通过）
```

全部 11 条断言（除 1 条对照组）对当前代码实测失败，即 BUG 真实存在；测试源码已全文粘贴在上述各小节，验证后未留在仓库中。
