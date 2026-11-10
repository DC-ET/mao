# 提案：输入效率包 —— 富文本粘贴转 Markdown 与截图轻标注

- 状态：已立项（2026-11-10，技术方案：[docs/plan/2026-11-10-rich-paste-annotate-technical-design.md](../plan/2026-11-10-rich-paste-annotate-technical-design.md)）
- 提案总览见 [docs/proposals/README.md](README.md)
- 关联：`desktop/src/components/chat/ChatInput.vue`、`desktop/src/components/chat/pasted-text-file.ts`、`desktop/package.json`、新增 `desktop/src/components/chat/ImageAnnotatorDialog.vue`

> 聊天输入框是全产品最高频的交互面，剪贴板是它的主通道。现状对三类高频来源只认「纯文本 + 文件」：从 Word / 网页 / 飞书文档复制一段带格式的说明，贴进 Mao 丢掉全部结构；贴一张截图想圈个重点或打码，只能发原图让对方自己找；从 Excel 复制一片区域，贴出来是一坨制表符。拖拽通道批次 24 已补完，粘贴通道还是半成品。

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 富文本粘贴 | 只读 `text/plain`，`text/html` 完全不读，格式全丢 | `ChatInput.vue:623` `event.clipboardData?.getData('text/plain')`；全文件无一处 `text/html` |
| 粘贴的既有善后 | 超长文本自动转附件、快捷命令标记转节点——这两条是既有资产，必须保序 | `ChatInput.vue:187`（`MAX_PENDING_ATTACHMENTS, createPastedTextFile, planPastedText`）、`:641-655`（pastePlan 分流 + `@{…}@` 等标记转 editor 节点） |
| 编辑器底座 | TipTap 3（StarterKit + 自定义 QuickCommandNode），有成熟的 paste 扩展点 | `ChatInput.vue:156-160`、`:168` |
| 截图标注 | 无。粘贴图片直接进 `pendingFiles` 发原图 | `pasted-text-file.ts` 只处理文本；无任何 canvas / 标注组件 |
| 表格粘贴 | Excel 区域 = 制表符分隔纯文本，按普通文本处理 | 同 `:623` 路径 |

## 2. 目标 / 非目标

**目标**

1. **富文本粘贴 → Markdown**：`text/html` 存在且非纯样式噪声时走转换——标题 / 列表 / 粗斜体 / 链接 / 行内代码 / 代码块 / 表格 七类结构进 Markdown，其余内联标签降级为纯文本。转换引入 `turndown`（MIT，约 30KB，纯前端），表格能力由 `turndown-plugin-gfm` 提供；两个依赖经 Vite 代码分割，不入主 chunk（`check-main-chunk` 门禁既有规则）。
2. **Excel 区域 → Markdown 表格**：剪贴板 `text/html` 为 `<table>` 时直接解析为 Markdown 表格（读 HTML 比解析制表符可靠：合并单元格、换行都在结构里），并入第 1 条的转换规则表。
3. **截图轻标注**：粘贴 / 附件含图片时，附件缩略卡新增「标注」入口；新组件 `ImageAnnotatorDialog.vue` 全屏 canvas 编辑器，六件套：画笔 / 矩形 / 箭头 / 文字 / 马赛克 / 撤销；确认后合成 PNG 替换对应附件，原图保留一份可反复重标。
4. 保序硬约束：快捷命令标记转换（`:655`）与超长文本转附件（`planPastedText`）**优先于**本提案的 HTML 转换——标记语义与附件上限是既有契约，转换只接管「普通富文本」这一剩余区间。

**非目标**

- 不做 OS 级截屏捕获（Electron `desktopCapturer`，涉及屏幕权限与隐私面，与标注正交）。
- 不做图片裁剪 / 旋转 / 滤镜 / 压缩设置（标注器只管「说清重点」）。
- 不碰上传链路、附件上限、图片注入行格式（后端契约零改动）。
- 不做富文本所见即所得编辑（输入框仍是 Markdown 心智，转换是单向一次性动作）。

## 3. 方案概要

- 粘贴分流改造在 `ChatInput.vue` 现有 onPaste 内：先 `planPastedText` / 标记检测（既有），未命中的文本若 `clipboardData.getData('text/html')` 非空则调 `htmlToMarkdown()`（新 `utils/html-to-markdown.ts`，turndown 封装 + 规则白名单），产物走 TipTap 既有 Markdown 插入路径。
- 标注器为独立对话框组件：接收图片 dataURL，canvas 两层（原图层 + 标注层），撤销栈存标注层操作；「马赛克」= 方块采样原像素；确认时合并导出 PNG，回写 `pendingFiles` 对应项（替换 blob，不动其余字段）。
- 依赖新增仅两个（turndown、turndown-plugin-gfm），均纯前端、按需加载。

## 4. 回归风险与隔离

- 粘贴是最高频路径，回归面控制靠**分流顺序**：`planPastedText`（上限）→ 标记转换（契约）→ HTML 转换（新增，仅 `text/html` 命中）→ 纯文本（现状兜底）。`text/plain` 一路的行为与今天逐字节一致。
- 既有测试锁定：`ChatInput` 相关用例（粘贴计划、标记节点）全部保留并通过。
- 标注器是新组件，主编辑器零触碰；不开启标注时粘贴图片行为不变。
- E2E 风险点：粘贴类用例依赖 clipboard 权限，Playwright 下维持既有做法（不走真实剪贴板的用例不动）。

## 5. 验收标准

- 从 Word / 飞书文档复制带标题、列表、表格的段落贴入，产物为等义 Markdown；纯文本复制（VS Code、终端）行为与现状一致。
- Excel 复制 5×3 区域贴入，产出合法 Markdown 表格；含合并单元格时按左上值展开并保序。
- 超长文本仍自动转附件、快捷命令标记仍转节点（既有用例全绿）。
- 截图标注六件套可用，撤销到空可取消不产附件；标注产物替换对应附件且其他附件不受影响。
- `npm run build` 通过，主 chunk 无 turndown 字面量（`check-main-chunk` 门禁）。
