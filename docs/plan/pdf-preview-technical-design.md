# PDF 文件预览技术方案

> 状态：方案已确认（待实施）｜版本：2026-08-06
> 适用范围：desktop 前端（Web / Electron / 安卓 Capacitor 三端共用）+ backend 后端 + Electron 主进程

## 1. 需求背景

当前客户端（desktop 前端，三端共用一份构建产物）的文件预览能力仅覆盖三类：

- **图片**：CLOUD 模式后端 `/files/workspace-read` 返回 `media_type=image` + base64 `data_uri`；LOCAL 模式 Electron `local-read-file` 同样识别图片；
- **文本**：按 UTF-8 文本读取，最多 5000 行；
- **其余一律按二进制处理**：显示「二进制文件，无法预览」。

PDF 落在第三条路径上：CLOUD 模式后端 `WorkspaceBrowseService.readFile` 对 PDF 执行 `Files.lines` 文本解码失败，抛出「二进制文件，无法预览」（`WorkspaceBrowseService.java:282`）；LOCAL 模式同样无法处理。用户在工作区文件浏览器中打开 PDF 得不到任何有效预览，只能走「下载后在本地阅读器打开」这一条路。

## 2. 需求描述

### 2.1 目标

在工作区文件浏览器的中心 Tab（`FileViewer.vue`）中，支持直接预览 `.pdf` 文件，覆盖 Web、Electron、安卓三种客户端。预览能力包括：连续滚动逐页渲染、缩放（适合宽度 / 实际大小 / 放大 / 缩小）、页码显示、加载进度、下载按钮（复用现有下载能力）。

### 2.2 要做的（本次范围）

1. **后端新增独立二进制预览接口** `GET /api/v1/files/workspace-preview`，返回 `application/pdf` 字节流（CLOUD 模式数据通道）。
2. **Electron 主进程扩展 LOCAL 数据通道**：`local-read-file` IPC 对 PDF 返回 base64 `data_uri`（LOCAL 模式数据通道）。
3. **前端新增 `PdfViewer.vue` 组件**：基于 pdf.js 渲染 PDF，提供基础交互（滚动、缩放、页码、进度、下载）。
4. **`FileViewer.vue` 集成**：按扩展名 `.pdf` 分流到 PDF 预览分支。
5. **文件 Provider 扩展**：`WorkspaceFileProvider` 增加 PDF 预览能力，CLOUD / LOCAL 两套实现各自封装数据获取，对组件层统一暴露 Blob。
6. **错误兜底**：加密 / 损坏 / 非 PDF 内容的 `.pdf` 文件，显示明确错误提示，并保留下载入口。
7. **主题适配**：预览组件的外围 UI（工具栏、加载框、滚动条）跟随现有深浅色主题；PDF 页面内容保持原生白底。
8. **测试**：后端补单测（沙箱路径校验、非 PDF 拒绝、越权拒绝）；附三端手动验证清单。
9. **CHANGELOG 更新**：根目录 `CHANGELOG.md` 的 `### 后端` 与 `### 前端（桌面 / Web / 安卓）` 两节。

### 2.3 不做的（明确排除）

| 事项 | 说明 |
|------|------|
| 聊天附件 PDF 预览 | 聊天 `message.files` 附件维持现状（仅文件名 tag），本次不做 |
| Agent `ReadFileTool` 支持 PDF | 后端 harness 链路不动；LLM 读 PDF 仍会文本解析失败，属后续独立需求 |
| 大小 / 页数限制 | 不做任何大小与页数上限（用户决策），超大 PDF 的安卓内存风险见 §7 |
| 文本选择层（textLayer） | 不做选中复制能力 |
| 全屏模式 | 不做 |
| 书签大纲侧栏 / 内部链接跳转 | 不做 |
| 暗色反色 | PDF 内容不做 CSS 反色，保持原生白底 |
| admin 端任何改动 | 不涉及 |
| Playwright E2E | 不新增前端自动化用例（现有 E2E 仅覆盖登录与主题），以手动清单为准 |

## 3. 技术选型

### 3.1 渲染引擎：pdf.js（`pdfjs-dist`）

| 方案 | 说明 | 结论 |
|------|------|------|
| iframe / 浏览器原生 PDF 渲染 | Web 与 Electron 可用，但**安卓 Capacitor WebView 无原生 PDF 渲染**，白屏 | 排除 |
| 后端 PDFBox 逐页转图片 | 服务器 CPU 与内存开销随文档大小线性增长，多端并发时成本高 | 排除 |
| **pdf.js 前端渲染** | 纯前端 canvas 渲染，三端同一份产物；渲染开销在客户端 | **选定** |

引入方式（已确认）：

- `npm install pdfjs-dist`（^4.x，ESM 模块，Vite 原生支持）；
- worker 文件通过 `?url` 导入打包进构建产物（`pdf.worker.min.mjs` 随 `desktop/dist` 部署 Nginx），**不依赖任何外部 CDN**，Electron / 安卓离线可用；
- 三端共用同一份构建产物，无需按端差异化构建。

### 3.2 数据通道

**CLOUD 模式（后端 → 前端）**：独立二进制接口，返回字节流，前端 `fetch` → `Blob`。

- 选此方案而非复用 `/files/workspace-read` 返回 base64：避免 JSON 内嵌 base64 造成 33% 体积膨胀与双份内存，且字节流可流式传输。

**LOCAL 模式（Electron 主进程 → 渲染进程）**：扩展现有 `local-read-file` IPC，对 PDF 返回 base64 `data_uri`（用户决策，实现最简），前端统一转 `Blob`。

**组件层统一**：两种模式的 Provider 各自负责把数据封装为 `Blob` 返回，`PdfViewer.vue` 只消费 `Blob → objectURL`，不感知执行模式。

### 3.3 关键决策记录

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 预览入口范围 | 仅文件浏览器中心 Tab；聊天附件不做 |
| 2 | Agent 边界 | 不涉及 `ReadFileTool` |
| 3 | CLOUD 数据通道 | 独立二进制接口 `/files/workspace-preview` + Blob |
| 4 | LOCAL 数据通道 | IPC `local-read-file` 扩展 + base64 |
| 5 | pdf.js 引入 | npm 依赖，worker 打包进产物，无 CDN |
| 6 | 交互能力 | 基础集：滚动 / 缩放 / 页码 / 进度 / 下载 |
| 7 | 大小 / 页数限制 | 不限制 |
| 8 | 暗色模式 | 外围 UI 适配主题，内容白底 |
| 9 | 测试范围 | 后端单测 + 手动验证清单 |
| 10 | 交付物 | 本方案文档；代码实施待用户另行确认 |

## 4. 总体设计

### 4.1 数据链路

```
【CLOUD】工作区在服务器
FileViewer ── provider.previewFile(path) ──> GET /files/workspace-preview?sessionId&path
        <── application/pdf 字节流 ──> Blob ──> objectURL ──> PdfViewer（pdf.js 渲染）

【LOCAL】工作区在本地
FileViewer ── provider.previewFile(path) ──> ipcRenderer.invoke('local-read-file', {path, pdf:true})
        <── { media_type:'pdf', data_uri: base64 } ──> Blob ──> objectURL ──> PdfViewer（pdf.js 渲染）
```

两种模式在 `PdfViewer` 组件层完全统一，差异只封装在 Provider 内部。

### 4.2 涉及文件

| 端 | 文件 | 改动 |
|----|------|------|
| 后端 | `backend/.../file/service/WorkspaceBrowseService.java` | 新增 `readPdfFile` 方法（沙箱校验 + 读字节流 + 魔数校验） |
| 后端 | `backend/.../file/controller/FileController.java` | 新增 `GET /workspace-preview` 接口（复用 `requireOwnedSession`） |
| 后端 | `backend/src/test/...` | 新增单测（沙箱逃逸 / 非 PDF / 正常返回） |
| Electron | `desktop/electron/main.cjs` | 扩展 `local-read-file`：`.pdf` 时返回 base64 `data_uri` |
| 前端 | `desktop/src/composables/workspace-file-provider.ts` | `WorkspaceFileProvider` 增加 `previewFile`；CLOUD / LOCAL 两套实现 |
| 前端 | `desktop/src/components/center/PdfViewer.vue` | 新增：pdf.js 渲染 + 工具栏 |
| 前端 | `desktop/src/components/center/FileViewer.vue` | `loadFile` 增加 `.pdf` 分流与 `'pdf'` 状态分支 |
| 前端 | `desktop/package.json` | 新增依赖 `pdfjs-dist` |
| 文档 | 根 `CHANGELOG.md` | 后端 / 前端两节补条目 |

## 5. 实现步骤

### 5.1 后端（CLOUD 通道）

1. `WorkspaceBrowseService` 新增 `readPdfFile(Path filePath, String relativePath)`：
   - 复用现有 `resolvePath` 沙箱（路径逃逸 → `FORBIDDEN`）；
   - 校验 `Files.isRegularFile`；
   - 读取前 5 字节校验 PDF 魔数 `%PDF-`，魔数不符视为损坏/伪 PDF，抛业务异常（前端据此显示错误提示）；
   - 返回文件路径与大小（`DownloadResult` 结构类似，或直接返回 `Path`），字节流由 Controller 以 `FileSystemResource` 写出。
2. `FileController` 新增：

   ```
   GET /api/v1/files/workspace-preview?sessionId=<id>&path=<相对路径>
   ```

   - 复用 `requireOwnedSession` 做会话归属校验（与 `workspace-read` / `workspace-download` 一致）；
   - `Content-Type: application/pdf`，`Content-Disposition: inline; filename="<原名>.pdf"`，`contentLength` 使用实际字节数；
   - 异常（文件不存在、非普通文件、非 PDF 内容）经全局异常处理返回统一 `Result<T>` 错误码。
3. 单测覆盖：沙箱路径逃逸被拒、非 `.pdf` 扩展名被拒、`%PDF-` 魔数缺失被拒、正常 PDF 返回 200 与正确 content-type。

> 注意：`workspace-read` 对 PDF 保持现有行为不变（仍按文本解码失败报「二进制文件」）；PDF 预览完全走新接口，互不影响。

### 5.2 Electron（LOCAL 通道）

1. `main.cjs` 的 `local-read-file` 处理器：当扩展名为 `.pdf` 时，读取字节并返回
   `{ media_type: 'pdf', mime: 'application/pdf', data_uri: 'data:application/pdf;base64,...' }`（参照现有 `readLocalImage` 的实现模式）；
2. `preload.cjs` 无需新增暴露（复用现有 `localReadFile` 通道）。

### 5.3 前端

1. **依赖**：`desktop/package.json` 增加 `pdfjs-dist`（^4.x）；在 `PdfViewer.vue` 中：

   ```ts
   import * as pdfjsLib from 'pdfjs-dist'
   import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
   pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker
   ```

2. **Provider 扩展**（`workspace-file-provider.ts`）：

   - 接口新增 `previewFile?(relativePath): Promise<{ blob?: Blob; error?: string }>`；
   - `CloudProvider.previewFile`：`fetch` 独立接口（带 `Authorization`），非 2xx 解析错误信息，成功返回 `{ blob }`；
   - `LocalProvider.previewFile`：`window.electronAPI.localReadFile` 对 PDF 返回的 base64 → `atob` 转 `Uint8Array` → `Blob`。

3. **`PdfViewer.vue`**（新增组件）：

   - props：`blobUrl: string`、`fileName: string`、`provider`（用于下载）；
   - 生命周期：挂载后 `pdfjsLib.getDocument({ url: blobUrl })` 加载 → 获取 `numPages` → 逐页渲染 `canvas`（`render` 任务链式排队，避免并发 OOM）；
   - 工具栏：页码「当前页 / 总页数」、上一页 / 下一页、缩放（`适合宽度` / `实际大小` / 放大 / 缩小）、下载按钮（调 `provider.downloadFile`）；
   - 滚动容器：`IntersectionObserver` 或滚动位置计算当前页，更新页码显示；
   - 缩放：按 `scale` 重渲染当前可视页；
   - 加载进度：`getDocument` 的 `onProgress` 回调更新进度条；
   - 错误态：`getDocument` 抛错（加密 / 损坏 / 非法内容）时显示错误文案 + 下载按钮兜底；
   - 卸载：取消未完成任务（`RenderTask.cancel`）、`doc.destroy()`、`URL.revokeObjectURL(blobUrl)`（blob URL 由组件负责创建与释放，Provider 只负责产出 `Blob`）；
   - 样式：使用现有主题变量（`--aw-surface`、`--aw-ink-*` 等），内容区白底。

4. **`FileViewer.vue` 集成**：

   - `LoadState` 增加 `'pdf'`；
   - `loadFile()` 前置判断：扩展名 `.pdf` → 调 `provider.previewFile` → 成功则 `URL.createObjectURL(blob)`、`state='pdf'`；失败则 `state='error'` 展示错误信息；
   - 模板增加 `<PdfViewer v-else-if="state === 'pdf'" ... />` 分支；
   - 文件变更自动刷新（现有 `matchingChangeCount` watch）对 PDF 同样触发重新加载（PDF 变更后重建预览）。

5. **安卓**：无需任何额外改动。Capacitor WebView（现代 Chromium）直接支持 pdf.js；前端构建产物部署后三端同步生效。

### 5.4 测试

- **后端单测**（`backend/src/test/`）：按 §5.1 列出的用例补充；
- **手动验证清单**（三端各执行一遍）：

  | 场景 | 预期 |
  |------|------|
  | 正常 PDF（多页） | 打开即显示，逐页滚动，页码正确 |
  | 缩放（适合宽度 / 实际大小 / ±） | 页面随缩放重渲染，不模糊失真 |
  | 下载按钮 | 触发浏览器/系统下载，文件完整可打开 |
  | 加密 PDF | 显示「无法预览」错误 + 下载入口可用 |
  | 损坏 / 伪 PDF（改扩展名） | 同上 |
  | 空 `.pdf` 文件 | 显示错误提示，不白屏 |
  | 大 PDF（几十 MB / 数百页） | 能滚动渲染，加载有进度提示 |
  | 暗色主题 | 工具栏可读，内容白底 |
  | CLOUD 模式 | 文件浏览器打开 PDF 正常 |
  | LOCAL 模式（Electron） | 文件浏览器打开 PDF 正常 |
  | 安卓（CLOUD 远程加载） | 文件浏览器打开 PDF 正常 |

## 6. 落地清单

- [ ] `backend`：`WorkspaceBrowseService.readPdfFile`（沙箱 + 魔数校验）
- [ ] `backend`：`FileController` 新增 `GET /files/workspace-preview`
- [ ] `backend`：新增单测并通过 `cd backend && mvn test`
- [ ] `desktop/electron/main.cjs`：`local-read-file` 支持 PDF base64
- [ ] `desktop`：安装 `pdfjs-dist`
- [ ] `desktop`：`workspace-file-provider.ts` 新增 `previewFile`（CLOUD / LOCAL 两实现）
- [ ] `desktop`：新增 `PdfViewer.vue`
- [ ] `desktop`：`FileViewer.vue` 集成 PDF 分支
- [ ] `desktop`：`cd desktop && npm run build` 通过（`vue-tsc` 类型检查）
- [ ] 三端手动验证清单（§5.4）逐项通过
- [ ] 根 `CHANGELOG.md`：`### 后端`、`### 前端（桌面 / Web / 安卓）` 各补一条
- [ ] （实施阶段）告知用户重启后端服务（Agent 不自行重启）

## 7. 风险与注意事项

| 风险 | 等级 | 说明与应对 |
|------|------|-----------|
| 安卓 WebView 渲染超大 PDF 内存压力 | 中 | 用户已决策不做限制；文档记录此风险，若线上出现 WebView 崩溃再评估页数上限 |
| LOCAL 模式 base64 过 IPC 的性能开销 | 低 | base64 体积 +33%；预览场景为单次交互，可接受；若大文件卡顿可后续切换自定义协议 |
| pdf.js worker 打包路径 | 低 | 使用 Vite `?url` 导入，构建产物随 Nginx 部署，`workerSrc` 运行时为已打包的静态资源绝对路径，三端一致 |
| 加密 PDF 无法渲染 | 无（预期行为） | 走错误提示 + 下载兜底，属设计内行为 |
| pdf.js 版本兼容 | 低 | 固定 `pdfjs-dist` ^4.x 与 worker 同版本同源引入，避免 worker 与主库版本不一致 |

## 8. 后续可能的方向（本次明确不做）

- 聊天附件 PDF 预览（复用 `PdfViewer` 组件，需新增附件预览链路与权限校验）；
- Agent `ReadFileTool` 支持 PDF（PDFBox 文本抽取 / 转图，属独立后端需求）；
- 文本选择层、全屏、书签大纲、内部链接跳转；
- PDF 内容暗色反色；
- LOCAL 模式自定义协议 `mao-file://` 替代 base64 IPC。
