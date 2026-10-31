# 容器 /etc/hosts 注入（Docker 模式）技术方案

> 版本：v1.1 | 日期：2026-10-31 | 状态：待评审
>
> 关联：V155/V160（用户级/全局运行时模式）、容器隔离技术方案 §5.2（容器生命周期）/§5.12（运行环境）
> 场景来源：docker 模式下宿主 `/etc/hosts` 的自定义域名映射不会进入容器，容器按 DNS 结果访问，导致部分内网服务不可达（实例：`prometheus.acg.team`）。

---

## 1. 背景与问题

- 宿主机上为个别域名单独配置了 `/etc/hosts` 映射（如 `prometheus.acg.team` 指向容器网络可达的局域网 IP），宿主机访问正常。
- docker 模式容器**不继承**宿主机 `/etc/hosts`（Docker 为每个容器单独生成，仅含 `localhost`、容器 hostname 等），容器按 DNS 解析到内网 IP，网络不通。
- 需求：容器需要支持这种域名解析配置；且最好能"宿主机通，容器就通"，不靠人工维护两份文件。

结论（已评审确认）：采用 **B + A 组合方案**——
- **B：自动继承**宿主机 `/etc/hosts` 的自定义条目（默认开启，可后台关闭）；
- **A：后台配置**「容器域名解析」规则作为追加/覆盖层，并在后台只读展示继承到的条目。

## 2. 目标与非目标

**目标**

1. 容器创建时把「宿主机 hosts 自定义条目 + 后台自定义规则」通过 `docker run --add-host` 注入，写入容器 `/etc/hosts`。
2. 自动继承宿主机 `/etc/hosts`（可开关），后台可对同域名追加/覆盖。
3. 配置变化（宿主文件或后台规则）后，受影响用户的容器在下次使用时**自动重建生效**；并提供管理后台的**即时重建**操作（单用户 / 全部，见 4.11）。
4. 管理后台可见：继承条目只读预览 + 自定义规则编辑 + 开关，全部沿现有系统设置体系（权限、审计、校验）。

**非目标**

- 不解决"IP 本身不可达"的连通性问题（本方案只改解析结果）。
- 本期不支持 IPv6 条目（P2 再议，`--add-host` 的 IPv6 写法需单独适配）。
- 不修改宿主机 `/etc/hosts`，不影响 host 模式（host 模式无容器，配置不生效、不展示误报）。
- 不做按用户/按 Agent 的粒度（全局配置；后续如有需求再扩展）。

## 3. 现状分析（代码事实）

### 3.1 容器创建与 docker run 参数

- `backend-ts/src/harness/container/container-registry.ts`：`createAndStart()` 内拼接 `docker run -d --name mao-user-{n} --label ... --memory --cpus --pids-limit --network ... -e ...`（约 L494 起），挂载列表由 `ContainerMountPlanner` 产出。
- 注入点即在此 args 数组：`--network` 之后追加 `--add-host host:ip`（每条一个参数对）。

### 3.2 容器复用与重建（为什么必须做"指纹"）

- `ensureRunningLocked()` 三条路径：
  - `running` 直接复用（挂载漂移时 `mountPlanDrifted()` 触发重建）；
  - `stopped` 走 `dockerStart()`（**复用时不会更新 run 参数**；仅在工作区/挂载漂移时重建）；
  - 异常/失联 → `rebuildEntry()`（停、删、run）。
- 先例：`entry.mountFingerprint`（planner 变更后一次性自愈重建，缺省视为漂移）。
- **结论**：只加 `--add-host` 参数不够，必须引入"解析规则指纹"并挂进 `ensureRunningLocked` 的两个复用分支，否则配置变更对既有容器永远不生效。

### 3.3 系统设置体系

- 存储：`system_setting` 表（`setting_key/value/category/description/editable/is_secret`），Flyway 迁移在 `backend-ts/db/migration/`（最新 V175；`runtime.mode` 的先例见 V160，`INSERT IGNORE`）。
- 读写 API：`GET /v1/system-settings`、`PUT /v1/system-settings/:key`、`PUT /v1/system-settings/batch`（`settings/settings.routes.ts`），权限 `settings:read` / `settings:write`。
- 保存钩子：`beforeSave`（校验，失败整批回滚）/ `afterSave`（缓存失效），装配处 `app-routes.ts`（`runtime.mode` 保存后 `runtimeModeResolver.invalidate()` 先例，L423）。
- 校验集中点：`settings/settings.service.ts#validateValue()`（L731 起）；JSON 数组先例 `tools.http.privateAllowlist`（L792，配 `admin/src/views/settings/cidrAllowlist.ts` 前端同口径校验）。
- 动态读取先例：`RuntimeModeResolver`（`harness/container/runtime-mode.ts`，TTL 缓存 + `invalidate()` + 查询失败降级）。

### 3.4 管理后台设置页

- `admin/src/views/settings/SystemSettingsView.vue`：TOC 分组声明（`TOC_GROUPS`），自定义面板按 `kind` 渲染（先例：`shell-env` → `ShellEnvVarsPanel.vue`，含表格 + 增删改弹窗 + 校验的模式）。
- 设置行按后端 `category` 字段归入「运行环境」分组；未声明分类兜底进「其他」。

---

## 4. 方案设计

### 4.1 总体流程

```
后台保存设置 / 宿主机 /etc/hosts 变更
        │
        ▼
ContainerHostsResolver.resolve()   ← TTL 缓存（5s）
  ├─ 读 system_setting：inheritHostHosts（开关）、extraHosts（自定义规则）
  ├─ 读宿主机 /etc/hosts（开关开启时）
  └─ 过滤 → 合并（自定义覆盖同名）→ 稳定排序 → [{host, ip, source}]
        │
        ▼
ContainerRegistry.ensureRunning()
  ├─ 计算期望指纹，与 entry.hostsFingerprint 比较
  │    ├─ 一致 → 复用（running 直用 / stopped docker start）
  │    └─ 漂移 → rebuildEntry()（停→删→run，重新注入）
        │
        ▼
docker run ... --network bridge --add-host host:ip ...
        │
        ▼
容器内 /etc/hosts 生效（files 先于 dns，解析被改用注入值）
```

### 4.2 设置项与迁移（V176）

新增两个 `system_setting` 行，`category='运行环境'`：

| setting_key | 默认值 | 说明 |
|---|---|---|
| `runtime.container.inheritHostHosts` | `true` | 是否自动继承宿主机 `/etc/hosts` 的自定义条目 |
| `runtime.container.extraHosts` | `[]` | 自定义规则，JSON 数组：`[{"host":"prometheus.acg.team","ip":"10.70.x.x"}]` |

迁移 SQL（`backend-ts/db/migration/V176__container_hosts_injection.sql`）：

```sql
-- V176: Docker 模式容器 /etc/hosts 注入（B+A：继承宿主机 hosts + 后台自定义规则）。
-- 消费方 ContainerHostsResolver：创建容器时逐条转 --add-host；配置漂移自动重建容器。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('runtime.container.inheritHostHosts', 'true', '运行环境', '容器域名解析：自动继承宿主机 /etc/hosts 的自定义条目（Docker 模式）。保存后该用户容器重建时生效', 1, 0),
('runtime.container.extraHosts', '[]', '运行环境', '容器域名解析：自定义 host→IP 规则（JSON 数组，如 [{"host":"a.example.com","ip":"10.0.0.1"}]）。与继承条目同名时以本配置为准', 1, 0);
```

### 4.3 宿主机 hosts 解析与过滤规则

解析 `IP host1 [host2 ...]` 行（忽略空行与 `#` 注释），逐条过滤：

| 规则 | 动作 | 说明 |
|---|---|---|
| IP 非合法 IPv4（含 IPv6 行） | 跳过 | 本期仅 IPv4 |
| IP ∈ `127.0.0.0/8` | 跳过 | 环回（含宿主 `127.0.1.1 hostname` 行） |
| host ∈ 内置保留名 | 跳过 | `localhost`、`localhost.localdomain`、`broadcast`、`broadcasthost`、`ip6-*` 系列 |
| host 非法（空/含空白/超长） | 跳过 | 宽松校验：`[a-zA-Z0-9.-]`，≤253 |
| 同 host 多条 | 取首条 | hosts 语义即首条生效 |
| 条目总数 > 100 | 截断 + warn | 防异常文件 |

输出统一 normalize：host 小写、去尾点。

### 4.4 合并与优先级

- 最终条目 = 宿主继承条目（开关开启时）∪ 自定义规则；
- **自定义规则优先**：同 host 时覆盖宿主条目；
- 合并后按 host 去重、按 host 字典序稳定排序（保证指纹稳定）；
- 每条带 `source` 标记（`hosts-file` / `custom`），供后台预览展示。

### 4.5 docker run 注入

`container-registry.ts#createAndStart()` args 修改（`--network` 后）：

```ts
const hostEntries = await this.opts.resolveHostsInjection?.() ?? [];
// ...
'--network', c.network,
...hostEntries.flatMap((e) => ['--add-host', `${e.host}:${e.ip}`]),
```

要点：

- 数组传参，无 shell 注入面；host/ip 已在解析与保存两侧校验；
- 空列表时零参数，行为与现状完全一致；
- `--add-host` 要求 Docker ≥ 17.09（现网满足）；
- 注入失败（如非法 host 被 docker 拒绝）→ 容器创建失败路径已有（`cleanupFailedStart`），不新增兜底。

### 4.6 配置解析器（容器侧）

新增 `backend-ts/src/harness/container/container-hosts-resolver.ts`：

```ts
export interface ContainerHostsEntry { host: string; ip: string; source: 'hosts-file' | 'custom' }

export interface ContainerHostsResolverDeps {
  systemSettingService: { getText(key: string, fallback?: string): Promise<string> };
  /** 便于单测注入；默认读取 /etc/hosts */
  readHostsFile?: () => Promise<string>;
  now?: () => number;
}

export class ContainerHostsResolver {
  private cached: { entries: ContainerHostsEntry[]; atMs: number } | null = null;
  constructor(private readonly deps: ContainerHostsResolverDeps) {}
  async resolve(): Promise<ContainerHostsEntry[]>;   // TTL 5s（与 RuntimeModeResolver 同口径）
  invalidate(): void;                                // 保存设置后立即失效
}
export function parseHostsFile(content: string): Array<{ host: string; ip: string }>;
export function mergeHostsEntries(hostFile: Entry[], custom: Entry[], inheritEnabled: boolean): ContainerHostsEntry[];
export function hostsFingerprint(entries: ContainerHostsEntry[]): string;  // sha1(稳定序列化)
```

- 常量：`CONTAINER_INHERIT_HOST_HOSTS_KEY = 'runtime.container.inheritHostHosts'`、`CONTAINER_EXTRA_HOSTS_KEY = 'runtime.container.extraHosts'`。
- 降级：读宿主机文件失败（不存在/权限/格式异常）→ `harnessLog('warn')` 后仅返回自定义条目，**不抛错、不阻塞容器创建**。
- 开关关闭 → 不读宿主机文件，仅自定义条目。
- 缓存 5s：`ensureRunning` 高频调用下避免反复读文件。

### 4.7 生效机制：指纹与重建

`ContainerEntry` 新增：

```ts
/** 本次 docker run 固化的 /etc/hosts 注入指纹；与期望不一致时 ensureRunning 重建容器。 */
hostsFingerprint?: string;
```

`ensureRunningLocked()` 的两个复用分支（`running`、`stopped`）在现有 `mountPlanDrifted()` 判定旁并列增加：

```ts
private async hostsInjectionDrifted(entry: ContainerEntry): Promise<boolean> {
  const expected = hostsFingerprint(await this.opts.resolveHostsInjection?.() ?? []);
  if (entry.hostsFingerprint === expected) return false;
  // 升级前的旧条目（无指纹）且当前期望为空：不重建，避免无配置机器全量重建一次
  if (entry.hostsFingerprint == null && expected === EMPTY_HOSTS_FINGERPRINT) return false;
  return true;
}
```

行为约定：

| 场景 | 结果 |
|---|---|
| 首次创建 / 挂载漂移重建 / 生命周期重建 | `createAndStart` 重新注入并写入新指纹 |
| 配置未变 + 容器 running | 直接复用，零开销（只多一次回解析缓存） |
| 配置变化 + 容器 running/stopped | 下次 `ensureRunning` 触发 `rebuildEntry()`（停→删→run） |
| 宿主机 hosts 变更 | 同上（resolver 5s 后感知） |
| 开关关闭且无自定义规则 | 同 host 条目被移除 → 指纹变化 → 重建一次恢复默认解析 |

**代价与文案**：重建会中断容器内的 shell 会话、终端与在途任务。后台面板必须明示："保存后，受影响用户的容器将在下次使用时重建；重建会中断容器内在跑的任务"。如需**立即生效**（跳过等待），使用 4.11 的容器重建操作（单用户 / 全部）。

### 4.8 管理后台只读预览 API

`GET /v1/system-settings/container-hosts/preview`（权限 `settings:read`），由 `settings.routes.ts` 新增，deps 注入 `containerHostsPreview`：

```json
{
  "inheritEnabled": true,
  "hostsFilePath": "/etc/hosts",
  "hostsFileError": null,
  "entries": [
    { "host": "prometheus.acg.team", "ip": "10.70.x.x", "source": "hosts-file" },
    { "host": "foo.internal", "ip": "10.0.0.9", "source": "custom" }
  ]
}
```

用途：后台展示"实际会注入容器的条目"（含宿主继承），让隐式继承可见；`hostsFileError` 暴露读取失败原因。

### 4.9 前端 UI 设计

新增 `admin/src/views/settings/components/ContainerHostsPanel.vue`（结构参照 `ShellEnvVarsPanel.vue`）：

1. 顶部开关：`自动继承宿主机 /etc/hosts`（读写 `runtime.container.inheritHostHosts`）；
2. 只读区「当前生效条目」：调用预览接口，表格列 `域名 / IP / 来源`，带刷新按钮；读取失败时展示错误提示；
3. 编辑区「自定义规则」：表格 + 新增/编辑弹窗（host、ip 两个字段）+ 删除，保存写 `runtime.container.extraHosts`；
4. 顶部 `el-alert` 说明：仅 Docker 模式生效；与宿主继承条目同名时以自定义为准；保存后容器重建时生效。

接入 `SystemSettingsView.vue`：

- 类型 union 增加 `'container-hosts'`；
- `TOC_GROUPS` 的「平台与运维 → 运行环境」下新增 `{ kind: 'container-hosts', name: 'container-hosts' }`；
- 渲染循环增加 `v-else-if="section.kind === 'container-hosts'"` 分支；
- 目录 label 映射为「容器域名解析」，并加入已声明集合（避免落「其他」）。

前端校验新增 `admin/src/views/settings/containerHosts.ts`，口径与后端一致（见 4.10）。

### 4.10 校验规则（保存前后端同口径）

| 项 | 规则 |
|---|---|
| host | 小写化后 `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`，≤253 字符；禁止 `localhost` 及 `ip6-*` 内置名 |
| ip | IPv4 四段（每段 0–255）；**禁止** `127.0.0.0/8`、`169.254.169.254`、`0.0.0.0`、`255.255.255.255`、组播 `224.0.0.0/4`、保留 `240.0.0.0/4` |
| 数量 | 自定义规则 ≤ 50 条 |
| 重复 | 同 host 重复直接拒绝（提示合并） |
| 体积 | JSON 序列化 ≤ 8KB |
| 清空 | 允许 `[]`（等价关闭自定义规则） |

后端实现位置：`settings.service.ts#validateValue()` 新增分支（参照 `tools.http.privateAllowlist`）；复用 `common/ssrf.ts` 的 `isLoopbackIp` / `isCloudMetadataIp`，组播/保留段按上表补充。

### 4.11 容器重建操作（单用户 / 全部）

4.7 的自动重建是**惰性**的：保存设置后等该用户下次使用容器才触发。本节提供两个显式操作，用于"立即生效 / 立即验证"：**单用户重建**（用户管理页）与**重建全部**（系统设置页）。二者重建逻辑完全复用 `rebuildEntry()`（停→删→run），因此天然带上最新的 hosts 注入与挂载配置。

#### 4.11.1 ContainerRegistry 新增公开方法

```ts
export type RecycleStatus = 'rebuilt' | 'none' | 'skipped-busy' | 'failed';
export interface RecycleResult { userId: number; status: RecycleStatus; error?: string }

/** 在册容器摘要（后台列表、全部重建的遍历来源）。只读快照。 */
listEntries(): Array<{
  userId: number; containerName: string; state: 'running' | 'stopped';
  busy: boolean; startedAtMs: number; lastUsedAtMs: number;
}>;

/** 重建单个用户容器。none = 当前没有在册容器（下次使用时按新配置创建）。 */
recycleUser(userId: number, opts?: { force?: boolean }): Promise<RecycleResult>;
```

- `recycleUser` 在既有 `withUserLock(userId)` 内执行（与自动重建共用同一把串行锁，不会互相摧毁）：
  - 无在册条目 → `{ status: 'none' }`
  - `!force` 且容器忙碌 → `{ status: 'skipped-busy' }`；忙碌判定复用 `entry.inContainer`：`shellSessions > 0 || pendingTasks > 0 || attachedTerminals > 0`
  - 否则 `rebuildEntry(entry, entry.sessionWorkspaces)` → `{ status: 'rebuilt' }`；异常捕获后返回 `{ status: 'failed', error }`（不抛出，便于批量场景逐条汇报）
- **stopped 容器同样重建**：`docker start` 复用创建时参数，不会更新 `/etc/hosts`，必须 rm+run。

#### 4.11.2 API 设计

| 方法 / 路径 | 权限 | 说明 |
|---|---|---|
| `GET /v1/admin/containers` | `container:manage` | 在册容器列表（userId、状态、busy、启动/最后使用时间） |
| `POST /v1/users/:id/container/recycle` | `container:manage` | 单用户重建；body 可选 `{ force?: boolean }`；返回 `RecycleResult` |

- 两个路径分别命中审计拦截器既有前缀 `/v1/admin`、`/v1/users`（见 `audit/audit.interceptor.ts` 的 `AUDITED_PREFIXES`），**自动留痕，无需新增审计代码**。
- host 模式（全局或该用户级覆盖）下调用返回 `none`，不报错（语义：无在册容器）。
- 权限 `container:manage` 新增（迁移 V177，参照 V118 写法）：`INSERT ... WHERE NOT EXISTS` + `INSERT IGNORE role_permission role_id = 1`（授予管理员角色）。
- **不提供后端批量接口**：全部重建由前端遍历 `GET /v1/admin/containers` 逐条调用。理由：单容器重建 3–10s，批量接口易触发 HTTP 超时；串行可控制宿主负载；逐条结果可观测、失败可单独重试。若未来需要 CLI/自动化，再在 registry 层加 `recycleAll()`（内部串行循环、默认跳过 busy）即可，属增量改动。

#### 4.11.3 前端

**单用户**：`admin/src/views/user/UserDetailDrawer.vue` 操作区新增「重建容器」按钮（按 `container:manage` 控制可见）：
- 二次确认弹窗，文案明确"将重启该用户容器，中断容器内正在执行的 shell / 终端 / 任务"；
- 结果提示：`rebuilt` → 成功；`none` → "该用户当前没有运行中的容器，下次使用时按最新配置创建"；`skipped-busy` → 提示勾选强制或稍后重试；`failed` → 展示错误摘要。

**全部**：`ContainerHostsPanel.vue` 下方新增「容器管理」区块：
- 表格展示 `GET /v1/admin/containers`（用户 ID、容器状态、忙碌标记、启动时间），每行提供「重建」按钮（复用同一接口，`force` 由全局勾选决定）；
- 「重建全部」按钮 + 勾选「包括正在运行任务的容器」（默认不勾选 = 跳过 busy）；
- 执行时逐条调用，展示进度（x/N）与结果汇总（成功 / 跳过 / 失败），失败项可点击重试；
- 顶部 Alert 说明重建的中断影响与耗时。

#### 4.11.4 边界与异常

| 场景 | 行为 |
|---|---|
| 在册容器为 `stopped` | 同样重建（否则 `docker start` 会沿用旧 `--add-host`） |
| 后端重启后 entries 为空、宿主机仍有残留容器 | 返回 `none`；该用户下次使用时由 `createAndStart` 的同名冲突清理路径自动替换（既有机制） |
| 重建时 docker 异常 | 返回 `failed` + 错误摘要；条目走既有 `cleanupFailedStart` 清理，下次自动重建 |
| 与自动重建并发 | 共用 per-user 串行锁，串行执行，不重复重建 |
| 全部重建耗时长 | 前端串行编排，避免单请求超时；容器数量多时提示预计耗时 |

---

## 5. 改动清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `backend-ts/db/migration/V176__container_hosts_injection.sql` | 新增 | 两条 `system_setting` 行（开关 + 自定义规则） |
| `backend-ts/src/harness/container/container-hosts-resolver.ts` | 新增 | hosts 解析/过滤/合并/指纹 + TTL 缓存 + 降级 |
| `backend-ts/src/harness/container/container-hosts-resolver.spec.ts` | 新增 | 纯函数与 resolver 单测 |
| `backend-ts/src/harness/container/container-registry.ts` | 修改 | ① `resolveHostsInjection` opts、`--add-host` 注入、`hostsFingerprint` 与漂移重建；② `listEntries()` / `recycleUser()`（复用 `withUserLock` + `rebuildEntry`） |
| `backend-ts/src/harness/container/container-registry.spec.ts` | 修改 | 断言 run 参数含 `--add-host`；指纹漂移触发重建 |
| `backend-ts/src/settings/settings.service.ts` | 修改 | 两个 key 常量、`getContainerExtraHosts()` / `isInheritHostHostsEnabled()`、`validateValue` 分支 |
| `backend-ts/src/settings/settings.routes.ts` | 修改 | `GET /v1/system-settings/container-hosts/preview`（`settings:read`） |
| `backend-ts/src/settings/settings.service.spec.ts`（或新增 spec） | 修改 | 校验分支用例 |
| `backend-ts/src/app-container-runtime.ts` | 修改 | 创建 `ContainerHostsResolver`，注入 `ContainerRegistry` opts 与预览 deps |
| `backend-ts/src/app-routes.ts` | 修改 | `afterSave` 中命中两个 key 时 `hostsResolver.invalidate()` |
| `admin/src/views/settings/components/ContainerHostsPanel.vue` | 新增 | 开关 + 生效条目只读预览 + 自定义规则编辑 |
| `admin/src/views/settings/containerHosts.ts` | 新增 | 前端同口径校验（host/ip/保留段/数量/重复） |
| `admin/src/views/settings/SystemSettingsView.vue` | 修改 | 类型 union、TOC 声明、渲染分支、label 映射 |
| `backend-ts/db/migration/V177__container_manage_permission.sql` | 新增 | `container:manage` 权限 + 授予管理员角色（参照 V118） |
| `backend-ts/src/harness/container/container-admin.routes.ts` | 新增 | `GET /v1/admin/containers`（在册容器列表） |
| `backend-ts/src/user/user.routes.ts` | 修改 | `POST /v1/users/:id/container/recycle`（单用户重建） |
| `admin/src/views/user/UserDetailDrawer.vue` | 修改 | 用户详情「重建容器」按钮 + 确认弹窗 + 结果提示 |
| `admin/src/api/index.ts` | 修改 | 容器列表 / 单用户重建两个接口封装 |
| `CHANGELOG.md` | 修改 | 0.0.391 一条用户可见变更 |
| `docs/plan/2026-10-31-container-hosts-injection.md` | 新增 | 本文档 |

## 6. 测试计划

### 6.1 单元测试

**resolver（新增 spec）**

- `parseHostsFile`：注释/空行/同行多 host/`#` 行内注释/IPv6 行/畸形行/超长行
- 过滤：`127.0.0.0/8`、`localhost`/`ip6-*` 等保留名、非法 host
- `mergeHostsEntries`：自定义覆盖同名、开关关闭、双空、排序稳定
- `hostsFingerprint`：顺序无关稳定性、内容变化时变化
- 降级：`readHostsFile` 抛错 → 返回自定义条目 + 不抛异常

**container-registry（扩展）**

- `createAndStart` 的 run 参数含 `--add-host host:ip`（fakeDocker 记录 args）
- 无配置时 args 不含 `--add-host`
- `hostsFingerprint` 漂移 → `rebuildEntry` 路径被触发（重建时 docker 调用序列含 stop/rm/run）
- 旧条目无指纹且期望为空 → 不触发重建
- 指纹一致 → running 直接复用 / stopped 走 `docker start`
- `recycleUser`：无在册条目 → `none`；忙碌且 `force=false` → `skipped-busy`；`force=true` → 执行重建；docker 异常 → `failed` 且不抛出
- `listEntries`：返回在册条目快照与 `busy` 标记，不包含敏感字段

**settings（扩展）**

- `validateValue`：合法条目、非法 host、非法 IP、`127.x`、`169.254.169.254`、超 50 条、重复 host、超 8KB
- 预览路由：返回结构、`settings:read` 权限、读取失败时 `hostsFileError` 非空

### 6.2 手动验收（用 prometheus 场景）

1. 宿主机执行 `getent hosts prometheus.acg.team`，记为可达 IP（`IP_OK`）；
2. 部署后端：`cd /data && bash deploy-mao.sh --backend-only`（Flyway 自动执行 V176 / V177）；
3. 管理后台「系统设置 → 运行环境 → 容器域名解析」：确认继承开关为开，预览表中能看到宿主机条目；
4. 在「用户管理 → 用户详情」点「重建容器」（或「容器管理 → 重建全部」），返回 `rebuilt`；
5. 容器内验证：`getent hosts prometheus.acg.team` → `IP_OK`；`curl -s http://prometheus.acg.team/-/healthy` → 200；
6. 后台新增自定义规则覆盖同名域名 → 重建 → 容器内解析取自定义值；
7. 关闭继承开关 → 重建 → 条目消失、恢复 DNS 解析结果（回归验证）；
8. busy 保护：在容器内执行一条长命令，点「重建」（不勾强制）→ 应返回 `skipped-busy`；勾选强制后 → `rebuilt`；
9. 权限：无 `container:manage` 的账号不显示重建按钮，直接调接口返回 403。

### 6.3 回归风险点

- 容器创建 args 变更：跑 `container-registry`、`docker-tool-router`、`container-tool-executor` 全量单测；
- 首次上线启用继承时，存量容器会因"无指纹 + 期望非空"各重建一次，发布窗口内注意容器重建日志；
- `docker start` 复用路径新增异步判定（resolver 调用），确认未引入锁内长耗时（缓存命中为内存操作）；
- 重建接口与 `ensureRunning` 的并发：`recycleUser` 必须走 `withUserLock`（与自动重建同一把锁），并补一条并发回归用例（重建期间触发一次容器工具调用）。

## 7. 风险与边界

1. **只改解析、不改连通**：目标 IP 本身从容器不可达时仍然失败（本方案不替代网络策略/安全组）。
2. **生效即重建**：配置变更会导致该用户容器重建，中断容器内 shell/终端/在途任务；后台文案必须明示。
3. **权限与安全**：配置读写走 `settings:write`；容器重建走新增的 `container:manage`（默认仅授予管理员角色）。本质是"管理员可控地为容器改 hosts"，已硬禁环回与云元数据地址，host/ip 强校验，args 数组传参无 shell 注入面。
4. **部署前提**：后端进程必须与容器运行在同一宿主机（读的是后端所在机器的 `/etc/hosts`）；若后端将来容器化部署，需重新定义"宿主 hosts"的语义。
5. **版本要求**：`--add-host` 需 Docker ≥ 17.09（现网满足）。
6. **IPv6 暂不支持**：宿主机 hosts 的 IPv6 行会被忽略。
7. **内置条目冲突**：`localhost` 系列已在校验中禁止，避免覆盖容器自身语义。

## 8. 实施顺序与工作量

| 步骤 | 内容 | 预估 |
|---|---|---|
| 1 | V176 迁移 + settings key/校验/getter | 0.25 人日 |
| 2 | hosts 解析/合并/指纹 resolver + 单测 | 0.25 人日 |
| 3 | ContainerRegistry 注入与指纹重建 + 单测 | 0.25 人日 |
| 4 | 装配（app-container-runtime / app-routes）+ 预览 API | 0.25 人日 |
| 5 | 前端面板 + 校验 | 0.5 人日 |
| 6 | 容器重建：V177 权限 + registry 方法 + 两个接口 + 用户详情/容器管理 UI | 0.5 人日 |
| 7 | 联调、手动验收、CHANGELOG | 0.25 人日 |

合计约 **1.5–2 人日**（不含评审与发布窗口）。

## 9. 决策记录与开放问题

**已确认（2026-10-31）**

1. 开关默认值：`true`（V176 按此值写入）。
2. 本期不支持 IPv6 条目（宿主机 hosts 的 IPv6 行直接忽略）。
3. 「立即重建」两个入口都做：单用户重建（用户管理页）+ 重建全部（系统设置「容器管理」区块），见 4.11。
4. 审计：两个重建接口分别挂在 `/v1/users`、`/v1/admin` 前缀下，由既有审计拦截器自动留痕；设置变更走 `/v1/system-settings` 前缀，同样已覆盖，无需新增审计代码。

**待确认**

5. 「重建全部」跳过 busy 容器后是否需要补偿机制（例如空闲后自动重建一次）——当前设计为"跳过即不处理"，依赖 4.7 的惰性重建在下次使用时兜底。

