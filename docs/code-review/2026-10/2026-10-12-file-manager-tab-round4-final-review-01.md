# 「文件管理」页签第四轮终审（2026-10-12 · 第四轮）

- **日期**：2026-10-12
- **基线**：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/file-manager-tab`（分支 `feature/file-manager-tab`，HEAD `42429edf`），第三轮报告 `2026-10-12-file-manager-tab-round3-fix-review-01.md` 之后的修复版未提交代码。行号以本轮审查时源码实测核对。
- **范围**：经 mtime 核对，本轮改动精确限于两个文件——`desktop/src/composables/useFileManager.ts`（顶部注释，13:32）与 `desktop/src/components/file-browser/FileManagerPanel.vue`（`handlePaste` cut 同目录过滤，13:32）。其余文件均停留在前三轮的时间戳。为回答「通读最终版 diff、确认无回退」，本轮对 `FileManagerPanel.vue` 全脚本段（L200-650）与 `useFileManager.ts` 全文做了完整通读。
- **方法**：与前三轮相同——面板处理器无法在无 DOM 环境挂载，探针复刻面板精确表达式（带行号引用）并驱动真实 composable / 纯函数；后端契约用真实 service 实例验证。

## 最终结论

> **无重大 bug，可以合并。**

本轮两处改动均正确：cut 同目录过滤语义完整（含混合多选、dedupe 交互、导航后原地粘贴等边界），注释改写后三处叙述一致，最终版 diff 通读未发现前三轮修复的回退或新引入的问题。仅余 1 条低优先级观察项（`handlePaste` 中 copy 同目录的注释与后端真实契约不符，行为本身无回归、不影响合并）。

---

## 一、本轮改动验证结论表

| 项 | 结论 | 验证探针（实测） |
| --- | --- | --- |
| O5 注释收尾 | ✅ 正确且三处一致。新注释（`useFileManager.ts:31-33`）准确描述「key 带会话 id → 切会话换新实例；同会话内 provider 被替换 → 实例复用、watch 负责整体重置」，与 `CenterTabContainer.vue:36-39` 的 key 实现和 L282-299 的 `watch([provider, sessionId])` 重置逻辑逐一对应 | 代码走查（注释项无可测行为） |
| handlePaste cut 同目录过滤 | ✅ 正确。混合多选只搬不同目录项并清剪贴板；全部同目录时清剪贴板直接返回、不发请求、不刷新；copy 不过滤；根目录落点仍 `'.'` | `zz4-paste-cut-filter` 9 通过 |
| 前三轮修复无回退 | ✅ `moveSourcesTo`/`onBodyDrop`/`onFolderDrop` 的 dest 归一化与同目录预检、`handlePaste` 的 FIX-6 剪贴板语义、根目录 `'.'` 落点，在最终版中全部保持修复后形态 | `zz4-move-noregress` 4 通过 |
| copy 同目录的后端契约 | ⚠️ 注释与契约不符（观察项 O-1）：copy 到源所在目录并非「走 3045 覆盖询问」，而是 `place()` same-rel 硬拒绝 `PARAM_INVALID「不能复制到自身」`；真正触发 3045 的是跨目录复制遇同名目标。行为与前三轮一致（无回归） | `zz4-copy-same-dir` 4 通过 |

## 二、三个重点复核点的回答

### 1. cut 同目录过滤：混合多选是否处理错？全部滤掉时直接 return 是否合理？

**答：混合场景处理正确；全部滤掉时直接 return 合理。**

- **混合多选**（`zz4-paste-cut-filter` 第 2、3 例）：根目录剪贴板 `['a.txt', 'docs/b.md']` 粘贴 → 过滤后 `targets = ['docs/b.md']`，只搬不同目录的那一个（`moveWorkspacePath(42, 'docs/b.md', '.')`，paths-changed 记 `to: 'b.md'`），随后 `clipboard.clear()`——与预期的「只搬不同目录的几个、剪贴板清空」完全一致。子目录 `['src/a.ts', 'docs/b.md']` 粘到 `src` 同理，只搬 `docs/b.md`。
- **全部同目录**（第 1、4、7 例）：不发任何请求、`clipboard.clear()` 后直接 return。合理性：(a) 磁盘无任何变更，`emit('tree-refresh')` 与 `refresh()` 都不必要；(b) 状态栏「剪贴板 N 项」是 `clipboard.current` 的 computed，清剪贴板后自动更新，不依赖刷新；(c) 避免了修复前「每个同目录项挨个打后端撞『不能移动到自身』、逐个弹错误 toast」的最差路径。第 7 例还覆盖了「剪切后导航进源所在目录再粘贴」的边界（过滤为空、无请求）。
- **与 dedupe 的交互**（第 4 例）：`['docs', 'docs/x.txt']` 先 dedupe 成 `['docs']` 再过滤，同样安全返回。
- **copy 不过滤**（第 8、9 例）：copy 同目录原样提交 `copyWorkspacePath(42, 'a.txt', '.')`，剪贴板不清空——就地复制诉求放行（其后端结果见观察项 O-1）。

### 2. 注释改写后三处叙述是否一致？

**答：一致。** 三处逐一对应：

| 位置 | 叙述 | 实际行为 |
| --- | --- | --- |
| `useFileManager.ts:31-33`（新注释） | 「key 带会话 id（切会话即换新实例）」 | `CenterTabContainer.vue:39` key = `` `file-manager-${props.sessionId}` ``，sessionId 变则 key 变，KeepAlive 卸载旧实例、挂新实例 ✓ |
| 同上 | 「同会话内 provider 被替换（如重新建连）时实例仍被复用，此时 watch 负责整体重置」 | key 不变则实例复用；`watch([provider, sessionId])`（L282-299，`immediate: true`）在 provider 变更时清空 history/future/currentDir/selection/search/draft 并 `loadDir('')` ✓ |
| 同上 | 「不能残留上一个会话的目录与选择」 | 正是该 watch 的职责；sessionId 变化路径上虽由换实例兜底，watch 的 sessionId 依赖属双保险，注释未过度声明 ✓ |

`CenterTabContainer.vue:36` 的既有注释（「key 带会话 id：KeepAlive 下同 id 分支会跨会话复用实例，按会话分 key 让切换会话即换新面板」）与新注释亦互相印证，无矛盾。

### 3. 通读最终版未提交 diff：有无前三轮修复的回退或新引入的问题？

**答：无回退、无新问题。** 全脚本段通读核验清单：

| 修复点 | 最终版状态 |
| --- | --- |
| BUG-7：handlePaste 落点 `currentDir.value \|\| '.'` | ✅ L402-403 原样在（`destDir`/`dest` 双变量正是本轮过滤所需） |
| FIX-6：cut 全部成功才清剪贴板、中途失败保留 | ✅ L421 在（本轮新增的 L407-410 早退分支只可能 targets 为空，此时清剪贴板同样正确） |
| BUG-8：moveSourcesTo 预检用 `dir` 原值、落点 `dir \|\| '.'` | ✅ L439-444 原样在 |
| BUG-8 第二半：canDropTargetDir 同目录拒绝 | ✅ `file-manager.ts:96-97` 未动（该文件 mtime 仍为第三轮的 13:18） |
| 上传落点归一化 | ✅ `pickUpload`/`onPickFiles`/`handleFiles` → `sendUpload` L197 `dir \|\| '.'` 链完整 |
| commitCreate/commitRename/handleDelete 参数 | ✅ `joinRel(draft.dir, name)`、条目 path，均非空 |
| ctxTargetDir / openContextMenu 选区校正 / gitHint / Esc 清空搜索 | ✅ 全部原样在 |
| useFileManager 的 searchSeq/listSeq 竞态防护、navigateTo cancelDraft、O3 truncated | ✅ 全部原样在（该文件本轮仅注释变化，L282-299 watcher 与 L262-263 truncated 逻辑未动） |
| 快捷键 Ctrl+A/C/X/V、Escape、Enter、F2、Delete | ✅ 原样在 |

## 三、观察项（未计 BUG，不影响合并）

- O-1（低）：`FileManagerPanel.vue:404-405` 注释称「copy 到同目录是合法的『就地复制』诉求（走 3045 覆盖询问）」，与后端真实契约不符——`zz4-copy-same-dir` 探针证实 copy 到源所在目录走的是 `place()` same-rel 硬拒绝（`PARAM_INVALID「不能复制到自身」`，不弹覆盖询问）；3045 只属于「跨目录复制且目标已存在同名文件」的场景。该行为自前三轮起一直如此（copy 从未被过滤），**无回归**，仅注释不准。建议后续把注释改为「copy 到同目录会被后端以『不能复制到自身』拒绝」或对 copy 同目录做与 cut 一致的静默过滤；不阻塞合并。

## 附录 A：排查后确认不构成 BUG 的候选（本轮）

| 候选 | 结论 |
| --- | --- |
| cut 过滤把同目录项从剪贴板丢弃（清空而非保留） | 符合本轮既定语义（修复方说明「全部滤掉则清剪贴板并返回」）；保留反而会在后续粘贴时把「搬不动」的项继续暴露给用户 |
| 全部滤掉时不 emit tree-refresh | 磁盘无变更，无须刷新；状态栏剪贴板计数响应式自更新 |
| copy 同目录不过滤 | 放行就地复制诉求；后端拒绝属既有契约（O-1），非本轮引入 |
| watcher 的 sessionId 依赖在 key 变化时是否死代码 | 双保险（同实例观察到 sessionId 变化的兜底路径），无害 |
| 注释项是否可测 | 注释无可测行为，按代码走查核验 |
| 其余文件是否需重审 | mtime 核对确认本轮仅两个文件变动，其余为前三轮已审内容 |

## 附录 B：探针代码与实测输出（17 条全部通过，验证后已移除）

### B-1 `desktop/src/composables/zz4-paste-cut-filter.test.ts`（9 通过）——cut 过滤

复刻 `handlePaste`（L393-427），驱动真实 `useFileClipboard`/`dedupeMoveSources`/`parentDirOf`；`treeRefreshes`/`refreshes` 计数对应 `emit('tree-refresh')` 与 `await refresh()`。

```ts
import { describe, expect, it, vi } from 'vitest'
import { useFileClipboard } from './useFileClipboard'
import { dedupeMoveSources, parentDirOf } from '../utils/file-manager'

interface Change { kind: 'move'; from: string; to: string }

function backendLikeResult(src: string, dest: string): { path: string } {
  const base = src.split('/').pop() ?? src
  return { path: dest === '.' ? base : `${dest}/${base}` }
}

interface PasteOutcome {
  moveCalls: Array<[string, string]>
  copyCalls: Array<[string, string]>
  changes: Change[]
  treeRefreshes: number
  refreshes: number
}

/** 复刻 FileManagerPanel.vue L393-427 的 handlePaste */
function runPaste(
  clipboard: ReturnType<typeof useFileClipboard>,
  currentDir: string,
  moveWorkspacePath: (from: string, to: string) => Promise<{ path: string }> = async (from, to) =>
    backendLikeResult(from, to),
  copyWorkspacePath: (from: string, to: string) => Promise<{ path: string }> = async (from, to) =>
    backendLikeResult(from, to),
): PasteOutcome & { done: Promise<void> } {
  const out: PasteOutcome = { moveCalls: [], copyCalls: [], changes: [], treeRefreshes: 0, refreshes: 0 }
  const clip = clipboard.current!
  const sources = dedupeMoveSources(clip.paths)
  const destDir = currentDir // ← 与 L402 一致（未归一化）
  const dest = destDir || '.' // ← 与 L403 一致
  const targets = clip.op === 'cut' ? sources.filter((src) => parentDirOf(src) !== destDir) : sources // ← 与 L406 一致
  const done = (async () => {
    if (targets.length === 0) {
      if (clip.op === 'cut') clipboard.clear() // ← 与 L408 一致
      return // ← 与 L409 一致：不 emit tree-refresh、不 refresh
    }
    try {
      for (const src of targets) {
        if (clip.op === 'cut') {
          const result = await moveWorkspacePath(src, dest)
          out.moveCalls.push([src, dest])
          out.changes.push({ kind: 'move', from: src, to: result.path })
        } else {
          await copyWorkspacePath(src, dest)
          out.copyCalls.push([src, dest])
        }
      }
      if (clip.op === 'cut') clipboard.clear()
    } catch {
      // 冲突面板与全局 toast 已提示
    }
    out.treeRefreshes++ // emit('tree-refresh')
    out.refreshes++ // await refresh()
  })()
  return Object.assign(out, { done })
}

describe('第四轮：handlePaste cut 同目录过滤', () => {
  it('根目录 cut 全部同目录：不发请求、清剪贴板、不刷新', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['a.txt'])
    const out = runPaste(clipboard, '')
    await out.done
    expect(out.moveCalls).toEqual([])
    expect(out.changes).toEqual([])
    expect(out.treeRefreshes).toBe(0)
    expect(out.refreshes).toBe(0)
    expect(clipboard.current).toBeNull()
  })

  it('根目录 cut 混合多选：只搬不同目录的项，剪贴板清空', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['a.txt', 'docs/b.md'])
    const out = runPaste(clipboard, '')
    await out.done
    expect(out.moveCalls).toEqual([['docs/b.md', '.']])
    expect(out.changes).toEqual([{ kind: 'move', from: 'docs/b.md', to: 'b.md' }])
    expect(out.treeRefreshes).toBe(1)
    expect(out.refreshes).toBe(1)
    expect(clipboard.current).toBeNull()
  })

  it('子目录 cut 混合多选：只搬当前目录外的项', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['src/a.ts', 'docs/b.md'])
    const out = runPaste(clipboard, 'src')
    await out.done
    expect(out.moveCalls).toEqual([['docs/b.md', 'src']])
    expect(out.changes).toEqual([{ kind: 'move', from: 'docs/b.md', to: 'src/b.md' }])
    expect(clipboard.current).toBeNull()
  })

  it('dedupe 后仅剩同目录项：同样安全返回', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['docs', 'docs/x.txt']) // dedupe → ['docs']
    const out = runPaste(clipboard, '')
    await out.done
    expect(out.moveCalls).toEqual([])
    expect(out.treeRefreshes).toBe(0)
    expect(clipboard.current).toBeNull()
  })

  it('根目录 cut 跨目录单项：仍传 "." 并正常搬运（第三轮修复无回退）', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['docs/a.txt'])
    const out = runPaste(clipboard, '')
    await out.done
    expect(out.moveCalls).toEqual([['docs/a.txt', '.']])
    expect(out.changes).toEqual([{ kind: 'move', from: 'docs/a.txt', to: 'a.txt' }])
    expect(clipboard.current).toBeNull()
  })

  it('从根剪切后进入子目录粘贴：跨目录搬运到子目录', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['a.txt'])
    const out = runPaste(clipboard, 'src')
    await out.done
    expect(out.moveCalls).toEqual([['a.txt', 'src']])
    expect(out.changes).toEqual([{ kind: 'move', from: 'a.txt', to: 'src/a.txt' }])
  })

  it('cut 到源所在目录（导航后原地粘贴）：过滤为空，无请求', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('cut', 42, ['docs/a.txt'])
    const out = runPaste(clipboard, 'docs') // 已进入 docs
    await out.done
    expect(out.moveCalls).toEqual([])
    expect(out.treeRefreshes).toBe(0)
    expect(clipboard.current).toBeNull()
  })

  it('copy 同目录不过滤：原样提交（后端契约见 backend 探针）', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('copy', 42, ['a.txt'])
    const out = runPaste(clipboard, '')
    await out.done
    expect(out.copyCalls).toEqual([['a.txt', '.']])
    expect(out.treeRefreshes).toBe(1)
    expect(clipboard.current?.op).toBe('copy')
  })

  it('copy 混合多选同样不过滤', async () => {
    const clipboard = useFileClipboard()
    clipboard.set('copy', 42, ['a.txt', 'docs/b.md'])
    const out = runPaste(clipboard, '')
    await out.done
    expect(out.copyCalls).toEqual([['a.txt', '.'], ['docs/b.md', '.']])
  })
})
```

实测：`✓ src/composables/zz4-paste-cut-filter.test.ts (9 tests)`。

### B-2 `desktop/src/composables/zz4-move-noregress.test.ts`（4 通过）——前三轮修复无回退

复刻 `moveSourcesTo`（L435-455，本轮未改动），驱动真实 `useFileManager` 与真实 `canDropTargetDir`/`canDropTarget`。

```ts
import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
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

function backendLikeResult(src: string, dest: string): { path: string } {
  const base = src.split('/').pop() ?? src
  return { path: dest === '.' ? base : `${dest}/${base}` }
}

function runMoveSourcesTo(
  fm: ReturnType<typeof useFileManager>,
  sources: string[],
  dir: string,
  dirIsCurrent = false,
) {
  const calls: Array<[string, string]> = []
  const movable = sources.filter((src) =>
    dirIsCurrent ? canDropTargetDir([src], dir) : canDropTarget([src], dir, fm.entries.value),
  )
  const dest = dir || '.'
  const done = (async () => {
    for (const src of movable) {
      calls.push([src, dest])
      await backendLikeResult(src, dest)
    }
  })()
  return { movable, calls, done }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('第四轮回退验证：moveSourcesTo / onBodyDrop / onFolderDrop', () => {
  it('根目录空白处拖入外部文件：dest "."（BUG-8 修复仍在）', async () => {
    const provider = ref(makeProvider({ '': [node('a.txt', 'a.txt')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    const { calls, done } = runMoveSourcesTo(fm, ['docs/a.md'], fm.currentDir.value, true)
    await done
    expect(calls).toEqual([['docs/a.md', '.']])
  })

  it('根目录空白处拖根目录自身条目：同目录拒绝（BUG-8 第二半仍在）', async () => {
    const provider = ref(makeProvider({ '': [node('a.txt', 'a.txt')] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    const { movable, calls, done } = runMoveSourcesTo(fm, ['a.txt'], fm.currentDir.value, true)
    await done
    expect(movable).toEqual([])
    expect(calls).toEqual([])
  })

  it('子目录空白处拖入外部文件：dest 子目录原值', async () => {
    const provider = ref(makeProvider({ '': [node('src', 'src', { isDirectory: true })], src: [] }))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    fm.navigateTo('src')
    await flush()
    const { calls, done } = runMoveSourcesTo(fm, ['docs/a.md'], fm.currentDir.value, true)
    await done
    expect(calls).toEqual([['docs/a.md', 'src']])
  })

  it('文件夹格拖放：跨目录合法（onFolderDrop → moveSourcesTo(entry.path)）', async () => {
    const provider = ref(makeProvider({
      '': [node('a.txt', 'a.txt'), node('docs', 'docs', { isDirectory: true })],
    }))
    const fm = useFileManager(provider, ref('42'))
    await flush()
    const { calls, done } = runMoveSourcesTo(fm, ['a.txt'], 'docs', false)
    await done
    expect(calls).toEqual([['a.txt', 'docs']])
  })
})
```

实测：`✓ src/composables/zz4-move-noregress.test.ts (4 tests)`。

### B-3 `backend-ts/src/file/zz4-copy-same-dir.spec.ts`（4 通过）——copy 同目录契约

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

describe('copy 同目录与 3045 的真实契约', () => {
  function setup() {
    const root = useTmpDir('mao-ws-copysame-');
    const sandbox = new PathSandbox(root);
    const workspace = join(root, 'user', 'sess');
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'a.txt'), 'x');
    writeFileSync(join(workspace, 'docs', 'a.txt'), 'x'); // 同名目标，供 3045 场景
    const activity = { record: vi.fn(async () => ({ id: 1 })) } as unknown as ActivityService;
    return { service: new WorkspaceWriteService(sandbox, activity), workspace };
  }

  it('copy 到源所在目录（"."）抛「不能复制到自身」，不是 3045', async () => {
    const { service, workspace } = setup();
    const e = await service.copy(1, workspace, 'a.txt', '.').catch((err) => err);
    expect(e).toBeInstanceOf(BusinessException);
    expect((e as Error).message).toBe('不能复制到自身');
    expect((e as BusinessException).code).toBe(ErrorCode.PARAM_INVALID.code);
    expect((e as BusinessException).code).not.toBe(ErrorCode.WORKSPACE_TARGET_EXISTS.code);
  });

  it('move 到源所在目录（"."）抛「不能移动到自身」', async () => {
    const { service, workspace } = setup();
    const e = await service.move(1, workspace, 'a.txt', '.').catch((err) => err);
    expect(e).toBeInstanceOf(BusinessException);
    expect((e as Error).message).toBe('不能移动到自身');
  });

  it('跨目录 copy 且目标已存在同名文件：抛 3045（覆盖询问的真实来源）', async () => {
    const { service, workspace } = setup();
    const e = await service.copy(1, workspace, 'a.txt', 'docs').catch((err) => err);
    expect(e).toBeInstanceOf(BusinessException);
    expect((e as BusinessException).code).toBe(ErrorCode.WORKSPACE_TARGET_EXISTS.code);
    expect((e as Error).message).toBe('目标已存在');
  });

  it('跨目录 copy 到根（面板 dest "."）：成功并返回 basename', async () => {
    const { service, workspace } = setup();
    writeFileSync(join(workspace, 'docs', 'fresh.txt'), 'x');
    const result = await service.copy(1, workspace, 'docs/fresh.txt', '.');
    expect(result.path).toBe('fresh.txt');
  });
});
```

实测：`✓ src/file/zz4-copy-same-dir.spec.ts (4 tests)`。

## 附录 C：基线与探针运行方式

```bash
cd /Users/yangjiayi/AiProjects/mao/.worktrees/file-manager-tab/desktop
npx vitest run src/composables/zz4-paste-cut-filter.test.ts   # cut 过滤：9 通过
npx vitest run src/composables/zz4-move-noregress.test.ts     # 无回退：4 通过
cd ../backend-ts && npx vitest run src/file/zz4-copy-same-dir.spec.ts  # copy 契约：4 通过
```

- 探针在位时 desktop 全量：60 文件 / 536 用例全通过；移除后 58 文件 / 523 用例全通过（与修复方自报一致）。
- `backend-ts npx vitest run src/file`：6 文件 / 67 用例通过。
- `desktop npm run build`（`vue-tsc -b && vite build`）：通过（仅余既有 INEFFECTIVE_DYNAMIC_IMPORT 提示）。
- 后端源码自第三轮起未再变动（`workspace-write.service.ts` mtime 12:20），第三轮全量 3592 用例通过的结论继续有效。
- 所有探针验证后已从仓库移除，源码零改动（`git status` 仅剩本功能原有未提交项、前三轮报告与本报告）。
