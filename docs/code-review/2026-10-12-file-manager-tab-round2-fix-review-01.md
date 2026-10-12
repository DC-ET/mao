# 「文件管理」页签修复轮代码审查（2026-10-12 · 第二轮）

- **日期**：2026-10-12
- **基线**：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/file-manager-tab`（分支 `feature/file-manager-tab`，HEAD `42429edf`），第一轮报告 `2026-10-12-file-manager-tab-review-01.md` 之后的修复版未提交代码。行号以本轮审查时源码实测核对。
- **范围**：本轮发生改动的 4 个文件——`desktop/src/composables/workspace-file-provider.ts`、`desktop/src/composables/useFileManager.ts`、`desktop/src/utils/file-manager.ts`、`desktop/src/components/file-browser/FileManagerPanel.vue`，以及它们的新增回归测试（`workspace-file-provider.mtime.test.ts`、`useFileManager.test.ts` +4 例、`file-manager.test.ts` +3 例）。`FileManagerGrid/List/ContextMenu.vue` 本轮未改动（mtime 12:31–12:43，早于修复提交 12:59–13:04），不在审查范围。
- **方法**：修复验证探针一律断言「修复后的正确行为」（通过即修复生效）；新问题探针断言「期望行为」（失败即 bug 存在）。全部探针在 worktree 内 `npx vitest run` 实测，验证后已从仓库移除，全文粘贴于本文。
- **基线健康度**：移除探针后 desktop `npx vitest run` → 58 文件 / 521 用例通过（与修复方自报一致）；`backend-ts npx vitest run src/file` → 7 文件 / 70 用例通过（含本文探针）；后端全量 `npm test` 结果见附录 C。
- **结论**：**6 项修复全部正确**（含 3 项附录 B 成立项），未发现修复引入的逻辑回归；但审查中发现 **2 个新 BUG**（1 高 / 1 中），同一根因：**根目录（`currentDir === ''`）的写操作落点传空串，后端 move/copy 端点拒收**。其中 BUG-7 是第一轮漏检的既存问题（根目录粘贴完全不可用），BUG-8 是 BUG-5 的修复未覆盖根目录（空白处拖放到根目录 100% 失败，且由「静默无操作」变为「报错 toast」）。

---

## 一、修复验证结论表

| 项 | 对应 | 结论 | 验证探针（实测） |
| --- | --- | --- | --- |
| FIX-1 | BUG-1 | ✅ 正确。`mtimeMs → mtime` 显式映射，缺省不臆造；用户可见的时间列与按时间排序恢复 | `zz2-fix1-mtime` 1 通过 |
| FIX-2 | BUG-2 | ✅ 正确。清空分支 `searchSeq++` 作废在途响应；**导航路径同样被作废**（经 `searchQuery=''` 触发 watcher，第一轮只怀疑清空一条，实测导航也覆盖） | `zz2-fix2-search` 2 通过 |
| FIX-3 | BUG-3 | ✅ 正确。右键未选中条目收敛选区、右键已选中条目保留多选、空选区右键不再静默跳过，三种场景均符合侧边栏 `actionPaths` 范式 | `zz2-fix3-ctxmenu` 3 通过 |
| FIX-4 | BUG-4 | ✅ 正确。`navigateTo/goBack/goForward` 均 `cancelDraft()`；`beginCreate(kind, dir)` 支持指定落点 | `zz2-fix4-draft` 3 通过 |
| FIX-5 | BUG-5 | ⚠️ 子目录正确，**根目录不完整**（见 BUG-8）。`canDropTargetDir` 自身/子孙/父子校验语义正确，`canDropTarget` 重构无行为变化 | `zz2-fix5-drop` 4 通过 |
| FIX-6 | BUG-6 | ✅ 正确。整批 try 全部成功才 `clear()`；中途失败保留；copy 不清空 | `zz2-fix6-paste` 3 通过 |
| 附录B-1 | 右键新建/上传落点 | ✅ 正确。`ctxTargetDir()` = 目录取自身、文件取父目录、空白取 currentDir，与侧边栏 `beginCreate`/`beginUpload` 同口径；`pickUpload(dir)` + `uploadDir` 记住落点 | 现有回归 `beginCreateUsesGivenDir` 通过 + 代码走查 |
| 附录B-2 | `.git` 删除提示 | ✅ 正确。四分支与侧边栏 `touchesGit`（`FileTree.vue:344-346`）逐条一致，覆盖任意层级 | 代码走查（表达式等价） |
| 附录B-3 | 搜索框 Esc 清空 | ✅ 有效。el-input `inheritAttrs:false` 但内部把原生 keydown 重新 `emit('keydown')`（`input.vue_..._lang.mjs` 的 `handleKeydown`），`@keydown.esc` 作为组件事件监听 + Vue `withKeys` 的 `esc→Escape` 映射可正常触发 | 依赖源码走查（组件库行为，无 DOM 测试环境） |

## 二、新发现问题表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-7 | 高 | desktop/FileManagerPanel | 根目录（`currentDir===''`）里剪切/复制粘贴把空串当落点传给 `workspace-move/copy`，后端 `path-sandbox` 拒收（`Path cannot be empty`）弹错误 toast——**根目录粘贴完全不可用**（第一轮漏检的既存问题） |
| BUG-8 | 中 | desktop/FileManagerPanel | BUG-5 的修复未覆盖根目录：空白处拖放移动在根目录同样传空串，100% 失败并弹错误 toast；修复前是静默 no-op，行为变差 |

---

## 三、修复验证详情

### FIX-1（BUG-1）：CLOUD `mtimeMs → mtime` 映射 ✅

改动（`workspace-file-provider.ts:196-212`）：新增 `CloudDirectoryEntry` 原始类型，`listDirectory` 显式映射，`typeof mtimeMs === 'number'` 守卫避免臆造。映射逻辑、缺省分支、请求参数均被新回归测试覆盖（质量合格：mock 形状与响应拦截器行为一致）。

探针（用户可见结果层）：`desktop/src/composables/zz2-fix1-mtime.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'

/** 复现/验证 FIX-1（BUG-1 修复）：CLOUD listDirectory 把 mtimeMs 映射为 mtime，且用户可见结果正确 */
vi.mock('../api', () => ({
  api: {
    get: vi.fn(async () => ({
      code: 0,
      data: {
        entries: [
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

describe('FIX-1 CLOUD mtime 贯通', () => {
  it('mtimeMs 映射为 mtime，时间列与按时间排序恢复', async () => {
    const provider = createCloudProvider('42')
    const result = await provider.listDirectory('')
    const nodes = result.entries as FileNode[]
    expect(nodes.map((e) => e.mtime)).toEqual([100, 200])
    // 用户可见：按修改时间升序 = b.txt(100) → a.txt(200)
    expect(sortEntries(nodes, 'mtime', 'asc').map((e) => e.name)).toEqual(['b.txt', 'a.txt'])
    // 用户可见：修改时间列渲染出日期而不是占位符
    expect(formatTime(nodes[0].mtime)).toMatch(/^\d{4}-/)
  })
})
```

实测：1 passed。第一轮的失败断言（`mtime` undefined、排序退化）现已通过。

### FIX-2（BUG-2）：在途搜索作废 ✅

改动（`useFileManager.ts:230-237`）：清空分支先 `searchSeq++` 再重置状态。除修复方覆盖的「清空」场景外，本轮补验了第一轮报告的第二个场景「搜索在飞时导航」——导航经 `searchQuery=''` 触发同一 watcher，同样作废（watcher 在真实应用中早于网络响应执行，无窗口期）。

探针：`desktop/src/composables/zz2-fix2-search.test.ts`

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

/** 验证 FIX-2（BUG-2 修复）：清空 / 导航都作废在途搜索，迟到响应不再点亮结果面板 */
describe('FIX-2 搜索在途响应的作废', () => {
  it('清空搜索词后迟到响应被丢弃', async () => {
    vi.useFakeTimers()
    let release: (v: { entries: FileNode[] }) => void = () => {}
    const provider = ref({
      async listDirectory(): Promise<DirectoryResult> { return { entries: [] } },
      searchFiles: () => new Promise((resolve) => { release = resolve }),
    } as unknown as WorkspaceFileProvider)
    const fm = useFileManager(provider, ref('42'))
    await vi.advanceTimersByTimeAsync(0)

    fm.searchQuery.value = 'a'
    await vi.advanceTimersByTimeAsync(300)
    fm.searchQuery.value = ''
    await vi.advanceTimersByTimeAsync(0)
    release({ entries: [node('a.ts', 'src/a.ts')] })
    await vi.advanceTimersByTimeAsync(0)

    expect(fm.searchResults.value).toBeNull()
    expect(fm.searching.value).toBe(false)
  })

  it('搜索在飞时导航到别的目录，迟到响应也被丢弃', async () => {
    vi.useFakeTimers()
    let release: (v: { entries: FileNode[] }) => void = () => {}
    const files: Record<string, FileNode[]> = {
      '': [node('src', 'src', { isDirectory: true })],
      src: [node('a.ts', 'src/a.ts')],
    }
    const provider = ref({
      async listDirectory(dir: string): Promise<DirectoryResult> {
        return { entries: (files[dir] ?? []).map(toEntry) }
      },
      searchFiles: () => new Promise((resolve) => { release = resolve }),
    } as unknown as WorkspaceFileProvider)
    const fm = useFileManager(provider, ref('42'))
    await vi.advanceTimersByTimeAsync(0)

    fm.searchQuery.value = 'a'
    await vi.advanceTimersByTimeAsync(300) // 搜索已发出、尚未返回
    fm.navigateTo('src')
    await vi.advanceTimersByTimeAsync(0) // 等 searchQuery watcher 跑完（真实应用里早于网络响应）
    await nextTick()
    release({ entries: [node('README.md', 'README.md')] })
    await vi.advanceTimersByTimeAsync(0)

    expect(fm.searchResults.value).toBeNull()
    expect(fm.currentDir.value).toBe('src')
    expect(fm.entries.value.map((e) => e.name)).toEqual(['a.ts'])
  })
})
```

实测：2 passed。

### FIX-3（BUG-3）：右键菜单选区校正 ✅

改动（`FileManagerPanel.vue:573-583` + `useFileManager.ts:184-188`）：右键未选中条目时 `selectOnly(entry.path)`，已选中则保留整个选区。三种场景（含第一轮「空选区右键静默跳过」）均修复。

探针：`desktop/src/composables/zz2-fix3-ctxmenu.test.ts`（复刻面板 L578 校正表达式与 L266-268 `selectedEntries()`，驱动真实 composable）

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
 * 验证 FIX-3（BUG-3 修复）：openContextMenu 在右键未选中条目时先把选区收敛为该项。
 * 复刻 FileManagerPanel.vue L573-583 的校正表达式与 L266-268 的 selectedEntries()，
 * 驱动真实 useFileManager。
 */
describe('FIX-3 右键菜单选区校正', () => {
  it('右键未选中条目：选区收敛为该条目，删除/复制打到正确目标', async () => {
    const provider = ref(makeProvider({ '': [node('a.txt', 'a.txt'), node('b.txt', 'b.txt')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    fm.toggleSelect('a.txt', { meta: false, shift: false }) // 左击选中 a.txt
    // 复刻 openContextMenu 的校正：右键未选中的 b.txt
    const rightClicked = node('b.txt', 'b.txt')
    if (rightClicked && !fm.selectedList.value.includes(rightClicked.path)) fm.selectOnly(rightClicked.path)

    // 面板 selectedEntries() 原样表达式
    const targets = fm.entries.value.filter((e) => fm.selectedList.value.includes(e.path))
    expect(targets.map((e) => e.path)).toEqual(['b.txt'])
  })

  it('右键已选中条目：保留整个多选，批量语义不变', async () => {
    const provider = ref(makeProvider({ '': [node('a.txt', 'a.txt'), node('b.txt', 'b.txt'), node('c.txt', 'c.txt')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    fm.toggleSelect('a.txt', { meta: true, shift: false })
    fm.toggleSelect('b.txt', { meta: true, shift: false })
    // 右键已选中的 a.txt：不收敛
    const rightClicked = node('a.txt', 'a.txt')
    if (rightClicked && !fm.selectedList.value.includes(rightClicked.path)) fm.selectOnly(rightClicked.path)

    const targets = fm.entries.value.filter((e) => fm.selectedList.value.includes(e.path))
    expect(targets.map((e) => e.path).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('未选中任何条目时右键：收敛为该条目，删除不再静默跳过', async () => {
    const provider = ref(makeProvider({ '': [node('a.txt', 'a.txt')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    const rightClicked = node('a.txt', 'a.txt')
    if (rightClicked && !fm.selectedList.value.includes(rightClicked.path)) fm.selectOnly(rightClicked.path)

    const targets = fm.entries.value.filter((e) => fm.selectedList.value.includes(e.path))
    expect(targets.map((e) => e.path)).toEqual(['a.txt'])
  })
})
```

实测：3 passed。

### FIX-4（BUG-4）：导航取消新建草稿 ✅

改动（`useFileManager.ts:116/129/141`）：三个导航函数都 `cancelDraft()`；`beginCreate(kind, dir = currentDir.value)` 支持指定落点。修复方回归覆盖 `navigateTo`，本轮补验 `goBack/goForward` 与指定 dir。

探针：`desktop/src/composables/zz2-fix4-draft.test.ts`

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

/** 验证 FIX-4（BUG-4 修复）：goBack / goForward 与 navigateTo 一样取消新建草稿 */
describe('FIX-4 导航取消新建草稿', () => {
  it('goBack 后草稿不残留', async () => {
    const files: Record<string, FileNode[]> = {
      '': [node('src', 'src', { isDirectory: true })],
      src: [node('docs', 'src/docs', { isDirectory: true })],
      'src/docs': [],
    }
    const provider = ref(makeProvider(files))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    fm.navigateTo('src')
    await flush()
    fm.navigateTo('src/docs')
    await flush()

    fm.beginCreate('file') // 在 src/docs 开始新建
    expect(fm.creating.value).toEqual({ dir: 'src/docs', kind: 'file' })
    fm.goBack()
    await flush()
    expect(fm.currentDir.value).toBe('src')
    expect(fm.creating.value).toBeNull()
  })

  it('goForward 后草稿不残留', async () => {
    const files: Record<string, FileNode[]> = {
      '': [node('src', 'src', { isDirectory: true })],
      src: [],
    }
    const provider = ref(makeProvider(files))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    fm.navigateTo('src')
    await flush()
    fm.goBack()
    await flush()

    fm.beginCreate('dir')
    expect(fm.creating.value).toEqual({ dir: '', kind: 'dir' })
    fm.goForward()
    await flush()
    expect(fm.currentDir.value).toBe('src')
    expect(fm.creating.value).toBeNull()
  })

  it('beginCreate 指定 dir 时草稿落在该目录（右键目录内新建）', async () => {
    const files: Record<string, FileNode[]> = {
      '': [node('docs', 'docs', { isDirectory: true })],
    }
    const provider = ref(makeProvider(files))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    fm.beginCreate('file', 'docs')
    expect(fm.creating.value).toEqual({ dir: 'docs', kind: 'file' })
  })
})
```

实测：3 passed。

### FIX-5（BUG-5）：空白处拖入内部路径 ✅（子目录）/ ⚠️ 根目录不完整（BUG-8）

改动（`file-manager.ts:86-98` 新增 `canDropTargetDir`，`canDropTarget` 重构复用它；`FileManagerPanel.vue:424-431` `moveSourcesTo` 增 `dirIsCurrent` 分支，`:467` `onBodyDrop` 传 `true`）。`canDropTargetDir` 的自身/子孙/父子关系校验语义正确，`canDropTarget` 重构后既有 4 条用例全过（无行为变化）。

探针：`desktop/src/utils/zz2-fix5-drop.test.ts`（复刻面板 L428-430 的预检表达式）

```ts
import { describe, expect, it } from 'vitest'
import type { FileNode } from '../types/file-browser'
import { canDropTarget, canDropTargetDir, parentDirOf } from '../utils/file-manager'

function node(name: string, path: string, extra: Partial<FileNode> = {}): FileNode {
  return { name, path, isDirectory: false, size: 0, ...extra }
}

/**
 * 验证 FIX-5（BUG-5 修复）：moveSourcesTo 的预检分支（复刻 FileManagerPanel.vue L424-431）。
 * 同时暴露修复后新开的口子：根目录空白处拖「已在根目录的条目」，
 * canDropTargetDir 放行 → 后端 place() 抛「不能移动到自身」→ 用户看到一次无谓的错误 toast
 * （修复前该路径整个是静默 no-op）。
 */
function movableOf(sources: string[], dir: string, dirIsCurrent: boolean, entries: FileNode[]): string[] {
  return sources.filter((src) =>
    dirIsCurrent ? canDropTargetDir([src], dir) : canDropTarget([src], dir, entries),
  )
}

describe('FIX-5 空白处拖入内部路径', () => {
  const srcEntries: FileNode[] = [
    node('a.ts', 'src/a.ts'),
    node('sub', 'src/sub', { isDirectory: true }),
  ]

  it('侧边栏拖外部文件到当前目录空白处：放行（BUG-5 已修复）', () => {
    expect(movableOf(['docs/a.md'], 'src', true, srcEntries)).toEqual(['docs/a.md'])
    expect(movableOf(['docs/a.md'], '', true, srcEntries)).toEqual(['docs/a.md'])
  })

  it('拖当前目录内的条目/子孙目录到空白处：仍然拒绝（同目录无操作）', () => {
    expect(movableOf(['src/a.ts'], 'src', true, srcEntries)).toEqual([])
    expect(movableOf(['src'], 'src/nested', true, srcEntries)).toEqual([])
    expect(movableOf(['src/nested'], 'src', true, srcEntries)).toEqual([])
  })

  it('拖到可见文件夹格：查表预检照旧工作', () => {
    const entries = [node('docs', 'docs', { isDirectory: true }), node('a.txt', 'a.txt')]
    expect(movableOf(['a.txt'], 'docs', false, entries)).toEqual(['a.txt'])
    expect(movableOf(['a.txt'], 'a.txt', false, entries)).toEqual([])
  })

  it('新问题：根目录空白处拖根目录自身条目，预检放行但后端会报错', () => {
    // 根目录视图下拖拽任意顶层条目（无论来自侧边栏还是管理器自身）落到空白处
    const movable = movableOf(['a.txt'], '', true, [node('a.txt', 'a.txt')])
    expect(movable).toEqual(['a.txt']) // 前端放行
    expect(parentDirOf('a.txt')).toBe('') // 而它本来就在根目录：这是同目录移动
    // 后端 place() 对 source.rel === dest.rel 抛 PARAM_INVALID「不能移动到自身」，
    // 经 api 拦截器弹错误 toast——一次无谓的报错（修复前是静默 no-op）
  })
})
```

实测：4 passed（第 4 条记录前端放行、后端拒绝的不一致）。注意第 1 条里 `movableOf(['docs/a.md'], '', true, ...)` 断言前端放行——但后端对 `to=''` 直接拒收，见 BUG-8。

### FIX-6（BUG-6）：剪切粘贴剪贴板语义 ✅

改动（`FileManagerPanel.vue:392-416`）：整批 try，全部成功才 `clear()`。三种路径（中途失败保留 / cut 全成功清空 / copy 成功不清空）均正确。

探针：`desktop/src/composables/zz2-fix6-paste.test.ts`（复刻面板控制流）

```ts
import { describe, expect, it } from 'vitest'
import { useFileClipboard } from './useFileClipboard'
import { dedupeMoveSources } from '../utils/file-manager'

/**
 * 验证 FIX-6（BUG-6 修复）：handlePaste 整批 try，全部成功才 clear；
 * 中途失败保留剪贴板。复刻 FileManagerPanel.vue L392-416 的控制流。
 */
function runPaste(
  clipboard: ReturnType<typeof useFileClipboard>,
  moveWorkspacePath: (from: string) => Promise<string>,
) {
  const clip = clipboard.current!
  const sources = dedupeMoveSources(clip.paths)
  const moved: string[] = []
  const failed = (async () => {
    try {
      for (const src of sources) {
        if (clip.op === 'cut') {
          const result = await moveWorkspacePath(src)
          moved.push(result)
        } else {
          await moveWorkspacePath(src)
        }
      }
      if (clip.op === 'cut') clipboard.clear()
    } catch {
      // 冲突面板与全局 toast 已提示
    }
  })()
  return { moved, failed }
}

describe('FIX-6 剪切粘贴的剪贴板语义', () => {
  it('中途失败：剪贴板保留剩余项（BUG-6 已修复）', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['a.txt', 'b.txt', 'c.txt'])
    const { moved, failed } = runPaste(clipboard, async (from) => {
      if (from === 'b.txt') throw new Error('目标已存在')
      return from
    })
    await failed
    expect(moved).toEqual(['a.txt'])
    expect(clipboard.current?.paths).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('全部成功：cut 剪贴板被清空（成功路径未破）', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['a.txt', 'b.txt'])
    const { failed } = runPaste(clipboard, async (from) => from)
    await failed
    expect(clipboard.current).toBeNull()
  })

  it('copy 成功：剪贴板不清空（可重复粘贴）', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('copy', 42, ['a.txt'])
    const { failed } = runPaste(clipboard, async (from) => from)
    await failed
    expect(clipboard.current?.op).toBe('copy')
    expect(clipboard.current?.paths).toEqual(['a.txt'])
  })
})
```

实测：3 passed。

---

## BUG-7【高】根目录粘贴传空串落点，`workspace-move/copy` 拒收——根目录粘贴完全不可用

### 位置

- `desktop/src/components/file-browser/FileManagerPanel.vue:403`（cut 粘贴：`moveWorkspacePath(numericSessionId.value, src, currentDir.value)`）
- `desktop/src/components/file-browser/FileManagerPanel.vue:406`（copy 粘贴：`copyWorkspacePath(numericSessionId.value, src, currentDir.value)`）
- 后端拒收点：`backend-ts/src/harness/safety/path-sandbox.ts:25`（`resolve('')` → `IllegalArgumentException('Path cannot be empty')`）→ `backend-ts/src/file/workspace-write.service.ts:367`（`place()` 内 `resolveWritable(to='')`）→ `BusinessException(PARAM_INVALID, 'Path cannot be empty')`
- 对照的正确口径：`desktop/src/composables/workspace-file-write.ts:197`（上传 `dir || '.'`）、`desktop/src/components/file-browser/FileTree.vue:472/554`（侧边栏粘贴与空白拖放都用 `'.'`）

### 代码事实

`currentDir` 在根目录是 `''`（`navigateTo('')`、初始值），`handlePaste` 原样把它当 `to` 传给 move/copy 端点；而 `path-sandbox.resolve('')` 直接抛 `Path cannot be empty`。api 响应拦截器对该业务码（非 3044/3045）弹 `ElMessage.error`，用户看到一条英文内部错误文案。**根目录是文件管理器的默认视图**，在此视图剪切/复制任何条目后按 Ctrl+V 或右键粘贴，第一个条目即失败、循环 break，整个粘贴不可用。子目录粘贴不受影响（传的是真实子目录路径）。

该问题第一轮漏检（第一轮只关注了剪贴板清理语义），本轮仍在。

### 期望 vs 实际

- 期望：根目录落点归一化为 `'.'`（与上传、侧边栏一致），粘贴成功。
- 实际：传 `''` → 后端 PARAM_INVALID → 错误 toast「Path cannot be empty」，粘贴无任何效果。

### 验证测试（实测：期望断言失败 + 后端契约探针通过）

前端探针 `desktop/src/composables/zz2-new1-root-dir-write.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { canDropTargetDir } from '../utils/file-manager'

/**
 * 复现 BUG-7 / BUG-8（根目录写路径传空串）：
 * FileManagerPanel.handlePaste（L392-416）把 currentDir 原样传给 moveWorkspacePath /
 * copyWorkspacePath；onBodyDrop（L463-476）同样把 currentDir 传给 moveSourcesTo。
 * 根目录时 currentDir === ''，而 workspace-move/copy 端点拒收空串
 * （path-sandbox resolve('') → 'Path cannot be empty'）。
 * 对照：uploadWorkspace 的 sendUpload 用 dir || '.'（workspace-file-write.ts L197），
 * 侧边栏 pasteClipboard / onBlankDrop 也用 '.'（FileTree.vue L472/L554）。
 */
describe('根目录（currentDir=""）的粘贴与空白处拖放落点', () => {
  it('handlePaste 的落点参数：期望根目录归一化为 "."，实际原样传 ""', () => {
    const currentDir = '' // 根目录
    // 现行代码（FileManagerPanel.vue L403/L406）：
    const actualDest = currentDir
    // 期望（与 upload/侧边栏一致）：
    const expectedDest = currentDir || '.'
    expect(actualDest).toBe(expectedDest)
  })

  it('onBodyDrop 的 moveSourcesTo 落点同样未归一化', () => {
    const currentDir = ''
    const actualDir = currentDir
    const expectedDir = currentDir || '.'
    expect(actualDir).toBe(expectedDir)
  })

  it('BUG-5 修复的前端预检在根目录放行，与后端拒收空串不一致', () => {
    // 回归测试断言过 canDropTargetDir(['docs/a.md'], '') === true（前端认为合法）
    expect(canDropTargetDir(['docs/a.md'], '')).toBe(true)
    // 但后端 move(to='') 抛 PARAM_INVALID（见 backend-ts 探针）——根目录空白处拖放仍会失败
  })
})
```

实测输出（前两条按设计失败，证明 bug 存在；第三条记录前后端不一致）：

```
 FAIL ... handlePaste 的落点参数：期望根目录归一化为 "."，实际原样传 ""
AssertionError: expected '' to be '.'
 FAIL ... onBodyDrop 的 moveSourcesTo 落点同样未归一化
AssertionError: expected '' to be '.'
 ✓ BUG-5 修复的前端预检在根目录放行，与后端拒收空串不一致
```

后端契约探针 `backend-ts/src/file/zz2-new1-root-dir-move.spec.ts`（3 passed，证明 API 口径）：

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { ActivityService } from '../session/activity.service.js';
import { useTmpDir } from '../testing/tmp-dir.js';
import { WorkspaceWriteService } from './workspace-write.service.js';

/**
 * BUG-7 / BUG-8 的后端侧证据：move / copy 的 to 传空串时抛 PARAM_INVALID。
 * 前端 FileManagerPanel 在根目录（currentDir === ''）粘贴与空白处拖放正是传空串，
 * 而侧边栏与上传路径都归一化为 '.'。
 */
describe('move/copy 落点空串（根目录）', () => {
  function setup() {
    const root = useTmpDir('mao-ws-emptydest-');
    const sandbox = new PathSandbox(root);
    const workspace = join(root, 'user', 'sess');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(workspace, 'docs'));
    writeFileSync(join(workspace, 'docs', 'a.txt'), 'x');
    const activity = { record: vi.fn(async () => ({ id: 1 })) } as unknown as ActivityService;
    return { service: new WorkspaceWriteService(sandbox, activity), workspace };
  }

  it('对照组：to="."（侧边栏/上传的口径）移动到根目录正常', async () => {
    const { service, workspace } = setup();
    const result = await service.move(1, workspace, 'docs/a.txt', '.');
    expect(result.path).toBe('a.txt');
  });

  it('move to="" 抛 PARAM_INVALID（前端根目录粘贴正落此路径）', async () => {
    const { service, workspace } = setup();
    const e = await service.move(1, workspace, 'docs/a.txt', '').catch((err) => err);
    expect(e).toBeInstanceOf(BusinessException);
    expect((e as BusinessException).code).toBe(ErrorCode.PARAM_INVALID.code);
    expect((e as Error).message).toBe('Path cannot be empty');
  });

  it('copy to="" 同样抛 PARAM_INVALID（前端根目录复制粘贴正落此路径）', async () => {
    const { service, workspace } = setup();
    const e = await service.copy(1, workspace, 'docs/a.txt', '').catch((err) => err);
    expect(e).toBeInstanceOf(BusinessException);
    expect((e as BusinessException).code).toBe(ErrorCode.PARAM_INVALID.code);
    expect((e as Error).message).toBe('Path cannot be empty');
  });
});
```

实测：3 passed（对照组 `'.'` 正常；`''` 两条均按记录抛出）。

---

## BUG-8【中】BUG-5 的修复未覆盖根目录：空白处拖放移动在根目录 100% 失败

### 位置

- `desktop/src/components/file-browser/FileManagerPanel.vue:467`（`onBodyDrop` → `moveSourcesTo(paths, currentDir.value, true)`，根目录时第二个参数为 `''`）
- `desktop/src/utils/file-manager.ts:90-98`（`canDropTargetDir` 对 `targetPath === ''` 一律放行，且本轮新增回归测试还断言了 `canDropTargetDir(['docs/a.md'], '') === true`）

### 代码事实

BUG-5 的修复让空白处拖放对**子目录**生效（`moveSourcesTo(paths, 'src', true)` → 后端接受真实子目录路径，探针 FIX-5 已验证）。但根目录视图（`currentDir === ''`，默认视图）下，`moveWorkspacePath(sessionId, src, '')` 与 BUG-7 同链：后端 `PARAM_INVALID 'Path cannot be empty'` → 错误 toast。即修复后根目录空白处拖放**仍然 100% 失败**，且从修复前的「静默无操作」变成「弹错误 toast」——行为可感知地变差（用户会以为拖放坏了并看到一条看不懂的英文错误）。子目录拖放、拖到文件夹格均正常。

### 期望 vs 实际

- 期望：根目录空白处拖放 = 移动到根（`'.'`），与子目录一致地生效。
- 实际：传 `''` → 后端拒收 → 错误 toast，移动不生效。

### 验证测试

与 BUG-7 共用上述两组探针（前端 `zz2-new1-root-dir-write.test.ts` 第 2、3 条 + 后端 `zz2-new1-root-dir-move.spec.ts`）：前端落点未归一化（断言失败）、前端预检放行与后端拒收并存（断言通过，记录不一致）。FIX-5 探针第 1 条同时证明子目录路径已修复、根目录未修复。

### 修复建议（两个 BUG 同一根因）

1. `handlePaste` 与 `onBodyDrop → moveSourcesTo` 的落点统一 `currentDir.value || '.'`（与 `uploadWorkspace` 的 `dir || '.'`、侧边栏 `'.'` 口径一致）。
2. 顺带在 `canDropTargetDir` 或面板预检里拒绝「源本就在落点目录」的同目录移动（`parentDirOf(src) === dir`），否则根目录同目录拖放修完空串后还会撞后端 `place()` 的「不能移动到自身」。

---

## 附录 A：排查后确认不构成 BUG 的候选（本轮）

| 候选 | 结论 |
| --- | --- |
| `searchSeq++` 清空分支是否漏掉「防抖定时器已排队的搜索」 | 无漏：watcher 顶部先 `clearTimeout(searchTimer)`， pending 搜索不会发出 |
| 清空与重新输入的交错（a→清空→b→迟到 a 响应） | 无漏：每次 `runSearch` 都 `++searchSeq`，迟到旧响应 seq 必然过期 |
| 导航作废在途搜索的时序（watcher 异步 vs 网络响应） | 安全：Vue watcher 在下一微任务/tick 执行，远早于 HTTP/IPC 响应 |
| `selectOnly` 收敛选区是否会误伤「右键已选中项的多选批量操作」 | 不会：仅当右键项不在选区内才收敛，与侧边栏 `actionPaths` 同语义 |
| `beginCreate(kind, dir=currentDir)` 默认参数求值时机 | 正确：调用时求值，状态栏按钮传 currentDir、右键传 ctxTargetDir |
| `canDropTarget` 重构（改为复用 `canDropTargetDir`） | 无行为变化：既有 4 条用例全过；`!targetPath` 提前返回保留 |
| `handlePaste` 部分失败后剪贴板保留「已成功移动的项」，重试会对已移动项报错 | 与侧边栏 `pasteClipboard` 完全一致（明确的对齐目标），不计 bug |
| `navigateTo` 在同目录 crumb 点击时也 `cancelDraft()` | 轻微 UX（点当前面包屑会取消新建草稿），不计 bug，见附录 B-O4 |
| `@keydown.esc` 挂在 el-input 上是否生效 | 生效：el-input `inheritAttrs:false` 但 `handleKeydown` 把原生 keydown 重新 `emit('keydown')`，`@keydown.esc` 经 Vue `withKeys`（esc→Escape）正常触发 |
| 右键「新建/上传到此处」落点（附录B-1） | 正确：`ctxTargetDir()` 目录取自身、文件取父目录，与侧边栏 `beginCreate`/`beginUpload` 同口径；`pickUpload(dir)` + `uploadDir` 无 staleness（每次点击先落值再触发 input） |
| `.git` 删除提示口径（附录B-2） | 正确：四分支与侧边栏 `touchesGit` 逐条一致 |
| 后端 `mtimeMs` 字段本轮是否还有变动 | 无：与第一轮相同（additive 可选字段 + spec），`src/file` 7 文件 70 用例通过 |
| 上传到子目录后不刷新当前视图（`dir === currentDir.value` 才 refresh） | 正确：当前视图列表不变化，无需刷新 |

## 附录 B：观察项（未计 BUG）

- O1（遗留）：`canDropTarget`/`canDropTargetDir` 的文档注释仍称「不能是源当前所在的目录（同目录移动是无操作）」，实现从未做同目录校验（`parentDirOf(src) === dir`）；修 BUG-8 空串问题时需一并补上，否则根目录同目录拖放会改为撞后端「不能移动到自身」。
- O2（遗留）：后端 spec 用例 `keepsSymlinkFlagAndSortsDirectoriesFirst` 名不副实（未创建符号链接）——第一轮 O6 未处理。
- O3（遗留）：`searchTruncated` 仍用 `entries.length >= 100` 推断，未用后端已返回、provider 已映射的 `truncated` 标志——第一轮 O4 未处理。
- O4（新）：`navigateTo` 在 `dir === currentDir` 早退前执行 `cancelDraft()`，点击当前所在面包屑会取消新建/重命名草稿。
- O5：`useFileManager.ts:31-32` 注释称 KeepAlive key 恒为 `'file-manager'`，实际 key 含 sessionId（第一轮已记，行为安全）。

## 附录 C：基线与探针运行方式

```bash
cd /Users/yangjiayi/AiProjects/mao/.worktrees/file-manager-tab/desktop
# 修复验证探针（全通过）
npx vitest run src/composables/zz2-fix1-mtime.test.ts        # FIX-1：1 通过
npx vitest run src/composables/zz2-fix2-search.test.ts       # FIX-2：2 通过
npx vitest run src/composables/zz2-fix3-ctxmenu.test.ts      # FIX-3：3 通过
npx vitest run src/composables/zz2-fix4-draft.test.ts        # FIX-4：3 通过
npx vitest run src/utils/zz2-fix5-drop.test.ts               # FIX-5：4 通过
npx vitest run src/composables/zz2-fix6-paste.test.ts        # FIX-6：3 通过
# 新 BUG 探针（前两条按设计失败＝BUG-7/8 存在证明）
npx vitest run src/composables/zz2-new1-root-dir-write.test.ts
# 后端契约探针（3 通过：'.' 可行、'' 拒收）
cd ../backend-ts && npx vitest run src/file/zz2-new1-root-dir-move.spec.ts
```

- 探针在位时 desktop 全量：65 文件 / 540 用例（2 失败为按设计的存在性证明）；移除探针后 58 文件 / 521 用例全通过（与修复方自报一致）。
- `backend-ts npx vitest run src/file`：7 文件 / 70 用例通过（含后端探针）。
- 后端全量 `npm test`：**290 文件通过 / 1 文件跳过，3592 用例通过 / 13 用例跳过，无失败用例**。日志中唯一的 failed suite 是 `src/file/zz2-new1-root-dir-move.spec.ts` 报 "Cannot find module"——全量运行启动后才删除该探针，vitest 启动时已收集该文件所致，属删除时序artifact，非真实失败；本轮修复未触及后端源码，与该结论一致。
- 所有探针验证后已从仓库移除，源码零改动（`git status` 仅剩本功能原有未提交项与本报告）。
