# 代码评审报告（round3）：桌面端工作区文件预览能力扩展（feat/workspace-file-preview）

- 日期：2026-10-26
- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/file-preview` 分支 `feat/workspace-file-preview` 的未提交改动
- 技术方案：`docs/plan/2026-10-26-workspace-file-preview-technical-design.md`
- 本轮定位：约定轮次的**最后一轮核验**。核验 round2 两个问题的修复是否真正解决问题、是否引入新问题；确认未破坏 round1 五处修复；若发现重大问题才继续。
- 方法：逐行读透 `FileViewer.vue` 计数器 / watch / 防抖 / 刷新回调全部路径；对问题 1 的三条关键路径各写临时复现用例实际运行（vitest，跑通即删、`git status` 确认仓库干净）；grep 核验 round1 五处修复标记；跑全量 `vitest run` + `node --test`。
- 基线：`npx vitest run` **121 文件 1157 用例全绿**；`node --test 'electron/*.test.cjs'` 124 例 2 失败（均为环境失败，见文末，与本次特性无关）。

---

## 严重度汇总

| # | 端 | 问题 | 类别 | 严重程度 | 位置 | 是否本次引入 |
|---|:---:|------|------|:---:|------|:---:|
| — | — | **本轮未发现新问题**（round2 两个问题修复均核验通过，未引入回归） | — | — | — | — |

---

## 一、round2 问题 1（PDF 竞态）修复核验 —— 通过，竞态真正消除

### 修复形态（已确认）
- `pdfPreviewSeq` **彻底移除**：`grep -rn pdfPreviewSeq` 仅命中 `FileViewer.vue:228-229` 的解释性注释（说明修复缘由），无任何代码引用。
- 统一为单一计数器：`FileViewer.vue:232` `let loadFileSeq = 0`；`:234-236` `isStaleLoad(seq) = seq !== loadFileSeq`。
- `loadPdfPreview(seq)`（`:238`，守卫 `:245`）与 `loadBinaryPreview(seq, target)`（`:262`，守卫 `:270`）均**从 `loadFile` 接收 seq**，不再各自自增。
- `loadFile` 内**单一自增点** `:293 const seq = ++loadFileSeq`，随后三处异步续跑分别传 seq：`:303 loadPdfPreview(seq)`、`:312 loadBinaryPreview(seq, kind)`、`:346 loadBinaryPreview(seq, sniffed)`；readFile 续跑 `:317`、catch `:362` 均 `isStaleLoad(seq)` 守卫。

### 为何能真正消除竞态（关键不变量）
`loadFileSeq` 是**单一单调计数器**，每次 `loadFile` 恰好 `++` 一次，seq 严格递增且唯一。一次异步续跑（迟到的 `previewFile`）要被接受，必须 `seq === loadFileSeq`；而任何一次新的 `loadFile` 都会让 `loadFileSeq` 严格超过旧 seq，使旧续跑**必然**被 `isStaleLoad` 判陈旧拒绝。因此**只要切换/重载目标都经 `loadFile`，迟到的 PDF 绝无可能覆盖新状态**。

已核实**所有** `loadFile` 触发点都走 `++loadFileSeq`：
- `onMounted(loadFile)`（`:368`）
- `watch(() => [props.filePath, props.provider])`（`:372-380`）→ 路径切换 / **provider 变化**，均 `loadFile`
- `watch({path, count: matchingChangeCount})`（`:384-395`）→ 文件外部变更，防抖 300ms 后 `loadFile`
- 顶部刷新按钮 `@click="loadFile"`（`:93`）、重试按钮（`:6`）
- 五个子组件 `@refresh="loadFile"`（`:32,:43,:53,:63,:73`）

### 四条指定路径逐条结论
用户点名的四条路径，我除读代码外，还写了 3 个临时用例实跑（`__round3_tmp.test.ts`，跑通已删）：

1. **PDF 为源切到任何目标**：目标态（zip/xlsx/docx/media/csv/md/txt/image/binary）**全部**经 `loadFile` → `++seq`，旧 PDF 的 seq 立即变陈旧被拒。临时用例 **C：pdf→media**（迟到的 `previewFile` resolve 后 `pdfProps=0`、`mediaProps` 落地 `clip.mp4`）实测通过。仓库既有回归 `FileViewer.dispatch.test.ts:620-657`「PDF 迟到时已切到 zip」同样通过。目标态无关性由机制保证，无需逐目标枚举。
2. **连点刷新**：**结构上被阻止**——任何 `loadFile` 一启动即 `state='loading'`（`:294`）且 `bytesData=null`（`:297`），顶部刷新按钮（仅 `ready` 态渲染，`:88`）与子组件刷新按钮（父组件 v-else-if 需 `bytesData` 真值，如 `:37`）都会**立即卸载**，第二次点击在加载完成前无按钮可点。即便出现两次 `loadFile` 重叠（如防抖+手动），seq 守卫依旧只放行最后一次。
3. **changeDebounce 触发的重载**（`:384-395`）：`setTimeout` 前有 `clearTimeout`，300ms 内的多次 count 变化**合并为一次** `loadFile`；触发时 `++seq`，在途旧 PDF 被拒、新 PDF 落地。与场景 A 同一机制。
4. **provider 变化触发的重载**（`:372-380`）：临时用例 **B：PDF 在途时 `providerRef` 切换**——旧 provider 的 `previewFile` 迟到 resolve 被拒（`isStaleLoad`），新 provider 的 `previewFile` 落地，`pdfProps` 长度为 1 且为当前文件。实测通过。

### 合并计数器是否引入新问题（用户特别关注「PDF 自身重载被误判过期」）—— 无
- **无误判**：最新一次 `loadFile` 的 seq 恒等于 `loadFileSeq`，其续跑**必被接受**；只有**严格更晚**的 `loadFile` 才会把旧 seq 判陈旧——而那正意味着有更新的加载在途，拒绝旧的是正确行为。临时用例 **A：pdf→pdf**（切到 `b.pdf` 后旧 `a.pdf` 迟到被拒、新 `b.pdf` 落地，`pdfProps=[b.pdf]`）实测通过，直接证明「PDF 自身重载不误判」。
- **计数器作用域安全**：`loadFileSeq` 在 `<script setup>` 内声明，**每实例独立**（KeepAlive 复用时保留、新标签页从 0 开始），无跨标签页计数器污染。
- **blob 生命周期反而更稳**：迟到的旧 PDF 在 `:245` 就被 `isStaleLoad` 拒绝，**够不到** `:256` 的 `releasePdfBlobUrl()`，因此绝不会误 revoke 新 PDF 的 blob URL（旧实现守卫失效时这会是个次生 bug）。
- **卸载后防抖不误触发**：`onUnmounted`（`:397-403`）清除 `changeDebounceTimer`。

**结论：问题 1 修复正确、彻底，竞态真正消除，未引入新问题。**

---

## 二、round2 问题 2（刷新按钮）修复核验 —— 通过，符合 §5.8 / §6-A3

### 修复形态（已确认）
- 三个组件刷新按钮均改为 `@click="$emit('refresh')"`：`ArchiveBrowser.vue:7`、`SpreadsheetView.vue:7`、`DocxPreview.vue:6`；`CsvTableView.vue:7`、`MediaPlayer.vue:11` 本就是 emit（一致）。
- 本地 `reload()` 函数**全部删除**：`grep -rn reload` 在 center 目录仅剩 `RunTracePanel.vue`（既有无关组件）、`FileViewer.vue:373`（注释）、`MediaPlayer.vue` 的 `preload="metadata"`（HTML 属性误匹配）——三个修复组件无任何 reload 残留。
- `defineEmits<{ refresh: [] }>()` 从死代码变为被使用：`ArchiveBrowser.vue:112`、`SpreadsheetView.vue:86`、`DocxPreview.vue:51`。
- `FileViewer` 侧五处 `@refresh="loadFile"`（`:32,:43,:53,:63,:73`）接线完整。
- 三个新回归均断言「emit 生效 + 本地重解析计数不增」：`ArchiveBrowser.test.ts:330-362`（error 态点刷新仍 emit）、`SpreadsheetView.test.ts:360-394`（`excelState.loadArgs` 恒为 1）、`DocxPreview.test.ts:278-311`（`mammothState.args` 恒为 1）。

### 用户三个子问逐一回答

**（1）`watch(props.bytes)` 是否变成新的死代码？—— 不是新的，本就是死代码，且无害。**
- 三处 watch 仍在：`ArchiveBrowser.vue:284`、`SpreadsheetView.vue:158`、`DocxPreview.vue:121`（round2 观察 #2 已记录，本次未改动）。
- 死因：`FileViewer.loadFile` 每次先 `bytesData=null`（`:297`，子组件卸载）再在 `loadBinaryPreview` 造新对象（`:281`，子组件**重挂**）。子组件只在 `bytesData` 真值时存在（如 `:37` `state==='zip' && bytesData`），旧实例在 `null` 时已卸载、其 watch 随之销毁；新实例挂载即拿到新 bytes、之后不再变化。故同一实例上 `props.bytes` 永不「变更」，watch 永不触发。
- **无害**：重载实际由重挂后的 `onMounted` 完成（三者均有：`ArchiveBrowser:291`、`SpreadsheetView:165`、`DocxPreview:128`），功能不缺；watch 不触发也意味着**不会**与 `onMounted` 双加载。
- **一处措辞问题（非 bug）**：watch 上方注释写着「FileViewer 刷新会造新 bytes 对象：watch 到即重走加载（§6-A3）」（`ArchiveBrowser.vue:283`、`SpreadsheetView.vue:157`、`DocxPreview.vue:120`、`MediaPlayer.vue:161`），描述的是设计意图，但实际重载走的是「重挂 + onMounted」而非 watch。该注释**先于本次修复存在**，非本次引入；建议后续把注释改准（属清理，不影响合入）。

**（2）卸载重挂期间的 loading 体验 —— 正常，无空白闪烁。**
- `FileViewer` 根 div 有 `v-loading="state === 'loading'"`（`:2`）。刷新 → `loadFile` → `state='loading'` + `bytesData=null`：子组件卸载，全局 loading 遮罩覆盖「重新取字节」阶段；字节就位后子组件重挂，各自进入自身 loading（如 `ArchiveBrowser.vue:20`）→ 解析 → ready。两段 loading 连续可感知，体验可接受。

**（3）`onDeactivated` 等生命周期是否受影响 —— 未受影响（本次未触碰生命周期）。**
- 三修复组件均无 `onDeactivated/onActivated`（既有状况）：`ArchiveBrowser` 有 `onMounted+onUnmounted`（`:291,:296`，卸载释放 previewUrl）；`SpreadsheetView/DocxPreview` 仅 `onMounted`。
- 后果评估：KeepAlive 切标签页是**停用**而非卸载，`ArchiveBrowser` 的 preview blob 在停用期间不释放，但**同时最多持有 1 个**条目预览、换条目即先 revoke 再建（`openEntry`）、停用归还或超 20 标签页淘汰时 `onUnmounted` 释放——有界，无泄漏。`SpreadsheetView/DocxPreview` 不产 blob URL，无此虑。`MediaPlayer` 显式处理 `onDeactivated`（停用即暂停+释放），不受问题 2 影响。此为**既有**行为，非本次引入。

**结论：问题 2 修复符合 §5.8 / §6-A3，emit 无遗漏，未引入新问题。**

---

## 三、round1 五处修复未被破坏 —— 确认完好

逐条 grep 核验关键标记均在位：
1. **sniff 排在 binary 之前**：`FileViewer.vue:344` `sniffContainerKind` 早于 `:351` `isBinaryContent`。✓
2. **entryError 状态机**：`ArchiveBrowser.vue:131` ref、`:37-38` 行内横幅、清空于 `loadArchive:150`/`openEntry:194`/`closePreview:276`、写错误于 `:223`。✓
3. **check-main-chunk 字面量**：`check-main-chunk.mjs:23-32` FORBIDDEN 五条齐全（`sequenceDiagram`/`katex-mathml`/`Can't find end of central directory`/`Corrupted zip : CRC32 mismatch`/`cannot open linked files from a web browser`）。✓
4. **MediaPlayer 编解码标注 + 失败兜底**：`MediaPlayer.vue:99` `codecHint` computed、`:8` ready 态常驻、`:154-159` `onMediaError` 落 error + 下载/Finder + 释放 blob、`:46,:55` `@error` 绑定。✓
5. **useShowInFinder 接线**：`ArchiveBrowser/MediaPlayer/DocxPreview/SpreadsheetView` 四个字节类组件均 import 并用于降级/拒绝态「在 Finder 中显示」按钮；`useShowInFinder.test.ts` 5 例全绿。✓

---

## 四、非 bug 观察（不阻塞合入）

1. `watch(props.bytes)` 为死代码且注释描述与实际机制不符（走 onMounted 重挂而非 watch）——既有、无害，建议后续清理注释（见二(1)）。
2. `ArchiveBrowser` 无 `onDeactivated`，切标签页停用期间 preview blob 延迟到关闭/淘汰才释放——有界、既有、近零影响（见二(3)）。
3. 刷新按钮在加载中即卸载，从 UI 层结构性阻止「连点刷新」重叠——这是**正向**特性，与 seq 守卫构成双保险（见一·2）。

---

## 五、测试基线

- `npx vitest run`：**121 文件 / 1157 用例全部通过**（含本轮新增的 PDF 竞态回归 `FileViewer.dispatch.test.ts:620-657` 与三组件刷新回归）。
- `node --test 'electron/*.test.cjs'`：124 例，121 通过、**2 失败均为环境问题、与文件预览特性无关**：
  - `gitOperations.test.cjs:211`——期望 git 身份 `Mao Agent <mao@etarch.cn>`，本机全局 git 身份为 `yangjiayi <yangjiayi@accesscorporate.com.cn>`；
  - `localShell.test.cjs:65`——macOS `/var`→`/private/var` 符号链接导致路径字符串不一致。
- 本轮 3 个临时核验用例（pdf→pdf / provider 变化 / pdf→media）跑通后**已删除**，`git status` 确认仓库干净（仅剩特性文件与 round1/round2/round3 三份 review 报告）。

---

## 六、总体结论

**无重大问题，可合入。**

- round2 问题 1（PDF 竞态）：修复正确且彻底——单一 `loadFileSeq` 计数器、所有重载路径统一 `++seq`、seq 严格递增唯一，迟到的 `previewFile` 在四条指定路径（切任意目标 / 连点刷新 / changeDebounce / provider 变化）下均被 `isStaleLoad` 拒绝，实测三场景 + 仓库回归全过；合并计数器未引入「PDF 自身重载误判过期」，反而顺带修复了旧实现下迟到 PDF 可能误 revoke 新 blob URL 的次生风险。
- round2 问题 2（刷新按钮 emit）：修复符合 §5.8 / §6-A3，三组件 `reload()` 删除干净、emit 无遗漏、回归断言充分；`watch(props.bytes)` 是**既有**死代码而非本次新增，无害；卸载重挂 loading 体验正常；生命周期未受影响。
- round1 五处修复全部完好，未被破坏。
