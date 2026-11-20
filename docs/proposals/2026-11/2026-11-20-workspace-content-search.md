# 提案：工作区文件内容搜索 —— 文件管理器全文检索

> 文件管理器（批次 5「工作区文件直管」）已经是文件操作的高完成度面板：名称递归搜索、新建 / 重命名 / 剪切粘贴 / 拖拽移动、上传（可取消）、多选打包 zip、多形态预览都有了。但搜索止步于**文件名**——用户想找「哪个文件里写了那个报错串 / 那个接口名」时，唯一手段是把这句话发给 Agent 让它跑 Grep 工具，再看聊天里的工具卡。文件管理器是**人的**文件界面，却缺了人的文件检索最后一块：跨文件内容搜索（VS Code 全局搜索的最低配版本）。地基全部现成：CLOUD 侧文件路由已有独立的名称搜索端点与递归扫描骨架；LOCAL 侧 0.0.526 / 0.0.527 刚建好的执行端文件代理（list / read / search / files 四个 op）天然是内容搜索的投递通道；FileViewer 已有行区间定位先例（选区引用，批次 18）。本提案补齐「名称 / 内容」两种搜索模式，结果可点击直达行——纯增量端点与增量 op，既有名称搜索端点与代理 op 逐字节不动。

- 状态：已否决（2026-11-20 评审：需求不高，性能影响大）
- 日期：2026-11-20
- 提案总览见 [docs/proposals/README.md](../README.md)
- 规模：中（约 2.5-3 人日；0 迁移；backend file 路由 1 端点 + desktop 搜索 UI + LOCAL 双执行端（桌面客户端 / mao-agent）新增代理 op）
- 关联：`backend-ts/src/file/file.routes.ts`（名称搜索端点 :238-255）、`backend-ts/src/file/workspace-browse.service.ts`（名称匹配 :244）、`desktop/src/composables/useFileManager.ts`（搜索与跳转 :230-286）、`desktop/src/composables/workspace-file-provider.ts`（LOCAL 名称搜索 IPC :114-173）、`backend-ts/src/file/remote-file-proxy.service.ts`（代理 op 枚举 :10）、`agent-cli/src/local/file-ops.ts`（执行端 search 为纯文件名 BFS :137-167）、`desktop/src/components/file-browser/FileManagerPanel.vue`

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 文件名搜索 | CLOUD 与 LOCAL 双模式齐备（300ms 防抖、竞态防护、截断提示、点击跳转） | `file.routes.ts:238-255`、`useFileManager.ts:230-286` |
| 跨文件内容搜索 | 两端均为零——匹配逻辑只看 `entry.name` | `workspace-browse.service.ts:244`、`workspace-file-provider.ts:168` |
| Agent 的 Grep 工具 | 有（服务端 / 容器执行），但结果只在聊天工具卡里，不可从文件面板触达 | `ToolGrepView.vue` 仅渲染工具结果 |
| 执行端文件代理 | list / read / search / files 四 op；search 为纯文件名 BFS（跳 .git / node_modules、深度与目录数上限） | `remote-file-proxy.service.ts:10`、`agent-cli/src/local/file-ops.ts:137-167` |
| 命中行定位 | FileViewer 已有行区间引用与定位先例（选区引用，批次 18） | `2026-10-27-selection-quote` 落地能力 |
| 客户端能力分层先例 | auth 帧 `capabilities` 声明 + 旧版本即时返回升级提示（0.0.527） | `streaming-ws-handler` capabilities 链路 |

## 2. 目标 / 非目标

**目标**

1. **P1 CLOUD 内容搜索端点**：`GET /v1/files/workspace-content-search`——参数 sessionId / query / caseSensitive / 文件名 glob 过滤（可选）；实现收敛到与 Agent Grep 工具同源的底层检索 util（同一套跳过目录与文本判定口径），执行于服务端 workspace 根（与既有 browse / search / read 路由同文件系统口径，容器隔离不改变 workspace 挂载位置）。约束：文本类扩展名白名单、单文件大小上限（1MB）、总命中上限（200 行 / 50 文件）、总超时（5s）、跳过 `.git` / `node_modules` / `dist` 等（与执行端 BFS 同名单）；二进制与超限文件跳过并在响应中汇总计数。返回 `{file, line, lineStart/End, snippet(截断), matchCount, truncated}`。
2. **P1 桌面端搜索模式**：文件管理器搜索框升级为「文件名 | 内容」双模式（下拉或分段控件，记忆上次选择）——内容模式结果按文件分组、显示命中行片段（关键词高亮），点击打开 FileViewer 文本预览并**滚动定位到命中行**（复用行区间定位先例）；截断提示沿用名称搜索的既有样式。
3. **P2 LOCAL 内容搜索**：执行端文件代理新增独立 op `content_search`（**不扩展现有 `search` op**——旧执行端收到陌生 op 返回明确「版本过旧」提示，复用 capabilities 分层先例）；mao-agent（`file-ops.ts`）与桌面客户端主机（Electron IPC 侧）同构实现，跳过目录 / 大小 / 命中上限口径与 CLOUD 逐字一致；执行端离线或版本过旧时返回明确中文提示（对齐 0.0.526 既有文案风格）。
4. **P3 顺带补齐：同目录复制副本**——当前「复制」必须换目录（同目录粘贴被后端拒绝，`workspace-file-write.ts:469-470` 注释）；补「粘贴为副本」生成 `xxx 副本.ext` 命名，消除该反直觉限制。

**非目标**

- 不做编辑保存（FileViewer 保持只读——Agent 是 workspace 的唯一写者，人改文件会引入与运行中任务的并发写冲突；定位是「找得到、看得清」，改交给 Agent）。
- 不做索引化 / 向量化检索（knowledge-rag 批次 2 已否决；本提案是按需单次精确文本检索，无驻留进程、无 embedding 设施）。
- 不做正则语法（第一版 contains + 大小写开关；正则语义与 Agent Grep 工具重叠，收益存疑）。
- 不做跨会话全局文件搜索（范围爆炸，工作区归属清晰，按会话检索即可）。
- 不改既有名称搜索端点、既有 `search` op、上传 / 下载 / Git 面板任何行为。

## 3. 与已落地 / 已否决方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 知识库 / RAG（批次 2 否决） | 否决的是 embedding 检索设施；本提案是精确文本匹配、零索引、随用随扫 |
| 跨会话全文检索（批次 5 已落地） | 那是**消息**检索；本提案是**工作区文件内容**检索，数据源与链路完全不同 |
| 会话内查找 / Markdown 导出（批次 20 否决） | 否决的是消息流定位与导出；文件面板不属其范围 |
| 运行轨迹搜索（批次 24 否决） | 轨迹透视面的事，与文件无关 |
| Agent Grep 工具 | 不动；工具是 Agent 用的，本提案是给人用的同一底层能力的 UI 出口 |

## 4. 方案设计

- **后端**：`workspace-browse.service.ts` 同族新增内容搜索函数——目录遍历复用名称搜索的既有骨架（防抖竞态在前端，后端单次请求）；文本判定按扩展名白名单 + 魔数嗅探兜底；命中行 snippet 前后各留 ~80 字符按码点截断（复用 clipByCodePoints 口径，防 emoji 切半——0.0.527 的教训）。检索 util 与 harness Grep 工具的目录跳过名单收编共享常量，避免两份名单漂移。
- **desktop**：`useFileManager` 搜索状态机加 mode 维度（名称 / 内容互斥，切换清结果）；内容结果树（文件 → 命中行列表）；点击命中行 → 打开 FileViewer（文本模式）+ 滚动定位（复用选区引用的行定位参数通道）；搜索框 placeholder 随模式切换。
- **LOCAL 代理**：`RemoteFileOp` 增 `content_search`；服务端按既有定向转发链路下发；执行端（mao-agent / 桌面客户端）实现同构约束并回传同构结果结构；版本分层——执行端未声明新能力时返回升级提示（capabilities 帧已具备该基建）。桌面客户端本机（非远程代理路径）同步支持，避免「桌面上看自己 LOCAL 任务也搜不了」的不对称。
- **改密式兼容**：无——新端点、新 op、新 UI 分支，全部可独立回滚。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | file 路由 1 端点 + browse service 内容搜索实现 + 共享跳过名单常量；新增 spec |
| desktop | FileManagerPanel / useFileManager / workspace-file-provider（内容模式 UI 与 LOCAL 双路径）；Electron 主进程 IPC 同步实现；新增组件测试 |
| agent-cli | `file-ops.ts` 新增 `content_search` op（与桌面同构） |
| admin / android | **零改动**（安卓共用 Web 文件面板即生效） |
| 数据库迁移 | **无** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 大工作区扫描拖垮服务端 | 扩展名白名单 + 单文件 1MB 上限 + 命中 / 文件数双上限 + 5s 总超时 + 排除目录名单；超限即截断并如实标注（名称搜索已有截断提示先例） |
| 二进制文件误扫出乱码 | 魔数嗅探 + 扩展名白名单双保险；跳过文件计入响应汇总而非静默 |
| 旧执行端不认识新 op | 独立 op 命名（不改 `search`）+ capabilities 分层 + 明确升级提示（0.0.527 先例）；不挂起不静默 |
| CLOUD 容器隔离下路径口径漂移 | 搜索执行于服务端 workspace 根，与既有 browse / read 路由同口径——容器只影响 Agent 工具执行面，不影响文件路由面，无新增漂移 |
| 命中片段截断切断 emoji / 中文 | snippet 按码点截断（clipByCodePoints，0.0.527 已收口的同口径 util） |
| 内容模式与名称模式状态互串 | 模式切换清空结果与防抖计时；两模式共用「点击跳转」但目标结构不同，分开测试 |

## 7. 测试要点

1. CLOUD 内容搜索：命中行数、snippet 截断、大小写开关、glob 过滤；二进制 / 超大文件跳过计数如实。
2. 上限与超时：构造超过 200 命中的工作区 → truncated 标记；超时返回明确文案不挂死。
3. 桌面内容模式：按文件分组展示、关键词高亮、点击直达 FileViewer 命中行；切回名称模式结果清空、行为与现状一致（回归口径）。
4. LOCAL：桌面客户端在线时浏览器发起内容搜索 → 代理转发 → 结果同构；mao-agent 执行端同验；执行端离线 / 版本过旧 → 明确中文提示。
5. 旧版执行端回归：旧 mao-agent / 旧桌面客户端收到 `content_search` 请求 → 返回版本过旧提示，`search` / `list` / `read` / `files` 四 op 行为逐字节不变。
6. 同目录复制副本：粘贴为副本生成正确命名与内容；原「复制必须换目录」限制在普通粘贴路径行为不变。
7. 回归：名称搜索（双模式）、打包下载、上传取消、预览全形态零变化。
