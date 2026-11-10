# 输入效率包技术方案：富文本粘贴转 Markdown 与截图轻标注

> 对应提案：[docs/proposals/2026-11-10-rich-paste-annotate.md](../proposals/2026-11-10-rich-paste-annotate.md)（批次 28）。零后端改动、零迁移；改动面收敛在 desktop 的粘贴分流与附件缩略卡两处，默认行为与现状逐字节一致。

## 1. 需求背景

聊天输入框的粘贴链路（`ChatInput.vue:593-698`，TipTap `editorProps.handlePaste`）当前按以下顺序分流：

1. **文件/图片分支**（:595-634）：clipboard items 含 image/ 或 kind==='file' 时入待发列表；图文混排（网页/Office「文字+截图」）时 `text/plain` 手动按行插入段落，返回 true。
2. **超长文本文件化**（:636-654）：`planPastedText`（阈值 2000 字符，`components/chat/pasted-text-file.ts`）命中的纯文本静默转 `.txt` 待发附件。
3. **快捷命令标记**（:655-695）：`@{…}@` / `${…}$` / `#{…}#` 转编辑器节点。
4. **兜底**（:696-697）：返回 false 交给 TipTap 默认粘贴——注释明说「strips formatting by default」。

全链路**从不读取 `text/html`**（grep 全文件零命中）。三类高频来源因此受损：Word/网页/飞书文档粘贴丢全部结构；Excel 区域粘贴成制表符乱流；截图只能发原图，无法圈重点或打码。拖拽通道已由批次 24 落地（`handleDropFiles` / `handleRefDrop`），粘贴通道是输入面最后一块半成品。

## 2. 需求描述

| # | 用户故事 | 判定 |
|---|---|---|
| 1 | 从 Word / 网页 / 飞书文档复制带标题、列表、粗斜体、链接、行内代码、代码块的段落粘贴 | 产物为等义 Markdown 源文本（输入框即所见，发送后由 MarkdownContent 正常渲染） |
| 2 | 从 Excel 复制一片区域粘贴 | 产出 Markdown 表格；合并单元格按左上值展开、行对齐保序 |
| 3 | 粘贴或添加一张图片，点击缩略卡上的「标注」 | 全屏 canvas 编辑器：画笔 / 矩形 / 箭头 / 文字 / 马赛克 / 撤销；确认后替换该附件，原图保留可反复重标 |
| 4 | 粘贴超长文本（≥2000 字符）、含快捷命令标记的文本 | 行为与今天完全一致（文件化 / 标记节点），新逻辑不得接管 |

## 3. 技术选型与决策

| 决策点 | 定案 | 理由 |
|---|---|---|
| HTML→Markdown 库 | **turndown + turndown-plugin-gfm**（MIT，约 30KB+4KB），新增两个运行时依赖与对应 `@types/*` | 仓库现状无 HTML→MD 能力；turndown 规则可白名单化、产物即 GFM 源文本；备选 rehype-in-markdown 链路重（统一 sanitizer+remark 全家桶）对本需求过重 |
| 加载方式 | **动态 import + ChatInput setup 预热**：`utils/html-to-markdown.ts` 模块级单例持有 converter（`let converter: TurndownService \| null`），`ensureHtmlConverter()` 在 ChatInput `setup` 里 fire-and-forget 调用；`handlePaste` 是同步钩子，粘贴时 converter 未就绪则**回落现状纯文本行为** | TipTap handlePaste 必须同步返回 boolean；预热后首贴几乎必然就绪，未就绪的回落是无损降级；turndown 因此天然在按需 chunk（进 `scripts/check-main-chunk.mjs` 的 FORBIDDEN 门禁，见 §4.6） |
| 转换产物的插入 | 复用 :626-631 的 ProseMirror 段落插入手法：Markdown 源文本按 `\n` 拆行建 paragraph 节点，`state.tr.replaceSelection` 分发。抽公共函数 `insertPlainParagraphs(view, text)`，文件分支（:624-632）与新分支共用 | 输入框是「纯文本 + 特殊节点」心智，Markdown 以源文本呈现与现契约一致；不得用 `insertContent(html)`——那会让 TipTap 解析 HTML 破坏格式语义 |
| Excel 合并单元格 | 先 `DOMParser` 解析 `<table>`，按 colspan/rowspan **重复左上值展开**成规整网格，再把规整后的表格 HTML 交给 turndown-gfm | turndown-gfm 对 colspan 会漏列错位；展开后每行单元格数一致，验收标准「行对齐保序」才可兑现 |
| 图片元素处理 | 转换前剥离全部 `<img>`（以及 `<script>`/`<style>`） | 剪贴板里的位图图片走 items 文件分支（:600-618）已是既有正确路径；HTML 里的 img src 多为 blob:/cid: 死链 |
| 尺寸护栏 | `text/html` 长度 > 512KB 不转换，回落纯文本 | 防病态粘贴卡死主线程（turndown 同步转换） |
| 标注器实现 | 独立新组件 `ImageAnnotatorDialog.vue`：双层 canvas（底层原图、顶层标注层），操作栈重放实现撤销，导出时合并两层为 PNG；马赛克 = 笔刷方块对底图 `getImageData` 取均值填充 | 不引入第三方绘图库；双层结构让撤销/重画零原图损伤；粘贴图片来自本地 File 的 objectURL，canvas 不会被污染（taint），`getImageData` 合法 |
| 附件替换口径 | 替换 `pendingFiles` 条目的 `file` 为标注产物 PNG，重建 `previewUrl`（旧 objectURL 先 revoke）；条目新增可选 `originalFile?: File` 保存原图供再次标注 | 与既有条目形状（`{ file, previewUrl, localPath? }`，`ChatInput.vue:289`；`addPendingImage` :1031-1046）最小兼容；上传链路、附件上限零改动 |

## 4. 实现步骤

### 4.1 依赖

```bash
cd desktop && npm i turndown turndown-plugin-gfm
npm i -D @types/turndown @types/turndown-plugin-gfm
```

> 类型包核对：`@types/turndown` 在 DefinitelyTyped 存在；`@types/turndown-plugin-gfm` 安装时验证，缺失则以仓库内一个 `.d.ts` 兜底（turndown-plugin-gfm 导出 `{ gfm, tables, strikethrough, taskListItems }`，本方案只用 `gfm`——含 tables 规则，Excel 表格转 MD 依赖它）。加运行时依赖有先例（jszip / katex / dompurify / mammoth 均在 dependencies）。

### 4.2 新增 `src/utils/html-to-markdown.ts`

- `ensureHtmlConverter(): Promise<void>`：动态 `import('turndown')` 与 `import('turndown-plugin-gfm')`，构造单例（`headingStyle:'atx'`、`codeBlockStyle:'fenced'`、`bulletListMarker:'-'`、`emDelimiter:'*'`、`strongDelimiter:'**'`，`use(gfm)`）。重复调用幂等（已有实例即 resolve）。
- `convertHtmlToMarkdown(html: string): string | null`：
  1. `html.length > 512_000` 返回 null（护栏）。
  2. `DOMParser` 解析，剥离 `script/style/img` 节点。
  3. 遍历 `table`：按 colspan/rowspan 重复左上值展开成规整 `tr/td` 网格（纯 DOM 操作函数 `expandTableCells(table)`，独立导出便于单测）。
  4. converter.convert(`documentElement.body.innerHTML`)；产物做 `\n{3,} → \n\n` 收敛，`trim()` 后为空返回 null。
- converter 未就绪时 `convertHtmlToMarkdown` 返回 null（同步探测模块级单例）。

### 4.3 修改 `ChatInput.vue` 粘贴分流

1. 从 :624-632 抽出 `insertPlainParagraphs(view, text)`（行为逐字节等价），文件分支改调它。
2. `setup` 中 `void ensureHtmlConverter()`。
3. 在标记分支（:655-695）之后、兜底 `return false`（:696）之前新增分支：
   - 前置条件：`text/plain` 为空或为普通文本（未进文件化与标记分支）、`text/html` 非空。
   - `const md = convertHtmlToMarkdown(html)`；null（未就绪/超限/转换空）→ 直接落到现有兜底（行为不变）。
   - 命中：`event.preventDefault()` + `insertPlainParagraphs(view, md)` + `return true`。
4. **保序断言（实现后必须成立）**：文件分支（:620-634）与长文本分支（:645-654）的 return 路径不变，`text/plain ≥ 2000` 的粘贴永不进转换；含标记的文本由 :656 分支拦截，转换不接管。

### 4.4 新增 `src/components/chat/ImageAnnotatorDialog.vue`

- 接口：props `{ file: File }`；emits `confirm(file: File)`、`update:visible`。el-dialog `fullscreen`（desktop 首个全屏对话框；基础对话框形态可参照 `ScriptPathPickerDialog.vue`，注意其为定宽 520px 且全文件无 aria-label，**不作为 aria 参照**）；工具按钮一律 aria-label + title 双写，先例 `ChatInput.vue:68`（移除引用按钮）。
- 画布：初始化把图片按原始尺寸绘入底层 canvas（视口超出时容器内滚动 + 顶层画布同尺寸覆盖）；顶层记录操作栈 `ops: Array<{tool, points/rect/text/seed…, style}>`，undo = 栈弹出后清空顶层重放。
- 六工具：画笔/矩形/箭头（线段+三角头）/文字（点击弹行内 input，Enter 落笔）/马赛克（笔刷半径方块，`getImageData` 均值）/撤销。颜色固定红 `#e5484d`，线宽 3，不做样式面板（首版只管「说清重点」）。
- 确认：合并两层导出 `image/png` → `new File([blob], 原名去扩展名 + '-annotated.png')` → emit confirm。
- 工具实现纯函数抽出 `utils/image-annotate.ts`（`expand` 无关，含 `drawOp(ctx, op)`、`applyMosaic(baseCtx, ctx, region)`），便于单测不依赖对话框。

### 4.5 接线 `ChatPendingFileList.vue` + `ChatInput.vue`

- 条目类型四处同步（`ChatInput.vue:289` 类型声明、`:1037/:1059` 两处条目创建、`ChatPendingFileList.vue:17` props）：加可选 `originalFile?: File`。
- 缩略卡：`item.file.type.startsWith('image/')` 时渲染「标注」按钮（aria-label="标注图片"，交互守卫用组件既有 `disabled` prop，与 :8 移除按钮同款）；emits 加 `annotate(index)`。**不设 LOCAL-浏览器排除**（评审修正，见 §8-6）：图片附件在全部执行模式统一走上传通道（`useChat.ts` 图片 `uploadChatImages` 无模式分支、`addPendingImage` :1031-1046 无模式拦截），标注只是发送前的本地 file 替换，对 LOCAL-浏览器与安卓壳无额外平台要求；原稿的排除条件无技术依据，且造成「能贴图不能标注」的功能残缺。
- ChatInput：`annotatingIndex` ref 控制对话框；confirm 回调里 revoke 旧 `previewUrl`、写入 `{ file: 新 PNG, previewUrl: 新 objectURL, originalFile: 原条目 originalFile ?? 原 file }`。
- 发送链路（:253 emit `send`）零改动——替换发生在 file 字段层面，CLOUD 上传 / LOCAL 拷贝自然拿到新 PNG。

### 4.6 chunk 门禁

`desktop/scripts/check-main-chunk.mjs` 的 `FORBIDDEN`（:23-32）新增 turndown 库内部独有字面量一条：取 `node_modules/turndown/dist/turndown.js` 中仓源码不可能出现的错误消息串（实现时 grep 该 dist 选定，如其内部异常文案），与既有 jszip 条目的「逐字符对齐库产物」注释同款写法。

## 5. 落地清单

| 类型 | 文件 | 内容 |
|---|---|---|
| 依赖 | desktop/package.json | turndown / turndown-plugin-gfm + 两个 @types |
| 新增 | src/utils/html-to-markdown.ts | ensureHtmlConverter / convertHtmlToMarkdown / expandTableCells |
| 新增 | src/utils/image-annotate.ts | drawOp / applyMosaic（纯函数） |
| 新增 | src/components/chat/ImageAnnotatorDialog.vue | 全屏标注对话框 |
| 新增 | src/utils/html-to-markdown.test.ts / image-annotate.test.ts | 单测 |
| 修改 | src/components/chat/ChatInput.vue | 抽 insertPlainParagraphs、setup 预热、粘贴新分支、标注接线（条目 originalFile） |
| 修改 | src/components/chat/ChatPendingFileList.vue | 图片项「标注」按钮 + annotate emit + 条目类型 |
| 新增 | src/components/chat/ChatPendingFileList.test.ts | 标注按钮渲染/守卫用例（该组件无既有测试） |
| 修改 | desktop/scripts/check-main-chunk.mjs | FORBIDDEN（:23-32）加 turndown 字面量 |
| CHANGELOG | 根 CHANGELOG.md | 前端（桌面/Web）小节，版本随发版批次 |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 粘贴是最高频路径，分流改坏现有行为 | 三条既有 return 路径逐字节不动，仅在其后追加分支；粘贴回归用例纳入本次工作——现状组件级粘贴用例不存在（仅纯函数内核 `pasted-text-file.test.ts` 覆盖计划分流，标记分支零测试），需新增（见 §7） |
| converter 未就绪首贴降级 | 预热在 setup 即发起（网络态无影响——同 chunk 本地加载）；降级路径 = 现状行为，无损 |
| turndown 产物含意外 HTML 片段 | turndown 输出即纯文本；转换结果再过一遍「含 `<` 的裸 HTML 标签」检测？**不做**——turndown 对白名单外标签本就降级为文本，不二次清洗 |
| canvas getImageData 抛 SecurityError | 图片全部来自本地 File objectURL（同源），不存在跨域污染；防御性 try/catch 降级为「该区域画灰色方块」并在控制台警告 |
| 大图性能 | 标注画布按图片原始尺寸，> 4096px 边等比缩放到 4096 导出（与常见上传上限一致）；操作重放节流到 pointermove 的 rAF |
| 仓库无 canvas 测试先例（jsdom `getContext('2d')` 返回 null，vitest 默认 node 环境，仅文件头 pragma 开 jsdom） | `image-annotate` 单测用「记录调用的 2D context stub」断言 drawOp 方法序列与参数；马赛克均值用 stub `getImageData` 返回构造像素数据（1×1 采样图精确断言）；真实渲染手测兜底 |

## 7. 测试要点

- `html-to-markdown.test.ts`：标题/列表/粗斜体/链接/行内代码/代码块七类结构；`<table>` 规整（colspan=3、rowspan、混合）→ 行单元格数一致且左上值重复；`<img>/<script>` 剥离；512KB 超限 null；converter 未就绪 null；输出空白收敛。
- `image-annotate.test.ts`（ctx stub 模式）：drawOp 各工具的方法序列与参数；马赛克均值采样（stub getImageData 返回构造像素，含 alpha 过滤与 SecurityError 降级）；undo 清层重放与全新重放的绘制序列逐条一致；fitImageSize 缩放边界。
- 组件：`ChatPendingFileList.test.ts`（**新增**，该组件无既有测试）——图片项出现标注按钮、非图片项不出现、disabled 守卫不触发回调。
- 粘贴回归：`pasted-text-file.test.ts` 既有用例保持全绿；ChatInput 组件级挂载用例落地策略（实施调整）：ChatInput 体量大（1500 行 + TipTap 挂载），改为三层更聚焦的用例——`paste-insert.test.ts`（真实 TipTap 编辑器验证共享插入函数的段落/空行/纯源文本语义）、`shouldConvertHtmlPaste` 分流守卫纯函数用例（含 ≥ 阈值不接管、纯 html 剪贴板接管）、`html-to-markdown.test.ts` 全结构用例（含「converter 未就绪/加载失败 → null」：fresh module + mock 失败的 turndown 导入，vi.resetModules 时序隔离）；分流顺序由「三条既有 return 路径不动 + 新分支插在 marker 之后」的代码结构保证，组件级端到端由手测兜底。
- 构建：`npm run build` 绿 + `check-main-chunk` 含新字面量后仍通过。

## 8. 决策记录

1. 转换接管范围 = 「非超长、无标记、text/html 非空」的普通富文本，三条既有契约（文件化/标记节点/图文混排手插）全部前置不动。
2. Markdown 以源文本插入，不做输入框所见即所得（渲染层已有 MarkdownContent，单向转换零新增心智）。
3. 标注工具固定单色单线宽，无样式面板；马赛克是不可逆操作（只有撤销栈，无「去马赛克」）。
4. 合并单元格策略 = 左上值重复展开（保行对齐），不丢失语义列。
5. `originalFile` 仅驻内存（pendingFiles 条目），不进持久化——刷新后原图即附件本体，标注产物同样重新可标（对 PNG 再标注=在产物上叠加）。
6. 标注按钮在全部执行模式渲染（评审修正）：图片发送通道（`uploadChatImages`）对 LOCAL / CLOUD / LOCAL-浏览器无分支，`addPendingImage` 也无模式拦截，标注（发送前本地替换 file）不引入新平台依赖；原稿「非 LOCAL-浏览器才渲染」无依据且与「能贴图能发图」的现状矛盾。

## 9. 明确不做的（汇总）

- OS 级截屏捕获（desktopCapturer）；图片裁剪/旋转/滤镜/压缩设置；上传链路与附件上限改动；图片注入行格式改动。
- 富文本所见即所得编辑器；粘贴 HTML 的沙箱清洗管线（依赖 turndown 白名单降级）。
- 标注的云端同步/多端一致（设备本地内存行为）；后端任何接口与字段。
