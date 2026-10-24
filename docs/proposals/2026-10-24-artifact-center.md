# 提案：交付物中心（Artifacts）—— 让 Agent 的产出成为可找到、可预览、可发送、可复用的对象

> 会话留下的是过程，工作留下的是文件；本提案让「交付的那一刻」成为系统里的一等对象。

- 状态：已否决（2026-10-24），存档勿再评审
- 日期：2026-10-24
- 提案总览：见 [docs/proposals/README.md](README.md)
- 规模：中（新域 + 一个工具 + 两个页面；存储与预览为主）
- 关联：`file` 域、`session` 域、`session_share`、`send-file-bytes`、`generate_image`

## 1. 背景与现状

### 1.1 Agent 已经在产出文件，但系统里没有「成果」这个概念

今天 Agent 的产出散落在三个互不相通的地方：

1. **工作区文件**：报告 `.md`、表格 `.csv`、脚本、截图。只有会话检查器的文件树 / 文件管理页能看，路径是唯一身份。会话归档、工作区清理、用户换机器之后，链接就断了。
2. **上传目录**：`generate_image` 把图片写到 `{uploadDir}/{userId}/`（`generate-image-tool.ts`），返回 `image_url` 与 `image_path`；图片只活在消息里，聊天记录滚过去就找不回来。
3. **消息附件**：用户上传的 `file` 表记录（V002），以及工具结果里的 base64 附件（`message.metadata.attachments`）。它们属于「输入/过程」，不是「交付」。

于是用户的真实问题都答不上来：

- 「上周那份竞品分析报告在哪？」——只能翻会话、翻文件树。
- 「这个月 Agent 一共给我产出了什么？」——没有地方看。
- 「把这份报告发给我领导」——要么下载再转发，要么让 Agent 重发一次。
- 「这版和上一版有什么区别？」——工作区里的文件可能已经被下一次任务覆盖。

### 1.2 现有设施各自解决了一部分，但都不是「交付物」

| 设施 | 解决什么 | 为什么不等于交付物 |
|---|---|---|
| 工作区文件管理（2026-10-09 已实施） | 增删改查、上传下载、移动复制 | 管的是**可变的工作区状态**；文件被改 / 删 / 清理即消失，没有标题、描述、来源 |
| 会话只读分享（2026-10-06 已实施） | 把整段对话冻在水位线上分享 | 分享的是**过程**，不是结果；收件人要在几百条消息里找文件 |
| 消息导出 JSONL | 审计与备份 | 面向系统，不面向人 |
| 渠道发送工具（`feishu_send_file` / `send_wechat_file` / `dingtalk_send_file`） | 把文件发到 IM | 一次性动作，没有记录「发过什么、发给谁」 |
| 图片生成工具 | 产出图片 | 只返回 URL / 路径，没有登记，没有列表 |

### 1.3 为什么现在做

- 使用重心正在从「问问题」转向「做东西」：报告、表格、图片、代码补丁、数据清洗结果。**产出越多，找不到的痛越强**。
- 批量任务（[2026-10-24-batch-runs.md](2026-10-24-batch-runs.md)）一次会产生 N 份结果，如果没有交付物层，结果只能散在 N 个工作区里。
- 定时任务 / 信号哨兵已经在无人值守地跑，但「跑完的成果」只能靠会话通知点进去看——缺一个「成果收件箱」。
- 这是产品叙事的一次升级：从「Agent 能回答」到「Agent 能交付」。前者是聊天框，后者才是工作台。

## 2. 目标 / 非目标

**目标**

1. 新增一等对象 **Artifact（交付物）**：有标题、描述、类型、大小、哈希、来源会话 / 工具调用、版本。
2. Agent 通过内置工具 `publish_artifact` 显式声明「这是本次任务的交付物」；系统复制一份**不可变快照**，工作区后续修改不影响已交付版本。
3. 用户在任务检查器看到「交付物」页签，在「我的交付物」页面跨会话检索、预览、下载、删除。
4. 预览覆盖常见类型：图片、PDF、Markdown、纯文本 / 代码、CSV 前 N 行；Office 文档 v1 只提供下载。
5. 交付物可一键发送到已绑定的飞书 / 微信 / 钉钉（P2），形成「产出 → 交付」闭环。
6. 与批量任务、定时任务、会话分享自然衔接：批次页按 `batch_id` 汇总产物；分享页可列出本次分享包含的交付物（P2）。

**非目标**

- 不做团队共享资产库 / 知识库：交付物默认私有，分享走显式链接（与已否决的团队知识层划清界限）。
- 不做在线编辑：交付物是不可变快照；要改就回工作区改，再发布新版本。
- 不做 docx / xlsx 的在线渲染（P2 再评估，需要引入解析依赖与服务端转换）。
- 不做全局数据保留策略 / 自动过期删除（2026-10-09 已否决数据保留方向）；本提案只有**配额**与**手动删除**。
- 不做交付物市场的评分、评论、推荐。
- v1 只支持 CLOUD 会话发布（LOCAL 文件在用户设备上，见 §6 开放问题）。

## 3. 与已否决 / 已实施方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 团队知识层（2026-10-19 否决） | 不做 TEAM 级共享记忆、不做经验提案；交付物是个人产物，分享是单次显式动作 |
| 结构化回复卡片（2026-10-19 否决） | 不新增消息块协议、不改渲染器；交付物是文件对象，聊天里仍走既有工具卡 |
| 数据保留策略（2026-10-09 否决） | 不定义全站数据生命周期；只有每用户存储配额 + 手动删除 + 软删物理清理 |
| 工作区文件管理（已实施） | 文件管理操作**可变工作区**；交付物是**不可变快照 + 交付语义**，二者并存 |
| 会话分享（已实施） | 会话分享冻结对话；交付物分享（P2）只分享结果对象，可独立于会话存在 |

## 4. 技术方案

### 4.1 数据模型（迁移按实施顺序顺延，当前最新 V168）

```sql
CREATE TABLE `artifact` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `user_id`       BIGINT NOT NULL,
  `session_id`    BIGINT NULL COMMENT '来源会话；会话删除后保留（交付物可独立存在）',
  `message_id`    BIGINT NULL COMMENT '发布时所在 assistant 消息',
  `tool_call_id`  VARCHAR(128) NULL COMMENT '来源工具调用，便于回轨迹',
  `agent_id`      BIGINT NULL,
  `title`         VARCHAR(256) NOT NULL,
  `description`   VARCHAR(1024) NULL,
  `kind`          VARCHAR(16) NOT NULL COMMENT 'FILE/IMAGE/REPORT/DATASET/ARCHIVE',
  `mime`          VARCHAR(128) NULL,
  `size`          BIGINT NOT NULL,
  `sha256`        CHAR(64) NOT NULL,
  `storage_path`  VARCHAR(512) NOT NULL COMMENT '不可变快照路径',
  `source`        VARCHAR(16) NOT NULL DEFAULT 'EXPLICIT' COMMENT 'EXPLICIT/IMAGE_TOOL/SENT',
  `version`       INT NOT NULL DEFAULT 1,
  `superseded_by` BIGINT NULL COMMENT '同会话同标题的下一版',
  `deleted_at`    DATETIME NULL,
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_artifact_user` (`user_id`, `created_at`),
  KEY `idx_artifact_session` (`session_id`, `created_at`),
  KEY `idx_artifact_hash` (`user_id`, `sha256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='交付物（不可变快照）';
```

**存储**：新增配置 `MAO_ARTIFACT_DIR`（默认 `/opt/mao-data/artifacts`，与 `uploadDir` 同级的数据根）。落盘结构 `{artifactDir}/{userId}/{yyyyMM}/{id}-{safeName}`。该目录**不挂载进用户容器**，只由后端读写——交付物对 Agent 只读（通过下载接口），避免「已交付版本被后续任务改掉」。

**为什么复制而不是引用工作区路径**：交付物的价值就在「交付那一刻的内容」。引用路径会随工作区修改、清理、换机器而失真，也无法回答「这版和上一版差在哪」。

### 4.2 发布路径

**P1：显式工具 `publish_artifact`**

```ts
publish_artifact({
  path: string,        // 必须位于当前会话工作区内（严格解析，禁 symlink 逃逸）
  title: string,       // 1-120 字
  description?: string,
  kind?: 'FILE' | 'IMAGE' | 'REPORT' | 'DATASET' | 'ARCHIVE'
})
```

执行流程：

1. 用 `StrictPathResolver` 把 `path` 解析到当前会话工作区，校验存在、是普通文件、大小 ≤ 100MB（可配）。
2. 读字节（CLOUD 下工作区在宿主机同路径挂载，可直接读；容器模式路径一致，不需要进容器）。
3. 计算 sha256；同用户同哈希已有活跃交付物时，仍新建记录（来源不同），但 UI 可提示「内容与某交付物相同」。
4. 写不可变快照；同 `(session_id, title)` 已有记录时 `version + 1`，旧记录 `superseded_by = 新 id`；列表默认只显示最新版。
5. 返回 `{ artifactId, title, size, mime, version, downloadPath }`，工具结果摘要显示「发布交付物：报告.pdf（1.2MB）」。
6. 工具结果里带 `artifactId`，该工具卡显示「查看交付物」按钮（复用既有工具卡，不新增消息块、不改消息表）。

**为什么先做显式**：不是工作区里每个文件都是交付物。自动收集会把临时脚本、中间数据、日志全部灌进来，列表很快不可用。显式声明还能让模型在收尾时自我确认「到底交付了什么」。

**P2：自动登记**
- `generate_image` 的产物自动登记为 `IMAGE`（`source=IMAGE_TOOL`），解决「生成的图找不回」；
- 渠道发送工具发送的文件自动登记 `source=SENT`，形成发送历史；
- 通过工具结果后置钩子实现，不把 artifact 服务塞进每个工具的构造链。

**LOCAL 会话**：v1 直接返回明确错误「LOCAL 会话的交付物暂不支持，请在工作区生成后从桌面端下载」。P2 由桌面端把字节上传到 `POST /v1/artifacts`（multipart），服务端落快照。

### 4.3 读取、预览与删除

| 接口 | 说明 |
|---|---|
| `GET /v1/artifacts?keyword&kind&agentId&from&to&page` | 当前用户列表，默认只返回最新版、未删除 |
| `GET /v1/artifacts/:id` | 元信息（含来源会话 / 工具调用 / 版本链） |
| `GET /v1/artifacts/:id/content?disposition=inline\|attachment` | 读字节；inline 仅对安全类型开放 |
| `DELETE /v1/artifacts/:id` | 软删除；物理文件由清理任务在 7 天后删除 |
| `GET /v1/artifacts/usage` | 当前用户已用容量 / 配额 |

- **权限**：仅属主可读写；管理员只读走 `session:read` + 来源会话归属校验（P2）。不新增权限码，避免权限目录扩散。
- **预览安全**：`Content-Disposition: inline` 只给 `image/*`、`application/pdf`、`text/plain`、`text/markdown`、`text/csv`；`text/html`、`image/svg+xml` 一律 `attachment` + `X-Content-Type-Options: nosniff`，防存储型 XSS。前端用 blob URL 渲染，不直接开新窗口。
- **前端预览**：优先复用中间区现有的 `FileViewer.vue` / `PdfViewer.vue`（前者已接 `useMonacoViewer` 与 Markdown 渲染，后者基于 `pdfjs-dist`），新增一个 artifact provider 把 `readFile` / `previewFile` 指向 `/v1/artifacts/:id/content`；图片直接 `<img>`；CSV 前端解析前 200 行做表格（P2）。Office 文档 v1 显示「下载查看」。
- **配额**：默认 2GB/用户（配置项），发布时超限返回 `ARTIFACT_QUOTA_EXCEEDED`，页面显示用量条；管理员可调。删除只释放软删记录占用的配额（物理清理前先扣减）。

### 4.4 前端

- **任务检查器新增「交付物」页签**（`TaskInspector` 现有 `workspace / filetree / git` 三 Tab 之后）：网格卡片，显示缩略图 / 类型图标、标题、大小、版本、发布时间；点击预览，悬浮出现下载、复制链接、发送（P2）、删除。
- **「我的交付物」页面**：侧栏新增入口，或挂在设置下（建议侧栏「交付物」，与任务并列——它是日常入口，不该藏在设置里）。支持关键词、类型、Agent、时间筛选；按日期分组；顶部显示容量用量。
- **聊天里的入口**：工具卡「查看交付物」按钮 + 发布成功时行内提示（不新增消息块，复用现有工具卡渲染）。
- **批量任务联动**：批次详情页「本批产物」区块，按 `batch_id`（经 session 关联）聚合；导出批次结果时附交付物清单。
- **管理后台（P2）**：会话详情新增只读「交付物」页签，便于审计「这个会话到底交付了什么」。

### 4.5 工具接入的规范同步

新增内置工具必须按 `AGENTS.md` 同改三处，漏一处会出现「工具能跑但界面显示空」：

1. `backend-ts/src/session/util/tool-result-summarizer.ts`：成功 / 失败 / 缺参的结果摘要；
2. `desktop/src/utils/toolDisplay.ts`：中文名「发布交付物」与参数预览（`title` / `path`）；
3. `backend-ts/src/harness/core/no-progress-notice.ts`：把 `artifactId`、`downloadPath` 纳入 `VOLATILE_RESULT_KEYS`（每次发布都不同，不剥离会误判「有进展」）。

另加回归测试：成功、文件不存在、越界路径、超大小、LOCAL 会话、配额超限。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | `artifact` 表 + 存储 + `publish_artifact` 工具 + 列表/详情/内容/删除接口 + 检查器页签 + 我的交付物页 + 图片/PDF/Markdown/代码预览 | 8-10 人日 |
| P2 | 图片工具自动登记、发送到渠道、Office 下载提示优化、CSV 表格预览、会话分享页列交付物、管理后台只读页签 | 5-6 人日 |
| P3 | 交付物分享链接（复用 `session_share` 的 token / 过期 / 吊销语义）、LOCAL 上传、批量产物打包下载、跨版本 diff（文本类） | 4-6 人日 |

P1 独立可用：没有批量、没有分享，也能解决「成果找不到、发不出、版本乱」三个最痛的点。

**改动面（P1）**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 后端 | 新域 `backend-ts/src/artifact/`（routes / service / repository / storage） | 发布、列表、详情、下载、删除、配额 |
| 后端 | `harness/tool/impl/publish-artifact-tool.ts` + `tool-registry` 装配 | 新内置工具与结果结构 |
| 后端 | `session/util/tool-result-summarizer.ts` / `harness/core/no-progress-notice.ts` | 结果摘要、`VOLATILE_RESULT_KEYS` |
| 后端 | `config/app-config.ts` / `application.yml` / `.env.example` | `MAO_ARTIFACT_DIR`、配额、单文件上限 |
| 前端 | `components/task/TaskInspector.vue`（新增页签）、新 `views/artifact/ArtifactsView.vue`、router | 任务内与全局两个入口 |
| 前端 | `components/center/FileViewer.vue` 的 artifact provider | 预览复用现有渲染器 |
| 迁移 | `V172__artifact.sql` | `artifact` 表 |
| 文档 | `CHANGELOG.md` / `skills/mao-cli/` / `USER_GUIDE.md` | 交付物语义、存储、配额 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| 存储增长 | 中 | 2GB/用户配额 + 删除软删 + 物理清理；不做自动过期（避开已否决的数据保留方向） |
| 敏感文件被复制一份 | 中 | 交付物只对属主可见；删除会话不自动删交付物（这是产品价值），但提供「随会话删除」可选项（P2） |
| 交付物与工作区不一致 | 低 | 明确「快照」语义；UI 标注「发布于…，工作区可能已更新」 |
| 模型滥用发布（把中间文件都发） | 中 | 工具描述限定「最终交付物」；单次执行最多 10 个（可配）；超限报错让模型收敛 |
| HTML / SVG 预览 XSS | 中 | 强制 attachment + nosniff；只对白名单 MIME inline |
| 容器模式读不到工作区文件 | 低 | 工作区以相同绝对路径 rw 挂载进容器，宿主机可直接读；仍走严格路径解析 |
| 版本链无限增长 | 低 | 同标题同会话只保留最近 5 版（旧版软删），可配置 |
| 配额计算口径 | 低 | 按活跃记录 `size` 求和，删除软删记录即扣减；物理清理失败不回滚配额 |

**待确认决策**

1. 交付物是「每人私有」还是「Agent 可见」？建议私有；Agent 不需要读历史交付物（要读文件直接读工作区）。
2. 删除会话时是否级联删除交付物？建议不删（成果应比对话活得久），但删除会话时提示「仍有 N 个交付物」。
3. 是否允许发布工作区外的文件（如共享目录 `/opt/mao-data/share`）？建议 P1 只允许会话工作区，避免把公共文件复制成私有副本。
4. 单文件上限 100MB 是否合适？建议默认 100MB，配置可调；超出让用户压缩或拆分。
5. 是否需要「交付物」与「产物」两个词？建议统一用「交付物」，避免用户以为是构建产物。

## 7. 测试要点

- `ArtifactService.publish`：正常复制、哈希一致、版本递增、旧版 `superseded_by` 正确；同名不同会话不串版本。
- 路径安全：`../`、绝对路径、symlink 指向工作区外、目录而非文件、不存在文件，全部拒绝且错误可读。
- 配额：达到上限拒绝发布；删除后释放；并发发布不超卖（事务 / 行锁）。
- 内容接口：属主可取；非属主 403/404；软删后 404；`inline` 白名单与 `attachment` 强制头正确；Range 请求（大文件）行为明确（P1 可不支持，返回 200）。
- 预览：图片 / PDF / Markdown / 代码四类正常；HTML 不 inline。
- 工具：成功 / 缺参 / 越界 / 超大 / LOCAL / 配额六类结果摘要与前端展示；`VOLATILE_RESULT_KEYS` 包含新字段，no-progress 不误报。
- 前端：检查器页签加载、分页、删除确认、容量条；全局页筛选与跳回会话。
- 回归：工作区文件管理、会话分享、渠道发送三条既有链路不受影响。

## 8. 验收标准与观察指标

**验收**

1. 让 Agent 生成一份 Markdown 报告并 `publish_artifact`，检查器「交付物」出现该文件；修改工作区原文件后，交付物内容不变。
2. 「我的交付物」跨 3 个会话筛出全部产物，图片有缩略图、PDF 能翻页、Markdown 能渲染。
3. 同名再发布一次，版本变为 2，列表默认只显示最新版，详情能看到版本链。
4. 删除交付物后列表消失、下载 404，配额释放。
5. 批量任务跑 20 条，其中 5 条发布交付物，批次页「本批产物」正确聚合 5 个。

**指标（上线后 8 周）**

- 每周发布交付物数、发布者占比；
- 交付物详情 / 下载 / 发送次数（判断是否真的被消费，而非只进不出）；
- 「找文件」类重复会话是否下降（定性）；
- 存储用量分布（P50 / P95 / 最大用户），验证 2GB 配额是否合理。
