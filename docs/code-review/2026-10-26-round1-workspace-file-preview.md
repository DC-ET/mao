# 代码评审报告：桌面端工作区文件预览能力扩展（feat/workspace-file-preview 未提交改动）

- 日期：2026-10-26
- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/file-preview` 分支 `feat/workspace-file-preview` 的**全部未提交改动**（`git status --short` 清单：electron main/preload + 新增 localFileBytes.cjs、workspace-file-provider.ts、FileViewer.vue、6 个新组件 + TableGrid + useTableCopyBar、5 个新 utils、check-main-chunk.mjs、package.json/lock、electron.d.ts）
- 技术方案：`docs/plan/2026-10-26-workspace-file-preview-technical-design.md`（权威依据，逐条核对 §5 详设与 §6 冲突清单）
- 审查维度：功能逻辑正确性（dispatch / 代际守卫 / blob 生命周期 / 字节上限与空文件分支 / DOMPurify 覆盖 / electron IPC 入参与错误路径 / 动态 import 失败降级 / CSV 边界 / zip 炸弹防线 / 复制条内容 / 路径处理），安全（任意文件读取、XSS）优先；不审文档变更
- 方法：逐文件通读全部改动源码与既有测试；对 5 个疑似点各写临时验证用例实际运行复现（vitest 单跑 + node 脚本，全部复现成功后**已删除临时文件，仓库保持干净**，用例代码见各条「已用测试验证」）；基线 `npx vitest run` 122 文件 1141 例全绿（含临时用例），`node --test electron/localFileBytes.test.cjs` 6/6 通过
- 本轮共 **5 个问题，全部为低严重度**：未发现高 / 中严重度功能缺陷，未发现任意文件读取、XSS、命令注入类安全问题。核心链路（扩展名早返回 dispatch、代际守卫、blob 三处释放纪律、DOMPurify 主链同款选项、zip 炸弹三道防线、CSV 解析器、exceljs/jszip/mammoth 动态加载与降级、IPC 路径复用与 64MB 上限）经审阅均正确。

---

## 严重度汇总

| # | 端 | 问题 | 类别 | 严重程度 | 位置 |
|---|:---:|------|------|:---:|------|
| 1 | desktop | sniff 兜底对**真实** zip/xlsx 完全不可达（本地头版本字段必含 NUL，先被 binary 检查拦截），代码注释的覆盖范围声明不成立 | 功能失效 / 注释失实 | 低 | `desktop/src/components/center/FileViewer.vue:339-353` + `desktop/src/utils/file-preview-format.ts:56-60` |
| 2 | desktop | ArchiveBrowser 条目解压失败时 catch 只写 `errorMsg`，而 `errorMsg` 仅在 `state==='error'` 渲染 → 点击损坏条目**完全无反馈** | 错误路径 UX | 低 | `desktop/src/components/center/ArchiveBrowser.vue:202-205`（模板 :24-27） |
| 3 | desktop | check-main-chunk 新增的 jszip 字面量与 jszip 实际错误消息差一个空格，该条守卫恒不命中 | 构建守卫半失效 | 低 | `desktop/scripts/check-main-chunk.mjs:27` |
| 4 | desktop | 技术方案 G2（★红线）要求 mp4/mov 标注「依赖编解码支持，失败可一键下载」，实现只落地了下载按钮，标注与播放失败兜底提示缺失 | 设计符合性 | 低 | `desktop/src/components/center/MediaPlayer.vue:5-6,34-51` |
| 5 | desktop | LOCAL 模式（无 downloadFile）下 xlsx/docx 超上限、zip 被拒时，降级文案「请下载后查看」没有任何可点出口（死路） | 降级路径 UX | 低 | `desktop/src/components/center/SpreadsheetView.vue:38-41`、`DocxPreview.vue:23-26`、`ArchiveBrowser.vue:24-27` |

---

## 一、问题清单

### 1. sniff 兜底对真实 zip/xlsx 完全不可达（desktop，低）

- **位置**：
  - `desktop/src/components/center/FileViewer.vue:339-353`——`isBinaryContent(result.content)` 在 sniff 之前拦截；
  - `desktop/src/utils/file-preview-format.ts:56-60`——`sniffContainerKind`；
  - 失实注释：`FileViewer.vue:347-348`「真实压缩过的 zip / xlsx 内容几乎必含 NUL，会被上面的 binary 检查先拦截——**兜底路径只覆盖 STORED 未压缩条目**（最佳努力，不承诺全覆盖）」。
- **问题描述**：注释声称 sniff 至少覆盖「STORED 未压缩条目」。事实并非如此：zip 本地文件头第 4–5 字节是 "version needed to extract"（小端），所有真实 zip 版本（1.0–6.3，均 < 256）该字段高位字节必为 `0x00`，即**任何以 `PK\x03\x04` 开头的真实 zip（含 STORED、含空包）在第 5 字节必含 NUL**，必被 `isBinaryContent`（查前 8192 字符）先拦截。因此 `sniffContainerKind` 在生产环境 100% 不可达——现有两条 dispatch 单测（`FileViewer.dispatch.test.ts:312-323`、`:404-419`）之所以绿，是因为 mock 的 content 是去掉 NUL 的人工串（`'PK\u0003\u0004stored-entry-bytes'`），给了「兜底可用」的虚假信心。
- **触发场景**：LOCAL 模式下打开**无扩展名或扩展名撒谎**（如把 bundle.zip 改名为 bundle）的 zip / xlsx：本应改道 ArchiveBrowser / SpreadsheetView，实际停在「二进制文件，无法预览」。CLOUD 模式该场景 readFile 直接报错（方案 §6-B7 已记录的不对称），不受影响。
- **影响**：方案 §5.1 承诺的 LOCAL 兜底能力实际不存在；行为退回现状（无回归），但注释误导后续维护者。Agent 产出的压缩包均有扩展名，实际业务影响近零。
- **建议修复方向**：二选一——① 承认兜底不可达，删掉 `sniffContainerKind` 调用与相关注释/测试，把 §6-B7 的不对称如实扩写；② 若确需兜底，把 sniff 移到 `isBinaryContent` **之前**（先验 PK 魔数再判 binary），此时 STORED/压缩包均可命中（真实压缩包以 PK 魔数开头即改道字节分支，binary 态不再产生）。
- **已用测试验证**（临时 spec `desktop/src/components/center/zz-review-repro-a.test.ts`，2 passed 后删除；harness 同 `FileViewer.dispatch.test.ts`，mock provider.readFile 返回真实 zip 的 utf-8 文本）：
  ```ts
  it('STORED 未压缩 zip 读成 utf-8 后含 NUL → 被 binary 检查先拦截，sniff 永不生效', async () => {
    const zip = new JSZip()
    zip.file('readme.txt', 'hello archive, plain text content')
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
    const content = Buffer.from(bytes).toString('utf-8')   // LOCAL localReadFile 口径
    let nulAt = -1
    for (let i = 0; i < Math.min(content.length, 8192); i++) {
      if (content.charCodeAt(i) === 0) { nulAt = i; break }
    }
    expect(nulAt).toBeGreaterThanOrEqual(0)   // 实测 nulAt = 4/5（版本字段）
    expect(nulAt).toBeLessThan(8)
    archiveProps.length = 0
    const root = await mountViewer(content, async () => ({ bytes }))
    expect(collectText(root)).toContain('二进制文件，无法预览')  // 未进入 ArchiveBrowser
    expect(archiveProps).toHaveLength(0)
  })
  // 同文件第二条：DEFLATE 压缩 zip 同样被 binary 拦截（亦通过）
  ```

### 2. ArchiveBrowser 条目解压失败时用户看不到任何错误（desktop，低）

- **位置**：`desktop/src/components/center/ArchiveBrowser.vue:202-205`（`openEntry` catch：`errorMsg.value = e?.message || '条目读取失败'`）；模板 `:24-27`——`errorMsg` 只在 `v-else-if="state === 'error'"` 分支渲染，而条目点击失败时 `state` 停留在 `'ready'`。
- **问题描述**：catch 块写了错误消息，但 ready 态模板里没有任何地方渲染 `errorMsg`。条目解压失败（jszip 对损坏 deflate 流抛 `Bug : uncompressed data size mismatch` 等）、`downloadEntry` 失败、`URL.createObjectURL` 失败，全部落入「点击后什么都不发生」。
- **触发场景**：打开一个下载不完整 / 磁盘损坏的 zip（中央目录完好、条目数据损坏——jszip `loadAsync` 能成功，炸弹防线只能信声明大小），点击文本 / 图片 / PDF 条目。
- **影响**：静默失败，用户无从得知是条目损坏还是界面无响应；唯一出路是自己想到点刷新或整包下载。无数据损失。
- **建议修复方向**：条目级失败把 `state` 一并切到 `'error'`（或新增轻量 toast / 条目行内错误标），让 `errorMsg` 有渲染出口；顺带补一条「损坏条目点击 → 可见错误」的回归。
- **已用测试验证**（临时 spec `desktop/src/components/center/zz-review-repro-b.test.ts`，1 passed 后删除；真实 jszip 造包后破坏条目压缩数据）：
  ```ts
  async function buildCorruptedZip(): Promise<Uint8Array> {
    const zip = new JSZip()
    zip.file('readme.txt', 'hello archive '.repeat(50))
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    const corrupted = new Uint8Array(bytes)
    const nameLen = corrupted[26] | (corrupted[27] << 8)
    const extraLen = corrupted[28] | (corrupted[29] << 8)
    const dataStart = 30 + nameLen + extraLen
    for (let i = 0; i < 8; i++) corrupted[dataStart + i] = 0xff
    return corrupted
  }

  it('损坏条目点击后：async 抛错被 catch，但 state 仍是 ready → 页面无任何错误反馈', async () => {
    const bytes = await buildCorruptedZip()
    const loaded = await JSZip.loadAsync(bytes)          // 中央目录完好，loadAsync 成功
    let threw = ''
    try { await loaded.file('readme.txt')!.async('text') } catch (e: any) { threw = e?.message ?? '' }
    expect(threw).not.toBe('')                            // 'Bug : uncompressed data size mismatch'
    const root = await mountBrowser(bytes)
    click(findEntry(root, 'readme.txt')!)
    await flush()
    expect(findAll(root, byTag('pre'))).toHaveLength(0)
    expect(findAll(root, byClass('archive-message'))).toHaveLength(0)  // 错误态 UI 不存在
    expect(findAll(root, byClass('error'))).toHaveLength(0)
    expect(collectText(root)).not.toContain('失败')        // 页面无任何失败提示
  })
  ```

### 3. check-main-chunk 新增字面量与 jszip 实际错误消息不一致，守卫半失效（desktop，低）

- **位置**：`desktop/scripts/check-main-chunk.mjs:27`——`'Corrupted zip: CRC32 mismatch'`（冒号前无空格）。
- **问题描述**：jszip 3.10.2 产物中的实际消息是 `"Corrupted zip : CRC32 mismatch"`（冒号前**有**一个空格，见 `node_modules/jszip/lib/load.js:22` 与 `dist/jszip.min.js`）。FORBIDDEN 里的这条字面量在 jszip 产物中不存在，恒不命中；真正有效的只剩 `"Can't find end of central directory"` 一条。即 jszip 若因误改静态 import 泄入主 chunk，两条新守卫只有一条能发现。
- **触发场景**：未来有人把 `await import('jszip')` 改成静态 import（或被其他依赖间接拉入主 chunk）——守卫仍可能因只命中一条而放过，或反之漏报。
- **影响**：CI 断言（验收标准 4「主 chunk 不含新库字面量」）强度低于设计预期；当前构建实际无泄漏（三个库均为动态 import，已 grep 确认全仓无其他 import 点）。
- **建议修复方向**：把字面量改成 jszip 实际串 `'Corrupted zip : CRC32 mismatch'`；更稳妥的做法是构建后对 jszip chunk 文件名做一次「存在性」断言（chunk 必须存在且主 chunk 不含任一库字面量），并顺带把方案 §6-C1 提到的 exceljs / mammoth 内部字面量补进 FORBIDDEN（目前同样缺失）。
- **已用测试验证**（node 脚本，直接跑）：
  ```js
  const { readFileSync } = require('fs')
  const js = readFileSync('node_modules/jszip/dist/jszip.min.js', 'utf8')
  // "Can't find end of central directory" => true
  // "Corrupted zip: CRC32 mismatch"     => false   ← 脚本里的字面量，产物中不存在
  // "Corrupted zip : CRC32 mismatch"    => true    ← jszip 实际消息（冒号前有空格）
  ```

### 4. mp4/mov 的编解码依赖标注未落地（技术方案 G2 ★红线）（desktop，低）

- **位置**：`desktop/src/components/center/MediaPlayer.vue:5-6`（工具条仅 `{{ kindLabel }} · {{ sizeLabel }}`）、`:34-51`（`<video>` / `<audio>` 无 `@error` 处理、无编解码提示）。
- **问题描述**：方案 §6-G2（★）的缓解措施是「媒体白名单 webm / ogg / wav 为主；**mp4 / mov 标注「依赖编解码支持，失败可一键下载」**；冒烟清单必查」。实现只落地了前半句（白名单含 webm/ogg/wav）与下载按钮，**标注不存在**；且 `<video>` 播放失败（Electron 官方构建不解码 H.264 时「有声音黑屏」或直接 error 事件）时没有任何提示告诉用户「换个格式或点下载」。
- **触发场景**：Electron（官方构建，无专有编解码）中打开 mp4 / mov；或白名单外内容走了 media 分支（`mediaKindOf` 白名单外回落 video）。
- **影响**：用户面对黑色播放器无解释；下载按钮在（CLOUD 有 downloadFile / LOCAL 有 Finder 按钮），「一键下载」兜底存在，缺的是「为什么播不了」的说明。属设计符合性缺口。
- **建议修复方向**：工具条对 mp4/mov 增加固定标注（如「依赖编解码支持，播放失败可点下载」）；`<video @error>` 时把 `state` 切 error 并展示同文案 + 下载出口。
- **已用测试验证**（临时 spec `desktop/src/components/center/zz-review-repro-d.test.ts`，1 passed 后删除；harness 同 `MediaPlayer.test.ts`）：
  ```ts
  it('mp4：渲染输出中没有任何「依赖编解码支持」类标注（G2 ★红线的缓解措施只落地了一半）', async () => {
    const root = await mountPlayer('clip.mp4')
    const text = collectText(root)
    expect(text).toContain('clip.mp4')
    expect(text).toContain('视频')          // 现状只有「视频 · 4 B」
    expect(text).not.toContain('编解码')    // G2 要求的标注不存在
    expect(text).not.toContain('H.264')
    expect(text).not.toContain('无法播放')  // 播放失败也无兜底提示
  })
  ```

### 5. LOCAL 模式下降级文案与可用出口不匹配（xlsx/docx 超上限、zip 被拒时死路）（desktop，低）

- **位置**：`desktop/src/components/center/SpreadsheetView.vue:38-41`（`表格过大，请下载后查看` + `v-if="provider?.downloadFile"` 的下载按钮）、`DocxPreview.vue:23-26`（同款）、`ArchiveBrowser.vue:24-27`（条目过多 / 解压总大小超限拒绝态，同款）。
- **问题描述**：LOCAL provider 没有 `downloadFile`（`createLocalProvider` 未实现，见 `workspace-file-provider.ts:148-202`），这三个组件的降级态按钮都是 `v-if="provider?.downloadFile"`，工具条也只有刷新 + 条件下载——LOCAL 下超上限的 xlsx（>20MB）/ docx（>10MB）/ 被拒的 zip 只剩一句「请下载后查看」和一個刷新按钮，既不能下载也没有 MediaPlayer 那样的「在 Finder 中显示」出口。文案本身在 LOCAL 语境下也不准确（文件就在本机）。
- **触发场景**：LOCAL 模式双击一个 25MB 的 xlsx（LOCAL readFileBytes 上限 64MB，能取到字节）→ 「表格过大，请下载后查看」→ 无可点出口；docx >10MB、zip 条目数 >500 / 解压合计 >500MB 同理。
- **影响**：降级路径死路 + 文案误导；用户需自己回想文件位置。无功能正确性问题（CLOUD 模式文案与按钮均正确）。
- **建议修复方向**：LOCAL 下（`!provider?.downloadFile` 且 `provider?.getAbsolutePath` 存在）给这三个降级态补「在 Finder 中显示」出口（复用 MediaPlayer 的 `canShowInFinder` 判定），或把文案按模式切换为「文件过大，请在文件管理器中打开」。
- **已用测试验证**（临时 spec `desktop/src/components/center/zz-review-repro-e.test.ts`，1 passed 后删除；harness 同 `SpreadsheetView.test.ts`；超限分支在动态 import exceljs 之前返回，无需 mock exceljs）：
  ```ts
  it('超 20MB 且 provider 无 downloadFile（LOCAL）：提示「请下载后查看」但没有任何可点出口', async () => {
    const provider = { getAbsolutePath: (p: string) => `/Users/u/work/${p}` }  // LOCAL provider 形态
    const root = await mountSheet(new Uint8Array(20 * 1024 * 1024 + 1), provider)
    expect(collectText(root)).toContain('表格过大，请下载后查看')
    expect(findAll(root, byClass('retry-btn'))).toHaveLength(0)               // 错误态无下载按钮
    const toolButtons = findAll(root, byClass('tool-btn'))
    expect(toolButtons.some((el) => el.props.title === '下载')).toBe(false)     // 工具条也无下载
    expect(toolButtons.some((el) => el.props.title === '在 Finder 中显示')).toBe(false)
    expect(toolButtons.some((el) => el.props.title === '刷新')).toBe(true)     // 只剩刷新
  })
  ```

---

## 二、其他观察（非 bug，不要求修改）

1. **测试注释与断言相反**：`desktop/src/components/center/ArchiveBrowser.test.ts:288-294` 注释写「这里也不应存在可调用的处理器入口」，断言却是 `expect(dirBtn.props.onClick).toBeDefined()`（断言处理器**存在**）。真实 DOM 中 disabled 按钮不派发 click，功能无问题，但该用例不断言任何行为、且注释误导，建议改为直接触发 onClick 验证 `openEntry` 对目录条目早返回（`zip.file('docs/')` 实测返回 null）。
2. **三个子组件的 `watch(() => props.bytes)` 实际不可达**：FileViewer 每次 `loadFile` 先把 `bytesData` 置 null（`FileViewer.vue:297`），子组件先卸载再以新 bytes 重挂，watch 永远不会在同一实例上触发（刷新走的是「卸载-重挂」而非 props 更新）。逻辑无害（重挂即重载），属死代码，知悉即可。
3. **jszip 默认不校验 CRC**（`checkCRC32: false`）：大小不变而内容损坏的条目会被静默展示。但开启 `checkCRC32: true` 会在 `loadAsync` 时全量解压，直接击穿懒解压的 zip 炸弹防线——属库层取舍，**不建议改**；本报告问题 2 只要求把「解压抛错」变可见。
4. **流程项（按指示未纳入正文）**：CHANGELOG.md 未随本改动更新（AGENTS.md 要求用户可见改动同任务写入顶部）；该条属文档/流程，不在本次功能逻辑审查范围。

---

## 三、核查为正确的重点（附依据）

- **Dispatch 与既有五态零回归**：zip/xlsx/docx/media 在 `readFile` 之前早返回；csv 只在 readFile 成功后的分支点改道；md/pdf/image/binary/empty/ready 六态语义未动（`FileViewer.dispatch.test.ts` 17 条用例覆盖，含 project 模式降级、四条过期响应守卫、二进制 NUL 拦截）。
- **代际守卫**：FileViewer `loadFileSeq`/`pdfPreviewSeq`、ArchiveBrowser `loadSeq`/`entrySeq`、SpreadsheetView/DocxPreview `loadSeq`，全部 await 后校验，迟到响应不覆盖新状态（已有测试 + 逐条复核）。
- **blob URL 生命周期**：MediaPlayer `onDeactivated`/`onBeforeUnmount` 双 pause + revoke、回前台按需重建（暂停放在 before 钩子的注释准确——卸载后 `mediaEl` 已置空）；ArchiveBrowser 换条目先 revoke 再建、`onUnmounted` 释放；FileViewer pdfBlobUrl 切文件/重载/卸载三处释放。jsdom 用例 unmount 后 revoke 被断言。
- **字节上限与空文件分支**：LOCAL 64MB（`localFileBytes.cjs`，`node --test` 6/6 通过，含目录/symlink/超限拒绝）；XLSX 20MB / DOCX 10MB / 媒体 50MB 均在动态 import **之前**判定；空字节在 provider 与 FileViewer 双层判错。
- **DOMPurify 覆盖**：全方案唯一 v-html 在 DocxPreview，选项与主链 `useMarkdown.ts:138` 完全一致（`{ ADD_ATTR: ['target'] }`），script/onclick/javascript: 均被剥掉（已有测试）；CSV/XLSX/ZIP 零 v-html，全部 Vue 文本插值。
- **XSS / 路径处理**：zip 条目名（含 `../../etc/passwd`）仅字符串展示、下载名取末段（`displayNameOf`）；svg 走 `<img src=blob>`（img 内 SVG 脚本不执行）；无命令注入面。
- **zip 炸弹三道防线**：条目数 500 / 合计 500MB / 单条目 100MB，边界值（恰好等于上限）均有测试；「中央目录撒谎」为方案 §12 已记录取舍（渲染进程隔离、单 tab OOM 可接受）。
- **CSV 解析器**：引号与 `""` 转义、引号内分隔符/换行、CRLF/lone CR/混合行尾、BOM、ragged 补齐、空行跳过、行列双上限与截断标记、分隔符 sniff 引号内不计频次——均有针对性用例；`sniffDelimiter` 对首行含引号换行的病例按逗号回落（单列退化，不崩）。
- **electron IPC**：`local-read-bytes` 复用 `local-read-file` 同一 `resolveWorkspacePath` + `lstatSync` 拒目录/symlink + 64MB 上限，不建第二套路径解析；入参缺失/类型错误走 try/catch 返回 `{ error }`；preload 暴露与 electron.d.ts 类型同步。与 `local-read-file` 同等暴露面（任意路径读取需先进渲染进程），未扩大攻击面。
- **动态 import 与浏览器兼容**：exceljs 浏览器包 `dist/exceljs.js` 的 `xlsx.load` 转交 `JSZip.loadAsync`（接受 Uint8Array），`process` 引用均为 global 属性守卫或包内 shim，浏览器不会 ReferenceError；jszip/mammoth 均走 browser 字段映射；三库全仓仅动态 import（已 grep 确认），主 chunk 无泄漏。
- **表格复制条**：`useTableCopyBar` 序列化的是 rows 数据源本身（非 DOM 序列化），CSV 转义 / Markdown 管道表口径与既有 `tableCopy.ts` 一致，含逗号/引号/换行单元格的复制结果有用例；hover 延迟隐藏与卸载定时器清理完备。

---

## 四、总结论

本轮 5 个问题**全部为低严重度**（1 个兜底路径失效、2 个错误/降级路径 UX 缺口、1 个构建守卫笔误、1 个设计符合性缺口），**不存在高/中严重度功能缺陷，也不存在任意文件读取、XSS、命令注入类安全问题**；本次需求的主干功能（csv/xlsx/docx/zip/media 六类新预览 + 既有五态零回归 + 代际守卫 + blob 生命周期 + 炸弹防线 + 消毒）实现正确且测试覆盖充分，**可以合入，建议顺手处理问题 2、3（改动都在 5 行内）**，问题 1、4、5 可评估后列入后续清理。
