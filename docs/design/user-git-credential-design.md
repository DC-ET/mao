# 用户级 Git Access Token 配置 — 技术方案文档

> **文档版本**：v1.0  
> **状态**：草稿  
> **作者**：-  
> **日期**：2026-07-06  

---

## 1. 需求背景

### 1.1 现状问题

当前系统（Agent Workbench）在多用户共用场景下存在 Git 权限区分问题：

- **服务端仅有一套 SSH 密钥**：`GitOperationService` 执行 `git clone` 时使用 `ssh -o BatchMode=yes`，依赖服务器上运维预配的统一 SSH key。
- **Agent Shell 会话无用户身份**：`ShellSessionTool` 创建的 bash 进程以服务器进程身份运行，当 Agent 执行 `git push` / `git pull` / `git fetch` 等远程操作时，同样使用服务器的统一凭证。
- **无法区分用户权限**：多个用户共享同一台服务器，但 Git 仓库的访问权限是按人分配的（不同用户对不同仓库/组织的权限不同），当前机制无法做到"用户 A clone 自己有权访问的仓库"。

### 1.2 期望目标

- 每个用户能在客户端**设置页面**配置自己的 Git Access Token，按 **Git 域名** 区分（如 `github.com`、`gitlab.com`、`git.example.com` 各自独立配置）。
- 在以下场景中，自动使用**当前用户**的 Access Token 执行 Git 操作：
  - 会话创建时选择"从 Git 仓库初始化工作区"（`git clone`）
  - Agent 在 Shell 会话中执行的 `git push` / `git pull` / `git fetch` / `git clone` 等远程操作
- 未配置 Token 的用户，Git 操作行为与现状一致（回退到服务器统一凭证，或报错提示用户配置 Token）。

---

## 2. 需求描述

### 2.1 功能范围

| 模块 | 功能点 | 是否做 |
|------|--------|--------|
| 前端设置页 | 用户新增/编辑/删除 Git Access Token（按域名区分） | **是** |
| 前端设置页 | 支持 Token 明文输入、脱敏展示（仅显示首尾几位） | **是** |
| 后端 API | `GET /v1/user/git-credentials` 获取当前用户的凭证列表 | **是** |
| 后端 API | `POST /v1/user/git-credentials` 新增凭证 | **是** |
| 后端 API | `PUT /v1/user/git-credentials/{id}` 编辑凭证 | **是** |
| 后端 API | `DELETE /v1/user/git-credentials/{id}` 删除凭证 | **是** |
| 后端数据库 | 新建 `user_git_credential` 表，Token 落库加密存储 | **是** |
| GitOperationService | 克隆前检测 URL 域名，匹配用户 Token 则注入 | **是** |
| ShellSessionManager | 创建 Shell 会话时，注入用户的 Git Token 环境变量 | **是** |
| SSH 协议的 Git URL | 本期不改变 SSH 行为，仅处理 HTTPS 协议 | **不改变** |
| Token 过期/失效处理 | Token 失效时 Git 操作报错，前端不做 token 健康检查 | **不做** |
| 凭证共享/团队级凭证 | 仅支持个人凭证，不支持团队共享 | **不做** |
| Token 权限校验 | 不做 Token 有效性预校验（scope 校验等），由 Git 服务端自行拒绝 | **不做** |

### 2.2 用户流程

```
用户进入设置页面 → 点击"新增 Git 凭证"
  → 输入域名（如 github.com）和 Access Token
  → 保存
  → 返回列表页，Token 脱敏展示（如 ghp_****...****abcd）
  → 之后创建新会话选择 Git 工作区时，clone 自动使用对应域名的 Token
  → Agent 在 Shell 中执行 git push 时，自动使用对应域名的 Token
```

---

## 3. 技术选型

### 3.1 整体方案

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Token 存储位置 | **服务端数据库** | Agent Shell 会话在服务端执行，Token 必须在服务端可获取才能注入；同时避免客户端存储导致多设备不同步 |
| Token 加密方式 | **AES-256-CBC + 应用级密钥** | Spring 项目已有 `application.yml` 配置管理机制，密钥配置在服务端环境变量中，不随代码仓库暴露 |
| 密钥管理 | **环境变量 `APP_GIT_CREDENTIAL_SECRET`** | 12-Factor 原则，部署时注入，不硬编码 |
| Clone 注入方式 | **HTTPS URL 嵌入 Token**（`https://oauth2:TOKEN@host/path`） | 与 `ProcessBuilder` 执行 `git clone` 最兼容，无需额外依赖，且一次性命令不会残留凭证 |
| Shell 会话注入方式 | **`GIT_ASKPASS` 辅助脚本 + 环境变量** | 持久 Shell 会话中 Agent 可执行多次 Git 命令，`GIT_ASKPASS` 脚本按域名动态返回对应 Token，Git 原生命令无需修改 |

### 3.2 注入方式详细说明

#### 3.2.1 Clone 场景（`GitOperationService`）

```
用户 Token: github.com → ghp_xxx
Clone URL:  https://github.com/user/repo.git

改写后 URL: https://oauth2:ghp_xxx@github.com/user/repo.git
Git 命令:   git clone --depth 1 https://oauth2:ghp_xxx@github.com/user/repo.git /target/dir
```

`-c core.sshCommand` 仅对 SSH 生效，HTTPS 直接改 URL 最简洁。

#### 3.2.2 Shell 会话场景（`ShellSessionTool`）

在 `ShellSessionManager.createSession()` 中：

1. 查询当前用户的 Git 凭证映射 `{host → token}`
2. 将 Token 写入 Shell 进程的环境变量：`GIT_TOKEN_<NORMALIZED_HOST>=<token>`
   - 例如：`GIT_TOKEN_github_com=ghp_xxx`、`GIT_TOKEN_gitlab_com=glpat-xxx`
3. 生成 `GIT_ASKPASS` 辅助脚本到临时路径：

```bash
#!/bin/bash
# Git 会自动调用此脚本，传入 "Username for 'https://github.com': " 作为参数
# 从环境变量中匹配域名获取对应的 Token
HOST=$(echo "$1" | sed -n "s/.*'https:\/\/\([^\/']*\)'.*/\1/p")
if [ -z "$HOST" ]; then
  HOST=$(echo "$1" | sed -n "s/.*'http:\/\/\([^\/']*\)'.*/\1/p")
fi
VARNAME="GIT_TOKEN_$(echo "$HOST" | tr '.-' '__')"
if [ -n "${!VARNAME}" ]; then
  echo "${!VARNAME}"
fi
```

4. 设置环境变量 `GIT_ASKPASS=<temp_script_path>` 和 `GIT_TERMINAL_PROMPT=0`

Git 在执行需要认证的远程操作时，会自动调用 `GIT_ASKPASS` 脚本获取密码（即 Token），无需 Agent/LLM 显式传递凭证。

#### 3.2.3 为什么不选其他方案

| 方案 | 放弃原因 |
|------|----------|
| Git Credential Helper（store 模式） | 需要将 Token 明文写入 `~/.git-credentials` 文件，多用户共享服务器会互相覆盖 |
| Git Credential Helper（cache 模式） | 跨 Shell 会话不持久，首次操作需要交互式输入 |
| `http.extraHeader` 方式 | 需要 `git -c` 每次显式传递，LLM 生成的命令未必携带，不可靠 |
| 环境变量直接注入 `git -c` | 同上，依赖 Agent 行为自觉，应做到对 Agent 透明 |

---

## 4. 实现步骤

### 4.1 数据库变更

**新建 Flyway 迁移文件 `V047__add_user_git_credential.sql`**

```sql
CREATE TABLE IF NOT EXISTS `user_git_credential` (
    `id`             BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`        BIGINT NOT NULL COMMENT '用户 ID',
    `domain`         VARCHAR(255) NOT NULL COMMENT 'Git 服务器域名，如 github.com',
    `access_token`   VARCHAR(2048) NOT NULL COMMENT 'Access Token（AES 加密存储）',
    `description`    VARCHAR(512) COMMENT '凭证备注，如 "个人 GitHub Token"',
    `created_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_user_domain` (`user_id`, `domain`),
    INDEX `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 4.2 后端实现

#### 4.2.1 新增实体 `GitCredential`

**文件**：`backend/src/main/java/cn/etarch/mao/user/entity/GitCredential.java`

```java
@Data
@TableName("user_git_credential")
public class GitCredential {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String domain;
    private String accessToken;  // 加密后的密文
    private String description;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
```

#### 4.2.2 新增 Mapper `GitCredentialMapper`

**文件**：`backend/src/main/java/cn/etarch/mao/user/mapper/GitCredentialMapper.java`

```java
@Mapper
public interface GitCredentialMapper extends BaseMapper<GitCredential> {
}
```

#### 4.2.3 新增 `GitCredentialService`（核心服务）

**文件**：`backend/src/main/java/cn/etarch/mao/user/service/GitCredentialService.java`

**职责**：
- CRUD 操作（按 userId 查询、新增、删除、更新）
- AES 加解密（加密后写入 DB，读取后解密返回给调用方）
- `getTokenMapByUser(Long userId)` 方法：返回 `Map<String, String>`（domain → 解密后的 token），供 `GitOperationService` 和 `ShellSessionManager` 调用

**加密细节**：
- 算法：`AES/CBC/PKCS5Padding`
- 密钥：从 `@Value("${app.git-credential.secret-key}")` 读取
- 密钥来源：部署时通过环境变量 `APP_GIT_CREDENTIAL_SECRET` 注入
- IV：随机生成，与密文拼接存储（格式：`<base64(IV)>:<base64(ciphertext)>`）

#### 4.2.4 新增 Controller `GitCredentialController`

**文件**：`backend/src/main/java/cn/etarch/mao/user/controller/GitCredentialController.java`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/user/git-credentials` | 获取当前用户的凭证列表（token 字段脱敏：仅展示首 4 位 + 尾 4 位） |
| POST | `/v1/user/git-credentials` | 新增凭证（body: `{domain, accessToken, description}`） |
| PUT | `/v1/user/git-credentials/{id}` | 更新凭证 |
| DELETE | `/v1/user/git-credentials/{id}` | 删除凭证 |

#### 4.2.5 修改 `GitOperationService.clone()`

**变更点**：
1. `clone()` 方法新增参数 `Long userId`
2. 方法开始时调用 `gitCredentialService.getTokenMapByUser(userId)` 获取用户的 domain→token 映射
3. 若 URL 为 HTTPS 协议，提取 host（复用 `GitUrlParser.extractHost()`），匹配用户 Token
4. 匹配成功则改写 URL：`https://oauth2:<token>@<host>/<path>`
5. Token 不记录到日志中（对日志输出做 URL 脱敏处理）

**日志脱敏**：`log.info("Starting git clone: {} → {} ...", maskToken(url), targetDir)`  
`maskToken()` 将 URL 中的 `oauth2:xxx@` 替换为 `oauth2:***@`。

#### 4.2.6 修改 `ShellSessionManager`

**变更点**：
1. `createSession()` 方法新增参数 `Map<String, String> domainTokenMap`
2. 在创建 `ProcessBuilder` 时，将 token 注入环境变量（命名规则：`GIT_TOKEN_<域名中的点和短横线替换为下划线>`）
3. 生成 `GIT_ASKPASS` 辅助脚本到工作区的 `.mao/git-askpass.sh`，设置可执行权限
4. 设置环境变量 `GIT_ASKPASS=<脚本路径>`、`GIT_TERMINAL_PROMPT=0`

**脚本生成时机**：仅在 `domainTokenMap` 非空时生成，避免不必要的文件写入。

#### 4.2.7 修改 `ShellSessionTool`

**变更点**：
1. `handleExec()` → `doExec()` 中，在首次创建 Shell 会话时，需要传入用户的 domainTokenMap
2. 当前 `ShellSessionTool` 无法直接获取 `userId`。需要在 `execute()` 方法中新增 `Long userId` 参数
3. 通过 `SessionService.getSession(sessionId)` 获取 `userId`，再调用 `GitCredentialService.getTokenMapByUser(userId)` 获取 Token 映射
4. 将 Token 映射传递给 `ShellSessionManager.getOrCreate()`

#### 4.2.8 修改 `ToolDispatcher`（透传 userId）

**变更点**：
- `ToolDispatcher` 调用 `ShellSessionTool.execute()` 时需传入 `userId`
- `ToolDispatcher` 可通过 `AgentExecutionContext` 获取 userId

#### 4.2.9 修改 `SessionService.createSession()`

**变更点**：
- `createSession()` 中调用 `gitOperationService.clone()` 时，传入当前 `userId`

#### 4.2.10 新增配置项

在 `application.yml` 中新增：

```yaml
app:
  git-credential:
    secret-key: ${APP_GIT_CREDENTIAL_SECRET:}  # 必须配置，否则启动报错
```

启动时校验 secret-key 非空，为空则抛出启动异常并提示配置该环境变量。

### 4.3 前端实现

#### 4.3.1 新增设置页面入口

**文件**：`desktop/src/router/index.ts` — 新增路由

```typescript
{
  path: '/settings',
  component: () => import('../views/settings/SettingsView.vue'),
  children: [
    { path: 'git-credentials', component: () => import('../views/settings/GitCredentialsView.vue') }
  ]
}
```

**入口位置**：在侧边栏或用户头像下拉菜单中增加"设置"入口。

#### 4.3.2 新增 `GitCredentialsView.vue`

**功能**：
- 列表展示当前用户的 Git 凭证（域名、脱敏 Token、备注、操作按钮）
- "新增凭证"按钮 → 弹出 Dialog / 跳转表单页
- 表单字段：域名（input，带格式校验）、Access Token（input type=password，可切换明文/密文）、备注（选填）
- 编辑：点击某条凭证的"编辑"按钮，弹出 Dialog 修改 Token 和备注
- 删除：二次确认后删除

**Token 脱敏规则**：仅展示 `****`，列表不展示任何 token 内容；详情/编辑页需要用户手动点击"显示"才能查看。

#### 4.3.3 新增 API 接口封装

**文件**：`desktop/src/api/index.ts` — 新增方法

```typescript
export function getGitCredentials(): Promise<GitCredential[]>
export function createGitCredential(data: {domain, accessToken, description}): Promise<GitCredential>
export function updateGitCredential(id: number, data: {accessToken, description}): Promise<GitCredential>
export function deleteGitCredential(id: number): Promise<void>
```

#### 4.3.4 类型定义

```typescript
interface GitCredential {
  id: number
  domain: string
  accessToken: string  // 脱敏后的 token
  description: string
  createdAt: string
  updatedAt: string
}
```

### 4.4 启动校验

在 `WorkbenchApplication` 启动后，使用 `@PostConstruct` 或 `ApplicationRunner` 校验 `app.git-credential.secret-key` 不为空。若为空，打印明确的错误信息并阻止应用启动。

### 4.5 错误处理

| 场景 | 处理方式 |
|------|----------|
| 用户未配置 Token，使用 HTTPS clone | `GitOperationService` 不做 URL 改写，直接以原始 URL 执行 clone（Git 服务端可能要求交互式认证，会超时失败并返回错误提示） |
| 用户未配置 Token，Agent 在 Shell 中执行 git push | `GIT_ASKPASS` 脚本返回空，Git 报认证失败，Agent 将错误反馈给用户 |
| Token 失效/过期 | 由 Git 服务端返回 403/401，错误信息原样透传给用户，提示检查 Token 有效性 |
| secret-key 未配置 | 启动阶段报错，阻止应用启动 |
| 同一域名重复添加 | 数据库唯一键约束 + API 层校验，返回 `"该域名的凭证已存在"` 错误提示 |

---

## 5. 落地清单

### 5.1 数据库

- [ ] 创建 Flyway 迁移文件 `V047__add_user_git_credential.sql`

### 5.2 后端 — 新增文件

- [ ] `user/entity/GitCredential.java` — 实体类
- [ ] `user/mapper/GitCredentialMapper.java` — Mapper 接口
- [ ] `user/service/GitCredentialService.java` — 核心服务（CRUD + AES 加解密）
- [ ] `user/controller/GitCredentialController.java` — REST API 控制器

### 5.3 后端 — 修改文件

- [ ] `session/service/GitOperationService.java` — `clone()` 新增 `userId` 参数，注入 Token 到 HTTPS URL
- [ ] `session/service/SessionService.java` — 调用 `clone()` 时传入 `userId`
- [ ] `harness/shell/ShellSessionManager.java` — `createSession()` 新增 `domainTokenMap` 参数，注入环境变量 + `GIT_ASKPASS` 脚本
- [ ] `harness/tool/impl/ShellSessionTool.java` — `execute()` 中获取 `userId` 并取得 Token 映射，传递给 `ShellSessionManager`
- [ ] `harness/tool/ToolDispatcher.java` — 透传 `userId` 给 `ShellSessionTool`
- [ ] `harness/tool/Tool.java` — 接口 `execute()` 方法签名新增 `Long userId` 参数（或通过上下文对象传递）
- [ ] `config/application.yml` — 新增 `app.git-credential.secret-key` 配置项
- [ ] `WorkbenchApplication.java` — 启动时校验 `secret-key` 非空

### 5.4 前端

- [ ] `router/index.ts` — 新增 `/settings/git-credentials` 路由
- [ ] `views/settings/GitCredentialsView.vue` — 凭证管理页面（列表 + 新增/编辑/删除）
- [ ] `api/index.ts` — 新增 Git 凭证 API 方法
- [ ] 侧边栏/导航栏 — 新增"设置"入口

### 5.5 部署配置

- [ ] 服务端环境变量 `APP_GIT_CREDENTIAL_SECRET` — 生成并配置 32 字节随机密钥
- [ ] 运维文档 — 记录密钥轮换流程（需解密→重新加密所有用户的 Token）

---

## 6. 安全考量

1. **Token 加密存储**：数据库存储的是 AES-256 加密后的密文，即使数据库泄露也无法直接获取 Token
2. **密钥独立管理**：加密密钥通过环境变量注入，与代码仓库分离
3. **日志脱敏**：`GitOperationService` 日志中不会输出包含 Token 的完整 URL
4. **HTTPS 传输**：API 接口本身通过 HTTPS 传输（前端→后端），Token 在传输过程中加密
5. **Token 不返回明文**：`GET /v1/user/git-credentials` 返回的 token 字段为脱敏值（如 `****`），仅在新增/编辑时接收明文
6. **`GIT_ASKPASS` 脚本隔离**：脚本写入工作区 `.mao/` 目录，仅当前用户的工作区可读；Shell 会话结束后，脚本随工作区一起被清理
7. **不做 Token 预校验**：不在服务端向 Git 服务发起 Token 校验请求，避免 Token 被第三方服务器记录

---

## 7. 风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|----------|
| 密钥泄露 | 所有用户 Token 可被解密 | 密钥配置在环境变量中，不随代码仓库暴露；运维侧做好服务器访问控制 |
| Token 注入到 git clone 日志 | Token 可能被日志系统采集 | `maskToken()` 脱敏处理，日志中 token 替换为 `***` |
| `GIT_ASKPASS` 脚本残留 | Token 以脚本形式存在文件系统中 | 脚本随工作区创建而生成，随工作区清理而删除；脚本路径在 `.mao/` 隐藏目录 |
| 多用户并发创建 Shell 会话 | Token 环境变量在各自进程空间隔离 | `ProcessBuilder.environment()` 是独立的 Map，不同进程互不影响 |
| SSH 协议 Git URL | 无法通过 Access Token 认证 | 不予处理，SSH 场景仍使用服务器的统一密钥；若用户需要 SSH 认证，后续可扩展 per-user SSH key 功能 |
| secret-key 轮换 | 历史 Token 无法解密 | 轮换时需执行迁移脚本：用旧密钥解密 → 用新密钥加密 → 更新所有记录 |

---

## 8. 附录

### A. 涉及的文件清单

```
backend/
├── src/main/java/cn/etarch/mao/
│   ├── user/
│   │   ├── entity/GitCredential.java                          [新增]
│   │   ├── mapper/GitCredentialMapper.java                    [新增]
│   │   ├── service/GitCredentialService.java                  [新增]
│   │   └── controller/GitCredentialController.java            [新增]
│   ├── session/
│   │   ├── service/GitOperationService.java                   [修改]
│   │   └── service/SessionService.java                        [修改]
│   └── harness/
│       ├── shell/ShellSessionManager.java                     [修改]
│       ├── tool/impl/ShellSessionTool.java                    [修改]
│       ├── tool/ToolDispatcher.java                           [修改]
│       └── tool/Tool.java                                     [修改]
├── src/main/resources/
│   ├── db/migration/V047__add_user_git_credential.sql         [新增]
│   └── application.yml                                        [修改]
└── WorkbenchApplication.java                                  [修改]

desktop/
├── src/
│   ├── router/index.ts                                        [修改]
│   ├── api/index.ts                                           [修改]
│   └── views/
│       └── settings/
│           └── GitCredentialsView.vue                         [新增]
```

### B. 参考

- [Git - gitcredentials Documentation](https://git-scm.com/docs/gitcredentials)
- [Git - GIT_ASKPASS environment variable](https://git-scm.com/docs/git-config#Documentation/git-config.txt-coreaskPass)
- 现有代码参考：`GitOperationService.java`（clone 实现）、`ShellSessionManager.java`（Shell 会话创建）
