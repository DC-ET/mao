# 用户 / 工作区 / 系统三级环境变量技术方案

- 日期：2026-10-18
- 状态：**方案已确认（需求方 21 项决策已锁定，见 §12；2026-10-18 一轮评审后修订，新增需求变更 c 与 16 项修订，见 §13）；本轮只出方案，不进入代码开发**
- 覆盖端：后端 backend-ts、数据库迁移、管理后台 admin、桌面 / Web / 安卓共用前端 desktop
- 不涉及：桌面 Electron 本地执行链路、安卓原生壳、agent-cli、mao-cli 技能文档（实施时按 AGENTS.md 规则同任务同步）
- 上游依赖：无（全新能力，不改动现有凭据注入机制的行为）

---

## 1. 需求背景

### 1.1 现状：环境变量全部由代码硬编码注入，无任何配置入口

当前 Agent 执行 shell 时，环境变量分两拨：

**平台预置（写死在代码里，用户与管理员均不可改）**

| 变量 | 来源 | 注入位置 |
|---|---|---|
| `GIT_TOKEN_<域名>` + `GIT_ASKPASS` + `GIT_TERMINAL_PROMPT` | 用户 Git 凭证表 | `harness/shell/shell-session-manager.ts:522` `refreshUserEnvironment` / `:721` `configureGitCredentials` |
| `HOME`（每用户虚拟家目录） | `RuntimeDataResolver` | `shell-session-manager.ts:710` `configureUserHome` |
| `MAO_TOKEN`（短效 JWT，供 `mao-*-cli`） | `JwtService.generateShellToken` | `tool/impl/shell-session-tool.ts:455` `injectMaoToken`（每条命令前 `export`） |
| `ECP_TOKEN` / `LARKSUITE_CLI_USER_ACCESS_TOKEN` / `LARKSUITE_CLI_APP_ID` | ECP / 飞书 UAT 注入器 | 同上 `injectMaoToken`（`shell-session-tool.ts:431`）；`harness/terminal/terminal-manager.ts:425` `buildEnv` |
| `NPM_CONFIG_PREFIX` / `PIP_TARGET` / `MAO_DEPS_BIN` 等（依赖持久化） | `container/session-envelope-builder.ts:105` `buildDepsEnv` | `shell-session-manager.ts:747` `applyDepsEnv` |
| `MAO_TASK_NAME` | 任务名归一化 | `terminal-manager.ts:425` `buildEnv` |
| `PATH` / `TERM` / `LANG` 等 | `sanitizeInheritedEnv(process.env)` 继承 | `common/sensitive-env.ts:20` |

> **（评审修订 P2-2）措辞修正：`sanitizeInheritedEnv` 是「黑名单剥离」不是「白名单继承」。**
>
> 实现（`sensitive-env.ts:20-26`）只剔除 `GIT_TOKEN_*` / `GIT_ASKPASS` / `GIT_TERMINAL_PROMPT` / `APP_GIT_CREDENTIAL_SECRET` / `JWT_SECRET` / `MYSQL_*` / `APP_NOTIFICATION_WEBHOOK_SECRET` / `APP_MCP_SECRET` / `MAO_TOKEN` / `ECP_TOKEN` / `LARKSUITE_CLI_USER_ACCESS_TOKEN`，**其余全部原样继承**——包括 `MAO_WORKSPACE_ROOT`、`APP_*` 下未列出的键、以及运维 `.env` 里的任意自定义键。
>
> 项目里真正的白名单只有 MCP stdio 一处（`mcp-client-manager.ts:255` `MCP_ALLOWED_INHERITED_ENV_KEYS`）。
>
> 对本方案的影响：三层注入发生在黑名单剥离**之后**，因此用户变量能覆盖这些继承键（`MAO_` 前缀已按 §5.3 修订禁配）；本表格「继承」一词按此理解，不要读成「只有列出的键才进 shell」。

**结论**：以上全部是「系统固定预置」。用户想给自己配一个 `GITEA_TOKEN`、`MAVEN_HOME`、内部制品库地址，或管理员想给全站下发一个 `ARTIFACTORY_URL`，当前**没有任何入口**，只能改代码 + 重新部署。

> 说明：CLOUD shell 以 `bash --norc --noprofile` 启动（`shell-session-manager.ts:700`），用户写进虚拟 `HOME` 的 `.bashrc` 不会被加载，所以「自己写 rc」这条路也是堵的。

### 1.2 痛点

1. **个人变量无处安放**：用户有自己的私有仓库 token、内部 npm/pip 镜像源、公司代理，只能每次在 shell 里手动 `export`（一次性会话还会丢），或写进虚拟 `HOME` 的 `.bashrc`（CLOUD shell 用 `--norc --noprofile` 启动，`.bashrc` 根本不加载）。
2. **工作区变量无隔离**：不同项目需要不同的构建参数（如 `JAVA_HOME`、`GRADLE_USER_HOME`、项目级 feature flag），现在只能靠会话里临时 export，跨会话不继承。
3. **管理员无下发通道**：运维想给全站统一注入内网镜像源、监控 agent 的 `OTEL_EXPORTER_OTLP_ENDPOINT`，只能改 `.env` 重启后端——与「配置应走管理后台」的既有约定（`system_setting` + 管理后台系统设置页）脱节。
4. **凭据面已经收口，缺的是正向扩展位**：项目对「平台凭据不得泄漏给用户进程」做了大量收口（`sanitizeInheritedEnv` 剥离 `GIT_TOKEN_*`/`JWT_SECRET`/`MYSQL_*`，MCP stdio 改白名单继承），但缺少一个**受控的、分层的、可审计的**变量注入机制来承接用户的正当诉求。

### 1.3 目标

把「环境变量」从代码硬编码升级为**三层可配置**：

```
内置凭据（不可覆盖，最高）  >  工作区变量  >  用户全局变量  >  系统全局变量（最低）
```

- 用户在桌面设置页维护自己的全局变量，在会话头部维护当前工作区变量；
- 管理员在管理后台维护全站系统变量；
- 三条 CLOUD 执行链路（Agent shell 工具、云端交互终端、docker 容器内执行）行为一致；
- 配置改动在下一条命令前生效，删除即时生效；
- 变量值一律加密存储，任何接口都不回显明文。

---

## 2. 需求描述

### 2.1 要做的（全部本期实现）

1. **用户全局变量**：登录用户在桌面「设置 → 环境变量」页维护一组 KV，对自己的全部 CLOUD 会话生效。
2. **工作区变量**：按「工作区绝对路径 + 用户」绑定，在会话头部抽屉中维护，仅对该用户在该工作区的会话生效。
3. **系统全局变量**：管理员在管理后台「系统设置 → Shell 环境变量」维护一组 KV，对全部用户的全部会话生效（优先级最低）。
4. **优先级与冲突**：同名变量按 `工作区 > 用户全局 > 系统全局` 覆盖；平台内置凭据（`GIT_TOKEN_*` / `MAO_TOKEN` / `ECP_TOKEN` / `LARKSUITE_CLI_*` / `HOME` / `PATH` / deps env 等保留键）**不可被任何一层覆盖**。
5. **生效链路（三条全做）**：
   - Agent `shell` 工具（host 模式 `ShellSessionManager` + docker 模式 `SessionEnvelopeBuilder` → 容器内 `ShellSessionManager`）；
   - 云端交互终端 `TerminalManager.buildEnv`（host 与容器两条 spawn 路径都覆盖，因为容器路径的 env 由宿主机 `buildEnv` 构造后经 `pty_open` 帧透传）；
   - docker 容器内的 Agent shell（经 `RuntimeEnvelope.envVars` 下发）。
6. **生效时机**：沿用现有 `refreshUserEnvironment` 机制——Agent shell 会话创建时注入 + 每条命令执行前刷新；删除变量在下一条命令前 `unset`。**（评审修订 P1-4）云端交互终端例外**：PTY 长驻、`buildEnv` 只在 spawn 时执行一次，已打开的终端不感知后续变更（与 git token / deps env 现状一致），需重开终端。
7. **存储与加密**：三张独立表，值一律 AES-CBC 加密（复用 `APP_GIT_CREDENTIAL_SECRET`，与 `user_git_credential` 同算法同密钥）。
8. **保留键清单**：服务端在写入与合并两处强制过滤（见 §7.5），`PATH` / `HOME` / `LD_PRELOAD` / `NODE_OPTIONS` 等一律拒绝配置。
9. **可观测**：会话头部抽屉「生效变量」展示当前会话最终合并结果（键名 + 来源 + 备注，值一律 `****`），并列明内置键与保留键；注入过程在 `harnessLog` 打一条 debug（只记条数，不记键名与值）。
10. **管理后台**：新增「Shell 环境变量」面板，复用 `settings:write` 权限与 `/v1/system-settings` 审计前缀。
11. **（需求变更 c）管理员只读查看用户层变量**：管理后台可按用户查看其用户全局变量与工作区变量，**键名明文、值脱敏**（见 §5.10）。管理员**不可**代配、修改或删除用户层变量。

### 2.2 不做的（本期明确不做）

1. **不做 LOCAL（Electron 本机执行）模式注入**：LOCAL 工具跑在用户自己电脑上，用的是本机 shell 与本机已存在的环境，本机 `.zshrc` / `.bashrc` 天然生效。本期只改 CLOUD 服务端链路，桌面本地执行路径零改动。
2. **不做 MCP stdio 子进程注入**：MCP env 目前是白名单收紧状态（`mcp-client-manager.ts:255` `MCP_ALLOWED_INHERITED_ENV_KEYS`，防平台凭据泄漏），本期不开这个口子。
3. **不做跨用户共享工作区变量**：同一工作区（如飞书群工作区）下，每个用户各配各的，互不可见（见 §5.2 决策 #2 的安全理由）。**（需求变更 c）注意区分**：管理员经 §5.10 的只读接口可见任意用户的变量（值脱敏），这是「运维可见性」不是「用户间共享」——普通用户之间仍完全隔离。
4. **不做管理员代配 / 修改 / 删除用户变量**：管理员只能维护系统全局变量；用户层与工作区层的写操作一律归用户自己。**（需求变更 c）管理员对用户层变量只有只读权限**（见 §5.10），不提供任何写入口。
5. **不做变量值回显**：任何接口都不返回明文值；用户侧（含用户自己的设置页）一律 `****`，管理侧查看用户层变量时按 §5.10 的「前 4 + `****` + 尾 4」掩码返回。
6. **不做工作区内 `.env` 文件读取**：不引入文件型配置源，全部走 DB + UI。
7. **不做变量引用 / 插值**（如 `FOO=${BAR}/bin`）：本期只做静态 KV。
8. **不做变量分组 / 标签 / 批量导入导出**。
9. **不做 agent-cli / mao-cli 侧改动**（本期无 CLI 交互需求）。
10. **不做配置变更主动推送**：不做「改配置即时推送到所有活跃 shell / pty / 容器」，靠执行前刷新 + 短 TTL 缓存收敛。
11. **不做历史留档 / 变更审计表**（用户层与工作区层）：仅系统层写操作走既有 `audit_log`。

---

## 3. 技术选型

### 3.1 三层存储形态

| 层 | 载体 | 理由 |
|---|---|---|
| 系统全局 | 新表 `system_env_variable` + `system_setting` 开关 `shell.envVars.enabled` | 与另两层同构，可复用同一套 repository / service / 校验；`system_setting` 只留一个总开关（紧急停用），不承载变量数据（`value` 列 `VARCHAR(1024)` 容量不足，见 §5.1 修订说明） |
| 用户全局 | 新表 `user_env_variable` | 一行一变量，天然支持 `uk(user_id, key)` 唯一约束与备注；与 `user_git_credential` / `user_command` 同构 |
| 工作区 | 新表 `workspace_env_variable` | 同上，唯一键 `uk(workspace_path, user_id, key)` |

> 决策记录：曾评估「三张独立表」与「合成一张表 + scope 字段」。合成表的两套唯一约束（`uk(user_id,key)` vs `uk(workspace,user_id,key)`）在同一张表里需要条件索引，反而更绕，故否掉。**系统层最终也采用独立表**（原拟走 `system_setting` 单键 JSON，因 `system_setting.value` 是 `VARCHAR(1024)`，50 条变量存不下，遂修订，详见 §5.1 修订说明）。

### 3.2 加密算法与密钥

- **算法**：AES-CBC，三层统一，直接复用 `crypto/aes-cbc.ts` 的 `encryptAesCbc` / `decryptAesCbc`。
- **密钥**：`APP_GIT_CREDENTIAL_SECRET`（`config/app-config.ts:499` 读取，`create-app.ts:457` 启动时强制非空）。**不新增密钥、不新增配置项**——`user_git_credential.access_token` 已在用同一把密钥，运维侧密钥管理面不变。三层用同一把密钥，排查时只需记一个 secret。
- **解不开时的行为**：解密失败（密钥轮换 / 跨实例搬库）时该变量**跳过不注入**并 `harnessLog('warn')`，绝不明文回落、不阻塞 shell 创建（对齐 `SystemSettingService.getBundleRegistryConfig` 的失败闭合思路，但那是安全门必须 fail-closed；这里是功能降级，fail-open 会泄漏错误值，故选「跳过 + 告警」）。

### 3.3 缓存策略

进程内短 TTL 缓存，TTL **5 秒**（对齐 `docker-tool-router.ts:38` `RUNTIME_MODE_CACHE_TTL_MS`）：

| 缓存 key | 内容 | 失效方式 |
|---|---|---|
| `sys` | 系统层全部变量（一次查库，全用户共用） | TTL 5s |
| `user:{userId}` | 该用户全局变量 | TTL 5s |
| `ws:{userId}:{workspace}` | 该用户该工作区变量 | TTL 5s |
| `enabled` | `shell.envVars.enabled` 总开关 | TTL 5s |

- 系统层一次查库供所有用户复用；用户 / 工作区层按需查。
- 不做主动失效：写入侧（3 个入口）不引入缓存依赖，装配与测试面最小；最多 5 秒延迟即可接受（已与需求方确认）。
- 容器模式同样在宿主机 `SessionEnvelopeBuilder` 侧缓存（`resolveForSession` 内部），容器内零改动。
- **缓存只包「查库 + 解密」，不包「合并」**：合并是纯内存操作，每次调用都做，保证保留键过滤与优先级逻辑永远走最新代码。
- **（评审修订 P1-3）exec 热路径的查库量级**：`sys` 是全用户共用的单条目（最多 1 次查库 / 5s），`user:{userId}` 与 `ws:{userId}:{workspace}` 按 key 各 1 次。单次 exec 最坏 3 次 `SELECT`（缓存全过期时），命中缓存时 0 次。50 条上限下单次结果集 ≤ 50 行 × ≤4KB，可忽略。**不要把开关查询与三层查询拆成 4 次独立查库**——`shell.envVars.enabled` 与 `sys` 层合并为一次事务内读取，或让开关缓存与 `sys` 缓存同 TTL 同时失效，避免 4 次往返。

### 3.4 为什么不用 `.bashrc` / 工作区 `.env` 文件

- CLOUD shell 明确以 `bash --norc --noprofile` 启动（`shell-session-manager.ts:700`），`.bashrc` 不加载，这是有意的（避免用户 rc 污染 Agent 环境）。
- 文件型配置不可审计、不可在管理端管控、在 docker 模式下还涉及挂载与越界判定，与「用户可配置、管理员可管控」的诉求不符。

---

## 4. 现状梳理（改哪、为何）

### 4.1 host 模式：Agent shell

`ShellSessionManager` 两个方法负责 env：

- `createSession`（`:670`）：spawn 时构造 `env`，登记 `initialUserEnvironmentKeys`（决定后续 refresh 时哪些键会被 `unset`）。
- `refreshUserEnvironment`（`:522`）：每条命令前被 `ShellSessionTool.handleExec`（`shell-session-tool.ts:184`）/ `handleWriteStdin`（`:332`）调用，写入 `export` / `unset` 序列到 shell stdin（`ShellSession.refreshEnvironment`，`:244`）。

**改动点**：两处都新增「注入用户/工作区/系统变量」，并把新键登记进 `userEnvironmentKeys`（否则删除变量后旧值无法被 `unset`）。具体插入位置与签名变更见 §5.7(1) 的 P0-1 / P1-2 修订。同时保留现有两条既有语义：

- `PATH` 永不进 `userEnvironmentKeys`（`:249` 的守卫，防 refresh 时 unset PATH 引爆 shell）；
- `GIT_TOKEN_*` 仍按前缀全清再注入（`:548`）。

### 4.2 docker 模式：容器内执行

`SessionEnvelopeBuilder.build`（`container/session-envelope-builder.ts:32`）把凭据打成 `RuntimeEnvelope` 随每个 `tool_call` 帧下发；容器内 `ContainerToolExecutor`（`container-tool-executor.ts:67`）据此构造 `ShellSessionManager` 与 `ShellSessionTool`，deps env 通过 `depsEnvProvider: () => this.currentEnvelope?.depsEnv` 注入（`:74`）。

**改动点**：

`RuntimeEnvelope` 新增字段 `envVars: Record<string,string>`（`container/runtime-channel-protocol.ts:14`）；
- `SessionEnvelopeBuilder` 填充该字段（含缓存 + 保留键过滤）；
- `ContainerToolExecutor` 把 `depsEnvProvider` 的模式复制一份 `envVarsProvider`，传给容器内 `ShellSessionManager`（走与 deps env 完全相同的注入路径，不新造机制）。

### 4.3 云端交互终端

`TerminalManager.buildEnv`（`terminal/terminal-manager.ts:386`）在 spawn PTY 前构造 env。容器用户的终端 env 由宿主机 `buildEnv` 构造后经 `pty_open` 帧透传到容器 node-pty（`pty-bridge.ts:99` → `pty-hub.ts:69`），**因此只需改宿主机 `buildEnv` 一处，容器终端自动覆盖**。

### 4.4 管理后台

`SystemSettingsView.vue` 的 `TOC_GROUPS`（`:236`）声明目录分组。新增 `{ kind: 'shell-env', name: 'shell-env' }` 一节，落在「工具与终端」组（与 `harness-shell` / `terminal` 并列），新增 `ShellEnvVarsPanel.vue` 组件。

### 4.5 桌面端

- 设置页：`SettingsView.vue` 侧边栏加「环境变量」入口 → 新增 `views/settings/EnvVariablesView.vue`（对齐 `GitCredentialsView.vue` 的卡片 + 弹窗交互）。
- 会话头部：`ChatInputToolbar.vue` 工作区指示器旁加「环境变量」按钮 → 新增 `components/chat/EnvVarsDrawer.vue`（`el-drawer`，同 `AgentChip.vue:84` 的用法），抽屉内展示「当前生效变量」并提供当前工作区变量的增删改。
- 后端接口：新增 `/v1/user/env-variables`、`/v1/user/workspace-env-variables`、`/v1/sessions/:id/effective-env`。

---

## 5. 详细设计

### 5.1 数据模型

#### V158 `user_env_variable`（用户全局变量）

```sql
CREATE TABLE IF NOT EXISTS `user_env_variable` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    `user_id`    BIGINT       NOT NULL COMMENT '所属用户',
    `env_key`    VARCHAR(128) NOT NULL COMMENT '变量名，POSIX 合法标识符',
    `env_value`  VARCHAR(4096) NOT NULL COMMENT '变量值（AES-CBC 密文）',
    `note`       VARCHAR(256) NULL COMMENT '备注，如 "私有 Gitea Token"',
    `created_at` DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_user_key` (`user_id`, `env_key`),
    INDEX `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户全局环境变量';
```

#### V158 `workspace_env_variable`（工作区变量）

```sql
CREATE TABLE IF NOT EXISTS `workspace_env_variable` (
    `id`            BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    `workspace_path` VARCHAR(512) NOT NULL COMMENT '工作区绝对路径（path.resolve 归一化）',
    `user_id`       BIGINT       NOT NULL COMMENT '配置者；仅配置者本人会话生效',
    `env_key`       VARCHAR(128) NOT NULL COMMENT '变量名',
    `env_value`     VARCHAR(4096) NOT NULL COMMENT '变量值（AES-CBC 密文）',
    `note`          VARCHAR(256) NULL COMMENT '备注',
    `created_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_workspace_user_key` (`workspace_path`, `user_id`, `env_key`),
    INDEX `idx_workspace_user` (`workspace_path`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作区环境变量（按绝对路径 + 用户绑定）';
```

`workspace_path` 用 `VARCHAR(512)`：`session.workspace` 在 schema 里是 `VARCHAR(512)`，同一量级即可；查询时用 `path.resolve()` 归一化后精确等值匹配（不做前缀匹配，避免 `/a/b` 与 `/a/bc` 混淆）。

#### V158 `system_env_variable`（系统全局变量）+ 总开关

```sql
CREATE TABLE IF NOT EXISTS `system_env_variable` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    `env_key`    VARCHAR(128) NOT NULL COMMENT '变量名',
    `env_value`  VARCHAR(4096) NOT NULL COMMENT '变量值（AES-CBC 密文）',
    `note`       VARCHAR(256) NULL COMMENT '备注，如 "内网 npm 镜像"',
    `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_key` (`env_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统全局环境变量（管理员维护，全站生效）';

-- 注入总开关：紧急一键停用三层变量（关闭后仅保留平台内置凭据）。默认开启。
INSERT IGNORE INTO `system_setting`
  (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`)
VALUES
  ('shell.envVars.enabled', 'true', 'Shell 环境', '环境变量注入总开关（关闭后三层变量全部不注入，仅保留平台内置凭据）', 1, 0);
```

**方案修订记录（原拟 `system_setting` 单键 JSON → 改为独立表）**：`system_setting.value` 是 `VARCHAR(1024)`，50 条变量 × 平均 60 字符 ≈ 3000+ 字符存不下，且 JSON 整值加密后任意一条修改都要全量重写。改为独立表后：三张表同构（同一套 repository / service / 校验 / 面板模板），`system_setting` 只留 `shell.envVars.enabled` 布尔开关供紧急停用。

`category = 'Shell 环境'` 需要在 `SystemSettingsView` 的 `TOC_GROUPS`（`admin/src/views/settings/SystemSettingsView.vue:236`）显式声明，否则后端返回的未声明分类会被兜底归入「其他」。总开关走普通布尔行（`is_secret=0`），复用 `isBooleanSetting` 渲染成 `el-switch`。

### 5.2 合并与优先级

```
mergeEnv(userId, workspace):
  base    = sanitizeInheritedEnv(process.env)      # 既有：剥离敏感键
  base   += depsEnv                                 # 既有：依赖持久化
  base   += gitTokens / GIT_ASKPASS / MAO_TOKEN / ECP_TOKEN / LARKSUITE_CLI_* / HOME   # 既有：平台凭据
  # ↓ 新增：三层注入，从低到高覆盖
  if shell.envVars.enabled:
    base += systemEnvVars        # 最低
    base += userEnvVars          # 覆盖系统
    base += workspaceEnvVars     # 最高
  # ↓ 保留键防线：任何一层都不得覆盖
  base = rejectReservedKeys(base)
```

- 保留键过滤放在**服务端合并前**（对三层分别过滤），确保库里根本存不进保留键；合并后再做一次防御性过滤（双保险，成本为零）。
- `PATH` 的处理：三层都**禁止**配置 `PATH`（在保留键清单内）。deps env 的 `MAO_DEPS_BIN` 前置逻辑保持不变（`applyDepsEnv`）。

### 5.3 保留键清单（`common/sensitive-env.ts` 扩展）

在既有 `isSensitiveChildEnvKey`（禁止从 `process.env` 继承的键）之外，新增**用户不可配置清单**：

```ts
/** 用户/系统配置的环境变量禁止覆盖的键（三类）：平台凭据、shell 基础键、deps 注入键。 */
const RESERVED_ENV_KEYS = new Set([
  // 平台凭据（与 isSensitiveChildEnvKey 对齐）
  'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT', 'APP_GIT_CREDENTIAL_SECRET', 'JWT_SECRET',
  'MAO_TOKEN', 'ECP_TOKEN', 'LARKSUITE_CLI_USER_ACCESS_TOKEN', 'LARKSUITE_CLI_APP_ID',
  // shell / 进程基础键
  'HOME', 'PATH', 'PWD', 'OLDPWD', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'COLORTERM',
  'LANG', 'LC_ALL', 'TMPDIR', 'IFS', 'PS1', 'PS2', 'PS4', 'BASH', 'BASHOPTS', 'BASH_ENV',
  'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'PYTHONSTARTUP', 'PYTHONPATH',
  'MAO_TASK_NAME', 'MAO_DEPS_BIN', 'NPM_CONFIG_PREFIX', 'PIP_TARGET', 'PIP_BREAK_SYSTEM_PACKAGES',
]);
const RESERVED_ENV_PREFIXES = ['GIT_TOKEN_', 'MYSQL_', 'APP_', 'MAO_'];

export function isReservedEnvKey(key: string): boolean { /* 精确 + 前缀，键名统一 toUpperCase 后比较 */ }
```

（`assertNotReservedEnvKey` 的封装在 `env/reserved-env-keys.ts`，见 §5.6。）

- `LD_PRELOAD` / `NODE_OPTIONS` / `BASH_ENV` 必须禁：这些键能让用户配置的变量直接改变子进程加载行为，等同于任意代码执行提权。
- `PYTHONPATH` 禁：理由同上（import 劫持）。
- `MYSQL_*` / `APP_*` 前缀禁：平台配置面。
- **（评审修订 P2-1）`MAO_` 前缀禁**：`sanitizeInheritedEnv`（`sensitive-env.ts:20`）是**黑名单剥离而非白名单**，`MAO_WORKSPACE_ROOT` / `MAO_RUNTIME_DIR` / `MAO_USER_HOME_DIR` / `MAO_USER_SKILLS_DIR` / `MAO_CONTAINER_USER_ID` / `MAO_DEPS_BIN` 等平台自研键会原样继承进子进程。若允许用户配置 `MAO_` 前缀变量，可让 Agent 侧读取这些键的代码路径读到用户注入值（即便当前 shell 自身不读，工具链与 runtime agent 会读）。与 `APP_` 同理整体列入前缀黑名单，比逐个列举更稳。
- 比较时对 `key` 做 `toUpperCase()`：`PATH` / `Path` / `path` 一律拒（环境变量在 Linux 大小写敏感，但保留键按大小写不敏感拒绝更稳，避免用户配 `home` 造成困扰）。

### 5.4 校验规则

| 项 | 规则 | 违反时 |
|---|---|---|
| 键名格式 | `^[A-Za-z_][A-Za-z0-9_]{0,127}$` | `PARAM_INVALID`：变量名须以字母或下划线开头，仅含字母/数字/下划线，最长 128 字符 |
| 保留键 | `isReservedEnvKey` 为 true | `PARAM_INVALID`：`{KEY}` 为平台保留变量，不允许配置 |
| 值长度 | ≤ 2048 字符 | `PARAM_INVALID`：变量值最长 2048 字符 |
| 条数上限 | 每层每用户 ≤ 50 条（工作区按 `workspace_path + user_id` 计） | `PARAM_INVALID`：单层最多配置 50 个变量 |
| 同层重名 | 唯一键冲突 | `PARAM_INVALID`：同名变量已存在 |
| 空值 | 允许（`export FOO=` 语义合法，用于显式清空上游值） | — |
| 工作区路径 | 非空字符串，服务端 `path.resolve()` 归一化；不校验存在性（工作区可能尚未创建） | `PARAM_INVALID`：工作区路径不能为空 |

> **（评审修订 P3-6）`VARCHAR(4096)` 与「值 ≤ 2048」的换算依据**：`encryptAesCbc`（`crypto/aes-cbc.ts:10`）输出格式为 `ivB64:cipherB64`。2048 字符明文 → AES-CBC 密文 2064 字节（PKCS7 补齐到 16 的倍数）→ base64 2752 字符；加 IV（16 字节 → 24 字符）与分隔符 `:` 共 **2777 字符** < 4096，余量充足。**4096 是密文上限，不是明文上限**——DDL 注释已写「AES-CBC 密文」，此处补换算过程，避免后来人误以为可存 4096 明文而在写入时触发 MySQL 严格模式截断错误。

### 5.5 接口设计

#### 用户侧（登录态，`/v1/user/...`，对齐 `git-credential.routes.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/user/env-variables` | 列出当前用户全局变量，VO 不含 value |
| POST | `/v1/user/env-variables` | 新增（`envKey` / `envValue` / `note`） |
| PUT | `/v1/user/env-variables/:id` | 修改（value 必传；不回显故无「留空不改」语义） |
| DELETE | `/v1/user/env-variables/:id` | 删除 |
| GET | `/v1/user/workspace-env-variables?workspace=` | 列出当前用户在该工作区的变量 |
| POST | `/v1/user/workspace-env-variables` | 新增（`workspacePath` / `envKey` / `envValue` / `note`） |
| PUT | `/v1/user/workspace-env-variables/:id` | 修改 |
| DELETE | `/v1/user/workspace-env-variables/:id` | 删除 |
| GET | `/v1/sessions/:id/effective-env` | 当前会话最终生效变量（合并三层 + 内置），敏感值 `****` |

VO 统一形如：

```ts
interface EnvVariableVO {
  id: number;
  envKey: string;
  note: string | null;
  createdAt: string;   // ISO-8601，' ' → 'T'
  updatedAt: string;
}
```

`effective-env` VO：

```ts
interface EffectiveEnvVO {
  items: Array<{ envKey: string; source: 'SYSTEM' | 'USER' | 'WORKSPACE' | 'BUILTIN' | 'INHERITED'; note: string | null }>;
  totals: { system: number; user: number; workspace: number; builtin: number };
}
```

- `BUILTIN`：`GIT_TOKEN_*` / `MAO_TOKEN` / `ECP_TOKEN` / `LARKSUITE_CLI_*` / `HOME` / `MAO_DEPS_BIN` 等（只列键名，值一律不出）；
- `INHERITED`：从 `process.env` 继承的非敏感键（`PATH` / `LANG` / `TMPDIR` 等）。
- 归属校验：`/v1/sessions/:id/effective-env` 必须校验 `session.userId === 当前用户`，否则 `FORBIDDEN`（防越权读他人环境构成）。

> **（评审修订 P2-3）`effective-env` 是「配置态声明」不是「spawn 快照」，必须在 VO 与 UI 上写明，否则会误导排障。**
>
> 与真实 env 的已知偏差（均已核实）：
>
> | 键 | 偏差 |
> |---|---|
> | `MAO_TOKEN` | host 模式由 `injectMaoToken`（`shell-session-tool.ts:431`）**逐命令** `export`，不在 spawn env 里 |
> | `ECP_TOKEN` / `LARKSUITE_CLI_*` | host 模式同样逐命令注入；容器模式在 envelope |
> | `MAO_DEPS_BIN` / `NPM_CONFIG_PREFIX` / `PIP_TARGET` | **仅容器模式存在**，host 模式 `depsEnvProvider` 未装配 → 恒无 |
> | `LARKSUITE_CLI_APP_ID` | **不在** `isSensitiveChildEnvKey`（`sensitive-env.ts:15` 只列 `..._USER_ACCESS_TOKEN`），`sensitive-env.spec.ts:24` 显式断言 `false`，故它走继承而非注入 |
>
> 采用方案：抽屉内固定提示「以下为服务端配置态视图，非逐命令实测值；排查执行问题请以 shell 内 `env` 输出为准」。§9 风险表中「`effective-env` 接口可直接问服务端」的表述同步限定为「问服务端配置态」。

#### 管理侧（`/v1/admin/...`，`settings:read` / `settings:write`）

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/v1/admin/system-env-variables` | `settings:read` |
| POST | `/v1/admin/system-env-variables` | `settings:write` |
| PUT | `/v1/admin/system-env-variables/:id` | `settings:write` |
| DELETE | `/v1/admin/system-env-variables/:id` | `settings:write` |

> 复核结论：原拟复用 `PUT /v1/system-settings/:key`（`settings.routes.ts:44`）承载系统层变量 JSON，因 §5.1 的容量问题改为独立表 + 独立 admin routes。`/v1/system-settings/**` 已在 `AUDITED_PREFIXES`（`audit.interceptor.ts:6`）内，写操作自动入审计；新增的 `/v1/admin/system-env-variables` 也在 `/v1/admin` 前缀内，同样自动留痕——满足「仅系统层写操作入审计」的决策。

---

### 5.6 后端模块划分

新增 `backend-ts/src/env/` 域（与 `settings/` `user/` 并列）：

```
env/
  types.ts                     # EnvVariable 实体 + EnvVariableRepository 接口 + EnvVariableSource
  env-variable.repository.ts   # MysqlEnvVariableRepository（三表同构，表名参数化）
  env-variable.service.ts      # CRUD + 校验 + 加密 + 5s 缓存 + resolveForSession()
  env-variable.routes.ts       # /v1/user/* 与 /v1/admin/* 路由
  env-variable.service.spec.ts
  env-variable.routes.spec.ts
  reserved-env-keys.ts         # assertNotReservedEnvKey（抛 BusinessException 的封装）
```

- `resolveForSession(userId, workspace)` 返回 `Record<string,string>`（已合并、已过滤保留键、已解密），供三条链路调用。
- 缓存放在 service 内（`Map<string,{value, atMs}>` + 5s TTL），不引入额外依赖。
- 纯函数 `isReservedEnvKey` 放 `common/sensitive-env.ts`（与 `isSensitiveChildEnvKey` 并列，无外部依赖，可被容器侧复用做防御性过滤）；抛异常的封装 `assertNotReservedEnvKey` 放 `env/reserved-env-keys.ts`（依赖 `BusinessException`）。
- 总开关 `shell.envVars.enabled` 由 `SystemSettingService` 读取，也走 5s 缓存（`SystemSettingService` 自身无缓存，这里是 `EnvVariableService` 内的缓存）。

> **（评审修订 P0-2）`SystemSettingService.getBool` 当前是 `private`（`settings.service.ts:589`），不可直接调用。**
>
> 实施时在 `SystemSettingService` 新增 public 方法（不提升 `getBool` 自身可见性，避免扩大既有 API 面）：
>
> ```ts
> /** 环境变量注入总开关（§5.1）：行缺失或值非 true/1 一律视为开启（功能默认可用，紧急停用需显式关闭）。 */
> async shellEnvVarsEnabled(): Promise<boolean> {
>   const raw = await this.getText(SHELL_ENV_VARS_ENABLED_KEY);
>   return raw === '' || raw === 'true' || raw === '1';
> }
> ```
>
> 注意与 `getBool` 的语义差异：`getBool` 未设置返回 `false`，这里**默认返回 `true`**（种子行 `INSERT IGNORE` 写入 `'true'`，但实例若因迁移未跑而行缺失时，按「默认开启」处理更符合「新能力默认可用」；紧急停用必须显式写 `false`）。此语义需在 §5.4 校验表与 admin 面板文案中保持一致。

> **（评审修订 P0-3）容器 import 约束必须显式守住，否则 `container-import-constraints.spec.ts` 直接失败。**
>
> `backend-ts/src/harness/container/container-import-constraints.spec.ts` 的 `FORBIDDEN_PATTERNS` 对 `runtime-agent.ts` / `container-tool-executor.ts` / `container-mcp-bridge.ts` / `pty-hub.ts` / `runtime-channel-protocol.ts` 五个文件禁止 import：
>
> | 模式 | 含义 |
> |---|---|
> | `/db\/db\.js\|createPool\|Mysql.*Repository/i` | MySQL 访问 |
> | `/jwt\.service\|JwtService/i` | JWT secret |
> | `/llm-adapter\|LlmAdapterFacade\|danger-assessor\|openai-llm\|anthropic-llm\|responses-llm/i` | LLM 调用 |
> | `/app-config(?!\.spec)/` | app-config 会带入全部平台配置 |
> | `/git-credential\.service/i` | 平台级 git 凭据服务 |
>
> 结论与约束：
> - `isReservedEnvKey` 放 `common/sensitive-env.ts` **安全**（该文件零外部依赖，且不在禁用模式内）；
> - `src/env/**` 的任何模块（`env-variable.service.ts` / `env-variable.repository.ts`）**不得**被上述五个文件 import——本方案容器内只经 `envelope.envVars` 取值，天然满足；
> - 实施时在该 spec 的 `FORBIDDEN_PATTERNS` **追加一条** `{ pattern: /env-variable\.(service\|repository)/, why: '环境变量仓库（容器内变量走 envelope 下发）' }`，把约束固化为回归，而不是只靠注释约定。

### 5.7 三条注入链路的具体改动

#### (1) host 模式 Agent shell — `shell-session-manager.ts`

构造参数新增第 8 个可选参数（与 `depsEnvProvider` 并列，保持「可选注入、不传即零变化」的既有风格）：

```ts
constructor(
  pathSandbox, runtimeDataResolver,
  maxSessionsPerConversation, sessionIdleTimeoutMinutes, sessionMaxLifetimeHours,
  askpassDirOverride?, depsEnvProvider?,
  /** 三级环境变量提供者（§5.7）：返回已合并的 KV；host 与容器都走同一入口。 */
  envVarsProvider?: (userId: number, workspace: string | null) => Record<string, string> | null,
) {}
```

`createSession`（`:670`）与 `refreshUserEnvironment`（`:522`）各自加：

```ts
const vars = this.resolveEnvVars(userId, sessionWorkspace);
if (vars) this.applyEnvVars(env, vars, initialUserEnvironmentKeys /* 或 session */);
```

`applyEnvVars` 与 `applyDepsEnv`（`:747`）同构：写入 env map + 把 key 登记进 `userEnvironmentKeys`（`PATH` 不进，沿用 `:249` 的守卫）。`sessionWorkspace` 取值见下方注意。

> **（评审修订 P0-1）`refreshUserEnvironment` 必须显式接收 envVars，否则删除语义在 host 模式失效、在容器模式完全失效。**
>
> 现状约束（已核实）：
> - `ShellSessionTool.handleExec`（`shell-session-tool.ts:184`）与 `handleWriteStdin`（`:332`）调用 `refreshUserEnvironment` 时**只传 3 参**，第 4 参 `depsEnv` 由 `resolveDepsEnv(explicit)` 回落 `this.depsEnvProvider?.()`（host 模式未装配 → null）。
> - 因此 `refreshUserEnvironment` 内部**读不到** `this.envVarsProvider` 之外的新信息；若只在 `createSession` 注入而不改 `refreshUserEnvironment`，新键虽进 spawn env，却**未登记进 `userEnvironmentKeys`**，用户删除变量时 `refreshEnvironment`（`:244`）无法 `unset`。
> - 容器模式更严重：`envVarsProvider` 是 `() => currentEnvelope?.envVars`，而 `refreshUserEnvironment` 的 env map 里根本没有这一段，容器内删除变量**永远 unset 不掉**。
>
> 采用方案：**签名扩展**（与 §4.2 `RuntimeEnvelope.envVars` 对称，语义最直白）
>
> ```ts
> refreshUserEnvironment(
>   session: ShellSession,
>   userId: number | null,
>   domainTokenMap: Record<string, string>,
>   depsEnv?: Record<string, string> | null,
>   envVars?: Record<string, string> | null,   // 新增：三级合并结果
> ): void
> ```
>
> `ShellSessionTool` 两处调用点同步传第 5 参（由 `ShellSessionManager` 暴露 `resolveEnvVarsFor(userId, workspace)`，工具侧不直接依赖 `EnvVariableService`，保持 `ShellSessionTool` 只认 `ShellSessionManager` 的既有分层）。
>
> 备选方案（不推荐）：把 `envVars` 塞进 `depsEnv` 同一入口。否决理由：deps env 的 `MAO_DEPS_BIN` 前置 PATH 逻辑（`applyDepsEnv`）会作用到用户变量上，且 `RuntimeEnvelope` 已把两者分列，合并后容器侧 envelope 语义变糊。

> 注意 `refreshUserEnvironment` 当前签名是 `(session, userId, domainTokenMap, depsEnv?)`，`workspace` 从 `session.currentWorkdir` 取会有偏差（cd 之后变化）。改为从 `session.workspaceDir` 取（spawn 时的原始工作区，即 `getOrCreate` 传入的 `workdir`）——**工作区变量绑定的是「会话创建时的工作区」**，与需求方确认的「按工作区绝对路径绑定」语义一致；cd 到别的目录不改变变量集合（避免同一会话内 cd 一次变量就变一套的困惑）。

> **（评审修订 P1-1）host 与容器两侧的工作区绑定键必须归一化，否则「三条链路行为一致」不成立。**
>
> 现状差异（已核实）：`ShellSession` 只有 `workspaceDir`（= `getEffectiveWorkspaceRoot(session.workspace)`，**恒非 null**，`shell-session-manager.ts:51`/`:58`），没有 `workspace` 字段；而 `RuntimeEnvelope.workspace` / `session.workspace` / `getOrCreate` 的 `workspace` 入参**可为 null**。
>
> 后果：`session.workspace = null` 时，host 侧按 `workspaceRoot`（全局根）命中工作区变量，容器侧按 `null` 查不到——**同一用户同一会话，host 与 docker 生效的变量集合不同**。
>
> 采用方案：`EnvVariableService.resolveForSession(userId, workspace)` 内部统一归一化，宿主与容器共用同一函数：
>
> ```ts
> /** 工作区绑定键归一化：null / 空串 / 未 resolve 一律归一为全局根，与 getEffectiveWorkspaceRoot 同口径。 */
> export function normalizeWorkspaceKey(workspace: string | null | undefined): string {
>   return workspace != null && workspace.trim() !== '' ? path.resolve(workspace) : GLOBAL_WORKSPACE_KEY;
> }
> ```
>
> `GLOBAL_WORKSPACE_KEY` 取 `path.resolve(cfg.app.harness.workspaceRoot)`（与 `PathSandbox.workspaceRoot` 同一来源），作为 `workspace_env_variable.workspace_path` 的一个合法取值。三处调用方（`ShellSessionManager.resolveEnvVars` / `SessionEnvelopeBuilder.build` / `TerminalManager.buildEnv`）都先过这个函数，容器侧 envelope 的 `workspace` 也走同一归一化后再查库（查库在宿主机，容器内仍零改动）。
>
> 同时 `workspace_env_variable` 的写入侧（§5.4）用同一函数归一化 `workspacePath`，保证读写同键。前端「会话头部抽屉」展示时按同一函数回显，用户看到的就是生效键。

#### (2) 容器模式 — `session-envelope-builder.ts` + `container-tool-executor.ts`

- `RuntimeEnvelope` 增 `envVars: Record<string,string>`（`runtime-channel-protocol.ts:14`）；
- `SessionEnvelopeBuilder` 构造参数增 `envVariableService`，`build()` 内 `envVars: this.resolveEnvVars(userId, workspace)`；
- `ContainerToolExecutor` 构造内 `envVarsProvider: () => this.currentEnvelope?.envVars ?? null`，传给容器内 `ShellSessionManager`。

容器内不查库（`container-import-constraints.spec.ts` 禁止 import MySQL 模块），全部由宿主机经 envelope 下发——与 git token / deps env 完全同构。

#### (3) 云端终端 — `terminal-manager.ts`

`buildEnv`（`:386`）内在 deps env 之后、git credentials 之前插入：

```ts
if (this.deps.envVariableService) {
  try {
    // 工作区键必须过 normalizeWorkspaceKey（§5.7(1) P1-1）：params.workspace 可为 null，
    // 而 host 侧 ShellSessionManager 用的是恒非 null 的 workspaceDir，两侧须归一化到同一键
    const vars = await this.deps.envVariableService.resolveForSession(
      userId, normalizeWorkspaceKey(params.workspace));
    Object.assign(env, vars);
  } catch (e) { harnessLog('warn', ...); }
}
```

> **（评审修订 P1-1 补充）** 原稿此处写 `params.workspace ?? null`，会与 host 侧 `ShellSessionManager` 用的 `session.workspaceDir`（恒非 null）产生键不一致。改为统一过 `normalizeWorkspaceKey()`。
>
> 另注意：终端是**长驻 PTY**，`buildEnv` 只在 spawn 时执行一次，不像 shell 那样每条命令前 refresh。因此终端会话**创建后**新增/删除的变量不会反映到已开着的终端里——这是终端链路的固有限制（与 git token / deps env 现状一致），需在 §9 风险表与抽屉文案中说明，避免用户以为「改了马上就变」。

`TerminalManagerDeps` 增可选 `envVariableService`（`:131`）。容器用户的终端 env 由本方法构造后经 `pty_open` 透传，自动覆盖，无需改 `pty-hub` / `pty-bridge`。

### 5.8 桌面端设计

#### (1) 设置页「环境变量」`views/settings/EnvVariablesView.vue`

复用 `GitCredentialsView.vue` 的视觉语言（`page-header` + `create-btn` + 卡片列表 + `el-dialog` 表单）：

- 顶部说明文案：「配置后注入你的云端 Agent Shell 与云端终端。LOCAL 模式使用本机环境，不在此配置。优先级：工作区 > 用户全局 > 系统全局。保存后数秒内（最多 5 秒）对新执行的命令生效。」
- 卡片展示 `envKey` + `note` + 更新时间 + 编辑 / 删除（值不回显，与 Git 凭证的 `accessToken: '****'` 一致）。

> **（评审修订 P3-1）「值不回显」的实现在后端，不在前端**：`GitCredentialsView.vue:47` 直接渲染 `item.accessToken`，前端零处理；`'****'` 是 `git-credential.routes.ts:63` 的 `toVO()` **硬编码**返回的。`GitCredentialService.maskToken()`（`git-credential.service.ts:122`，支持 `前4****后4`）在当前路由里**根本没被调用**，是死代码——`UserDetailDrawer.vue` 的 Git 凭证 Tab 因此改用「已配置 / 未配置」标签而非展示 `****`（该处有注释说明）。
>
> 本方案照此模式：`EnvVariableVO` **不含 value 字段**（比 Git 凭证更严格——连 `****` 占位都不要），服务端 `toVO()` 不返回。§5.10.2 的管理端掩码是唯一带值形态的出口，且按密文长度派生。
- 弹窗表单：变量名（`el-input` + 前端预校验格式与保留键提示）、变量值（`type="password" show-password`，与 `McpServersView.vue:145` 的 env 编辑器一致）、备注。
- 新增 `router/index.ts` 子路由 `env-variables` 与侧边栏入口（放在「Git 凭证」之后）。

#### (2) 会话头部抽屉 `components/chat/EnvVarsDrawer.vue`

入口放在 `ChatInputToolbar.vue` 的 workspace-indicator 旁（`:44` 那块），仅 `executionMode === 'CLOUD'` 时显示（LOCAL 不注入，避免误导）。

抽屉内容（`el-drawer size="min(560px, calc(100vw - 32px))"`，同 `components/command/CommandManagerDrawer.vue:8-16` 的用法，**必须带 `append-to-body`**——该文件 `:1-7` 有注释：不带时抽屉头部会伸进 Electron 顶部拖拽区，点击被系统拖拽吞掉）：

> **（评审修订 P3-3）对齐对象修正**：
> - 原写「同 `AgentChip.vue:84` 的用法」不准确——`AgentChip` / `WorkspaceChip` 的抽屉是 `direction="btt"` **底部**抽屉（移动端手势语义），本抽屉需要的是**右侧**抽屉；
> - `components/chat/CommandManagerDrawer.vue` **不存在**，实际路径是 `components/command/CommandManagerDrawer.vue`（`components/chat/` 下只有 `AgentChip.vue` / `WorkspaceChip.vue` / `MobileCommandGrid.vue` 等）；
> - 因此对齐 `components/command/CommandManagerDrawer.vue`：右侧 `el-drawer` + `append-to-body` + `destroy-on-close`。

1. **当前生效变量**（只读区）：调 `/v1/sessions/:id/effective-env`，按来源分组展示（`SYSTEM` / `USER` / `WORKSPACE` / `BUILTIN` / `INHERITED`），每组显示条数徽标；同层同名时高亮「已覆盖」。
2. **当前工作区变量**（可编辑区）：调 `/v1/user/workspace-env-variables?workspace=...`，内嵌与设置页同款的小型 CRUD（变量名 / 值 / 备注）。
3. **保留键提示**：静态说明「`PATH` / `HOME` / `MAO_TOKEN` 等平台变量不可配置」，与后端清单一致（前端只做提示，真正的拒绝在后端）。

抽屉只在有 `sessionId`（非「新建任务」占位态）时可用；`isNewTask` 态隐藏入口。

#### (3) `api/index.ts` 新增

```ts
listEnvVariables / createEnvVariable / updateEnvVariable / deleteEnvVariable
listWorkspaceEnvVariables / createWorkspaceEnvVariable / updateWorkspaceEnvVariable / deleteWorkspaceEnvVariable
getEffectiveEnv(sessionId)
```

### 5.9 管理后台设计

新增 `admin/src/views/settings/components/ShellEnvVarsPanel.vue`：

- `el-table` 列出系统变量（`envKey` / `note` / 更新时间 + 编辑 / 删除）；
- 「新增变量」弹窗：变量名、变量值（`type="password" show-password`）、备注；
- 顶部 `el-alert type="info"`：「系统变量对全部用户生效，优先级最低（用户与工作区配置可覆盖）。保存后数秒内（最多 5 秒）对新执行的命令生效。」
- `TOC_GROUPS` 的「工具与终端」组加 `{ kind: 'shell-env', name: 'shell-env' }`，`SystemSettingsView.vue` 模板加对应 `v-if` 分支（同 `EcpConfigPanel` 的写法）。

---

### 5.10 管理员只读查看用户层变量（需求变更 c）

#### 5.10.1 决策变更与安全边界

原决策 #8「管理员只维护系统全局变量，不代配 / 不查看用户变量」**在 c 中部分反转**：管理员获得**只读可见性**，写权限仍完全归用户。

| 能力 | 管理员 | 普通用户 |
|---|---|---|
| 查看系统层变量 | 明文键名 + 掩码值 | 不可见 |
| 查看任意用户的用户层 / 工作区层变量 | 明文键名 + 掩码值（**新增**） | 仅自己 |
| 写系统层变量 | ✅ | ❌ |
| 写任意用户的用户层 / 工作区层变量 | ❌（不提供接口） | 仅自己 |

安全边界要点：

- **只读，零写入口**：不为用户层变量提供任何 admin 侧 POST/PUT/DELETE 路由。管理端看不到值，也就无法据此代配（代配需要明文）。
- **掩码不可反推**：`前4 + **** + 尾4` 只用于「辨认配的是哪个 token」，不构成凭据；且掩码在**服务端**完成，前端拿不到密文也拿不到明文。
- **读操作入审计**：这些路由落在 `/v1/admin` 前缀内，`AUDITED_PREFIXES`（`audit.interceptor.ts:6`）对该前缀**全量留痕**（不区分 method，`shouldAudit` 对前缀命中直接 `return true`），因此管理员每次查看都会被记录 `userId / username / path / ip / 时间`。这是「运维可查看」必要的对价，需在面板文案中明示「查看行为将被审计」。
- **不解密路径**：只读接口**不做 AES-CBC 解密**——`env_value` 密文对管理端无意义，掩码只需长度信息（密文长度）。若为实现「尾 4 位」而解密，等于把凭据明文送进 admin 响应链路，违背「值不回显」。故采用**密文长度派生**方案（见 5.10.2）。

#### 5.10.2 掩码规则

```ts
/** 管理端用户层变量掩码：不解密密文，仅按密文长度派生「已配置 / 空值」与长度暗示。 */
function maskEnvValueForAdmin(ciphertext: string | null): string {
  if (ciphertext == null || ciphertext === '') return '****';           // 空值配置
  return `**** (${ciphertext.length} chars)`;                            // 已配置，仅长度可见
}
```

- 与 `GitCredentialService.maskToken`（`git-credential.service.ts:122`，`前4****后4`）**故意不同**：git token 的尾 4 位能帮管理员辨认「配的是哪个平台的 token」，而环境变量的键名（`GITEA_TOKEN` / `ARTIFACTORY_URL`）本身已带辨认信息，值的首尾 4 位反而增加泄漏面。
- 用户侧（§5.5 的 `EnvVariableVO`）继续**完全不带 value 字段**，与本规则一致。
- 若后续需求方要求「尾 4 位」样式，必须在 `EnvVariableService` 增加 admin 专用解密分支并重新评估审计与泄漏面——本期不做。

#### 5.10.3 接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/v1/admin/users/:id/env-variables` | `user:read` | 列出指定用户的用户全局变量（键名明文 + 掩码值 + 备注 + 时间） |
| GET | `/v1/admin/users/:id/workspace-env-variables?workspace=` | `user:read` | 列出指定用户在指定工作区的变量；`workspace` 省略时返回该用户**全部工作区**的分组列表 |

VO：

```ts
interface AdminEnvVariableVO {
  id: number;
  userId: number;
  username: string;            // 冗余，避免管理端再查一次用户
  workspacePath: string | null; // 用户全局层为 null；工作区层为归一化后的绝对路径
  envKey: string;               // 明文
  maskedValue: string;          // 形如 '**** (287 chars)' 或 '****'
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
```

- 权限选 `user:read` 而非 `settings:read`：语义上这是「看某个用户的配置」，与同文件的 `/v1/admin/users/:id/git-credentials`（`git-credential.routes.ts:43`，`user:read`）对齐；`settings:*` 留给系统层。
- 不加写路由，也就不需要 `user:write`。

#### 5.10.4 管理后台 UI

落在 **`UserDetailDrawer.vue` 新增 Tab「环境变量」**（与既有「Git 凭证」「MCP 服务器」Tab 并列），**不**放「系统设置 → Shell 环境变量」面板——后者是系统层变量的管理入口，两者受众与语义不同。

- 表格列：`workspacePath`（`null` 显示「全局」）/ `envKey` / `maskedValue` / `note` / `updatedAt`；
- 顶部 `el-alert type="info"`：「只读视图。查看行为将被审计。值已脱敏，无法查看明文。」；
- **无操作列**（对齐「管理员无写权限」）；
- 数据加载函数 `loadEnvVariables()` 与既有 `loadGitCredentials()` 同构（`UserDetailDrawer.vue` 的 `loadingTabs` 按 Tab 独立记录加载态，`handleOpen` 里先清空再加载）。

---

## 6. 实现步骤（按依赖顺序）

> 每一步都可独立编译 + 跑测试，不留下「半成品中间态」。

### Step 1 — 迁移与仓储层

1. `backend-ts/db/migration/V158__env_variables.sql`：三张表 + `shell.envVars.enabled` 种子行。
2. `backend-ts/src/env/types.ts`、`env-variable.repository.ts`（表名参数化的通用实现：`list(table, where)` / `insert` / `update` / `delete` / `count`）。
3. 仓储层单测：三表的 CRUD、唯一键冲突、`count` 上限判定。

> **（评审修订 P3-7）「三表同构、表名参数化」做不到完全同构**：`workspace_env_variable` 比另两张多 `workspace_path` 列，`user_env_variable` 多 `user_id` 列，`system_env_variable` 两者皆无。三张表的列集合两两不同。
>
> 采用方案：**同一 repository 接口 + 三个薄实现**（`MysqlUserEnvVariableRepository` / `MysqlWorkspaceEnvVariableRepository` / `MysqlSystemEnvVariableRepository`），共享一个内部泛型 helper（`selectBy(table, where, params)` / `insertInto(table, row)` 之类），**不做**「一个实现 + 表名参数」的强行抽象。差异点在实现里显式写开，比在 SQL 里条件拼列更可读、也更好针对唯一键冲突写单测。

### Step 2 — 保留键与校验

4. `common/sensitive-env.ts` 增 `isReservedEnvKey`；`env/reserved-env-keys.ts` 增 `assertNotReservedEnvKey`。
5. 单测：保留键精确命中 + 前缀命中（`GIT_TOKEN_foo` / `MYSQL_URL` / `APP_X`）、大小写变体（`path` 小写也要拒——`isReservedEnvKey` 内部统一 `toUpperCase` 比较键名集合，注意 `PATH` 与 `Path` 都拒）。

### Step 3 — Service 与接口

6. `env-variable.service.ts`：CRUD + 校验（§5.4）+ AES-CBC 加解密 + 5s TTL 缓存 + `resolveForSession`（合并 + 保留键过滤 + 解密失败跳过）。
7. `env-variable.routes.ts`：§5.5 全部路由 + VO 脱敏。
8. `create-app.ts` 装配：`envVariableService` 注入 `ShellSessionManager`（第 8 个参数）/ `SessionEnvelopeBuilder` / `TerminalManager`。**注意**：host 模式的 `ShellSessionManager` 与容器模式 `ContainerToolExecutor` 内的实例是两套不同装配（后者由 `envVarsProvider` 从 envelope 取值），不要混淆。
9. Service / routes 单测：校验分支、加密往返、`resolveForSession` 的优先级与保留键过滤、`effective-env` 的归属校验（他人 session → 403）、50 条上限、`shell.envVars.enabled=false` 时全层停用。
9b. **（需求变更 c）** `EnvVariableService.listByUserForAdmin(userId)` + `listWorkspaceByUserForAdmin(userId, workspace?)` + 掩码函数（§5.10.2）；admin 只读 2 路由（§5.10.3）；单测覆盖权限 403、掩码形态、无写路由。

### Step 4 — 三条注入链路

10. `RuntimeEnvelope.envVars` + `SessionEnvelopeBuilder` 填充 + `ContainerToolExecutor` 的 `envVarsProvider`。
11. `ShellSessionManager` 的 `envVarsProvider` 参数 + `createSession` / `refreshUserEnvironment` 注入 + `userEnvironmentKeys` 登记。
12. `TerminalManager.buildEnv` 注入 + `TerminalManagerDeps` 扩展。
13. 链路回归测试：
    - `shell-session-manager.spec.ts`：host 模式 spawn env 含三层合并值；refresh 时删除的键被 `unset`；保留键配置被拒；
    - `session-envelope-builder.spec.ts`：envelope 含 `envVars`，容器内不查库；
    - `terminal-manager.spec.ts`：`buildEnv` 含合并值；容器用户经 `pty_open` 帧透传（既有 fake pty 用例补断言）。

### Step 5 — 桌面端

14. `api/index.ts` 九个函数 + 类型。
15. `views/settings/EnvVariablesView.vue` + 路由 + 侧边栏入口。
16. `components/chat/EnvVarsDrawer.vue` + `ChatInputToolbar.vue` 入口（仅 CLOUD + 非新建任务态）。
17. 前端验证：`cd desktop && npm run build`（`vue-tsc -b && vite build`，**不跑** `npx vue-tsc --noEmit`，AGENTS.md 明确其为假通过）。

### Step 6 — 管理后台

18. `admin/src/api`（或既有 settings api 模块）增四个 admin 接口。
19. `components/ShellEnvVarsPanel.vue` + `SystemSettingsView.vue` 的 `TOC_GROUPS` 与模板分支。
20. 前端验证：`cd admin && npm run build`。
20b. **（需求变更 c）** `UserDetailDrawer.vue` 新增「环境变量」Tab：`loadEnvVariables()` 内联调 `/admin/users/:id/env-variables` 与 `.../workspace-env-variables`；只读表格 + 「查看行为将被审计」`el-alert`；无操作列。`handleOpen` 里同步清空 `envVariables.value = []`（对齐既有 `loadGitCredentials` 的清空逻辑，避免抽屉复用时透出上一位用户的数据）。

### Step 7 — 回归与收尾

21. `cd backend-ts && npm run build && npm test`（落盘日志后 grep 摘要）。
22. 文档同任务更新：根 `CHANGELOG.md` 顶部新版本小节（后端 / 前端 / 管理后台三节）；`README.md` / `DEPLOY.md` 若涉及配置说明则补；`skills/mao-cli/reference/config.md` 无需改（本期无 CLI 交互）。

---

## 7. 安全设计

### 7.1 凭据不泄漏

- 三层变量**不会**进入 MCP stdio 子进程（`mcpWhitelistEnv` 白名单不变），也不进入 LOCAL 链路。
- 注入到 shell 的变量值只在服务端内存与 DB 密文中存在；`harnessLog` 只记条数，不记键名与值。
- `effective-env` 接口不返回值，只返回键名与来源。

### 7.2 保留键防提权

`LD_PRELOAD` / `LD_LIBRARY_PATH` / `NODE_OPTIONS` / `BASH_ENV` / `PYTHONPATH` 等可改变子进程加载行为的键一律禁配（§5.3）。这一条是本方案最重要的安全边界：若允许，用户配置一个变量即可让 Agent 的 shell 子进程加载任意共享库，等同于绕过全部沙箱。

### 7.3 越权防护

- 用户层：`userId` 一律取 `requireUserId(request)`，不接受请求体传入（对齐 `git-credential.routes.ts`）。
- 工作区层：`workspace_path` 不校验存在性，但**必须校验归属**——查询与删除都带 `user_id = 当前用户`。他人即使猜到路径也读不到该路径下别人的变量（§2.2 第 3 条：不做跨用户共享）。
- `effective-env`：校验 `session.userId === 当前用户`。
- 管理侧：系统层写操作用 `settings:write`（与修改其它系统设置同一把闸门）。
- **（需求变更 c）管理侧只读**：`/v1/admin/users/:id/env-variables` 与 `.../workspace-env-variables` 用 `user:read`，与 `/v1/admin/users/:id/git-credentials` 同权限；返回体**不含**明文值（§5.10.2），管理端无法据此代配。这两个路由命中 `AUDITED_PREFIXES` 的 `/v1/admin`（`audit.interceptor.ts:6`），**读操作也全量入审计**，需在 UI 明示。

### 7.4 注入顺序与既有收口不冲突

`refreshUserEnvironment` 里三层变量在 git token 之后注入；`GIT_TOKEN_*` 的前缀全清逻辑（`:548`）在三者之前执行，互不影响。deps env 的 PATH 前置仍最后生效（用户禁配 PATH，不存在冲突）。

> **（评审修订 P1-2）注入顺序的准确描述（按现方案文字实施会引入 bug）。**
>
> 现状（`shell-session-manager.ts:522` `refreshUserEnvironment`）不可变更的顺序约束：
>
> ```ts
> // :546  deps env 先并入 env map
> const deps = this.resolveDepsEnv(depsEnv);
> if (deps) this.applyDepsEnv(env, deps, session.currentPath);
> // ↓ 新增：三层变量在此并入 env map（在 applyDepsEnv 之后）
> // :548  GIT_TOKEN_* 前缀全清（必须在 refreshEnvironment 之前，否则清不掉残留）
> session.writeStdin('for k in ${!GIT_TOKEN_@}; do unset "$k"; done\n');
> // :549  统一 flush（export/unset 序列）
> session.refreshEnvironment(env);
> ```
>
> 即：**三层注入是「合并进 `env` map」的一个步骤，位置在 `:546` 与 `:548` 之间**；`:548` 的前缀全清与 `:549` 的 `refreshEnvironment` 的相对位置**不能动**。
>
> 若把注入点误写到 `:548` 之后（按「全清在三者之前执行」的字面理解），注入动作本身仍有效，但会让人误以为可以调整全清位置——一旦顺手把全清后移，`GIT_TOKEN_*` 残留清不掉，属于回归。故此处明确：全清位置固定，三层注入点固定在其前一步。

### 7.5 双保险过滤

1. **写入时**：`assertNotReservedEnvKey` 拒绝入库；
2. **合并时**：`resolveForSession` 对三层结果再过一遍 `isReservedEnvKey`，命中即跳过 + warn。

第二道防线防的是「保留键清单未来扩充，但库里已有旧数据」的情形（无需数据迁移）。

---

## 8. 落地清单

### 8.1 后端 backend-ts

| 文件 | 动作 |
|---|---|
| `db/migration/V158__env_variables.sql` | 新建：三表 + 开关种子行 |
| `src/env/types.ts` | 新建：实体 / 仓储接口 / source 联合 |
| `src/env/env-variable.repository.ts` | 新建：MySQL 实现 |
| `src/env/env-variable.service.ts` | 新建：CRUD + 校验 + 加密 + 缓存 + `resolveForSession` |
| `src/env/env-variable.routes.ts` | 新建：用户侧 9 路由 + admin 侧系统层 4 路由 + admin 侧只读 2 路由（§5.10.3） |
| `src/env/reserved-env-keys.ts` | 新建：`assertNotReservedEnvKey` |
| `src/env/*.spec.ts` | 新建：service / routes 单测 |
| `src/common/sensitive-env.ts` | 改：加 `isReservedEnvKey` 纯函数 |
| `src/common/error-code.ts` | 改：新增 `ENV_VARIABLE_NOT_FOUND` / `ENV_VARIABLE_KEY_DUPLICATE` / `ENV_VARIABLE_LIMIT_EXCEEDED` / `ENV_VARIABLE_KEY_RESERVED` |
| `src/harness/shell/shell-session-manager.ts` | 改：`envVarsProvider` 参数 + `createSession` / `refreshUserEnvironment` 注入 |
| `src/harness/container/runtime-channel-protocol.ts` | 改：`RuntimeEnvelope.envVars` |
| `src/harness/container/session-envelope-builder.ts` | 改：填充 `envVars` |
| `src/harness/container/container-tool-executor.ts` | 改：`envVarsProvider` 透传 |
| `src/harness/terminal/terminal-manager.ts` | 改：`TerminalManagerDeps.envVariableService` + `buildEnv` 注入 |
| `src/create-app.ts` | 改：装配 `envVariableService`（`ShellSessionManager` host 实例 + `SessionEnvelopeBuilder` + `TerminalManager`；容器实例走 envelope，不在此文件） |

### 8.2 前端 desktop

| 文件 | 动作 |
|---|---|
| `src/api/index.ts` | 改：9 个函数 + 类型导出 |
| `src/views/settings/EnvVariablesView.vue` | 新建 |
| `src/views/settings/SettingsView.vue` | 改：侧边栏入口 |
| `src/router/index.ts` | 改：`env-variables` 子路由 |
| `src/components/chat/EnvVarsDrawer.vue` | 新建 |
| `src/components/chat/ChatInputToolbar.vue` | 改：抽屉入口（CLOUD + 非新建态） |

### 8.3 管理后台 admin

| 文件 | 动作 |
|---|---|
| `src/api/index.ts`（或 settings api 模块） | 改：4 个 admin 接口 |
| `src/views/settings/components/ShellEnvVarsPanel.vue` | 新建 |
| `src/views/settings/SystemSettingsView.vue` | 改：`TOC_GROUPS` + 模板分支 |
| `src/views/user/UserDetailDrawer.vue` | 改（需求变更 c）：新增「环境变量」Tab + `loadEnvVariables()`，只读表格 |

> **（评审修订 P3-5）admin 无 settings 专用 api 模块**：`admin/src/api/index.ts` 只导出 `api` 实例，没有任何具名 api 函数；既有页面（含 `SystemSettingsView.vue`）一律内联裸调 `api.get/put/post`。故上表第一行改为：四个系统层接口 + 两个只读接口**均在各自视图组件内内联调用**，不为它们新建 api 模块——与现有风格一致，也避免引入项目里不存在的抽象层。

### 8.4 文档（同任务，AGENTS.md 强制）

| 文件 | 动作 |
|---|---|
| 根 `CHANGELOG.md` | 顶部新 `## x.y.z (日期)`，含「后端 / 前端（桌面 / Web / 安卓）/ 管理后台」三节 |
| `README.md` | 若「环境变量」属用户可见能力，补一节说明三层优先级与入口 |
| `DEPLOY.md` | 无需改（无新增配置项、无新增密钥） |
| `docs/plan/2026-10-18-env-variables-technical-design.md` | 本文档 |

### 8.5 验证清单

| 验证 | 命令 / 方式 | 通过标准 |
|---|---|---|
| 后端构建 | `cd backend-ts && npm run build` | tsc 零错误 |
| 后端测试 | `cd backend-ts && npm test > /tmp/x.log 2>&1; echo exit=$?` + grep `Test Files\|Tests\|FAIL` | 全绿，新增用例覆盖 §6 Step 3/4 |
| desktop 构建 | `cd desktop && npm run build` | 零错误 |
| admin 构建 | `cd admin && npm run build` | 零错误 |
| 容器 import 约束 | `container-import-constraints.spec.ts` | 通过（`env` 域模块不得被容器内代码 import；envelope 透传不破坏该约束）。**（评审修订）需按 §5.6 P0-3 给该 spec 的 `FORBIDDEN_PATTERNS` 追加 `env-variable.(service|repository)` 模式** |
| 管理端只读（需求变更 c） | `env-variable.routes.spec.ts` 新增用例 | 非 `user:read` 权限 → 403；返回体**不含**明文值（`maskedValue` 形态校验）；`workspace` 省略时返回全部分组；**不提供** admin 侧 POST/PUT/DELETE 用户层变量的路由（用 `fastify.inject` 打这些路径应得 404，防止将来误加） |
| 手工联调 | 配一条 `DEMO_TEST_VAR=hello` → shell `echo $DEMO_TEST_VAR` → 输出 `hello`；删掉 → 下一条命令为空。**注意不要用 `MAO_TEST_VAR`：`MAO_` 是保留前缀，会被拒绝** | 三条链路一致 |

---

## 9. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| 三层变量让「这个值从哪来」变难排查 | 中 | 会话头部「生效变量」按来源分组展示；`harnessLog` 记注入条数；`effective-env` 接口可直接问服务端**配置态**（注意 §5.5 P2-3：非 spawn 快照）；管理端可在用户详情只读查看该用户的键名（需求变更 c） |
| 5s 缓存导致「刚保存不生效」 | 低 | 已在文档与 UI 文案中说明「保存后数秒内对新执行的命令生效」；管理员紧急停用走 `shell.envVars.enabled` 开关（同样有 5s 延迟，可接受） |
| 保留键清单未来漏加 | 中 | 双保险过滤（写入 + 合并）；清单集中在 `common/sensitive-env.ts` 一处，评审时统一过 |
| 工作区路径归一化不一致（尾斜杠 / 符号链接 / 大小写） | 中 | 统一 `path.resolve()`；不做前缀匹配；`session.workspace` 与配置写入都用同一归一化函数。符号链接场景本期不处理（与 `getEffectiveWorkspaceRoot` 现有行为一致） |
| docker 容器重建后变量丢失 | 无 | 变量不落容器，每次 `tool_call` 都经 envelope 重新下发（与 git token 同机制） |
| **（评审新增）已开着的云端终端不感知配置变更** | 中 | `TerminalManager.buildEnv`（`terminal-manager.ts:386`）只在 spawn PTY 时执行一次，终端是长驻进程、无 refresh 机制（与 git token / deps env 现状一致）。Agent shell 无此问题（每条命令前 refresh）。缓解：会话头部抽屉在用户修改变量后提示「Agent 会话立即生效（最多 5s）；已打开的交互终端需重开」 |
| 值加密后无法协助排查「用户配错了」 | 低 | 备注字段 + 「生效变量」列表的键名可见；**（需求变更 c）** 管理员可在用户详情只读查看该用户的全部键名与掩码值，边界从「完全看不到」收窄为「看得到键、看不到值」 |
| 50 条上限不够用 | 低 | 已可覆盖常见场景（个人 token / 镜像源 / 项目参数）；超限时接口明确报错，用户可合并同类项 |

**已知限制（明示不做，见 §2.2）**：LOCAL 模式、MCP stdio、跨用户共享、值回显、`.env` 文件、变量插值、分组标签、变更主动推送、历史审计表。

---

## 10. 工作量估算（粗粒度）

| 步骤 | 规模 |
|---|---|
| Step 1 迁移 + 仓储 | 0.5 天 |
| Step 2 保留键 + 校验 | 0.5 天 |
| Step 3 Service + 接口 + 装配 | 1.5 天 |
| Step 4 三条注入链路 + 测试 | 1.5 天 |
| Step 5 桌面端（设置页 + 抽屉） | 2 天 |
| Step 6 管理后台 | 0.5 天 |
| Step 7 回归 + 文档 | 0.5 天 |
| **合计** | **≈ 7 人日** |

---

## 11. 待实施时确认的小项（不阻塞方案）

1. 版本号：实施时按 CHANGELOG 规则取当时最新版本 +1。
2. 迁移编号 `V158`：实施时确认是否已被其它并行任务占用（本文档成稿时最新为 `V157`）。
3. 「生效变量」抽屉是否需要在移动端（安卓 WebView）展示：建议跟随 `ChatMobileConfigRow` 的既有移动端降级策略，若空间不足则仅显示条数徽标。

---

## 12. 需求方决策记录（21 项，已锁定）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 工作区变量绑定范围 | 按**工作区绝对路径**绑定（复用 `session.workspace`，`getEffectiveWorkspaceRoot` 同口径） |
| 2 | 跨用户可见性 | 不做跨用户共享：同工作区下每人各配各的 |
| 3 | 优先级与冲突 | **工作区 > 用户全局 > 系统全局**，内置凭据最高（不可覆盖） |
| 4 | 生效链路 | Agent shell + 云端终端 + docker 容器（三条全做） |
| 5 | LOCAL / Electron | 不做（本机 rc 天然生效，桌面本地路径零改动） |
| 6 | 配置入口 | 桌面设置页（用户全局）+ 管理后台系统设置面板（系统全局） |
| 7 | 工作区变量录入位置 | 会话头部入口 |
| 8 | 管理员权限 | 系统层变量可写（`settings:write`）；**用户层与工作区层只读可见**（`user:read`，键名明文 + 值掩码，见 §5.10），不可代配 / 修改 / 删除。~~原决策「不查看用户变量」已被需求变更 c 部分反转~~ |
| 9 | 加密策略 | **全部值一律加密**（含非敏感值） |
| 10 | 存储形态 | 三张独立表；密钥复用 `APP_GIT_CREDENTIAL_SECRET`（AES-CBC） |
| 11 | 系统层载体 | 曾定 `system_setting` 单键 JSON → **因 `VARCHAR(1024)` 容量不足，修订为独立表 `system_env_variable`**（§5.1 修订说明） |
| 12 | 生效时机 | 执行前刷新 + 会话创建时注入（沿用 `refreshUserEnvironment`） |
| 13 | 保留键 | 新增完整保留键清单，禁配 `PATH` / `HOME` / `LD_PRELOAD` 等 |
| 14 | 变量名格式 | `^[A-Za-z_][A-Za-z0-9_]*$`，最长 128 |
| 15 | 规模上限 | 单值 2048 字符，每层最多 50 条 |
| 16 | 可观测性 | 提供「查看当前生效变量」界面入口 |
| 17 | 查看入口位置 | 会话头部抽屉，看 + 快捷管理 |
| 18 | 值回显 | 用户侧一律不回显 value（含用户自己的设置页）；管理侧查看用户层变量时按 §5.10.2 的长度掩码返回 |
| 19 | 删除即时生效 | 沿用 `refreshEnvironment` 机制，下一条命令前 `unset` |
| 20 | 缓存策略 | 进程内 5s TTL，不做主动失效 |
| 21 | 审计范围 | 系统层写操作入审计（`/v1/system-settings` 与 `/v1/admin` 前缀自动覆盖）；**（需求变更 c）管理端查看用户层变量同为 `/v1/admin` 前缀，读操作也自动入审计**；用户层自身写操作按决策不入审计 |

---

## 13. 评审修订记录（2026-10-18 一轮评审）

评审结论：**需求可行、方案总体可行，无推翻性障碍；但原稿存在 3 项阻塞级缺口、3 项机制缺口与若干引用错误，已全部回写本文档。** 本轮不进入代码开发。

### 13.1 需求方对三项固有限制的处置

| 原风险 | 需求方处置 | 落到文档 |
|---|---|---|
| (a) 工作区变量按「会话创建时的工作区」绑定，会话内 `cd` 不换变量集合 | **了解**（接受） | §5.7(1) 已有说明，无需改 |
| (b) 5s 缓存 →「保存后最多 5 秒生效」 | **文案写明即可** | §9 风险表 + §5.8(1) 顶部文案 + §5.9 面板 `el-alert` 三处均已写「保存后数秒内对新执行的命令生效」 |
| (c) 管理员看不到用户层变量，「用户配错了」无法代查 | **调整需求**：管理员需能在后台看到用户层变量 | **§2.1 第 11 项 + §5.10（新增）+ §7.3 + §8.1/§8.3/§6 Step 3/6 + §12 #8/#18/#21** 同步改为「只读可见」 |

### 13.2 阻塞级修订（不修则功能失效或测试失败）

| # | 级别 | 问题 | 修订位置 |
|---|---|---|---|
| P0-1 | 阻塞 | `refreshUserEnvironment` 无 envVars 入口：`ShellSessionTool` 两处调用只传 3 参（`shell-session-tool.ts:184`/`:332`），只在 `createSession` 注入会导致删除变量无法 `unset`；容器模式完全失效 | §5.7(1)：签名扩展第 5 参 + 调用点同步 + 备选方案否决理由 |
| P0-2 | 阻塞 | `SystemSettingService.getBool` 是 `private`（`settings.service.ts:589`），不可直接调用 | §5.6：新增 public `shellEnvVarsEnabled()`，并明确**默认开启**语义（与 `getBool` 的默认 false 不同） |
| P0-3 | 阻塞 | 容器 import 约束（`container-import-constraints.spec.ts`）会拦住 `src/env/**`，但原稿只靠注释约定 | §5.6：约束表格化 + 要求给 spec 追加 `env-variable.(service\|repository)` 禁用模式；§8.5 同步 |

### 13.3 机制缺口修订

| # | 级别 | 问题 | 修订位置 |
|---|---|---|---|
| P1-1 | 高 | host 与容器两侧工作区绑定键不一致：`ShellSession` 只有恒非 null 的 `workspaceDir`，而 `RuntimeEnvelope.workspace` 可为 null → `session.workspace=null` 时两侧生效集合不同 | §5.7(1)：新增 `normalizeWorkspaceKey()`，三处调用方统一归一化，读写同键 |
| P1-2 | 高 | §7.4 注入顺序描述与实际代码相反，按字面实施易顺手把 `GIT_TOKEN_*` 全清后移导致残留清不掉 | §7.4：明确全清位置固定在 `:548`、三层注入点固定在其前一步，附代码骨架 |
| P1-3 | 中 | 未说明 exec 热路径查库量级；开关与三层查询若拆成 4 次独立往返会放大 | §3.3：补量级说明 + 要求开关与 `sys` 层合并读取 |
| P1-4 | 中 | **（评审新增）已开着的云端终端不感知配置变更**：`buildEnv` 只在 spawn 时执行一次，PTY 长驻无 refresh 机制——原稿「配置改动在下一条命令前生效」对终端链路不成立 | §5.7(3)：明确该固有限制 + 抽屉提示文案；§9 风险表补一行 |

### 13.4 语义与引用修订

| # | 级别 | 问题 | 修订位置 |
|---|---|---|---|
| P2-1 | 中高 | 保留键清单缺 `MAO_` 前缀：`sanitizeInheritedEnv` 是黑名单，`MAO_WORKSPACE_ROOT` 等平台键会继承进子进程 | §5.3：`RESERVED_ENV_PREFIXES` 增 `MAO_` |
| P2-2 | 中 | §1.1 称 `sanitizeInheritedEnv` 为「白名单继承」，实为黑名单剥离 | §1.1：措辞修正 + 真实白名单只有 MCP 一处 |
| P2-3 | 中 | `effective-env` 与真实 spawn env 有 4 类已知偏差（`MAO_TOKEN` 逐命令注入、deps env 仅容器、`LARKSUITE_CLI_APP_ID` 走继承），原稿把它当排障依据会误导 | §5.5：明确为「配置态声明非 spawn 快照」+ 抽屉固定提示 |
| P3-1 | 低 | 「值不回显」被写成前端行为，实际在后端 `toVO()` 硬编码；`maskToken` 是死代码 | §5.8(1)：改为「`EnvVariableVO` 不含 value 字段」 |
| P3-2 | 低 | 多处行号偏移（`configureGitCredentials` :665→:721、`configureUserHome` :640→:710、`applyDepsEnv` :735→:747、`createSession` :625→:670、spawn :658→:700、GIT_TOKEN 全清 :547→:548、PATH 守卫 :246→:249、`buildEnv` :384→:386、`SessionEnvelopeBuilder` :33/:97→:32/:105、`ContainerToolExecutor` :79→:67/74、`AUDITED_PREFIXES` :20→:6） | §1.1 / §4.1 / §4.2 / §4.3 / §5.5 已逐处刷新 |
| P3-3 | 低 | `CommandManagerDrawer.vue` 路径错（在 `components/command/` 不在 `components/chat/`）；`AgentChip` 是底部抽屉不是右侧抽屉 | §5.8(2)：对齐对象改为 `components/command/CommandManagerDrawer.vue`，并强调 `append-to-body` |
| P3-4 | 低 | §8.3 称 admin 有 settings api 模块，实际 `admin/src/api/index.ts` 只导出 `api` 实例，全站内联裸调 | §8.3：改为「在各自视图组件内内联调用」 |
| P3-5 | 低 | §6 Step 1「三表同构、表名参数化」做不到——三张表列集合两两不同 | §6 Step 1：改为「同一接口 + 三个薄实现 + 共享泛型 helper」 |
| P3-6 | 低 | `VARCHAR(4096)` 与「值 ≤ 2048」的换算依据未写，易被误读为明文上限 | §5.4：补 AES-CBC base64 换算（2777 < 4096） |

### 13.5 已核实为「方案正确」的关键判断（保留不改）

1. 三条注入链路全部复用既有机制（`refreshEnvironment` export/unset、`RuntimeEnvelope` 透传、`pty_open` env 透传，`pty-bridge.ts:114` → `pty-hub.ts:69`），不新造注入通道。
2. `isReservedEnvKey` 放 `common/sensitive-env.ts` 供容器复用是安全的（零依赖、不在禁用模式内）。
3. `PATH` 禁配 + deps env 前置逻辑不变，不会与既有 PATH 守卫（`:249`）冲突。
4. `V158` 迁移编号未被占用（当前最大 `V157`）；`system_setting.value` 确为 `VARCHAR(1024)`（`V048:24`）、`session.workspace` 为 `VARCHAR(512)`（`V007:8`）、`is_secret` 列已存在——§5.1 容量论证成立。
5. `AUDITED_PREFIXES` 对 `/v1/admin` 与 `/v1/system-settings` 前缀**全量留痕**（不区分 method），故 §5.10 的管理端只读接口自动入审计，无需额外埋点。
