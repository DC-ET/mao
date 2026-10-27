# 代码评审报告（round2）：桌面端工作区文件预览能力扩展（feat/workspace-file-preview 未提交改动）

- 日期：2026-10-26
- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/file-preview` 分支 `feat/workspace-file-preview` 的**全部未提交改动**（git status 清单同 round1）
- 技术方案：`docs/plan/2026-10-26-workspace-file-preview-technical-design.md`
- 审查维度：沿用 round1——只审查功能逻辑（不审文档）；安全（任意文件读取 / XSS / 命令注入）优先；每个 bug 必须补测试自证真实存在；临时复现文件跑通即删、仓库保持干净
- 方法：逐文件通读全部改动源码 + 既有测试；对 round1 五处修复逐条核验；对 2 个新嫌疑点各写临时复现用例实际运行（vitest，全部复现后**已删除，`git status` 确认仓库干净**）；`check-main-chunk` FORBIDDEN 字面量与 jszip / exceljs / mammoth 产物逐字符核对
- 基线：`npx vitest run`（FileViewer.dispatch / ArchiveBrowser / MediaPlayer 三个关键文件）48 例全绿

---

## 严重度汇总

| # | 端 | 问题 | 类别 | 严重程度 | 位置 | 是否本次引入 |
|---|:---:|------|------|:---:|------|:---:|
| 1 | desktop | 从 PDF 切换到其他文件时，迟到的 PDF 预览响应会覆盖新文件状态（代际守卫 `pdfPreviewSeq` 与 `loadFileSeq` 序号碰撞） | 状态错乱 / 陈旧响应守卫失效 | 中 | `FileViewer.vue:242,244,293` | **否（既有）** |
| 2 | desktop | ArchiveBrowser / SpreadsheetView / DocxPreview 的「刷新」按钮重解析同一份内存字节而非 emit 回 FileViewer 重新取字节，`refresh` emit 成死代码，与 CsvTableView / MediaPlayer 不一致，无法刷新到磁盘变更 | 设计符合性 / 功能缺口 | 低 | `ArchiveBrowser.vue:7,112`、`SpreadsheetView.vue:7,86`、`DocxPreview.vue:6,51` | 是 |

---

## 一、round1 五个问题逐条核验结论

五处修复**均已落地且有回归覆盖**，未发现引入新的功能缺陷。逐条：

### 1. sniff 兜底对真实 zip 不可达 —— 已修复
- **证据**：`FileViewer.vue:344-348` sniff 现已排在 `FileViewer.vue:351` 的 `isBinaryContent` **之前**；`file-preview-format.ts:56-58` 注释已如实说明「调用方必须把本函数排在 binary 检查之前」。回归 `FileViewer.dispatch.test.ts:424-442`「sniff 兜底（真实 zip）：STORED 与 DEFLATE 包都能改道字节分支」用真实 jszip 生成两种压缩包、以 `Buffer.from(bytes).toString('utf-8')` 造含 NUL 内容，均断言改道 ArchiveBrowser。
- **是否引入新问题**：sniff 前移后，binary 态的新边界仅为「以 `PK\x03\x04`/`PK\x05\x06`/`PK\x07\x08` 开头但非 zip 的文本」会被送进 ArchiveBrowser 并落 error 态（见「非 bug 观察」4）——真实文本几乎不可能以这些控制字节开头，影响近零。**无新 bug**。

### 2. ArchiveBrowser 条目解压失败无反馈 —— 已修复
- **证据**：`ArchiveBrowser.vue:131` 新增 `entryError` ref；模板 `:37-39` 在 ready 态渲染行内错误横幅（`.archive-entry-error`，不踢出条目列表）；`openEntry` catch `:223` 写 `entryError`，`openEntry` 入口 `:194` / `closePreview` `:276` / `loadArchive` `:150` 三处清空。回归 `ArchiveBrowser.test.ts:336-364`「条目数据损坏：解压抛错时行内横幅可见」用 `buildCorruptedEntryZip` 造中央目录完好、条目数据损坏的包，断言 ready 态出现「条目读取失败」且点正常条目后清除。
- **是否引入新问题**：entryError 状态机已核查无残留（失败时 preview 恒为 null，横幅与覆盖层不共存；成功点击入口即清空）。**无新 bug**。

### 3. check-main-chunk jszip 字面量差一个空格 —— 已修复
- **证据**：`check-main-chunk.mjs:30` 已改为产物实际串 `'Corrupted zip : CRC32 mismatch'`（冒号前有空格），`:33` 补 mammoth 独有串 `'cannot open linked files from a web browser'`。我用脚本逐字符核对：`jszip/dist/jszip.min.js`、`exceljs/dist/exceljs.js`、`exceljs/dist/exceljs.min.js`、`mammoth/mammoth.browser.js` 中该三条字面量**均存在**（FOUND）。exceljs 浏览器包内置同一份 jszip，CRC 串同时覆盖它，注释准确。
- **是否引入新问题**：无。守卫强度符合 §6-C1 预期。

### 4. mp4/mov 编解码标注与播放失败兜底（§6-G2 ★）—— 已修复
- **证据**：`MediaPlayer.vue:99-101` `codecHint` computed（`!tooLarge && isCodecDependent`），模板 `:8` ready 态常驻渲染；`:154-159` `onMediaError` 落 error 态 + 下载/Finder 双出口 + `releaseBlobUrl`；`<video>/<audio>` 均绑 `@error`（`:46,:55`）。`media-format.ts:56-59` `isCodecDependent` 纯函数。回归 `MediaPlayer.test.ts:406-415`（mp4/mov 有标注、webm 无）、`:417-442`（@error → 错误态 + 下载 + 释放 blob）、`:444-464`（LOCAL @error → Finder）。
- **是否引入新问题**：onMediaError 无代际守卫，但 video 元素仅在 ready 态存在、且 FileViewer 按文件 remount，不存在陈旧元素误触。**无新 bug**。

### 5. LOCAL 降级态死路（xlsx/docx 超上限、zip 被拒）—— 已修复
- **证据**：抽出 `useShowInFinder.ts`（`canShowInFinder` + `showInFinder`）；`SpreadsheetView.vue:42`、`DocxPreview.vue:27`、`ArchiveBrowser.vue:28` 降级/拒绝态补 `v-else-if="canShowInFinder"` 的「在 Finder 中显示」按钮；`MediaPlayer.vue:104-107` 复用它（内联实现已删）。回归 `SpreadsheetView.test.ts:301-320`、`DocxPreview.test.ts:240-258`、`ArchiveBrowser.test.ts:246-264` 均断言 LOCAL 形态下点击 Finder 按钮带正确绝对路径调 `showItemInFolder`。
- **是否引入新问题**：核查了 CLOUD 场景——CLOUD provider 恒有 `downloadFile`，三个降级态的 Finder 按钮都是 `v-else-if`，CLOUD 下永远走下载分支，不会出现「对服务器路径调 showItemInFolder」。**无新 bug**（`useShowInFinder` 注释「CLOUD/Web 下自动不可用」措辞不够精确，见「非 bug 观察」3）。

---

## 二、本轮新发现问题

### 1.【既有缺陷，非本次引入】从 PDF 切换到其他文件时，迟到的 PDF 预览响应覆盖新文件状态（中）

- **位置**：`desktop/src/components/center/FileViewer.vue`
  - `:242` `const seq = ++pdfPreviewSeq`（PDF 用**独立计数器**自增）
  - `:244` `if (seq !== pdfPreviewSeq) return`（PDF 陈旧守卫）
  - `:293` `pdfPreviewSeq = loadFileSeq`（`loadFile` 每次把 pdfPreviewSeq **同步回** loadFileSeq）
- **问题描述**：`loadFile` 用一个共享的 `loadFileSeq`（`loadBinaryPreview`/readFile 都靠 `isStaleLoad` 校验它，正确）；但 `loadPdfPreview` 用的是**另一个**计数器 `pdfPreviewSeq`（`:242` 自增），而 `loadFile` 又在每次进入时执行 `pdfPreviewSeq = loadFileSeq`（`:293`）。二者序号会**碰撞**，导致 PDF 的陈旧守卫失效。
- **触发场景 / 时序复现**：
  1. 打开 `a.pdf`：`loadFile` 使 `loadFileSeq=1`、`pdfPreviewSeq=1`；`loadPdfPreview` 执行 `++pdfPreviewSeq` → 捕获 `seq=2`，`await previewFile` 挂起。
  2. 迅速切到 `b.zip`：`loadFile` 使 `loadFileSeq=2`、`pdfPreviewSeq=2`；`loadBinaryPreview(seq=2)` 的 `readFileBytes` 先返回，`state='zip'`、`bytesData` 就位。
  3. 此时**大的** `a.pdf` 的 `previewFile` 才 resolve：`loadPdfPreview` 校验 `seq(2) !== pdfPreviewSeq(2)` → **false**，未判陈旧 → 继续把 `state='pdf'`、`pdfBlobUrl` 覆写回去。
  - 结果：界面停在 `a.pdf` 的 PDF，而选中文件已是 `b.zip`；因 `watch([filePath, provider])` 只在路径**变化**时触发，该错误态会**持久**到用户再次切换/刷新。LOCAL 下 `previewFile` 需读全文件并 base64（大 PDF 慢）、小 zip 的 `readFileBytes` 快，该时序现实可达。
- **根因归属**：`pdfPreviewSeq`/`loadFileSeq`/`isStaleLoad`/`pdfPreviewSeq = loadFileSeq` 四行在 `git show HEAD:...FileViewer.vue`（:168,:170,:182,:184,:209,:210）**均已存在**，属**既有缺陷**。本次改动未引入它，但：① 它落在本轮明确要求 review 的「FileViewer loadFileSeq/pdfPreviewSeq」范畴；② round1「代际守卫……迟到响应不覆盖新状态」结论对 **PDF 为源**的情形不成立（round1 的守卫回归只覆盖了 zip→csv / xlsx→zip / media→csv 等**新格式为源**、走 `loadFileSeq` 的方向，漏看了 PDF 分支的独立计数器）；③ 本次新增的 zip/xlsx/docx/media 扩大了可被覆盖的目标面。
- **修复方向（仅建议，未改）**：让 `loadPdfPreview` 也用共享代际——`const seq = loadFileSeq`（去掉 `++pdfPreviewSeq` 与 `:293` 的同步），或 `loadPdfPreview` 捕获 `loadFileSeq` 而非自增 `pdfPreviewSeq`；并补一条「PDF→新格式，PDF 迟到」的 dispatch 回归。
- **复现用例**（临时 `zz-review-repro-pdfrace.test.ts`，2 条均**按预期失败**后删除；harness 同 `FileViewer.dispatch.test.ts`，`previewFile` 返回手动 resolve 的 deferred、`readFileBytes` 立即返回）：
  ```ts
  it('迟到的 PDF 预览响应覆盖已切走的 zip 状态', async () => {
    let resolvePdf: (v: { blob?: Blob }) => void = () => {}
    const pdfDeferred = new Promise<{ blob?: Blob }>((r) => { resolvePdf = r })
    const provider = { listDirectory: async () => ({ entries: [] }), searchFiles: async () => ({}),
      previewFile: () => pdfDeferred,
      readFile: async () => ({ content: 'x,y\n3,4', total_lines: 2 }),
      readFileBytes: async () => ({ bytes: new Uint8Array([1,2,3]), size: 3 }) } as unknown as WorkspaceFileProvider
    const filePath = ref('a.pdf')
    const Host = defineComponent({ render: () => h(ClientViewer as never, { filePath: filePath.value, provider } as never) })
    /* ...mount... */ await flush()
    filePath.value = 'b.zip'; await flush()
    expect(archiveProps).toHaveLength(1)        // zip 已就位
    resolvePdf({ blob: new Blob(['%PDF-1.4']) }); await flush()
    expect(pdfProps).toHaveLength(0)            // ❌ 实际 =1：过期 PDF 覆盖了 zip
    expect(archiveProps).toHaveLength(1)
  })
  // 第二条把目标换成 b.txt（既有 ready 路径）同样 pdfProps=1 → 证明与新增格式无关、系既有缺陷
  ```
  实测输出：`AssertionError: expected [ { …(4) } ] to have a length of +0 but got 1`（两条皆然）。
- **严重程度**：中（可持久显示错误文件内容；触发需快速切换 + 特定异步时序；**非本次引入**）。

### 2. ArchiveBrowser / SpreadsheetView / DocxPreview 的「刷新」按钮不重新取字节，`refresh` emit 成死代码（低）

- **位置**：
  - `ArchiveBrowser.vue:7` `<button ... @click="reload">`、`:279-281` `reload()→loadArchive()`、`:112-114` `defineEmits<{ refresh: [] }>()`（**从未调用 emit**）
  - `SpreadsheetView.vue:7`、`:157-159`、`:86-88`（同款）
  - `DocxPreview.vue:6`、`:120-122`、`:51-53`（同款）
  - 对照：`CsvTableView.vue:7`、`MediaPlayer.vue:11` 均为 `@click="$emit('refresh')"`（符合设计）
- **问题描述**：技术方案 §5.8 与 §6-A3 明确要求新组件「刷新按钮 **emit 回 FileViewer 重走 dispatch**」（即重新 `readFileBytes` 取最新字节）。但上述三个组件的刷新按钮走本地 `reload()`，只对 `props.bytes`（同一份内存字节）**重新解析**，既不 emit、也不重新取数；`defineEmits` 里的 `refresh` 因此是**死代码**。而 `props.bytes` 在同一实例内不会变（FileViewer 每次 `loadFile` 先把 `bytesData` 置 null 使子组件卸载再以新 bytes 重挂），故 `reload()` 实际只剩「解析重试」效果。
- **触发场景 / 影响**：LOCAL 模式下用户在外部编辑器改动了 `report.xlsx` / `spec.docx` / `bundle.zip`（未触发会话的 `activeFileChanges`，自动重载不生效），回到预览点「刷新」——这三个组件重解析旧字节，**拿不到磁盘新内容**；而同样操作下 CSV / 媒体会 emit→FileViewer 重取→刷新成功。行为不一致 + 刷新按钮对主要用途（看最新）失效。对「Agent 重新生成文件」这一主场景，`matchingChangeCount` 防抖重载会兜底，故实际影响有限。
- **修复方向（仅建议，未改）**：把这三个按钮统一改成 `@click="$emit('refresh')"`（与 CsvTableView/MediaPlayer 一致），删除各自的 `reload()` 或保留为内部重试；若担心 emit 触发重挂会丢滚动/ sheet / 预览态，可在 FileViewer 侧评估，但不应以「永远拿不到新字节」为代价。
- **复现用例**（临时 `zz-review-repro-refresh.test.ts`，**通过**——即断言如实捕获了「重解析但不 emit」的现状；harness 同 `SpreadsheetView.test.ts`，exceljs mock 计数 `load` 调用）：
  ```ts
  it('点刷新：重新解析同一份 bytes，但不 emit refresh（FileViewer 不会重新取字节）', async () => {
    excelState.sheets = [{ name: 'S', rowCount: 1, getRow: () => ({ values: [null, 'a'] }) }]
    const refreshes: number[] = []
    const bytes = new Uint8Array([0x50,0x4b,0x03,0x04])
    const Host = defineComponent({ render() {
      return h(ClientSheet as never, { filePath: 'r.xlsx', bytes, provider: null, onRefresh: () => refreshes.push(1) } as never) } })
    /* ...mount... */ await flush()
    expect(excelState.loadArgs).toHaveLength(1)
    click(findAll(root, byTitle('刷新'))[0]!); await flush()
    expect(excelState.loadArgs).toHaveLength(2)   // 重新解析了同一份 bytes
    expect(refreshes).toEqual([])                  // 但没有 emit 回 FileViewer → 磁盘变更拿不到
  })
  ```
  （该文件运行时我的简化 nodeOps 报了 3 个 nextSibling/anchor 相关 unhandled error，系复现器未实现 anchor 传入所致，与组件逻辑无关；两条断言均通过，证明现状。）
- **严重程度**：低。

---

## 三、其他观察（非 bug，不要求修改）

1. **round1 观察 #1（ArchiveBrowser.test.ts 注释与断言相反）—— 已消失**：原 `:288-294` 的误导性用例已被改写为 `ArchiveBrowser.test.ts:330-334`「目录条目不可点：disabled 按钮不派发 click」，仅断言 `dirBtn.props.disabled === true`，注释与断言一致。
2. **round1 观察 #2（三个子组件 `watch(() => props.bytes)` 不可达）—— 仍成立**：FileViewer 每次 `loadFile` 先 `bytesData.value = null`（`:297`）使子组件卸载再重挂，watch 永不在同一实例触发；死代码但无害（重挂即重载）。
3. **round1 观察 #3（jszip 默认不校验 CRC）—— 仍成立**：`JSZip.loadAsync(props.bytes)` 未开 `checkCRC32`；开启会在 loadAsync 全量解压、击穿懒解压炸弹防线，属 §12 已记录取舍，维持现状。
4. **round1 观察 #4（CHANGELOG 未更新）—— 已解决**：`CHANGELOG.md` 顶部 `## 0.0.354` 已补「前端（桌面 / Web / 安卓）」两条（五类预览 + 降级出口）。
5. **CLOUD `readFileBytes` 无「取数前」大小上限**：`workspace-file-provider.ts:324-342` 直接 `fetch → arrayBuffer()`，不看 `Content-Length`；xlsx 20MB / docx 10MB / 媒体 50MB 的判定都在子组件**取到全量字节之后**。LOCAL 侧有 `localFileBytes.cjs` 64MB IPC 上限保护，CLOUD 侧则会把超大文件整体读进渲染进程内存后再判「表格过大/文档过大/已转为下载」。功能正确、与方案 §5.2 选择一致，且渲染进程隔离（最坏单 tab OOM），故不计为 bug；如要收敛可在 fetch 后按 `resp.headers.get('content-length')` 或分块上限提前拒绝。
6. **`useShowInFinder` 注释措辞**：注释称「CLOUD / Web 下自动不可用」，实际判定是「有 electronAPI 且有 getAbsolutePath」。CLOUD 之所以不可用，真实原因是 CLOUD provider 恒有 `downloadFile`、降级态按钮是 `v-else-if` 永远走下载分支——结论正确，但注释描述的机制不精确。
7. **CSV 列截断复用行截断文案**：`CsvTableView.vue:43` 的提示硬编码「仅显示前 5000 行」，当 `parsed.truncated` 因**列数**超 512 触发时文案不准（罕见，需 >512 列）。
8. **sniff 对「PK 魔数开头的非 zip 文本」**：`:344` sniff 前移后，极少数以 `PK\x03\x04` 等控制字节开头的非 zip 文本会进 ArchiveBrowser 并落 error 态（此前会进 binary 态）；真实文本几乎不可能以此开头，影响近零。

---

## 四、总结论

- **round1 五处修复：全部真实解决，且均未引入新的功能缺陷**，回归覆盖充分；`check-main-chunk` 三条 FORBIDDEN 字面量已与库产物逐字符对齐。
- **本轮未发现本次改动新引入的高 / 中严重度功能缺陷，也未发现任意文件读取 / XSS / 命令注入类安全问题**。核心链路（扩展名早返回 dispatch、`loadFileSeq` 守卫、blob 三处释放、DOMPurify 主链同选项、zip 炸弹三道防线、CSV 解析、exceljs/jszip/mammoth 动态加载与降级、IPC 路径复用与 64MB 上限、复制条序列化、路径处理、entryError 状态机）经审阅均正确。
- 两个新发现问题中：**问题 1（PDF→其他代际守卫竞态）为既有缺陷**（`git show HEAD` 可见守卫四行早已存在），但因落在本轮明示要 review 的 `pdfPreviewSeq` 范畴、round1「守卫正确」结论对 PDF 为源不成立、且新增格式扩大其覆盖面，建议**顺手修**（改动约 2 行 + 补 1 条回归）；**问题 2（三组件刷新按钮不 emit）为本次引入的设计偏离**，严重度低，建议合入前统一成 `$emit('refresh')` 以符合 §5.8/§6-A3 并消除死代码。
- **结论：主干功能正确、可以合入**；建议合入前处理问题 1、问题 2（均为小改动），其余列入后续清理。
