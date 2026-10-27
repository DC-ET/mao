# 工作区文件预览完整度（表格 / 压缩包 / 表格文件 / 音视频）技术方案

> 版本：v1.0（2026-10-26）
> 状态：待评审（提案见 [../proposals/2026-10-26-workspace-file-preview.md](../proposals/2026-10-26-workspace-file-preview.md)；第十七批另两件见 [../proposals/README.md](../proposals/README.md)）
> 设计红线：**既有五种预览路径（markdown / PDF / 图片 / 文本 / 二进制）行为零变化；后端、admin、agent-cli、mao-cli 零改动零迁移；新库全部动态 chunk 不进首屏。**

## 0. 待确认决策（评审逐条定）

| # | 决策点 | 推荐 | 备选 / 说明 |
|---|--------|------|------------|
| 1 | XLSX 解析库 | **`exceljs`（npm 原生）** | SheetJS 官方 npm 版停留 0.18.5（存在已披露的原型污染类历史漏洞，修复版仅 CDN 分发，违反内网禁 CDN 硬约束）；exceljs 维护活跃、体积大但走动态 chunk。实施前过一次 `npm audit` 依赖安全评审 |
| 2 | ZIP 解析库 | **`jszip`（中央目录先行 + 按条目懒解压）** | fflate 体积更小但 `unzipSync` 全量解压，zip 炸弹防线要自建；adm-zip 是 Node 向（Buffer/fs 语义），浏览器不可用——不因 desktop/package.json 已有该依赖而选它 |
| 3 | 媒体获取方式 | **blob fetch 复用 `workspace-download`**（不新增端点、不改响应头） | 新签 `?token=` 流式端点（省内存但新增对外暴露面，否） |
| 4 | CSV 数据口径 | **沿用 `readFile`（5000 行 / 512KB 上限）+ 截断提示**，与文本预览现状一致 | `readFileBytes` 全量解析（取消行数口径但引入大文件内存风险，留作 P3 后评估） |
| 5 | 媒体大小阈值 | **50MB**，超限降级下载（阈值集中为常量，后续可配置） | 不做流式 Range 播放（v1 范围外） |
| 6 | DOCX 预览 | **P2 伸展项**：mammoth → HTML → DOMPurify → 既有 markdown 容器；数据验证后再定去留 | 直接不做（Agent 产 docx 频率待 P1/P2 数据验证） |
| 7 | 代码形态 | **FileViewer 保持调度器，新格式拆独立子组件**（CsvTableView / ArchiveBrowser / MediaPlayer / SpreadsheetView） | 全部内联进 FileViewer（该文件已 627 行，拒绝） |
| 8 | `.tar` / `.tar.gz` | **不做**（JSZip 只支持 zip 家族；tar 需另一套解析，下载兜底） | 提案 §1.3 提到 tar.gz，此处收窄为 zip，如实记录偏差 |
| 9 | 未知二进制格式的双端不一致（CLOUD 报错态 + 全局 toast vs LOCAL 干净 binary 态） | **不在本方案收口**（避免行为面扩大；新格式已绕过该路径） | 顺手归一（需改后端错误语义或字符串匹配， hack，否） |

## 1. 需求背景

提案已论证：Agent 高频产出 CSV / XLSX 报表、ZIP 打包、音视频，而 `FileViewer.vue` 只有 markdown / PDF / 图片 / 文本 / 二进制五档，其余「无法预览，请下载」。本方案承接提案 §4，细化到文件与函数级，并把「与现有预览链的每一个冲突点」逐项列出（§6）。

## 2. 现状：预览链全貌（代码事实，file:line）

### 2.1 FileViewer 状态机（`desktop/src/components/center/FileViewer.vue`）

- 状态联合：`'loading' | 'ready' | 'error' | 'binary' | 'empty' | 'image' | 'pdf'`（:83）。
- `loadFile()` 分发顺序（:201-260）：**扩展名只判 pdf（`isPdfPath` :162）** → `provider.readFile(path, {limit:5000})` → 依次判 `media_type==='image'`（:232）/ 空文件（:239）/ `isBinaryContent` NUL 嗅探（:146）/ 文本 ready（:251）。markdown 判定（`isMarkdown` :102）只影响 ready 态内的「预览 / 源码」切换，不进分发。
- 代际守卫：`loadFileSeq` / `pdfPreviewSeq`（:168-174），切换文件 / 重载时作废过期响应；ChatInput.vue:477 注释亦引此为范式。
- 变更重载：`watch [filePath, provider]`（:266-274）切文件重载；`matchingChangeCount` watch（:278-289）对当前文件的新变更防抖 300ms 重载。
- Monaco：`useMonacoViewer` 的 `enabled = state==='ready' && showSource`（:109）——非 ready 态不激活编辑器。
- 刷新按钮仅在 ready 态模板内（:41-43）；「仅显示前 5000 行」截断提示（:54-56）。

### 2.2 CLOUD 与 LOCAL 的现存行为差异（设计输入）

| 场景 | CLOUD | LOCAL（Electron） |
|---|---|---|
| 二进制文件（如 .zip） | 后端 `readFile` 遇 NUL 抛 `二进制文件，无法预览`（workspace-browse.service.ts:333-341）→ 请求拦截器弹**全局 ElMessage.error**（api/index.ts:63-71）+ FileViewer 进 error 态带重试按钮 | `localReadFile` 以 utf-8 读全文件（main.cjs:1896-1925，NUL 是合法 UTF-8 字符故保留）→ `isBinaryContent` 命中 → 干净 binary 态 |
| 无全局 toast | 否（拦截器统一弹） | 是 |

**这是本方案最重要的现状事实**：新格式（zip / xlsx / 媒体）今天在 CLOUD 上是「错误态 + 全局错误提示」的双重噪音。扩展名先行分发（§5.1）让这些格式根本不走 `readFile`，噪音路径自然消失。

### 2.3 Provider 抽象（`desktop/src/composables/workspace-file-provider.ts`）

- 三实现：`createLocalProvider`（:135，Electron IPC）、`createCloudProvider`（:175，REST `sessionId`）、`createProjectProvider`（:303，新建态只读）。
- 取数能力现状：`readFile`（文本 / 图片 data_uri）、`previewFile`（**仅 PDF**，:64 注释明示）、`downloadFile` / `downloadDirectory`（**仅 CLOUD**，:78-81 注释）、`searchFiles`、`getAbsolutePath`。
- **二进制字节通道缺口**：LOCAL 的 `localReadFile` 只能返回 utf-8 文本或图片 / PDF 的 data_uri（main.cjs:1896-1925），zip / xlsx / 媒体拿不到原始字节 → 需新增 IPC（§5.2）。CLOUD 侧 `workspace-download`（file.routes.ts:152）本就可取任意文件字节（带鉴权 fetch），**零新端点**。
- `downloadWorkspaceResource`（:397-428）是现成的「带鉴权 fetch + token query 兜底 + Content-Disposition 解析」范式，新 `readFileBytes` 复用其 fetch 模式。

### 2.4 后端 file 域约束（`backend-ts/src/file/workspace-browse.service.ts`）

| 约束 | 值 | 位置 |
|---|---|---|
| 路径安全 | `resolvePath` 工作区内解析，拒绝 symlink / 非普通文件 | :306-318 |
| 文本预览总大小 | `MAX_TEXT_PREVIEW_BYTES` = 10MB | :25 |
| 单次内容大小 | `MAX_CONTENT_BYTES` = 512KB | :24 |
| 单次行数 | `MAX_READ_LIMIT` = 5000 | :23 |
| 目录条目上限 | `MAX_ENTRIES` = 500 | :16 |
| `downloadFile` / `readPdfFile` | **无格式限制**，任意字节 | :207-261 |

结论：新格式全部「前端解析 + 既有取数字节」，**后端零改动**。

### 2.5 消费方与构建 / 测试基建

- 消费方：`CenterTabContainer.vue:5-10` 在 `<KeepAlive :max="20">` 内以 `:key="${activeTabId}-${version}"` 挂载 FileViewer；文件管理器（`FileManagerPanel.vue:301-307` emit open-file → TaskView handleOpenFile）与 markdown 内链（FileViewer:135-139）都经 `openFileTab` 汇入同一 FileViewer——**一个调度器覆盖全部入口**。
- KeepAlive 范式：`PdfViewer.vue` 的 `onActivated` 重载 + `onDeactivated` 销毁文档 / 观察器（:351-384）是新组件生命周期管理的直接先例。
- 构建：`vite.config.ts` 无 manualChunks，动态 import 自动独立 chunk；`scripts/check-main-chunk.mjs` 以**库内部字面量**（`sequenceDiagram` / `katex-mathml`）断言主 chunk 不含 mermaid / katex（脚本注释明确：不能按 chunk 文件名判断）。
- 测试：desktop vitest `environment: 'node'`；DOM 全链用 `@vitest-environment jsdom` 单文件开启（先例：`markdown-sanitize.dom.test.ts`，devDep `jsdom` 已在）。FileViewer 真实渲染 E2E 历史上降级为手动冒烟（message-rendering 方案 §9），`tests/workspace-file-dialog-*.spec.ts` 是「静态 SFC 断言」式轻量 E2E 先例。
- 现存包体事实：`PdfViewer.vue:51` 对 `pdfjs-dist` 为**静态 import**（随主 chunk 加载）。本方案不扩大静态依赖面；是否顺手把 PdfViewer 动态化列为可选清理，**不做**（改加载态有行为风险，§6-C6）。

## 3. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| CSV / TSV 解析 | **自研纯函数**（`utils/csv-parse.ts`，约 150 行） | 无依赖、node 环境可全测；复制序列化复用既有 `csvEscape` / `tableToCsv`（utils/tableCopy.ts:12-19） |
| XLSX | `exceljs` 动态 import | 决策 1 |
| ZIP | `jszip` 动态 import | 决策 2；懒解压 = 天然炸弹防线 |
| DOCX（P2 伸展） | `mammoth` 动态 import | 输出 HTML 过 DOMPurify 后进既有 markdown 容器 |
| 音视频 | 原生 `<video>` / `<audio>` + blob URL | 无依赖； Electron H.264 风险见 §6-G2 |
| 架构 | FileViewer = 调度器 + 4 个子组件 + 判定纯函数模块 | 决策 7 |
| 安全 | CSV / XLSX / ZIP 零 v-html（Vue 文本插值）；DOCX 唯一 v-html 且过既有 DOMPurify 选项 | 主链消毒配置零改动 |

## 4. 总体架构

```
loadFile()（FileViewer，总入口不变）
 ├─ resolvePreviewKind(filePath)            ← 新：扩展名判定（§5.1）
 │    xlsx/docx/zip/media 命中 → 字节分支（readFileBytes，不调 readFile）
 │    csv/tsv 命中          → 仍走 readFile 取文本，成功后改道表格渲染（§5.3）
 ├─ pdf / 图片 / markdown / 文本 / 二进制   ← 既有五条路径，一行不动
 └─ readFile 之后、isBinaryContent 之前插入 sniff 兜底：
      内容含 PK\x03\x04 魔数 → zip / xlsx 分支（仅 LOCAL 可达，§6-B7）

新分支数据获取：provider.readFileBytes(path)   ← 新 provider 方法（§5.2）
 ├─ local：IPC local-read-bytes（main.cjs 新增，Buffer structured clone）
 ├─ cloud：fetch workspace-download → arrayBuffer
 └─ project：不实现 → 明确降级文案

新状态渲染（FileViewer 模板平行追加，互斥分支）：
 state='csv'        → <CsvTableView :rows>            （P1）
 state='archive'    → <ArchiveBrowser :blob>          （P1）
 state='spreadsheet'→ <SpreadsheetView :bytes>        （P2）
 state='media'      → <MediaPlayer :blob :mime>       （P3）
 state='docx'       → <DocxPreview :bytes>            （P2 伸展）
```

## 5. 详设

### 5.1 格式判定（`desktop/src/utils/file-preview-format.ts`，纯函数）

```ts
export type PreviewKind =
  | 'markdown' | 'pdf' | 'image' | 'text' | 'binary'   // 既有语义（由 FileViewer 现路径产生）
  | 'csv' | 'xlsx' | 'docx' | 'zip' | 'media'          // 新增

export function resolvePreviewKind(filePath: string): PreviewKind | null
// null = 交回既有 readFile 文本路径（现状）
```

- 扩展名表（大小写不敏感）：`md/markdown`、`pdf`、图片（**与后端 `ImageFileSupport.mimeFromPath` 同款集合**：`.png/.jpg/.jpeg/.gif/.webp`，见 `backend-ts/src/harness/tool/image-file-support.ts:3-9`——判定必须与后端取数能力一致，不新造集合）、`xlsx/xlsm/xltx`、`docx`、`zip`、媒体白名单（`mp4/webm/ogg/mov/m4a/mp3/wav/flac`，决策 5 阈值外的降级见 §6-G2）、`csv/tsv/tab`。
- **判定顺序**：xlsx/docx 必须先于 zip（二者本质是 zip 容器），再 zip，再 media，再 csv。
-  sniff 兜底（§6-B7）：`readFile` 返回内容以 `PK\x03\x04` 开头 → `zip`；进一步含 `xl/workbook.xml` 特征 → `xlsx`。仅在 LOCAL 下可达（CLOUD 的 readFile 对二进制直接报错），作为无扩展名 / 扩展名撒谎文件的兜底。
- 单测：每个扩展名一条（含大写、双扩展名 `data.csv.zip`→zip）、sniff 两条、null 回落三条。

### 5.2 Provider 扩展：`readFileBytes`

```ts
// WorkspaceFileProvider 新增可选方法（既有实现不破坏）
// bytes 用 Uint8Array 而非 ArrayBuffer：JSZip / exceljs / Blob 构造 / atob 场景
// 都要 TypedArray，ArrayBuffer 每次用都得再包一层，且与 IPC structured clone 的
// Buffer（渲染进程侧即 Uint8Array）形状一致。
readFileBytes?(relativePath: string): Promise<{ bytes?: Uint8Array; size?: number; error?: string }>
```

- **local**（`workspace-file-provider.ts` + electron）：新增 IPC `local-read-bytes`。main.cjs 实现严格对齐 `localReadFile`（main.cjs:1896-1925）的安全口径：同一 `resolveWorkspacePath`、`lstatSync` 拒绝目录 / symlink、大小上限 `LOCAL_READ_BYTES_MAX = 64MB`，返回 Buffer（Electron IPC structured clone 原生支持，无需 base64）。preload.cjs 暴露 `localReadBytes`（紧邻 `localReadFile` :63）。
- **cloud**：`fetch(workspace-download?sessionId&path)` + Authorization 头 + token query 兜底（复用 `downloadWorkspaceResource` 的 fetch 模式，:397-428）→ `resp.arrayBuffer()`。**端点 / 响应头 / 权限一行不改**。
- **project**：不实现。FileViewer 对 `readFileBytes` 缺失显示「该文件需要在会话工作区中打开预览」（project 模式本就没有下载能力，不做半吊子实现）。
- 失败统一走 `{ error }`，FileViewer 转 error 态（既有 error 态复用，不新增态）。

### 5.3 CSV / TSV 表格视图（P1，`components/center/CsvTableView.vue`）

- 数据：既有 `readFile` 内容 → `utils/csv-parse.ts` 解析（决策 4：5000 行 / 512KB 口径与文本预览一致，超限在表格下方显示既有款式的截断提示）。
- 解析器（纯函数，node 全测）：分隔符 sniff（`,` `;` `\t`，按首行出现频次定）、引号与 `""` 转义、CRLF / LF、ragged rows 按最宽行补齐、跳过空行、列数上限 512；返回值 `{ rows: string[][], truncated }`。
- 视图：表头吸附（sticky thead）、数值列右对齐启发式（该列 ≥80% 单元格可 `Number()` 解析）、hover 行高亮、斑马纹；行数 > 200 启用简单窗口化虚拟滚动（固定行高 32px，scroll 事件算窗口，不引依赖）。
- 复制：hover 工具条「复制 CSV / 复制 Markdown」，直接调 `tableToCsv(rows)` / `rowsToMarkdown(rows)`（tableCopy.ts:12-40，DOM 序列化路径，本组件表格即数据源无需 `data-table-md`）。交互沿用 document 级委托太重复——本组件用 Vue `@click`（组件自有按钮，非注入 HTML，无白名单问题）。
- 安全：全部 Vue 文本插值，零 v-html。
- 刷新 / 下载：组件工具栏（照 PdfViewer 范式，§5.8）。

### 5.4 ZIP 浏览（P1，`components/center/ArchiveBrowser.vue`）

- 流程：`JSZip.loadAsync(bytes)`（只读中央目录，不解压内容）→ 条目列表（名称 / 解压大小 / 压缩率 / 目录标识，扁平展示 + 目录分组折叠二选一，推荐扁平 + 排序）。
- **zip 炸弹三道防线**（决策 2 的懒解压是前提）：
  1. 条目数 > `ZIP_MAX_ENTRIES`（500，对齐后端 MAX_ENTRIES）→ 拒绝并提示下载；
  2. 中央目录 `uncompressedSize` 合计 > `ZIP_MAX_TOTAL_BYTES`（500MB）→ 拒绝；
  3. 单条目 `uncompressedSize` > `ZIP_MAX_ENTRY_BYTES`（100MB）→ 该条目标灰不可预览，仅整包下载。
- 条目点击行为（P1 范围，避免引入「内存 provider」抽象污染 CenterTabs 状态机）：
  - 图片 → `createObjectURL` → `<img>`（内嵌预览态）；
  - PDF → `<PdfViewer :blob-url :provider="null">`（下载按钮随 `v-if` 隐藏，PdfViewer 对 null provider 已安全，:13/:24-25/:258-263）；
  - md / 文本 → 内存 `<pre>` 等宽预览（标注「压缩包内预览」，不做语法高亮——不为包内条目拉起第二套 Monaco）；
  - 其他 → 该单条目 blob 触发 `a.download`（文件名取条目名）。
- 安全：条目名纯文本展示（Vue 转义），**全程不落盘、无路径穿越面**；`../../` 类条目名仅作为字符串显示。
- 「返回条目列表」：内嵌预览态顶部提供返回，覆盖层状态在组件内管理（§6-D3）。

### 5.5 XLSX（P2，`components/center/SpreadsheetView.vue`）

- `exceljs`：`new ExcelJS.Workbook().xlsx.load(buffer)` → sheet 列表 → 每 sheet 抽 `rows: string[][]`：`cell.value` 取计算值（公式单元格为 `{formula, result}` 时取 `result`；富文本取 `richText` 拼接 `text`；日期序列号按 1899-12-30 纪元转 `YYYY-MM-DD`）。
- 视图：sheet tab 切换 + 复用 §5.3 的表格网格（抽 `TableGrid.vue` 公共子组件：props = rows + 虚拟滚动阈值，CsvTableView 与 SpreadsheetView 共用）。
- 上限：文件 `XLSX_MAX_BYTES`（20MB）、单 sheet `XLSX_MAX_ROWS_PER_SHEET`（5 万行）、总单元格 `XLSX_MAX_CELLS_TOTAL`（100 万）——任一超限提示「表格过大，请下载后查看」。
- 依赖安全：决策 1；实施时 `npm audit` 留档。
- **audit 留档（2026-10-26，desktop `npm audit`）**：引入 `exceljs@4.4.0` / `mammoth@1.13.0` / `jszip@3.10.2` 后总量 51（2 low / 7 moderate / 37 high / 5 critical），与引入前同量级——存量 50 条来自 vite / electron / tiptap / adm-zip 等既有依赖。新增仅 1 条 moderate：`exceljs >=3.5.0` 传递依赖 `uuid` 的 buffer bounds 检查（GHSA-w5hq-g745-h8pq，v3/v5/v6 提供 buf 时触发）；exceljs 全仓只用 `uuid.v4`（`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`），不触达脆弱路径，且唯一修复是降级 exceljs@3.4.0（breaking，放弃）。判定：可接受，记录在案。mammoth / jszip 无 audit 记录。

### 5.6 DOCX（P2 伸展，`components/center/DocxPreview.vue`）

- `mammoth.convertToHtml({ arrayBuffer })` → `DOMPurify.sanitize(html, SANITIZE_OPTIONS)`（**主链同款选项**：默认白名单 + `ADD_ATTR:['target']`，useMarkdown.ts:119）→ v-html 进 `.markdown-body` 容器（复用 FileViewer 既有样式类）。
- 失败 / 超 10MB → 降级下载。去留由决策 6 定。

### 5.7 媒体（P3，`components/center/MediaPlayer.vue`）

- `<video controls>` / `<audio controls>`（按扩展名分支）+ blob URL；≤ `MEDIA_MAX_BYTES`（50MB，决策 5）播放，超限工具栏提示「文件较大（N MB），已转为下载」并触发 `downloadFile`。
- 生命周期纪律：切文件 / `onDeactivated`（KeepAlive）/ `onUnmounted` 三处 `pause()` + `revokeObjectURL`（照 PdfViewer 的 loadSeq + deactivate 范式）。
- 下载按钮：`provider.downloadFile` 存在时显示（CLOUD）；LOCAL 下显示「在 Finder 中显示」（`electronAPI.showItemInFolder(provider.getAbsolutePath(path))`，preload.cjs:55 既有 IPC）。

### 5.8 工具栏统一范式（全部新组件）

每个新组件自带顶部工具条（照 `PdfViewer.vue:3-16`）：刷新（emit 回 FileViewer 重走 dispatch）/ 下载（按 §5.7 规则显隐）/ 文件信息（名称 + 大小）。**不移动 FileViewer 现有刷新按钮位置**（:41-43 仅在 ready 态渲染，既有用户习惯零变化）。

### 5.9 主题与样式

全部使用既有 `--aw-*` 设计 token（FileViewer.vue:300-627 同套）；深浅主题随 `data-theme` 自动生效，无新色彩决策；表格密集信息在深色下的对比度进冒烟目检（§6-E2）。

## 6. 冲突与风险清单（逐项）

> 每项给出代码依据与应对；标 ★ 为设计红线，违反即产生真冲突。

### A. 与 FileViewer 现状

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| A1 | ★既有五条路径被误改 | FileViewer.vue:201-260 | 设计约束：二进制类新格式（zip / xlsx / media / docx）以「扩展名命中 → 早返回」形式在 readFile 之前平行追加；文本类新格式（csv）只在 readFile 成功后的分支点改道（kind==='csv' → state='csv' 代替 state='ready'）；既有 md / pdf / image / binary / empty / ready 六态语义一行不动；回归集（§9）锁定五态行为 |
| A2 | ★新异步路径缺代际守卫 → 快速切文件时旧 bytes / 旧解析结果覆盖新状态 | :168-174 既有范式 | 所有新分支 await 后统一 `isStaleLoad(seq)` 检查；JSZip / exceljs 的 async 解析同样在守卫内 |
| A3 | 文件变更防抖重载（:278-289）对新态失效 | watch 调 `loadFile` 总入口 | 新态保持经 `loadFile` 进入，自动获得变更重载；子组件刷新按钮也 emit 回总入口 |
| A4 | Monaco 被新态误激活 | :109 `monacoEnabled` | 新态是平行 state 值，`state==='ready'` 条件天然排除；加一条 dispatch 单测断言新态不触 `loadMonaco` |
| A5 | KeepAlive(:max=20) 下新组件不释放资源（blob URL / 观察器 / 媒体播放） | CenterTabContainer.vue:3-10 | 照 PdfViewer：`onDeactivated` 暂停 + `onUnmounted` 释放（§5.7）；jsdom 单测断言 unmount 后 revoke 被调用 |
| A6 | 刷新按钮位置 / 形态变化影响既有习惯 | :41-43 | 既有按钮原地不动；新态自带工具条（§5.8） |
| A7 | `viewMode` / `showSource` 是 markdown 专属概念被新态污染 | :91,107 | 新态不进入该分支；csv 等态的「源码查看」不做（v1 表格即最终形态） |

### B. 与 Provider / 后端 / Electron

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| B1 | ★LOCAL 拿不到二进制字节（zip / xlsx / 媒体） | main.cjs:1896-1925 只回文本 / data_uri | 新增 `local-read-bytes` IPC（§5.2）；复用同一 `resolveWorkspacePath` + lstat 校验 + 64MB 上限，不建第二套路径解析 |
| B2 | CLOUD 复用 `workspace-download` 是否改变其「下载」语义 | file.routes.ts:152-160 | 不改端点 / 响应头 / 权限；fetch blob 对 `attachment` 无感知，纯消费方扩展 |
| B3 | project provider（新建态）无字节通道 | workspace-file-provider.ts:303-382 | 明确降级文案（§5.2），不半实现 |
| B4 | 后端零改动论证 | §2.4 | `downloadFile` / `readPdfFile` 无格式限制；评审可核 |
| B5 | adm-zip 已在 desktop 依赖中，误以为浏览器可用 | package.json:20 | Node 向库（Buffer/fs），浏览器不可用；选型 jszip（决策 2） |
| B6 | fetch 鉴权模式与既有不一致 | downloadWorkspaceResource :397-428 | 复用同模式（Authorization 头 + token query 兜底） |
| B7 | sniff 兜底只在 LOCAL 可达（CLOUD readFile 对二进制直接报错） | workspace-browse.service.ts:333-341 | 记录为已知不对称：CLOUD 下「无扩展名的 zip」保持现状错误态；Agent 产出的压缩包均有扩展名，实际影响近零。实现期修正：sniff 原被放在 `isBinaryContent` 之后，导致真实 zip（本地头第 5 字节必为 0x00）100% 落 binary 态、兜底永不生效；已按 §4 架构图挪回 binary 检查之前，并用真实 jszip STORED / DEFLATE 包回归（review round1 #1） |

### C. 性能与包体

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| C1 | ★新库进首屏主 chunk | check-main-chunk.mjs 机制 | 全部动态 import；FORBIDDEN 扩充新库内部字面量（实施时从产物挑 1-2 个本仓源码不含的串，如 jszip 的中央目录错误消息、exceljs 的流标识；**不能按 chunk 文件名判断**——脚本注释既有教训） |
| C2 | 大 CSV（5000 行宽列）渲染卡顿 | — | 行数 > 200 窗口化虚拟滚动；解析 <50ms 级可接受；512KB 内容上限天然兜底（决策 4） |
| C3 | exceljs 全量 load 内存 | — | 20MB 文件 / 100 万单元格上限（§5.5），超限降级下载 |
| C4 | 超大 zip 中央目录 loadAsync 耗时 | 后端 zip 上限 1GB（DEFAULT_MAX_ZIP_BYTES） | 条目数 + 总大小双上限先拒；loading 态 + 取消（切文件即作废，A2） |
| C5 | 媒体 blob 常驻内存 | — | 50MB 阈值（决策 5）+ 三处 revoke 纪律（§5.7） |
| C6 | pdfjs-dist 静态 import 已在主 chunk（现存） | PdfViewer.vue:51 | 本方案不扩大静态面；动态化 PdfViewer 列为可选清理**不做**（改加载态有行为风险） |

### D. 多实例与并发

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| D1 | 多个 FileViewer tab（KeepAlive 20）各持 blob / 解析态 | CenterTabContainer.vue:3 | unmount 释放纪律（A5）；blob URL 组件内私有不共享 |
| D2 | 快速切换文件时并发解析 | :168-174 | seq 守卫 + 子组件内部 loadSeq（照 PdfViewer:128） |
| D3 | zip 条目点击产生「嵌套预览」若开新 tab 会污染 CenterTabs 状态机（:key version 机制不适用内存内容） | useCenterTabs.ts:247-255 | 用组件内内存预览覆盖层（§5.4），不开新 tab |

### E. 主题

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| E1 | 新组件色彩偏离设计体系 | FileViewer.vue:300-627 token 用法 | 全部 `--aw-*` token；深浅自动 |
| E2 | 密集表格深色对比度 | — | 冒烟目检（深浅两主题各过一遍） |

### F. 安全

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| F1 | ★新增 HTML 注入面 | — | CSV / XLSX / ZIP 零 v-html（Vue 文本插值）；DOCX 唯一 v-html 且 DOMPurify 主链同选项（§5.6）；主链 `SANITIZE_OPTIONS` 永不改（code review 检查项） |
| F2 | zip 炸弹 | — | 三道防线（§5.4）：条目数 / 总解压大小 / 单条目大小；懒解压是前提 |
| F3 | zip 条目名伪造路径 | — | 不落盘、仅文本展示；无穿越面 |
| F4 | XLSX 公式 / 超链接执行或外联 | — | 只渲染计算值与纯文本；不做可点链接（v1） |
| F5 | 媒体外联 | — | blob URL 同源；无外部 src |
| F6 | 依赖供应链（exceljs / jszip / mammoth） | 内网禁 CDN 硬约束 | 全部 npm 本地打包 + 动态 chunk；`npm audit` 留档；code review grep CDN 域名 |
| F7 | 恶意构造 xlsx（巨大 shared strings / 深度嵌套） | — | 单元格总量上限（§5.5）；exceljs 解析失败即降级下载 |

### G. 兼容

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| G1 | 安卓 WebView 差异 | Capacitor 远程加载 | 纯 JS 解析无兼容问题；`<video>` 现代 WebView 成熟；冒烟 |
| G2 | ★Electron H.264 专有编解码缺失：官方 Electron 构建不解码 H.264，mp4 可能「有声音黑屏」 | Electron 已知约束 | 媒体白名单 webm / ogg / wav 为主；mp4 / mov 标注「依赖编解码支持，失败可一键下载」；冒烟清单必查；不在本方案引 ffmpeg 专有包 |
| G3 | 低性能机大文件 | — | 上限 + 降级下载；虚拟滚动 |
| G4 | CSV 地区分隔符差异（欧洲 `;`） | — | sniff 覆盖（§5.3） |

### H. 回归与测试基建

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| H1 | node 环境跑不了 DOM 全链 | vitest environment: 'node' | 分层：判定 / CSV 解析 / 序列化 / 上限逻辑 = node 纯函数单测；dispatch = jsdom 单文件（先例 markdown-sanitize.dom.test.ts）；真实渲染 = 手动冒烟（与 message-rendering §9 同口径） |
| H2 | FileViewer 现无单测 | center/ 目录既有测试惯例 | 新增 dispatch 回归即增量：md / pdf / image / binary / empty 五态 mock provider 断言不进入新分支 |
| H3 | 误触 AGENTS.md「三处同改」规范 | 本方案不新增内置工具 / LLM 场景 / 收件箱 kind / contracts 枚举 | 不触发；评审时对照规范清单确认 |
| H4 | check-main-chunk 扩充误报 | 字面量挑选 | 字面量须为本仓源码不含的库内部串；本地 `npm run build` 全绿才合 |

## 7. 改动面

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 依赖 | `desktop/package.json`：`exceljs`、`jszip`（P2 再加 `mammoth`） | 新增（全部动态 chunk） |
| desktop/electron | `main.cjs`（`local-read-bytes` IPC，约 25 行）、`preload.cjs`（暴露，1 行） | 小 |
| desktop | `composables/workspace-file-provider.ts`：`readFileBytes` 接口 + local / cloud 两实现 | 小~中 |
| desktop | `components/center/FileViewer.vue`：dispatch 扩展 + 5 个新态模板分支（早返回式） | 中 |
| desktop | 新组件：`CsvTableView.vue`、`ArchiveBrowser.vue`、`SpreadsheetView.vue`、`MediaPlayer.vue`、（P2）`DocxPreview.vue`、公共 `TableGrid.vue` | 主要工作量 |
| desktop | 新 utils：`file-preview-format.ts`、`csv-parse.ts`（+ 对应 `.test.ts`） | 中 |
| desktop | `scripts/check-main-chunk.mjs`：FORBIDDEN 扩充 | 极小 |
| backend-ts / admin / agent-cli / mao-cli / android | 无 | 零改动零迁移 |

注：admin 的 `WorkspaceFileDialog.vue` 是另一套独立实现（会话附件场景），不在本方案范围。

## 8. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | dispatch + provider/IPC（无 UI 可先行合）→ CSV 表格 → ZIP 浏览 → check-main-chunk 扩充 + 冒烟 | 3-4 人日 |
| P2 | XLSX（+ TableGrid 抽取）→ DOCX 伸展（决策 6） | 2 人日 |
| P3 | 媒体播放 + 阈值降级 + Finder 显示 | 1-2 人日 |

P1 内部顺序：判定纯函数 + 单测 → `readFileBytes` 三端实现 + IPC → dispatch 接线（新格式先进「加载中」占位）→ CSV → ZIP。每步独立可回归。

## 9. 测试方案

- **node 单测**：判定表（全扩展名 / 大写 / 双扩展名 / null 回落 / sniff 两条）；CSV 解析（引号转义、CRLF、分隔符 sniff 三种、ragged rows、空行、列上限、5000 行截断）；序列化（`tableToCsv` / `rowsToMarkdown` 既有函数复用断言）；上限常量单调性。
- **jsdom 单文件**：FileViewer dispatch——mock provider（readFile 返回 csv 文本 / readFileBytes 返回小 zip / 超限 bytes）断言进入对应子组件；既有五态不进入新分支（H2）；unmount 后 blob revoke 被调用（A5）。
- **Electron IPC**：`local-read-bytes` 单测（照 electron/*.test.cjs 既有 node --test 范式）：正常读取、目录拒绝、symlink 拒绝、超 64MB 拒绝、工作区外路径拒绝。
- **CI**：`npm run build`（vue-tsc -b + vite build + check-main-chunk）+ vitest 全绿。
- **手动冒烟矩阵**（Web / Electron / 安卓 × CLOUD / LOCAL × csv / zip | xlsx | 媒体 × 深浅主题 × 5000 行截断 × 炸弹用例 × KeepAlive 多 tab 切换 × 变更重载）。

## 10. 验收标准

1. Agent 产出的 CSV / XLSX / ZIP / 媒体文件在文件树双击即可阅读 / 播放 / 浏览，无需下载找外部工具。
2. **既有五条预览路径行为零变化**（md / PDF / 图片 / 文本 / 二进制，回归集 + 冒烟证明）；CLOUD 打开新格式不再出现「文件读取失败」错误态与全局 toast。
3. 后端 / admin / agent-cli / mao-cli 零改动零迁移（评审可核）；安卓经同一前端链路自动获得能力。
4. 主 chunk 不含新库字面量（CI 断言绿）；不含新格式的会话首屏零增长。
5. 恶意 / 炸弹用例集全部安全降级（条目超限、总大小超限、单条目超限、伪造条目名、超大树）。
6. 冒烟矩阵通过；Electron H.264 场景按「降级下载」口径可接受。

## 11. CHANGELOG 与文档同步（实施时同任务）

- CHANGELOG「前端（桌面 / Web / 安卓）」节：P1 / P2 / P3 各一条。
- `skills/mao-cli/reference/desktop.md`：文件预览能力段补格式清单。
- README「核心能力」工作区行可选补半句（「报表 / 压缩包 / 音视频可直接预览」）。
- 本提案状态回填「已细化」，README 第十七批索引同步。

## 12. 残余风险

| 风险 | 概率 | 缓解 |
|---|---|---|
| exceljs 对超大 / 畸形 xlsx 性能差 | 中 | 上限先行（§5.5）；实测差则把 XLSX 降回 P2 伸展项 |
| Electron H.264 解码缺失导致 mp4 体验差 | 高（官方构建已知） | 白名单引导 webm；降级下载路径 always 可用 |
| JSZip 对 zip64（>4GB）不支持 | 低 | 加载失败降级下载；文案明示 |
| mammoth 对复杂 docx 转换质量参差 | 中 | 决策 6 留的后路：直接不做 |
| zip 炸弹新型构造绕过中央目录大小声明 | 低 | 三道防线 + 解压本身在渲染进程、单条目上限后仍可能吃内存——最坏情况是单个 tab OOM 崩溃，不影响主进程与其他 tab（渲染进程隔离）；可接受 |
| FileViewer E2E 覆盖缺口（历史降级冒烟） | 中 | 纯函数 + jsdom dispatch 覆盖核心逻辑；真实渲染冒烟矩阵化 |

## 13. 实现期评审修正（review round1）

子代理 code review（`docs/code-review/2026-10-26-round1-workspace-file-preview.md`）报 5 个低严重度问题，全部已修复并补回归：

| # | 问题 | 处理 |
|---|---|---|
| 1 | sniff 兜底被放在 binary 检查之后，对真实 zip 100% 不可达（§6-B7 行已回填） | 按 §4 架构图挪回 binary 之前；dispatch 测试改用含 NUL 的真实内容 + 真实 jszip STORED / DEFLATE 双包回归 |
| 2 | ArchiveBrowser 条目解压失败只写 `errorMsg`，而它仅在整包 error 态渲染 → 点击损坏条目毫无反馈 | 新增 `entryError` 行内横幅（ready 态可见，不踢出条目列表），下次点击自动清除；真实损坏包回归 |
| 3 | check-main-chunk 的 jszip 字面量与库产物差一个空格，该条守卫恒不命中 | 改为产物实际串 `Corrupted zip : CRC32 mismatch`（同串覆盖 exceljs 内置 jszip），并补 mammoth 独有串 |
| 4 | §6-G2 ★红线要求的 mp4 / mov 编解码标注与播放失败兜底未落地 | 工具条常驻「依赖编解码支持，播放失败可点下载」；`<video|audio @error>` 落错误态 + 下载 / Finder 双出口 |
| 5 | LOCAL（无 downloadFile）下 xlsx / docx 超上限、zip 被拒时降级态死路 | 抽出 `useShowInFinder` composable（MediaPlayer 与三个降级态共用），降级态补「在 Finder 中显示」出口 |

round2 / round3（`docs/code-review/2026-10-26-round2-workspace-file-preview.md`、`-round3-`）复核上述修复全部有效且未引入回归，另修 2 个问题：

| # | 问题 | 处理 |
|---|---|---|
| 6 | PDF 代际守卫竞态（既有缺陷，本次新分支放大触发面）：`loadPdfPreview` 单独 `++pdfPreviewSeq`，而 `loadFile` 又执行 `pdfPreviewSeq = loadFileSeq`，两个计数器序号碰撞使 PDF 的陈旧守卫失效——a.pdf 切到 b.zip 后迟到的 `previewFile` 会把界面持久覆盖回 a.pdf | 删掉 `pdfPreviewSeq`，`loadPdfPreview(seq)` 改为接收 `loadFile` 传下来的 seq，PDF 与文本/图片/新格式共用单一 `loadFileSeq` + `isStaleLoad`；新增「PDF 迟到时已切到 zip」回归（变异验证：去掉守卫即红） |
| 7 | ArchiveBrowser / SpreadsheetView / DocxPreview 的刷新按钮走本地 `reload()`（重解析同一份内存字节），不符合 §5.8「emit 回 FileViewer 重走 dispatch」，LOCAL 外部改动文件后刷新拿不到磁盘新内容 | 三个组件刷新按钮改为 `$emit('refresh')` 并删除各自 `reload()`，与 CsvTableView / MediaPlayer 一致；各补一条「emit 生效且本地解析计数不增」回归 |

round3 结论：无重大问题，可合入；round1 五处修复完好。
