# 提案：CLOUD 工作区环境模板与快照 —— 别再让每个新会话从裸目录开始

- 状态：**已否决**（2026-10-11 评审：不做。本文仅存档，勿再评审）
- 日期：2026-10-11
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

CLOUD 会话的工作区初始化（`session.service.ts` 的 `initializeCloudWorkspace`）今天只有四条路：

1. **新建**：建个空目录（`{workspaceRoot}/{userId}/{sessionId}` 或项目目录）；
2. **复用**：指向已有项目工作区；
3. **Git clone**：从 HTTPS 仓库拉（`git-operation.service.ts`，带 askpass Token 注入）；
4. **临时**：渠道（飞书 / 微信）会话的固定工作区。

初始化之后还做一件事：`environmentInfoProvider.detect(session.workspace)`——探测环境信息（技术栈 / 版本等）注入系统提示。也就是说，**Mao 已经知道"给 Agent 一个可用的环境"很重要**，但"可用环境"的定义被冻结在"空目录 + 一个 git 仓库 + 探测报告"。

真实使用的断点：

1. **装环境是每会话的重复劳动**。Node 项目要 `npm install`（几百 MB、数分钟）、Python 要 venv + pip、Java 要 Maven 缓存。今天每个新会话从零开始，Agent 第一轮几乎必然在跑安装——慢、烧 token、还经常在依赖下载上失败。而同一个项目的第三个会话，装的是和第一个会话完全相同的东西。
2. **项目级配置进不去**。`AGENTS.md` 注入了、技能注入了、记忆注入了——但**项目的 `.npmrc` / `pom.xml` / 预置的 `.env.example` / 数据种子 / 构建脚本**这些让项目"能跑起来"的东西，只存在于用户本机或某个 git 仓库里，空工作区里没有。
3. **clone 解不了"私有资产"问题**。公司内网项目不一定有 git 远端；有些"环境"是打包好的一整个目录（含 node_modules 或数据文件），git 根本不合适（大文件、二进制）。
4. **快照是"做脏了救不回来"的另一半**。今天会话工作区改坏了，只能靠 git（如果它是 git 仓库）或手动重来。**「任务检查点与工作区回滚」提案已在 0.0.236 评审否决**（存档于 `docs/proposals/2026-10-06-task-checkpoint-rollback.md`），否决理由是轮次边界快照的工程复杂度和收益不匹配。本提案**不重启那个方向**，只做"建会话时选一个环境起点"这一件事，不做执行中回滚。

相邻方向的边界：

- **不是备份恢复**（已否决）：备份是实例级灾备（DB + 全量数据目录）；模板是工作区级的"起点资产"，跟实例灾备无关。
- **不是 LOCAL 能力**：LOCAL 工作区就是用户本机目录，本提案只管 CLOUD（服务端工作区）。安卓 / Web / 桌面 CLOUD 会话受益。
- **不是 Docker / 容器化**：不做镜像构建与容器编排（那是基础设施重构，远超提案范围）。模板 = 目录资产 + 可选初始化命令，仍是进程级执行。
- **不是检查点回滚**（已否决，不重启）：不做执行中快照与轮次级回滚；模板只在**建会话那一刻**生效一次。

## 2. 目标 / 非目标

**目标**

1. **环境模板**：用户可把任意 CLOUD 会话工作区（或其中的一部分，按规则过滤）保存为「环境模板」，含：目录内容快照 + 元信息（名称、说明、来源项目、大小、探测到的技术栈）+ 可选初始化命令（`npm install` 等，保存时记录**当时跑过的命令**供复用）。
2. **建会话选起点**：新建 CLOUD 会话时，工作区选择器在「新建 / 复用 / Git clone」之外多一项「从模板创建」：选模板 → 服务端把模板目录复制到新会话工作区（大模板异步复制 + 进度）→ 可选执行初始化命令（或直接沿用快照里已装好的依赖）。
3. **模板管理**：设置页模板列表（名称 / 大小 / 技术栈 / 创建时间 / 被引用次数）、重命名、删除（物理删 + 二次确认，列出占用）、更新（从某个会话工作区重新覆盖生成，版本号 +1）。
4. **共享**：模板可设为「团队可见」（实例内全员可用）或私有；团队模板由创建者维护，使用者只读（对齐团队共享 Agent 的模式：`shared_agent_entry`）。
5. **配额与限制**：每用户模板总量上限（默认 5GB，可配）；单模板大小上限；复制到会话工作区时做磁盘余量预检，不足即拒绝并提示（不写半截）。

**非目标**

- 不做模板的增量 / 差异更新（更新 = 全量重新生成，版本号 +1）。
- 不做跨实例模板分发（bundle 格式另立议题，模板含二进制大文件，与 Agent bundle 的 JSON 形态不同）。
- 不做初始化命令的编排 DSL（就是一条或多条 shell 命令串行执行，记录时是什么就是什么）。
- 不做模板的自动"新鲜度"检查（模板里的 node_modules 会不会过期——用户自己更新模板）。
- 不做执行中的工作区快照与回滚（已否决方向，不重启）。
- 不改 LOCAL 会话的任何行为。

## 3. 技术方案

### 3.1 存储布局

模板落在数据目录下独立区域（**不在**任何会话工作区内，避免被会话文件管理 / 工作区搜索扫到）：

```
{dataDir}/workspace-templates/
  {templateId}/
    manifest.json        # 名称/说明/技术栈/版本/创建人/大小/命令列表
    files/               # 目录内容（tar 解包态或直接拷贝态）
```

`manifest.json` 结构：

```json
{
  "id": 12,
  "name": "node20-api-starter",
  "description": "公司 API 项目基础环境",
  "visibility": "TEAM",
  "techStack": ["node20", "npm"],
  "initCommands": ["npm ci --prefer-offline"],
  "sizeBytes": 734003200,
  "fileCount": 12453,
  "createdBy": 3,
  "version": 2,
  "sourceSessionId": 88,
  "createdAt": "..."
}
```

元信息落库（`workspace_template` 表）供列表 / 权限 / 配额查询，`files/` 目录是实际内容。**DB 与目录的一致性**：删除时先删库行再删目录（删失败留下孤儿目录由巡检清理，反向则会出现有行无内容）。

### 3.2 数据模型（迁移号顺延，当前已到 V147）

```sql
CREATE TABLE IF NOT EXISTS `workspace_template` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`      BIGINT NOT NULL COMMENT '创建人',
    `name`         VARCHAR(128) NOT NULL COMMENT '模板名称（同用户内唯一）',
    `description`  VARCHAR(500) NULL,
    `visibility`   VARCHAR(8) NOT NULL DEFAULT 'PRIVATE' COMMENT 'PRIVATE / TEAM',
    `tech_stack`   VARCHAR(500) NULL COMMENT '探测到的技术栈 JSON 数组',
    `init_commands` TEXT NULL COMMENT '保存时记录的初始化命令 JSON 数组',
    `size_bytes`   BIGINT NOT NULL DEFAULT 0,
    `file_count`   INT NOT NULL DEFAULT 0,
    `version`      INT NOT NULL DEFAULT 1,
    `source_session_id` BIGINT NULL,
    `ref_count`    INT NOT NULL DEFAULT 0 COMMENT '被引用次数（建会话时 +1）',
    `deleted`      TINYINT NOT NULL DEFAULT 0,
    `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_user_name` (`user_id`, `name`, `deleted`),
    INDEX `idx_visibility` (`visibility`, `deleted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='CLOUD 工作区环境模板';
```

`uk_user_name` 带 `deleted` 列：软删后同名可重建（与项目里其他软删表的口径一致）。

### 3.3 保存：从会话工作区到模板

- 入口：CLOUD 会话的工作区文件面板工具栏「存为环境模板」（仅 CLOUD 会话显示；会话属主本人）。
- 快照构建（异步任务 + 进度）：
  - 默认排除规则（与备份提案同源思路，可编辑）：`node_modules`、`.git/objects`、`dist`、`build`、`.cache`、`uploads`、`*.log`、`tmp`；
  - 但 **`node_modules` 是否排除是可选项**——模板的核心价值恰可能是"装好的依赖"。排除规则做成勾选清单，默认勾选排除（保守，体积优先），用户可取消勾选把 node_modules 打进去（提示体积）。
  - 复制方式：目录级拷贝 + 边拷边统计（fileCount / sizeBytes）；中断（取消 / 失败）清理半截目录。
- `initCommands` 来源：保存时让用户填"这个环境当时怎么装的"（一个多行输入，每行一条命令），或从该会话的活动记录里自动提取疑似安装命令（`npm install` / `pip install` / `mvn` 等模式匹配，供一键填入）。
- 保存后 `detect` 跑一次技术栈探测，写 `tech_stack`。
- 配额检查：保存前估算体积，超用户总量上限即拒。

### 3.4 使用：从模板到会话工作区

- 新建会话向导的工作区步骤：模板选择器（我的模板 + 团队模板分区，展示大小 / 技术栈 / 被引用次数）。
- 服务端 `POST /v1/files/workspace-template/:id/instantiate`（body: `sessionId`）：
  1. 校验会话属主 + CLOUD + 会话工作区为空（非空拒绝，避免覆盖已有内容——用户想覆盖应先清空）；
  2. 磁盘余量预检（模板体积 + 余量）；
  3. **异步复制**（大模板可能数分钟）：返回 taskId，WS / 轮询进度；失败清理半截；
  4. 复制完成后可选执行 `initCommands`（用户在向导里勾选"创建后执行初始化命令"）——执行走既有 shell 会话通道（`shell-session-tool` 同源），输出实时可见，失败不阻塞会话创建（提示用户手动处理）。
- 复制完成的会话工作区 = 普通工作区，后续行为（文件管理、Git、Agent 执行）零差异。

### 3.5 前端与管理后台

- 设置页「工作区模板」：列表 / 新建（从已有会话导入，弹会话选择器）/ 重命名 / 删除（二次确认列体积）/ 更新（重新生成，版本 +1）/ 共享开关。
- 新建会话向导：模板选择分区 + 大小与"含 node_modules"徽标。
- 管理后台：全量模板清单（用户 / 体积 / 引用次数 / 技术栈）+ 总量统计（磁盘占用 Top），`template:read` 权限；不提供管理侧写入（模板是用户资产）。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | `workspace_template` 表 + 存储布局 + 保存（排除规则 + 异步拷贝 + 配额）+ 设置页模板管理（CRUD）+ 建会话时模板实例化（异步复制 + 进度 + 空工作区校验） | 中~大 |
| P2 | initCommands 记录与创建后执行（shell 通道复用 + 实时输出）+ 从活动记录提取安装命令 | 小~中 |
| P3 | TEAM 共享 + 管理后台统计 + 更新重新生成（版本 +1）+ 孤儿目录巡检清理 | 小~中 |

## 5. 风险与开放问题

- **磁盘爆炸**：模板动辄数百 MB（含 node_modules 时数 GB），N 个用户 × M 个模板可能吃满数据盘。缓解：用户总量上限（默认 5GB 可配）+ 管理后台磁盘占用可见 + 默认排除 node_modules 的保守策略 + 保存前体积预估提示。
- **复制期间的一致性**：保存模板时源工作区可能有 Agent 正在写。缓解：保存时若会话在跑，提示"会话执行中，快照可能不含最新变更"（不阻断——与 git 提交同样的语义：快照即当时状态）；不要求会话停止。
- **路径逃逸**：模板内容若含符号链接，拷贝时可能逃出目标工作区。缓解：拷贝器跳过符号链接（与 `workspace-search` 的遍历策略一致：跳过 `.git` / `node_modules` / 符号链接目录），或对链接目标做沙箱内校验后拷实体。
- **敏感数据进模板**：工作区里的 `.env`、密钥文件会原样进模板；TEAM 共享后全员可见。缓解：保存预览时按敏感文件名规则（与 git 提交信息同源规则）高亮警告"包含疑似敏感文件"；TEAM 共享二次确认明示风险；不做内容级扫描（成本与误报）。
- **实例化失败半截**：复制到 80% 磁盘满了。缓解：余量预检（模板体积 × 1.2 缓冲）+ 失败清理 + 明确错误码（不留下"看起来成功了其实没拷完"的工作区）。
- **与 Git clone 的关系**：模板和 clone 都是"起点"，并存不冲突（clone 适合有远端的、模板适合私有资产 / 装好依赖的）。文档需说清选择建议。
- **开放问题**：模板要不要支持"只存差异"（以某个基础模板为底，只存增量）——P1 全量，差异版是后续优化（工程复杂度高，先不做）。
- **开放问题**：定时任务 / Webhook 触发**新建**会话时能否指定模板（而非只能复用既有会话）——涉及开放 API 的会话创建面，建议 P3 评估，P1 只覆盖桌面端手工创建。

## 6. 测试要点

- 保存：排除规则生效（默认排除项不进模板）；勾选 node_modules 时进；符号链接被跳过；体积 / 文件数统计正确；超用户配额拒绝；保存中取消不留半截目录。
- 实例化：会话工作区为空时才允许（非空拒绝且提示）；异步复制进度上报；磁盘余量不足预检拒绝且不落任何文件；复制失败清理半截；完成后工作区内容与模板一致（文件数 / 抽样内容）。
- initCommands：命令按序执行、输出实时可见、失败不阻塞会话创建但给出提示；含交互式命令（如 `npm login`）时超时处理。
- 权限：仅属主可保存 / 更新 / 删除自己的模板；TEAM 模板全员可实例化但不可改；越权模板 ID 返回 404（不暴露存在性差异）。
- 前端：设置页 CRUD；建会话向导模板分区与大小徽标；复制进度条（大模板不卡死 UI）。
- 管理后台：清单与统计口径（体积 Top / 引用次数）；只读不可写。
- 回归：`initializeCloudWorkspace` 既有四条路径（新建 / 复用 / clone / 临时）行为不变；LOCAL 会话无模板入口；文件管理 / 工作区搜索 / Git 面板对模板实例化出的工作区零差异。
