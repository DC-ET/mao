# 提案：Agent 的产出不再以「二进制文件」面对 —— 工作区文件预览完整度

> 0.0.350 让回复里的 mermaid / 公式 / 表格不再以源码形态阅读；同一时期，Agent 落盘的文件仍停在「四种格式能看、其余一律二进制」：数据分析任务交出的 CSV 报表按纯文本摊开、XLSX 根本打不开、录屏和压缩包只能下载后找外部工具。成果审阅的最后一公里，断在文件预览。

- 状态：已细化，技术方案待评审（第十七批）：[docs/plan/2026-10-26-workspace-file-preview-technical-design.md](../plan/2026-10-26-workspace-file-preview-technical-design.md)（含 §6 全量冲突清单；技术方案对提案有三处范围修正：XLSX 库定 exceljs、`.tar/.gz` 收窄为不做、DOCX 列 P2 伸展项）
- 日期：2026-10-26
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（P1 约 2-3 人日、P2 约 1-2 人日、P3 约 1-2 人日；零迁移，P3 零新端点）
- 关联：`desktop/src/components/center/FileViewer.vue`、`desktop/src/api`、`desktop/package.json`；不触后端执行链路

## 1. 背景与现状

### 1.1 预览管线只覆盖四种形态（代码可查）

`desktop/src/components/center/FileViewer.vue` 经 `provider` 注入同时服务工作区文件树与项目文件预览，判定链只有四档：

| 形态 | 判定位置 | 通道 |
|---|---|---|
| Markdown | `isMarkdown`（:102） | 既有 markdown 渲染链（0.0.350 同链） |
| PDF | `isPdfPath`（:162） | 后端 `readPdfFile` 转文本 |
| 图片 | `media_type === 'image'`（:232） | data_uri |
| 其余 | `isBinaryContent`（:146） | 「二进制文件，无法预览」（:246 分支） |

CSV / TSV 虽是纯文本能打开，但按 Monaco 源码逐行展示——千行销售报表没有表头吸附、没有列对齐、没有数值右对齐，看图成本比下载后用 Excel 打开还高。XLSX、MP4、ZIP 等则直接落入二进制分支。

### 1.2 后端预览通道同样只有 PDF

`backend-ts/src/file/file.routes.ts`：workspace-preview（:162）与 project-preview（:394）固定走 `readPdfFile`；`/v1/files/:id/preview`（:421）是附件内联预览，全端无消费。任意文件的字节获取靠 workspace-download（:152，带鉴权的 api 通道）——**这意味着媒体播放不需要新端点，前端 blob 即可承接**。

### 1.3 Agent 的高频产出恰好都在缺口里

- 数据分析类任务：CSV / XLSX 报表（多 sheet、公式值、日期序列号）
- 录屏 / 音频类任务：MP4 / MP3
- 打包交付类任务：ZIP / TAR.GZ
- 文档类任务：DOCX

现状是「下载到本地 → 找对应软件打开」，与 Mao「Agent 干完活结果就在手边」的产品叙事相悖——0.0.350 解决了回复内嵌内容，本提案解决落盘文件，是同一条主线（产出可阅读性）的延伸。

### 1.4 现成的地基

- 按需加载先例：katex / mermaid 已是动态 chunk，构建有 `check-main-chunk` 断言主 chunk 不含其字面量（0.0.350 立下的模式），新解析库走同款。
- 表格复制口径：0.0.350 已实现 CSV 引号 / 换行 / 逗号转义与 Markdown 保真复制，本提案的表格化预览直接复用同一套转义函数。
- 压缩包整包下载已有 workspace-download-zip（:171），预览只需补「包内浏览」。

## 2. 目标 / 非目标

**目标**

1. **P1 零后端**：CSV / TSV 表格化（分隔符 sniff、引号转义、列宽自适应、数值右对齐、大表虚拟滚动、复制 CSV / Markdown）；ZIP 目录浏览（列条目 + 文本 / 图片 / PDF 条目直通既有预览 + 整包下载走既有端点）。
2. **P2 前端库按需**：XLSX 多 sheet 预览（公式取值、日期序列号还原）；DOCX 转 HTML 进既有 markdown 链（mammoth 输出仍过 DOMPurify，白名单不放宽）。
3. **P3 媒体流**：音视频经 workspace-download blob → `<video>` / `<audio>`（进度 / 音量 / 播完回收）；超阈值降级为下载。

**非目标**

- 不做 Office 在线编辑、不做服务端格式转换（不落转换产物，纯前端解析）。
- 不做 PSD / EXE 等专业格式（下载兜底），不做压缩包内解压到工作区（只读浏览）。
- 不动聊天附件内联预览（`/v1/files/:id/preview` 闲置是另一问题，另案处理）。
- 不动后端文件读取 / 权限 / 沙箱语义，LOCAL 模式经同一 provider 抽象自然覆盖，无分支代码。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 结构化回复卡片（2026-10-19 否决） | 那是模型输出协议 + 提示词改造；本提案是既有文件的原生渲染，零协议零提示词。 |
| 交付物中心（2026-10-24 否决） | 不登记资产、不新增表、不做跨会话聚合，只增强既有 FileViewer 一个组件。 |
| 知识库 / RAG（已否决） | 不建索引不建 embedding，纯客户端解析。 |
| 消息渲染完整度（0.0.350 已实施） | 那次改「消息里的结构化内容」，本次改「工作区文件」，渲染链复用但触发源不同。 |

## 4. 技术方案

### 4.1 表格化预览（P1 核心）

- 判定：扩展名 + 内容 sniff 双通道（防扩展名撒谎），集中在 FileViewer 顶部纯函数，单测覆盖。
- CSV / TSV 解析：分隔符 sniff（逗号 / 分号 / Tab）、引号与换行转义（复用 0.0.350 转义函数，提为公共模块）；超过行数阈值（如 5 万行）截断并提示；表头吸附 + 数值右对齐 + hover 行高亮；复制 CSV / Markdown 与 0.0.350 表格复制同口径。
- XLSX：SheetJS 动态 import（多 sheet 切换、公式取计算值、日期序列号还原）；大 sheet 分页。
- 安全面不变：表格渲染走既有表格组件，不新增 HTML 注入面；DOCX（P2）mammoth 输出进既有 markdown 链前过 DOMPurify（与 0.0.350 同口径），主渲染链白名单不放宽。

### 4.2 压缩包浏览（P1）

- JSZip 动态 import；列目录（名称 / 大小 / 压缩率 / 修改时间），防「zip 炸弹」：条目数、单文件解压大小、总解压大小三道上限，超限拒绝并提示整包下载。
- 单击条目：文本 / 图片 / PDF 直通既有预览分支；其他类型触发该单文件下载（workspace-download 带路径参数）。
- 中文名 / 嵌套目录 / 空目录条目需进回归。

### 4.3 媒体播放（P3）

- `api.get(workspace-download, { responseType: 'blob' })` → `URL.createObjectURL` → `<video controls>` / `<audio controls>`；播完 / 切文件 `revokeObjectURL`。
- 大小阈值（建议 50MB，可配置）内走 blob，超阈值降级为既有下载并提示。
- 不加 `?token=` 流式端点：避免新对外暴露面；Electron / WebView / 移动端行为差异进人工冒烟清单。

### 4.4 体积护栏

- 三个解析库（表格 / SheetJS / JSZip / mammoth）全部动态 chunk；`check-main-chunk` 断言扩充为「主 chunk 不含任一解析库字面量」——不含图 / 表 / 公式 / 压缩包的会话首屏体积零增长，与 0.0.350 验收口径一致。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | CSV / TSV 表格化 + ZIP 浏览 | 2-3 人日 |
| P2 | XLSX + DOCX 预览 | 1-2 人日 |
| P3 | 音视频播放 + 阈值降级 | 1-2 人日 |

**改动面**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| desktop | `FileViewer.vue`（新分支 + 判定纯函数）、新增 `csv-table.ts` / `archive.ts` 纯函数模块 | 主要工作量 |
| desktop | `api`（blob 下载参数）、`package.json`（按需依赖）、构建断言扩充 | 小 |
| backend-ts | 无 | 零改动、零迁移 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| 大 CSV / XLSX 卡界面 | 中 | 虚拟滚动 + 行数阈值截断；解析放异步 chunk 内不阻塞首帧 |
| 解析库进主包 | 中 | 动态 import + check-main-chunk 断言（0.0.350 先例） |
| zip 炸弹 / 超大压缩包 | 中 | 三道上限（条目数 / 单文件 / 总解压），超限拒绝转下载 |
| 媒体 blob 内存占用 | 中 | 阈值降级下载；播完即 revoke；Electron 冒烟 |
| SheetJS 分发源 | 中 | 新版仅官方 CDN 分发（npm 停留 0.18.5），需定来源或评估 exceljs（体积更大），见待确认 1 |
| 扩展名混淆（.csv 实为二进制） | 低 | 内容 sniff 兜底，落入既有二进制分支 |

**待确认决策**

1. XLSX 库选型：SheetJS CDN 引入（功能全、体积小、外链 CDN 依赖）vs exceljs（npm 原生、体积大）vs 仅支持 CSV 把 XLSX 留后？**技术方案已定（2026-10-26）：exceljs**——SheetJS 官方 npm 版停留 0.18.5（存在已披露的原型污染类历史漏洞），修复版仅 CDN 分发，违反内网禁 CDN 硬约束；exceljs 走动态 chunk，体积可接受。
2. 媒体阈值与降级策略：50MB 是否合理，是否区分「下载」与「仍尝试播放」。
3. DOCX 是否纳入 P2（mammoth 约 1MB，按需加载可接受）还是等 P1/P2 数据验证后再议。

## 7. 测试要点

- CSV：引号 / 换行 / 分隔符 sniff、空文件、单列、数值右对齐、行数阈值、复制 CSV / Markdown 与 0.0.350 口径一致。
- XLSX：多 sheet 切换、公式值、日期序列号、空 sheet、超大 sheet 分页。
- ZIP：中文名、嵌套目录、空条目、三道上限各命中一次、包内文本条目直通预览。
- 媒体：播放 / 暂停 / 播完回收、阈值降级、切文件时旧 URL 回收。
- 护栏：主 chunk 断言；不含新格式的会话首屏零增长（与 0.0.350 同口径）。
- 回归：markdown / PDF / 图片 / 二进制分支行为不变；LOCAL provider 同链路；文件树与项目管理双入口。

## 8. 验收标准

1. Agent 产出 CSV / XLSX / ZIP / MP4 后，在文件树双击即可阅读或播放，无需下载找外部工具。
2. 不含上述格式的会话首屏包体零增长（`check-main-chunk` 断言可证）。
3. 后端零改动、零迁移（评审可核）；Web / Electron / 安卓三端同链路一致。
4. 安全白名单零放宽：新渲染内容全部过既有 DOMPurify / 表格组件通道。
