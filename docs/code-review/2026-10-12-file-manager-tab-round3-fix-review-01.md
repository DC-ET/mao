# 「文件管理」页签第三轮修复审查（2026-10-12 · 第三轮）

- **日期**：2026-10-12
- **基线**：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/file-manager-tab`（分支 `feature/file-manager-tab`，HEAD `42429edf`），第二轮报告 `2026-10-12-file-manager-tab-round2-fix-review-01.md` 之后的修复版未提交代码。行号以本轮审查时源码实测核对。
- **范围**：本轮发生改动的文件（mtime 13:18–13:20）：`desktop/src/components/file-browser/FileManagerPanel.vue`、`desktop/src/utils/file-manager.ts`、`desktop/src/composables/useFileManager.ts`、`backend-ts/src/file/workspace-browse.service.spec.ts`、`desktop/src/components/center/CenterTabContainer.vue`，及同步更新的回归测试 `desktop/src/utils/file-manager.test.ts`。`FileManagerGrid/List/ContextMenu.vue`、`FileTree.vue`、`workspace-file-write.ts` 本轮未改动（mtime 分别停在 12:31–13:04）。
- **方法**：与第二轮相同——面板内处理器无法在无 DOM 环境下挂载，探针复刻面板精确表达式（带行号引用）并驱动真实 composable / 纯函数；后端契约用真实 service 实例验证。修复验证探针断言「修复后的正确行为」（通过即修复生效）。
- **结论**：**本轮 2 个 BUG 的修复全部正确，未发现新 BUG，未发现修复引入的逻辑回归**；三个观察项中 O2、O3 正确落实，O5 只落实一半（key 处已补注释，但 `useFileManager.ts` 内的过期注释未同步）。针对「根目录空串落点」的同类根因，本轮对全部写端口调用点做了穷举审计（见第二节 Q1），**无其他漏网路径**。共 26 条探针全部通过，探针验证后已移除。

---

## 一、修复验证结论表

| 项 | 对应 | 结论 | 验证探针（实测） |
| --- | --- | --- | --- |
| BUG-7 修复 | 根目录粘贴 | ✅ 正确。`handlePaste` 落点 `currentDir.value \|\| '.'`，cut/copy 均走 dest；根目录粘贴恢复可用，子目录无回归，FIX-6 剪贴板语义未回退 | `zz3-fix7-paste` 4 通过 |
| BUG-8 修复 | 根目录空白拖放 | ✅ 正确。`moveSourcesTo` 预检仍用 `dir` 原值（保持「当前目录」语义）、实际落点 `dir \|\| '.'`；根目录空白处拖外部文件成功、拖根目录自身条目被静默拒绝（不再打后端） | `zz3-fix8-drop` 7 通过 |
| BUG-8 第二半 | 同目录移动拒绝 | ✅ 正确且无误杀。`canDropTargetDir` 新增 `parentDirOf(src) === targetPath` 拒绝；差分测试证明行为变化**仅限**「根目录同目录」一种场景，其余全部组合与修复前一致 | `zz3-drop-matrix` 2 通过 + `zz3-fix8-drop` 内 5 场景 |
| O2 | symlink 用例名副实 | ✅ 正确。spec 真造 `symlinkSync`（L111）并断言 `isSymlink` true/false 各一（L114-115） | 既有用例随 `src/file` 套件通过（67 用例） |
| O3 | searchTruncated 以后端为准 | ✅ 正确。`result.truncated ?? (条数 >= 上限)`：后端标志优先，缺省才回退按条数；两个方向的旧误报/漏报均修正 | `zz3-o3-truncated` 3 通过 |
| O5 | KeepAlive key 注释 | ⚠️ 半落实。`CenterTabContainer.vue:36` 已补注释说明 key 为何带 sessionId；但 `useFileManager.ts:31` 仍称「key 恒为 'file-manager'」且「组件实例会被相邻会话复用」，与新 key 矛盾（观察项 O-2，行为安全） | 代码走查（注释项无可测行为） |

## 二、三个特别复核点的回答

### Q1：除 handlePaste / moveSourcesTo 外，还有没有把 currentDir（可能为 ''）直接传给写端口的路径？

**答：没有。** 对两个组件内全部写端口调用点逐一审计（含绕过 wrapper 的直连排查——`grep workspace-move|copy|mkdir|write|rename|delete|upload` 在 desktop/src 仅命中 `workspace-file-write.ts` 的封装与 FileTree/Panel 两处 import，无其他直连）：

| 调用点 | 传入参数 | 根目录（''）时 | 结论 |
| --- | --- | --- | --- |
| `FileManagerPanel.vue:406/409` handlePaste move/copy | `dest`（L402 `currentDir.value \|\| '.'`） | 归一化为 `'.'` | ✅ 本轮已修 |
| `FileManagerPanel.vue:439` moveSourcesTo move | `dest`（L436 `dir \|\| '.'`） | 归一化为 `'.'` | ✅ 本轮已修 |
| `FileManagerPanel.vue:472` onBodyDrop → moveSourcesTo | `currentDir.value` 作 `dir`，落点在其内部归一化 | 安全 | ✅ |
| `FileManagerPanel.vue:478` onBodyDrop → handleFiles | `currentDir.value` 作上传 dir | `sendUpload` L197 `dir \|\| '.'` | ✅ |
| `FileManagerPanel.vue:453` onFolderDrop → moveSourcesTo | `entry.path`（真实条目路径，非空） | 不涉及 | ✅ |
| `FileManagerPanel.vue:459` onFolderDrop → handleFiles | `entry.path` | 不涉及 | ✅ |
| `FileManagerPanel.vue:485-495` pickUpload/onPickFiles → handleFiles | `uploadDir`（可能为 ''，来自 ctxTargetDir） | `sendUpload` L197 归一化 | ✅ |
| `FileManagerPanel.vue:311-318` commitCreate mkdir/write | `joinRel(draft.dir, name)`：`joinRel('', 'a.txt') = 'a.txt'` | 产出非空相对路径 | ✅ |
| `FileManagerPanel.vue:337` commitRename | 条目 `path`（非空） | 不涉及 | ✅ |
| `FileManagerPanel.vue:372` handleDelete | 条目 `path`（非空） | 不涉及 | ✅ |
| `FileTree.vue:472` pasteClipboard dest | `!node ? '.' : ... parentOf(node.path) \|\| '.'` | 本就归一化 | ✅ |
| `FileTree.vue:491/505` beginUpload/onPickFiles | `... \|\| '.'` / `uploadDir \|\| '.'` | 本就归一化 | ✅ |
| `FileTree.vue:527` handleInternalDrop | `payload.target.path`（树节点路径，非空） | 不涉及 | ✅ |
| `FileTree.vue:540/554` handleExternalDrop/onBlankDrop | `target.path \|\| '.'` / `'.'` 字面量 | 本就归一化 | ✅ |
| `useFileBrowser.ts` | 不调用任何写端口 | — | ✅ |

读路径同样安全：`createCloudProvider.listDirectory` 对 `''` 发送 `dir: undefined`（`workspace-file-provider.ts:194`），后端 `normalizeRelativeDir` 再兜底为 `'.'`（`workspace-browse.service.ts:403-408`）。

### Q2：canDropTargetDir 新增的同目录拒绝，有没有把合法场景误杀？

**答：没有。** 差分测试（`zz3-drop-matrix`）把新实现与修复前实现在 8×7 的 (源, 落点) 矩阵上逐对比较：全部行为差异**仅有**「落点为 `''` 且源本就在根下」由放行变为拒绝，且每一处差异方向都是放行→拒绝、落点都是 `''`、源的父目录都是 `''`——即精准命中预期的根目录同目录场景，没有误杀任何其他组合（含拖到非当前目录的文件夹、跨目录拖到根、拖到兄弟子目录等合法场景，均由 `zz3-fix8-drop` 的 5 个场景断言覆盖）。

附带发现（观察项 O-4）：该新检查实际只对 `targetPath === ''` 生效——非空落点时 `parentDirOf(src) === target` 必然蕴含 `src.startsWith(target + '/')`，已被 L95 先行拒绝。因此它是「根目录同目录」的专用守卫，行为正确；`file-manager.test.ts:83-85` 的 `canDropTarget(['src/a.ts'], 'src')` 一条在修复前同样被拒，对新检查无覆盖力（真正生效覆盖的是 `canDropTargetDir(['a.txt'], '')`，L106-110）。测试冗余，无害。

### Q3：根目录落点改 '.' 后，paths-changed 的 from/to 记账是否仍准确？

**答：准确。** 后端契约探针（`zz3-root-dest`，真实 `WorkspaceWriteService`）证实：`move/copy` 到 `'.'` 时 `place()` 先把 `'.'` 解析为工作区根（`resolveWritable` L292-293 将根映射为 `rel='.'`），再按「落点是目录」规则 `join(dest.abs, basename(source.abs))`（L372-374），最终 `move()` 返回 `placed.dest.rel`（L121）——即**干净的 basename**（`'a.txt'`），不是 `'./a.txt'`、不是 `'.'`、也不是原路径。面板 emit 的 `{from: 'docs/a.txt', to: 'a.txt'}` 经真实 `retargetTabPath` 验证：打开中的 `docs/a.txt` 页签正确重定向到 `a.txt`，深层文件（`a/b/c.txt`→`c.txt`）、目录移动（`a/docs`→`b/docs` 的子孙页签）、无关页签保持等场景全部正确（`zz3-tab-accounting` 5 通过）。后端返回 `'.'` 的路径不存在（根目录移动必被 same-rel 检查 L377-379 拒绝），记账不会出现异常值。

## 三、新发现问题

**无。** 本轮修复未引入新 BUG；对「空串落点」同类根因的穷举审计（Q1）未发现其他漏网路径。

## 四、观察项（未计 BUG）

- O-1（新增）：**根目录自我粘贴会弹「不能移动到自身」**。场景：根目录选中 `a.txt` → 剪切/复制 → 原地粘贴 → dest `'.'` → 后端 same-rel 拒绝 → 错误 toast。与修复前（`Path cannot be empty`）相比文案更准确，且与侧边栏 `pasteClipboard`（同样无同目录预检）行为一致，非回归。可选优化：粘贴前加同目录预检做成无操作。
- O-2（新增）：**O5 只落实一半**。`CenterTabContainer.vue:36` 已补注释，但 `useFileManager.ts:31` 仍写「key 恒为 'file-manager'」「组件实例会被相邻会话复用」，与 L39 实际的 `` `file-manager-${props.sessionId}` `` key 矛盾。行为安全（key 含 sessionId 后跨会话即换新实例，`[provider, sessionId]` watcher 重置仍是双保险），但两处注释并存会误导后来者。
- O-3（新增）：`file-manager.test.ts:83-85` 对 `canDropTarget` 新增的同目录用例在修复前即被拒（见 Q2），对新检查无覆盖力；无害。
- O-4（新增）：`canDropTargetDir` 的 parentDirOf 检查只对根目录落点生效（见 Q2），注释「源已在目标目录下」字面正确但可能让读者误以为是通用检查。
- O-5（新增）：多选粘贴中途失败会 `break`，剩余项不再尝试（剪贴板按 FIX-6 保留）——与侧边栏 `pasteClipboard` 完全一致，属既定对齐行为。
- O-6（遗留，第二轮 O-2/O-3 已处理）：无新增遗留；第二轮其余观察项（后端 spec 名不副实、searchTruncated 条数推断）本轮已按清单处理。

## 附录 A：排查后确认不构成 BUG 的候选（本轮）

| 候选 | 结论 |
| --- | --- |
| `handleFiles(items, currentDir.value)` 上传落点空串 | `sendUpload` L197 `dir \|\| '.'` 归一化，且后端 upload L166 也兜底 |
| `pickUpload` 的 `uploadDir` 陈旧（右键 A 后取消，再右键 B） | 每次 `pickUpload` 先落 `uploadDir` 再触发 input，无跨次陈旧 |
| `commitCreate` 的 `joinRel(draft.dir, name)` 在根目录产出空串 | `joinRel('', name) = name`，非空 |
| `ctxTargetDir()` 对根级文件返回 `''` | 下游全部归一化或走 joinRel，安全 |
| `listDirectory('')` 读路径空串 | provider 转 `undefined` + 后端 `normalizeRelativeDir` 双兜底 |
| Electron LOCAL 模式是否有同类空串写路径 | 文件管理器面板仅 CLOUD（`ensureWritable` + `numericSessionId > 0`），LOCAL 走 FileTree 且已归一化 |
| admin 端是否有同类调用 | 无（写端口仅 desktop 两处组件调用） |
| CHANGELOG 未单独记录 BUG-7/8 修复 | 功能尚未发版，0.0.281 条目已整体覆盖本功能，符合 AGENTS.md「无行为依赖的修复可不单独记」口径 |
| FileManagerGrid/List/ContextMenu 是否需重审 | 本轮未改动（mtime 12:31–12:43），不在范围 |
| `searchTruncated` 的 `??` 回退不可达 | cloud/local provider 均总返回布尔 `truncated`，回退是防御性代码，非缺陷 |

## 附录 B：探针代码与实测输出（全部通过，验证后已移除）

### B-1 `desktop/src/composables/zz3-fix7-paste.test.ts`（4 通过）——BUG-7 修复

复刻 `handlePaste`（L393-419）控制流，`dest = currentDir.value || '.'` 与 L402 一致；`moveWorkspacePath` 桩按后端 `place()` 语义返回 `join(dest, basename(src))`（根目录即 basename）。

```ts
import { describe, expect, it, vi } from 'vitest'
import { useFileClipboard } from './useFileClipboard'
import { dedupeMoveSources } from '../utils/file-manager'

interface Change { kind: 'move'; from: string; to: string }

function backendLikeMoveResult(src: string, dest: string): { path: string } {
  const base = src.split('/').pop() ?? src
  return { path: dest === '.' ? base : `${dest}/${base}` }
}

function runPaste(
  clipboard: ReturnType<typeof useFileClipboard>,
  currentDir: string,
  moveWorkspacePath: (from: string, to: string) => Promise<{ path: string }>,
) {
  const changes: Change[] = []
  const clip = clipboard.current!
  const sources = dedupeMoveSources(clip.paths)
  const dest = currentDir || '.' // ← 与 FileManagerPanel.vue L402 一致
  const done = (async () => {
    try {
      for (const src of sources) {
        if (clip.op === 'cut') {
          const result = await moveWorkspacePath(src, dest)
          changes.push({ kind: 'move', from: src, to: result.path })
        } else {
          await moveWorkspacePath(src, dest)
        }
      }
      if (clip.op === 'cut') clipboard.clear()
    } catch {
      // 冲突面板与全局 toast 已提示
    }
  })()
  return { changes, done }
}

describe('BUG-7 修复：根目录粘贴落点归一化', () => {
  it('根目录（currentDir=""）cut 粘贴传 "." 而非空串，paths-changed 记账为干净相对路径', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['docs/a.txt'])
    const calls: Array<[string, string]> = []
    const { changes, done } = runPaste(clipboard, '', async (from, to) => {
      calls.push([from, to])
      return backendLikeMoveResult(from, to)
    })
    await done
    expect(calls).toEqual([['docs/a.txt', '.']])
    expect(changes).toEqual([{ kind: 'move', from: 'docs/a.txt', to: 'a.txt' }])
    expect(clipboard.current).toBeNull()
  })

  it('根目录 copy 粘贴同样传 "."', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('copy', 42, ['docs/a.txt'])
    const calls: Array<[string, string]> = []
    const { done } = runPaste(clipboard, '', async (from, to) => {
      calls.push([from, to])
      return backendLikeMoveResult(from, to)
    })
    await done
    expect(calls).toEqual([['docs/a.txt', '.']])
    expect(clipboard.current?.op).toBe('copy')
  })

  it('子目录粘贴仍传子目录原值（修复无副作用）', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['a.txt'])
    const calls: Array<[string, string]> = []
    const { changes, done } = runPaste(clipboard, 'src', async (from, to) => {
      calls.push([from, to])
      return backendLikeMoveResult(from, to)
    })
    await done
    expect(calls).toEqual([['a.txt', 'src']])
    expect(changes).toEqual([{ kind: 'move', from: 'a.txt', to: 'src/a.txt' }])
  })

  it('多选根目录粘贴逐项传 "."，中途失败保留剪贴板（FIX-6 语义未回退）', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['a.txt', 'b.txt', 'c.txt'])
    const calls: Array<[string, string]> = []
    const { done } = runPaste(clipboard, '', async (from, to) => {
      calls.push([from, to])
      if (from === 'b.txt') throw new Error('目标已存在')
      return backendLikeMoveResult(from, to)
    })
    await done
    expect(calls).toEqual([['a.txt', '.'], ['b.txt', '.']])
    expect(clipboard.current?.paths).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })
})
```

实测：`✓ src/composables/zz3-fix7-paste.test.ts (4 tests)`。

### B-2 `desktop/src/composables/zz3-fix8-drop.test.ts`（7 通过）——BUG-8 修复 + 无误杀

复刻 `moveSourcesTo`（L427-447），驱动真实 `useFileManager`（`currentDir`/`entries`）与真实 `canDropTargetDir`/`canDropTarget`。

```ts
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { DirectoryResult, WorkspaceFileProvider } from './workspace-file-provider'
import type { FileNode } from '../types/file-browser'
import { useFileManager } from './useFileManager'
import { canDropTarget, canDropTargetDir } from '../utils/file-manager'

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

function backendLikeMoveResult(src: string, dest: string): { path: string } {
  const base = src.split('/').pop() ?? src
  return { path: dest === '.' ? base : `${dest}/${base}` }
}

interface Change { kind: 'move'; from: string; to: string }

/** 复刻 FileManagerPanel.vue L427-447 的 moveSourcesTo */
function runMoveSourcesTo(
  fm: ReturnType<typeof useFileManager>,
  sources: string[],
  dir: string,
  dirIsCurrent = false,
  moveWorkspacePath: (from: string, to: string) => Promise<{ path: string }> = async (from, to) =>
    backendLikeMoveResult(from, to),
) {
  const changes: Change[] = []
  const calls: Array<[string, string]> = []
  const movable = sources.filter((src) =>
    dirIsCurrent ? canDropTargetDir([src], dir) : canDropTarget([src], dir, fm.entries.value),
  )
  const dest = dir || '.' // ← 与 FileManagerPanel.vue L436 一致
  const done = (async () => {
    for (const src of movable) {
      try {
        calls.push([src, dest])
        const result = await moveWorkspacePath(src, dest)
        changes.push({ kind: 'move', from: src, to: result.path })
      } catch {
        break
      }
    }
  })()
  return { movable, changes, calls, done }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('BUG-8 修复：根目录空白拖放 + 同目录拒绝', () => {
  it('根目录空白处拖入侧边栏外部文件：dest 归一化为 "."，移动成功', async () => {
    const provider = ref(makeProvider({ '': [node('a.txt', 'a.txt')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    expect(fm.currentDir.value).toBe('')

    const { movable, changes, calls, done } = runMoveSourcesTo(fm, ['docs/a.md'], fm.currentDir.value, true)
    await done
    expect(movable).toEqual(['docs/a.md'])
    expect(calls).toEqual([['docs/a.md', '.']])
    expect(changes).toEqual([{ kind: 'move', from: 'docs/a.md', to: 'a.md' }])
  })

  it('根目录空白处拖根目录自身条目：同目录拒绝，不发请求（不再弹错误 toast）', async () => {
    const provider = ref(makeProvider({ '': [node('a.txt', 'a.txt'), node('docs', 'docs', { isDirectory: true })] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    const { movable, calls, done } = runMoveSourcesTo(fm, ['a.txt'], fm.currentDir.value, true)
    await done
    expect(movable).toEqual([])
    expect(calls).toEqual([])

    const dirCase = runMoveSourcesTo(fm, ['docs'], fm.currentDir.value, true)
    await dirCase.done
    expect(dirCase.movable).toEqual([])
    expect(dirCase.calls).toEqual([])
  })

  it('子目录空白处拖入外部文件：dest 传子目录原值（无回归）', async () => {
    const provider = ref(makeProvider({ '': [node('src', 'src', { isDirectory: true })], src: [] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    fm.navigateTo('src')
    await flush()

    const { changes, calls, done } = runMoveSourcesTo(fm, ['docs/a.md'], fm.currentDir.value, true)
    await done
    expect(calls).toEqual([['docs/a.md', 'src']])
    expect(changes).toEqual([{ kind: 'move', from: 'docs/a.md', to: 'src/a.md' }])
  })

  it('子目录空白处拖当前目录自身条目：同目录拒绝', async () => {
    const provider = ref(makeProvider({ '': [node('src', 'src', { isDirectory: true })], src: [node('a.ts', 'src/a.ts')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    fm.navigateTo('src')
    await flush()

    const { movable, calls, done } = runMoveSourcesTo(fm, ['src/a.ts'], fm.currentDir.value, true)
    await done
    expect(movable).toEqual([])
    expect(calls).toEqual([])
  })

  it('拖到可见文件夹格：跨目录合法、同目录拒绝', async () => {
    const provider = ref(makeProvider({
      '': [node('a.txt', 'a.txt'), node('docs', 'docs', { isDirectory: true }), node('src', 'src', { isDirectory: true })],
    }))
    const fm = useFileManager(provider, ref('42'))
    await flush()

    const ok = runMoveSourcesTo(fm, ['a.txt'], 'docs', false)
    await ok.done
    expect(ok.calls).toEqual([['a.txt', 'docs']])
    expect(ok.changes).toEqual([{ kind: 'move', from: 'a.txt', to: 'docs/a.txt' }])

    const same = runMoveSourcesTo(fm, ['src/a.ts'], 'src', false)
    await same.done
    expect(same.movable).toEqual([])
    expect(same.calls).toEqual([])
  })
})

describe('canDropTargetDir 同目录拒绝不误杀合法场景', () => {
  it('跨目录拖到根、拖到别的文件夹均放行', () => {
    expect(canDropTargetDir(['docs/a.md'], '')).toBe(true)
    expect(canDropTargetDir(['docs/a.md'], 'src')).toBe(true)
    expect(canDropTargetDir(['a.txt'], 'docs')).toBe(true)
    expect(canDropTargetDir(['src/a.ts'], 'src/sub')).toBe(true)
    expect(canDropTargetDir(['a/b/c.txt'], 'a/b')).toBe(false)
  })

  it('自身/子孙/父子关系拒绝保持不变', () => {
    expect(canDropTargetDir(['src'], 'src')).toBe(false)
    expect(canDropTargetDir(['src'], 'src/nested')).toBe(false)
    expect(canDropTargetDir(['src/nested'], 'src')).toBe(false)
    expect(canDropTargetDir([''], 'src')).toBe(false)
    expect(canDropTargetDir([], 'src')).toBe(false)
  })
})
```

实测：`✓ src/composables/zz3-fix8-drop.test.ts (7 tests)`。

### B-3 `desktop/src/utils/zz3-drop-matrix.test.ts`（2 通过）——差分证明无误杀

```ts
import { describe, expect, it } from 'vitest'
import { canDropTargetDir, parentDirOf } from './file-manager'

/** 修复前（第二轮版本，无 parentDirOf 行） */
function preFixCanDropTargetDir(sourcePaths: string[], targetPath: string): boolean {
  if (sourcePaths.length === 0) return false
  for (const src of sourcePaths) {
    if (!src || src === targetPath) return false
    if (targetPath.startsWith(`${src}/`)) return false
    if (src.startsWith(`${targetPath}/`)) return false
  }
  return true
}

const SRCS = ['a.txt', 'src', 'src/a.ts', 'src/sub', 'src/sub/x.ts', 'docs/a.md', 'a/b/c.txt', 'docs']
const TARGETS = ['', '.', 'src', 'src/sub', 'docs', 'a', 'a/b']

describe('canDropTargetDir 差分：新检查只影响根目录同目录', () => {
  it('修复前后仅「空 target 且源本就在根下」由放行变为拒绝', () => {
    const diffs: Array<{ src: string; target: string; before: boolean; after: boolean }> = []
    for (const src of SRCS) {
      for (const target of TARGETS) {
        const before = preFixCanDropTargetDir([src], target)
        const after = canDropTargetDir([src], target)
        if (before !== after) diffs.push({ src, target, before, after })
      }
    }
    for (const d of diffs) {
      expect(d.target, `diff ${d.src}→${d.target}`).toBe('')
      expect(parentDirOf(d.src), `diff ${d.src}→${d.target}`).toBe('')
      expect(d.before).toBe(true)
      expect(d.after).toBe(false)
    }
    expect(diffs.length).toBeGreaterThan(0)
    const rootLevelSrcs = SRCS.filter((s) => parentDirOf(s) === '')
    expect(diffs.map((d) => d.src).sort()).toEqual([...rootLevelSrcs].sort())
  })

  it('非空 target 的任何组合行为不变（新检查对其完全冗余）', () => {
    for (const src of SRCS) {
      for (const target of TARGETS) {
        if (target === '') continue
        expect(canDropTargetDir([src], target), `${src}→${target}`)
          .toBe(preFixCanDropTargetDir([src], target))
      }
    }
  })
})
```

实测：`✓ src/utils/zz3-drop-matrix.test.ts (2 tests)`；第一例的 diffs 精确等于全部根级源（`a.txt`、`src`、`docs`——`src/sub`、`docs/a.md` 等父目录非根，不在 diff 集内），第二例 48 个非空落点组合（8 源 × 6 非空落点）逐一相等。

### B-4 `desktop/src/composables/zz3-o3-truncated.test.ts`（3 通过）——O3 修复

驱动真实 `useFileManager`，桩 provider 返回不同 `truncated`/条数组合（fake timers 推进 300ms 防抖）。

```ts
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryResult, WorkspaceFileProvider } from './workspace-file-provider'
import type { FileNode } from '../types/file-browser'
import { useFileManager } from './useFileManager'
import { SEARCH_RESULT_LIMIT } from '../utils/file-manager'

const localStorageStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => localStorageStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStorageStore.set(k, v),
  removeItem: (k: string) => void localStorageStore.delete(k),
  clear: () => void localStorageStore.clear(),
})

function node(name: string, path: string): FileNode {
  return { name, path, isDirectory: false, size: 0 }
}

function makeSearchProvider(result: { entries: FileNode[]; truncated?: boolean }): WorkspaceFileProvider {
  return {
    async listDirectory(): Promise<DirectoryResult> { return { entries: [] } },
    searchFiles: async () => result,
  } as unknown as WorkspaceFileProvider
}

async function searchAndReadTruncated(result: { entries: FileNode[]; truncated?: boolean }): Promise<boolean> {
  vi.useFakeTimers()
  try {
    const provider = ref(makeSearchProvider(result))
    const fm = useFileManager(provider, ref('42'))
    await vi.advanceTimersByTimeAsync(0)
    fm.searchQuery.value = 'a'
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()
    return fm.searchTruncated.value
  } finally {
    vi.useRealTimers()
  }
}

beforeEach(() => localStorageStore.clear())
afterEach(() => vi.useRealTimers())

describe('O3 修复：searchTruncated 以后端标志为准', () => {
  it('truncated=true 且条数远低于上限 → 显示截断提示（旧实现按条数会漏报）', async () => {
    const entries = [node('a.txt', 'a.txt'), node('b.txt', 'b.txt'), node('c.txt', 'c.txt')]
    expect(await searchAndReadTruncated({ entries, truncated: true })).toBe(true)
  })

  it('truncated=false 且条数恰好等于上限 → 不显示截断提示（旧实现会误报）', async () => {
    const entries = Array.from({ length: SEARCH_RESULT_LIMIT }, (_, i) => node(`f${i}.txt`, `f${i}.txt`))
    expect(await searchAndReadTruncated({ entries, truncated: false })).toBe(false)
  })

  it('后端未返回 truncated 时回退按条数判断（老 provider 兼容）', async () => {
    const full = Array.from({ length: SEARCH_RESULT_LIMIT }, (_, i) => node(`f${i}.txt`, `f${i}.txt`))
    const partial = [node('a.txt', 'a.txt')]
    expect(await searchAndReadTruncated({ entries: full })).toBe(true)
    expect(await searchAndReadTruncated({ entries: partial })).toBe(false)
  })
})
```

实测：`✓ src/composables/zz3-o3-truncated.test.ts (3 tests)`。

### B-5 `desktop/src/utils/zz3-tab-accounting.test.ts`（5 通过）——Q3 记账

```ts
import { describe, expect, it } from 'vitest'
import { retargetTabPath } from './workspace-tab-paths'

describe('根目录移动的 paths-changed 记账', () => {
  it('文件从子目录移到根：打开的页签重定向到根下干净路径', () => {
    const change = { kind: 'move' as const, from: 'docs/a.txt', to: 'a.txt' }
    expect(retargetTabPath('docs/a.txt', change)).toEqual({ action: 'retarget', path: 'a.txt' })
  })

  it('深层文件移到根：同样只改到 basename', () => {
    const change = { kind: 'move' as const, from: 'a/b/c.txt', to: 'c.txt' }
    expect(retargetTabPath('a/b/c.txt', change)).toEqual({ action: 'retarget', path: 'c.txt' })
  })

  it('目录移动（非根落点）：子孙页签整体改挂', () => {
    const change = { kind: 'move' as const, from: 'a/docs', to: 'b/docs' }
    expect(retargetTabPath('a/docs/x.txt', change)).toEqual({ action: 'retarget', path: 'b/docs/x.txt' })
  })

  it('移到子目录：页签跟到子目录下', () => {
    const change = { kind: 'move' as const, from: 'a.txt', to: 'src/a.txt' }
    expect(retargetTabPath('a.txt', change)).toEqual({ action: 'retarget', path: 'src/a.txt' })
  })

  it('无关页签不受影响', () => {
    const change = { kind: 'move' as const, from: 'docs/a.txt', to: 'a.txt' }
    expect(retargetTabPath('src/main.ts', change)).toEqual({ action: 'keep' })
  })
})
```

实测：`✓ src/utils/zz3-tab-accounting.test.ts (5 tests)`。

### B-6 `backend-ts/src/file/zz3-root-dest.spec.ts`（5 通过）——后端契约

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

describe('move/copy 落点为根目录（.）', () => {
  function setup() {
    const root = useTmpDir('mao-ws-rootdest-');
    const sandbox = new PathSandbox(root);
    const workspace = join(root, 'user', 'sess');
    mkdirSync(join(workspace, 'docs', 'sub'), { recursive: true });
    writeFileSync(join(workspace, 'docs', 'a.txt'), 'x');
    writeFileSync(join(workspace, 'docs', 'sub', 'deep.txt'), 'x');
    const activity = { record: vi.fn(async () => ({ id: 1 })) } as unknown as ActivityService;
    return { service: new WorkspaceWriteService(sandbox, activity), workspace };
  }

  it('move 文件到 "."：返回 basename（记账用干净相对路径）', async () => {
    const { service, workspace } = setup();
    const result = await service.move(1, workspace, 'docs/a.txt', '.');
    expect(result.path).toBe('a.txt');
  });

  it('copy 文件到 "."：同样返回 basename', async () => {
    const { service, workspace } = setup();
    const result = await service.copy(1, workspace, 'docs/a.txt', '.');
    expect(result.path).toBe('a.txt');
  });

  it('move 目录到 "."：返回该目录名', async () => {
    const { service, workspace } = setup();
    const result = await service.move(1, workspace, 'docs/sub', '.');
    expect(result.path).toBe('sub');
  });

  it('根目录同目录移动（源本就在根下）抛「不能移动到自身」', async () => {
    const { service, workspace } = setup();
    writeFileSync(join(workspace, 'root.txt'), 'x');
    const e = await service.move(1, workspace, 'root.txt', '.').catch((err) => err);
    expect(e).toBeInstanceOf(BusinessException);
    expect((e as Error).message).toBe('不能移动到自身');
  });

  it('空串落点仍抛 PARAM_INVALID（面板必须归一化的契约依据）', async () => {
    const { service, workspace } = setup();
    const e = await service.move(1, workspace, 'docs/a.txt', '').catch((err) => err);
    expect(e).toBeInstanceOf(BusinessException);
    expect((e as BusinessException).code).toBe(ErrorCode.PARAM_INVALID.code);
    expect((e as Error).message).toBe('Path cannot be empty');
  });
});
```

实测：`✓ src/file/zz3-root-dest.spec.ts (5 tests)`。

## 附录 C：基线与探针运行方式

```bash
cd /Users/yangjiayi/AiProjects/mao/.worktrees/file-manager-tab/desktop
npx vitest run src/composables/zz3-fix7-paste.test.ts     # BUG-7：4 通过
npx vitest run src/composables/zz3-fix8-drop.test.ts      # BUG-8：7 通过
npx vitest run src/utils/zz3-drop-matrix.test.ts          # 差分：2 通过
npx vitest run src/composables/zz3-o3-truncated.test.ts   # O3：3 通过
npx vitest run src/utils/zz3-tab-accounting.test.ts       # Q3 记账：5 通过
cd ../backend-ts && npx vitest run src/file/zz3-root-dest.spec.ts  # 后端契约：5 通过
```

- 探针在位时 desktop 全量：63 文件 / 544 用例全通过；移除后 58 文件 / 523 用例全通过（与修复方自报一致）。
- `backend-ts npx vitest run src/file`：6 文件 / 67 用例通过（含 O2 更新后的 symlink 断言）。
- `desktop npm run build`（`vue-tsc -b && vite build`）：通过（日志仅余既有的 INEFFECTIVE_DYNAMIC_IMPORT 提示）。
- 所有探针验证后已从仓库移除，源码零改动（`git status` 仅剩本功能原有未提交项、前两轮报告与本报告）。
