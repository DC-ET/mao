# Markdown 渲染补完技术方案：任务列表样式化与正文图片点击放大

> 对应提案：[docs/proposals/2026-11-11-markdown-render-polish.md](../proposals/2026-11-11-markdown-render-polish.md)（批次 29）。零后端、零迁移、零新依赖。改动面收敛在 `style.css` 全局 markdown 段与 `MarkdownContent.vue` 一处后处理；不含这两类语法的既有消息渲染产物逐字节不变。

## 1. 需求背景（含现状复核修正）

提案写作时断言「marked 核心（v14）不含 task list，`- [ ]` 渲染成字面 `[ ]` 文本」。**2026-11-11 用仓库实际依赖复核，该前提已过时**：desktop 依赖 marked ^18.0.4（`desktop/package.json`），默认 `gfm: true`，实测 `- [ ]` / `- [x]` 已经产出 `<input disabled type="checkbox">`，且 DOMPurify 默认白名单放行 `input`（jsdom 实测通过）。

| 场景 | 现状（2026-11-11 复核） | 代码证据 |
|---|---|---|
| GFM 任务列表 | **checkbox 已渲染**，但无任务列表样式：与 `<ul>` 项目符号叠显、完成项无删除线/置灰 | `desktop/node_modules/marked` 实测 + `useMarkdown.ts:54`（`new Marked({ breaks: false })`，gfm 默认开） |
| 任务列表只读性 | `input disabled` 天然只读，不可点击切换 | 同上实测产物 |
| 正文内联图片 | `![描述](/uploads/…)` 经 marked 默认 image renderer 产出原生 `<img>`，无放大交互 | `useMarkdown.ts` renderer 链无 image 定制（html/code/table/text/link 之外走默认） |
| 图片放大先例 | 工具卡图片结果用 `el-image` preview-src-list | `ToolCallCard.vue:183-192` |
| DOM 后处理先例 | `!streaming` 分支做 Mermaid 注入与代码块增强，纯函数抽 utils 可测 | `MarkdownContent.vue:48-56`、`utils/mermaid-renderer.ts`、`utils/codeBlockCollapse.ts` |
| 兼容面 | `:has()` 选择器可用性：仓库样式已用 `color-mix()`（Chrome 111+），`has()`（Chrome 105+）约束更松 | `ToolCallCard.vue:928` 等多处 color-mix |

本方案因此收窄为：**任务列表样式补齐**（不是语法解析补齐）+ **图片点击放大**两项。

## 2. 需求描述

| # | 用户故事 | 判定 |
|---|---|---|
| 1 | 消息/文件预览/轨迹等所有 markdown-body 宿主渲染 `- [ ]` / `- [x]` 列表 | 列表项以 checkbox 呈现、**无项目符号叠显**、checkbox 与文字对齐；已完成项整行**灰色 + 删除线**（评审拍板样式） |
| 2 | 点击已完成任务的 checkbox | 无任何反应（disabled 只读，界面与工作区文件事实一致；评审拍板不加只读提示） |
| 3 | 点击正文（MarkdownContent 全部宿主）里非链接包裹的内联图片 | 弹出全屏预览查看器（el-image-viewer），Esc / 遮罩点击 / 关闭按钮退出 |
| 4 | 点击被 `<a>` 包裹的图片 | 打开链接，**不**弹预览（链接行为优先） |
| 5 | 流式输出进行中点击图片 | 不弹预览（半张图不预览）；流式结束后的下一帧起可点 |

**要做**：上述五条。

**不做**：

- 任务列表勾选切换、在聊天里写回文件——不做，checkbox 保持 `disabled`。
- 脚注等其他 GFM 扩展——不做，无需求不加。
- 会话级图片 gallery、批量下载——不做（批次 26 已否决方向）。
- 工具卡内 `<img>` 的放大绑定——不做，工具卡图片已有各自 el-image 预览，不重复。
- useMarkdown 渲染链的任何改动（marked 配置、renderer、缓存、流式链路）——本方案不触碰 `useMarkdown.ts`。

## 3. 技术选型与决策

| 决策点 | 定案 | 理由 |
|---|---|---|
| 任务列表实现 | **纯 CSS（`:has()` 选择器），零 JS、零 DOM 后处理**：`.markdown-body li:has(> input[type="checkbox"])` 隐藏 bullet 并对齐；`li:has(> input[type="checkbox"][checked])` 置灰 + `line-through`；checkbox `accent-color: var(--aw-primary)` | checkbox 产物已存在，样式层即可完成；`:has()` 纯声明式，流式中间帧同样生效，无需等流结束；不用 `:has()` 的替代（renderer 改 listitem）需要覆盖 marked 默认嵌套列表渲染，回归面大得多 |
| 样式落点 | `style.css` 全局 markdown 段（:746 起的 `Markdown 富渲染` 区块内追加） | markdown-body 分散在聊天/文件预览/轨迹/技能/分享页多宿主，全局段是既有惯例（同段注释明说） |
| 图片放大的标记方式 | `MarkdownContent` 渲染后处理：`!streaming` 分支调 `markZoomableImages(root)`，给符合条件的 `<img>` 加 `md-img-zoom` 类（排除 `<a>` 后代与 `.code-block` 内） | 与 mermaid/codeBlockCollapse 后处理同位同范式；排除规则落在标记层，点击层只认类，逻辑单点 |
| 点击监听 | **组件内 `@click` 绑定在 root div**，`closest('img.md-img-zoom')` 命中即开预览 | 不引入 document 级常驻委托（utils/codeCopy 模式是为跨实例全局行为设计的）；组件卸载监听随组件销毁，零清理负担 |
| 预览组件 | **`ElImageViewer`**（element-plus 2.14 公共导出，仓库首用）：`v-if` + `:url-list="[src]"` + **`teleported`（必须显式）** + `@close` 置空；模板直接写 `<el-image-viewer>` 标签（main.ts `app.use(ElementPlus)` 全量注册 + `element-plus/dist/index.css` 全量样式，与全部 el-* 组件用法一致，无需显式 import） | 不用「隐藏 el-image 再触发 preview」的黑科技；ElImageViewer 自带 Esc/遮罩关闭、z-index 管理，公开 API 稳定；**`teleported` 默认 false = 原地渲染**（node_modules 实证 `disabled: !teleported`），fixed 定位会被 overflow / transform 祖先裁剪——ToolCallCard 既有 el-image 也因此显式 `preview-teleported="true"`，本方案同口径 |
| 图片 src 取值 | `img.currentSrc || img.src` 原值进 url-list | uploads 相对路径同源直显；data URI（如粘贴预览）同样可用 |
| 流式行为 | 标记只在 `!streaming` 分支执行（与 Mermaid/代码块同位）；流中点击无预览 | 流式帧高频重建 DOM，逐帧标记是浪费；「streaming 翻转必触发回调」的既有语义（C6）保证流结束即标记 |

## 4. 实现步骤

### 4.1 `style.css`：任务列表样式（全局 markdown 段追加）

```css
/* GFM 任务列表：checkbox 由 marked gfm 管线产出（input disabled），这里只管样式 */
.markdown-body li:has(> input[type="checkbox"]) {
  list-style: none;
  margin-left: -1.1em;   /* 抵消 ul 的 padding-left，checkbox 与正文左缘对齐 */
}
.markdown-body li:has(> input[type="checkbox"]) > input[type="checkbox"] {
  margin-right: 6px;
  vertical-align: -2px;
  accent-color: var(--aw-primary);
}
.markdown-body li:has(> input[type="checkbox"][checked]) {
  color: var(--aw-ink-muted-48);
  text-decoration: line-through;
}
```

具体偏移量（-1.1em 等）实现时按聊天宿主（`MessageBubble.vue:1208-1218` li 行高 2 / padding-left 20px）目测校准，以 checkbox 与相邻普通列表项文字左缘对齐为准；选择器与类名结构按本节锁定。

### 4.2 新增 `desktop/src/utils/markdownZoom.ts`

```ts
export const ZOOM_CLASS = 'md-img-zoom'
/** 标记可放大的正文图片：跳过链接内与代码块内的 img。由 MarkdownContent 渲染后调用。 */
export function markZoomableImages(root: HTMLElement): void
export function pickZoomImage(target: EventTarget | null): HTMLImageElement | null
```

- `markZoomableImages`：`root.querySelectorAll('img')`，命中以下任一则跳过——`img.closest('a')` 非空；`img.closest('.code-block, pre')` 非空；`img.getAttribute('data-no-zoom') === 'true'`（逃生口，当前无设置方，预留给未来宿主内嵌图片场景）。其余加 `ZOOM_CLASS`。幂等（已带类跳过）。
- `pickZoomImage`：从事件 target 向上 `closest('img.' + ZOOM_CLASS)`，命中且 `closest('a')` 为空时返回该 img（双保险），否则 null。
- 样式（style.css markdown 段追加）：`.markdown-body .md-img-zoom { cursor: zoom-in; }`——点击放大的 affordance（现状 markdown-body 对 img 无任何样式规则，grep 实证）；只加光标不改布局，图片宽度等布局约束维持现状。

### 4.3 修改 `MarkdownContent.vue`

1. 模板 root 加 `@click="onBodyClick"`；`<el-image-viewer v-if="previewUrl" :url-list="previewList" teleported @close="closePreview" />`（previewList 为 `[previewUrl]` computed；`teleported` 必须显式，见 §3）。teleport 到 body 后 viewer 内点击不再冒泡回 root，委托零误开。
2. `!streaming && root.value` 分支（:48-56）追加 `markZoomableImages(root.value)`（与 insertMermaidDiagrams 并列，先于 codeBlockEnhance 与否均可，互不依赖）。
3. `onBodyClick(e: MouseEvent)`：`const img = pickZoomImage(e.target)`；命中时 `previewUrl.value = img.currentSrc || img.src`；未命中直接返回（不 preventDefault，链接等既有点击行为不变）。
4. `closePreview()`：`previewUrl.value = ''`。
5. 组件注册：模板直接写 `<el-image-viewer>`，无需显式 import——main.ts `app.use(ElementPlus, { locale: zhCn })` 全量注册、`element-plus/dist/index.css` 全量样式，全部 el-* 组件均此用法。

### 4.4 测试

1. 新增 `desktop/src/utils/markdownZoom.test.ts`（jsdom）：
   - 普通正文 img 被加类；`<a><img></a>` 不加；`.code-block` 内 img 不加；重复调用幂等。
   - `pickZoomImage`：img target 命中返回元素；a 内 img 返回 null；非 img target 返回 null。
2. `useMarkdown` 既有测试全绿（渲染链零改动）；如有 marked 层任务列表产物断言，补一条 `- [x]` 产出 `<input checked disabled type="checkbox">` 的锁定用例（防未来 marked 升级/配置漂移）。
3. 新增 `desktop/src/components/common/MarkdownContent.test.ts`（组件级接线，评审补充）：mount 范式照 `ToolCallCard.test.ts`（mock `utils/theme` 与 `utils/monaco-colorize`），element-plus 注册用 `app.use(ElementPlus)`（`WorkspaceOverviewPanel.*.test.ts` 先例）——正文 img 点击 → `.el-image-viewer` 渲染于 body（teleported）；`<a><img></a>` 点击不弹；`streaming: true` 时点击不弹、翻转 false 后可弹；close 事件置空后 viewer 卸载。
4. 手测矩阵：聊天消息、文件预览（FileViewer）、轨迹（RunTracePanel）三宿主——任务列表样式与图片放大均生效；流式中点击无预览、流结束可点；暗色主题下 checkbox accent-color 与置灰可见；viewer 全屏无裁剪（teleported 生效）。

## 5. 落地清单

| 类型 | 文件 | 内容 |
|---|---|---|
| 修改 | desktop/src/style.css | markdown 段追加任务列表三条规则（:has()） |
| 新增 | desktop/src/utils/markdownZoom.ts | markZoomableImages / pickZoomImage / ZOOM_CLASS |
| 修改 | desktop/src/components/common/MarkdownContent.vue | root @click、el-image-viewer（teleported）、!streaming 分支标记调用 |
| 新增 | desktop/src/utils/markdownZoom.test.ts | 标记与拾取纯函数用例 |
| 新增 | desktop/src/components/common/MarkdownContent.test.ts | 组件级接线用例（点击 → viewer / a 包裹不弹 / 流式守卫） |
| 修改 | desktop/src/composables/useMarkdown.test.ts（如存在） | `- [x]` checkbox 产物锁定用例 |
| CHANGELOG | 根 CHANGELOG.md | 前端（桌面 / Web）小节，版本随发版批次 |
| backend-ts / admin / android / agent-cli | — | **无改动**（安卓壳共用 UI，样式与预览同样生效） |
| 数据库迁移 | — | **无** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `:has()` 在某宿主不可用（极老 WebView） | 仓库已用 `color-mix()`（Chrome 111+），`:has()`（105+）兼容面是其超集；即便失效也只是回到「bullet 叠显、无删除线」的今天现状，功能无损 |
| 正文里字面 `[ ]`（非列表项）被误判 | 本方案零解析改动，不存在该回归面（提案原风险随 marked 既有能力一并消失） |
| ElImageViewer 与 Mermaid/代码块折叠的全局 z-index 冲突 | element-plus viewer 默认 z-index 管理走 el-popup-manager（与 el-dialog 同源），仓库内 dialog/message 均已共存；`teleported` 后 viewer 挂 body 顶层，与 teleport 型 dialog 同层管理；实施后手测三宿主叠层 |
| 点击放大劫持图片的原生拖拽 / 右键 | 委托只挂在 click，不拦截 contextmenu/dragstart；右键菜单行为不变 |
| 长文重复渲染开销 | 标记是 O(imgs) 一次 classList 操作，且只在 !streaming 帧执行；对比每帧全量渲染可忽略 |
| 消息流式中图片逐帧重建导致闪烁 | 现状已有行为（v-html 重建），本方案不触碰渲染链，不新增 |

## 7. 测试要点

1. `- [ ]` / `- [x]` / `- [X]` 三态：checkbox 呈现、完成项灰色 + 删除线、无 bullet 叠显（手测 + marked 产物锁定用例）。
2. 非列表位置的字面 `[ ]` 文本不受影响（本方案不改解析，回归基线即既有用例）。
3. 正文图片点击弹预览（viewer 全屏无裁剪，`teleported` 生效）、Esc / 遮罩关闭；带 `<a>` 包裹的图片点击走链接不弹预览；代码块内 img（如 mermaid 占位前的原文）不弹。
4. 流式进行中点击图片无反应；流式结束下一帧起可点。
5. 工具卡图片既有 el-image 预览回归不变（MarkdownContent 改动不波及 ToolCallCard）。
6. 数学公式 / mermaid / 代码块 / 表格既有渲染回归零变化（`useMarkdown` 既有用例全绿）。
7. 构建：`npm run build`（desktop）绿。

## 8. 决策记录

1. 提案前提修正：marked ^18 已原生渲染任务列表 checkbox（jsdom + node 实测），本方案是**样式补齐**而非解析补齐——不再挂 listitem renderer。
2. 完成项样式 = 灰色 + 删除线 + 勾选框（评审拍板）；只读不提示（评审拍板）。
3. 任务列表样式用 `:has()` 纯 CSS，不用 renderer 覆盖 / DOM 后处理：零 JS 回归面，流式中间帧即生效。
4. 图片放大范围 = MarkdownContent 全部宿主（聊天 / 文件预览 / 轨迹 / 技能 / 分享），不加宿主开关 prop——行为一致性优先，各宿主并无「不可放大」的合理场景；工具卡 img 不绑定（评审拍板）。
5. 预览组件用 ElImageViewer 公共导出，不用隐藏 el-image 触发的内部态黑科技。
6. 流式期间无预览（评审拍板口径），标记层实现；流结束由既有 streaming 翻转回调兜底（C6 语义既有）。

## 9. 明确不做的（汇总）

- 任务列表勾选切换 / 写回文件；只读 title 提示；脚注等其他 GFM 扩展。
- 会话级图片 gallery、批量下载；工具卡 `<img>` 放大绑定。
- `useMarkdown.ts` 渲染链任何改动（marked 配置 / renderer / 缓存 / 流式节流）。
- 图片的下载 / 新窗口打开等附加按钮（ElImageViewer 默认工具条之外的定制）。
- 图片布局约束改动（max-width / 尺寸缩放等维持现状，本方案只加光标与点击）。
- 后端、admin、agent-cli、数据库迁移的任何改动。

## 10. 评审修订记录（2026-11-12）

1. **`teleported` 必须显式（关键修正）**：实证 element-plus 2.14 `ElImageViewer` 的 `teleported` 默认 false（`disabled: !teleported`，原地渲染），fixed 定位会被 overflow/transform 祖先裁剪或错层；仓库先例 ToolCallCard 的 el-image 也因此显式 `preview-teleported="true"`。§3/§4.3/§6/§7 已补。
2. **组件注册方式修正**：main.ts 是 `app.use(ElementPlus)` 全量注册 + 全量 CSS，模板直接写 `<el-image-viewer>` 即可；删除原稿「显式 import ElImageViewer」的错误指令（与仓库全部 el-* 用法不一致）。§3/§4.3-5。
3. **补 affordance 样式**：`.markdown-body .md-img-zoom { cursor: zoom-in }`——现状 markdown-body 对 img 无任何样式规则，无可点击暗示；只加光标不改布局（§4.2/§9）。
4. **补组件级接线测试**：原稿只有纯函数单测 + 手测，「点击 → viewer」接线无自动化。新增 MarkdownContent.test.ts，范式有先例（mock：ToolCallCard.test.ts；app.use(ElementPlus)：WorkspaceOverviewPanel.test.ts）。§4.4-3/§5。
5. **遮罩点击退出落地补齐（实现轮 review 发现）**：§2/§3/§7 声称的「遮罩点击退出」需显式 `hide-on-click-modal`（element-plus 默认 false，实现初版遗漏）；实现补该属性，与 ToolCallCard el-image 既有口径（未开）刻意不同——本方案验收口径以更标准的查看器交互为准。另：多根模板使 attrs 透传失效，实现以 `useAttrs()` + `v-bind="attrs"` 恢复单根时代语义（ToolWebPageView `class="page-body"` 依赖此行为）。
