# 提案：实例备份与一键恢复 —— 自托管的"救命按钮"

- 状态：**已否决**（2026-10-09 评审：不做。本文仅存档，勿再评审）
- 日期：2026-10-09
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

Mao 的数据今天分散在三个地方，恢复全靠运维手工：

1. **MySQL**：会话、消息、记忆、Agent/模型配置、审计、用量——一切结构化状态。
2. **数据目录**（`app-config.ts`：`uploadDir` / `workspaceRoot` 等）：上传文件、工作区、技能、compaction 归档。
3. **环境变量**（`backend-ts/.env`）：JWT 密钥、数据库口令、模型 Key——**不在任何备份范围内**，换机迁移时最容易丢。

`DEPLOY.md` / `deploy.md` 教的是手工 `mysqldump` + 拷目录，三个缺口没有任何产品化弥补：

- **无一致性**：备份时刻可能有任务在跑（消息写一半、工作区文件改一半），DB 与文件目录天然不在同一时间点。
- **无校验**：备份文件损坏、迁移号不匹配，要到恢复失败时才知道。
- **无恢复路径**：新实例怎么从备份起步（建库 → 导 SQL → 解包数据目录 → 校验版本与迁移号 → 启动）没有向导，恢复成功率取决于运维个人经验。

对"个人与团队自托管"的定位，这是留存底线功能：一次误操作（DROP TABLE、数据盘故障、迁移新服务器）就可能让用户永久弃用。同类自托管项目（Gitea、Outline）都把备份恢复做进产品，Mao 在这方面是空白。

## 2. 目标 / 非目标

**目标**

1. **一键备份**：DB 逻辑导出（`mysqldump --single-transaction`）+ 数据目录打包（tar+zstd，可配排除规则：`node_modules`、`.git/objects` 外的大目录按需排除）+ `manifest.json`（版本号、Flyway 迁移号、时间、各类条目数、SHA-256）。
2. **备份管理**：列表（时间/大小/迁移号/校验状态）、保留策略（份数 + 天数）、立即校验（重算哈希 + 抽查 manifest 条目）。
3. **一键恢复**：恢复向导 = 预检（目标库是否空、迁移号是否兼容、磁盘空间）→ 恢复 DB → 解包数据目录 → 启动自检（迁移版本、数据目录权限、上传可达性）→ 报告。全程二次确认，预检不过不进删除步骤。
4. **入口**：管理后台「系统设置 → 备份与恢复」页 + `mao-cli backup create/list/verify/restore`（CLI 供无人值守脚本）。

**非目标**

- 不做异地/对象存储自动同步（P1 备份落本地目录，`rsync` 到异地由运维自行决定，manifest 里的哈希正好服务于这类搬运）。
- 不做增量/差异备份（P1 全量 + 保留策略；工作区大的实例用排除规则控体积）。
- 不做主从热备 / 高可用（超出单实例自托管定位）。
- 不备份 `.env`（密钥归运维管）；但恢复向导**检查** `.env` 关键项存在性并在缺失时明示，迁移场景引导用户从旧服务器手工搬运。

## 3. 技术方案

### 3.1 备份（P1）

- 新 `backup` 域：`BackupService` 编排——
  - DB：子进程调 `mysqldump --single-transaction --routines --triggers`（连接参数从现有 `db` 配置取，不落命令行明文：用 `MYSQL_PWD` 或 defaults-file 临时文件）；
  - 文件：流式 tar+zstd，边打边算 SHA-256，manifest 记录顶层条目（uploads / workspace / skills / compaction 归档）；
  - 一致性：备份开始时打"备份中"标记，新任务入队暂停（对齐 messageQueue 语义），打完释放——DB 快照与目录打包的时间窗缩到最短；标记期间运行中的任务不杀，只拒绝**新**任务（与预算 BLOCK 同款"拒新保旧"）。
- 存储：`{dataDir}/backups/mao-backup-{timestamp}.tar.zst` + 同名 `.manifest.json`。

### 3.2 校验（P1）

- `verify`：重算文件哈希对 manifest；解包 manifest 校验条目存在性；对比 manifest 的迁移号与当前代码 `db/migration/` 最新号，输出兼容性结论（相同/可前滚/不兼容）。

### 3.3 恢复（P2）

- `RestoreService`：预检（目标库连接、库空或确认覆盖、`migration_version` 表、磁盘余量 ≥ 解包估体）→ 停后端写入（恢复期间服务置维护态或要求停机执行，二选一在向导明示）→ 导 SQL → 解包 → 启动自检 → 报告页。
- 恢复全程审计记录；预检任一项失败即中止，不触碰任何数据。

### 3.4 定时与保留（P2）

- 调度器对齐既有模式（`InboxCleanupScheduler` / `WebhookDeliveryScheduler` 的 start/stop + interval 结构）：每日 cron 式配置；保留策略（最近 N 份 + M 天内）+ 超期清理（先删包再删 manifest，审计留痕）。

### 3.5 入口（P1 CLI / P2 admin）

- `mao-cli`：`backup create [--exclude ...]` / `list` / `verify <file>` / `restore <file> --yes`；admin 页面复用系统设置集成配置的表单模式（2026-08-30 system-settings-integration-config 先例）。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | BackupService（DB+目录+manifest+哈希）+ create/list/verify CLI + "备份中"拒新保旧 | 中 |
| P2 | 恢复向导（预检+执行+报告）+ admin 页面 + 定时与保留 | 中 |
| P3 | 排除规则编辑器、备份体积报告、迁移场景 checklist（.env 搬运引导） | 小 |

## 5. 风险与开放问题

- **DB 一致性**：`--single-transaction` 对 InnoDB 给一致快照，但"拒新保旧"窗口内运行中任务的文件写入仍可能越过目录打包起点。缓解：manifest 记录备份起止时间与期间活动会话数，恢复报告明示；进一步收紧需引擎侧轮边界挂钩（P3 评估）。
- **大工作区体积**：workspace 动辄数 GB。缓解：排除规则（默认排除 `node_modules`、`.git`）+ zstd；仍大的实例引导只备份 DB + 小目录（manifest 标记"部分备份"）。
- **备份含敏感数据**：DB 内有加密字段、模型 Key。缓解：备份文件权限 0600 + 创建时 UI/CLI 明示"备份含敏感数据，请妥善保管"；可选加密口令（P3，age/gpg 二选一评估）。
- **恢复误操作**：覆盖式恢复是毁灭性操作。缓解：预检不过不执行、执行前二次确认、恢复前自动给当前状态打一个"恢复前自动备份"（若当前实例健康）。
- **开放问题**：mysqldump 依赖 mysqldump 二进制随部署存在——部署文档已要求 MySQL 客户端工具链，但需在预检里显式检查并在缺失时给出明确报错（而非中途失败）。

## 6. 测试要点

- 备份 → 校验 → 恢复到测试库 round-trip：数据条目数一致、上传文件可达、迁移号一致。
- 损坏备份（截断/改一字节）被 verify 拦截并指出 manifest 字段。
- 迁移号不兼容时恢复预检拒绝，且不触碰目标库。
- "备份中"标记：新任务被拒（明确错误码），运行中任务完成不受影响。
- 保留策略到期清理：先删包后删 manifest，审计留痕；磁盘不足时 create 失败且不残留半包。
