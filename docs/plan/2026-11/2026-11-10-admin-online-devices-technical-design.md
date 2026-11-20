# 管理后台在线设备（实时 WS 连接）查看技术方案

- 状态：草案（2026-11-10，待评审；待确认项见 §10）
- 日期：2026-11-10
- 关联方案：
  - [2026-11-05-local-task-device-delegation-technical-design.md](./2026-11-05-local-task-device-delegation-technical-design.md)（deviceId 设备身份、`deviceExecutors` 索引与设备自报帧的由来）
  - [2026-11-06-multi-end-approval-technical-design.md](./2026-11-06-multi-end-approval-technical-design.md)（WS 客户端类型、能力协商与多端审批广播）
  - [2026-11-06-admin-session-activity-window-technical-design.md](./2026-11-06-admin-session-activity-window-technical-design.md)（管理后台会话活动窗口；本方案是「连接实时态」，与其「会话历史活动」互补）

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 在线 / 连接 | WS `/api/ws/stream` 认证成功后仍存活的连接（`streaming-ws-registry.ts` `userSessions` 登记的每一条 socket） |
| 客户端类型 clientType | 服务端归一化后的取值，契约 `shared/contracts/src/ws.ts` 的 `WsClientType`：`electron` / `android` / `cli` / `browser` / `embed` |
| 设备信息 `WsDeviceInfo` | LOCAL 执行端（electron / cli）在 WS auth 帧自报的 `{ id, name, platform }`，来自 `~/.mao/agent-cli/device.json`（同机桌面端与 CLI 共用同一 deviceId） |
| 去重设备数 | 按 `(userId, deviceId)` 去重后的 LOCAL 端设备数 + android 连接数（android 不自报 deviceId，见 §6.2）；browser / embed 不计入设备数（无设备标识，多开即多连接） |

## 1. 需求背景

管理员希望在管理后台查看**当前在线设备**：哪些端（Mao agent CLI、桌面客户端、Web、安卓 App）在线、各类型数量、按用户的列表。

### 1.1 现状：无对外查询口，但底层数据已齐全

管理后台现有约 20 个页面（`admin/src/router/index.ts:28-154`）均无在线设备/在线用户内容；后端也没有对外的在线查询接口。但 WS 层已经实时维护了全部在线状态，且内部逻辑已在消费：

| 消费点 | 位置 | 用途 |
|---|---|---|
| 用户级在线判定 | `streaming-ws-registry.ts` `hasConnection(userId)`（`harness/tool/tool-dispatcher.ts:505` 调用） | 审批升级延迟（用户在线则等 WS 放行，离线直接升级飞书卡片） |
| 目标设备在线判定 | `streaming-ws-registry.ts` `hasDeviceConnection` / `getDevice`（`session/session.routes.ts:70` 附近，session VO 的 `targetDeviceOnline` 快照，`session-vo.ts:36`） | LOCAL 会话目标设备是否在线 |
| 设备定向投递 | `sendToDevice` / `sendToDeviceFamily`（`streaming-ws-registry.ts:416-458`） | LOCAL 执行、多端审批放行信号 |

这些查询都只服务于内部逻辑，没有面向管理后台的枚举接口。

### 1.2 数据底座：registry 内存态一览

五端共用同一条 WS `/api/ws/stream`，认证成功后 `StreamingWsRegistry`（`backend-ts/src/session/ws/streaming-ws-registry.ts`）登记以下内存映射（均为 `streaming-ws-registry.ts:105-131` 附近字段）：

| 映射 | 内容 | 本方案用途 |
|---|---|---|
| `userSessions: Map<userId, Set<WsSocket>>` | **全部**在线连接（含 browser/android/embed） | 连接枚举主体 |
| `sessionToUser: Map<socketId, userId>` | 连接归属用户 | 快照归属 |
| `sessionToClientType: Map<socketId, clientType>` | 归一化客户端类型（`normalizeClientType`，`:716-722`，与 handler `normalizeClient` 同集） | 类型列 |
| `connectionAuth: Map<socketId, ConnectionAuth>` | 认证元数据 `{ userId, authSource?, expiresAt }` | 认证来源/到期展示 |
| `connectionDevice: Map<socketId, WsDeviceInfo>` | 自报设备信息（仅 LOCAL capable 且字段合法） | 设备列 |
| `deviceExecutors: Map<userId, Map<deviceId, WsSocket>>` | 当前执行连接（同设备覆盖为最新） | 设备去重参考 |

各端自报 clientType 的代码位置：

| 端 | clientType | 自报位置 |
|---|---|---|
| 桌面 Electron | `electron` | `desktop/src/utils/platform.ts:15-20` `clientKind()` → `useStreamWS.ts:253-271` auth 帧 `{ client, device? }` |
| 安卓 App（Capacitor 壳远程加载） | `android` | 同上 `clientKind()`（`isAndroidCapacitor()` 分支） |
| 桌面 Web 版 / 任意浏览器 | `browser` | 同上 `clientKind()` 兜底分支；服务端缺省也归 `browser`（`streaming-ws-handler.ts:2692-2697`） |
| mao-agent 终端 CLI | `cli` | agent-cli 连接时 auth 帧自报，与桌面端共用 `~/.mao/agent-cli/device.json` 设备身份 |
| sdk/embed 页面嵌入 | `embed` | embed SDK auth 帧 |

设备帧校验：`streaming-ws-handler.ts:2788-2799` `parseDevice()`（id ≤ 64、name ≤ 128、platform ≤ 32，任一缺失/超长整帧设备信息丢弃）。

### 1.3 缺口

1. registry **不记录连接建立时间**（无 `connectedAt`），无法展示连接时长；
2. 无对外枚举接口（现有查询均为按 userId/deviceId 的点查）；
3. registry 只有 userId，列表需补 username / displayName（查 `user` 表）。

## 2. 方案总览

纯内存实时快照，**零新增表、零历史记录、零迁移**：

| 层 | 改动 |
|---|---|
| WS registry | register 时记 `connectedAt`；新增只读方法 `listConnections()` 返回全量连接快照 |
| 契约 | `shared/contracts/src/statistics.ts` 新增响应 VO 类型（`clientType` 复用既有 `WsClientType`） |
| 后端 REST | `statistics` 域新增 `GET /v1/statistics/online-devices`，权限复用 `analytics:read` |
| admin 前端 | 新页面 `/online-devices`（菜单「在线设备」），统计卡 + 用户分组表格，15s 轮询 + 手动刷新 |

不改动：desktop / android / agent-cli / sdk 各端（auth 帧不动）、DB、部署脚本、OTA。

## 3. 后端设计

### 3.1 registry 改动（`streaming-ws-registry.ts`）

**新增字段**（生命周期与 `connectionDevice` 完全对齐）：

```ts
/** socket.id → 连接建立（首次 auth 成功 register）时间，epoch ms。 */
private readonly connectionConnectedAt = new Map<string, number>();
```

- `register()`（`:153-194`）：登记 `connectionConnectedAt.set(session.id, Date.now())`；
- `unregister()`（`:196-221`）：`connectionConnectedAt.delete(session.id)`；
- 同一 socket 重复 auth / 重连注册时 `register` 会重入：以最后一次 register 时间为准（重连即刷新，符合「当前连接已持续时长」直觉）。

**新增只读快照方法**：

```ts
export interface WsConnectionSnapshot {
  wsSessionId: string;
  userId: number;
  clientType: WsClientType;
  connectedAt: number;
  authExpiresAt: number | null;
  authSource: string | null;
  device: WsDeviceInfo | null;
}

/** 全量在线连接只读快照（管理后台在线设备页用）。迭代内部 Map，不产生关连副作用。 */
listConnections(): WsConnectionSnapshot[];
```

实现要点：

- 迭代 `userSessions`（userId → Set\<WsSocket\>），逐 socket 读 `sessionToClientType` / `connectionDevice` / `connectionAuth` / `connectionConnectedAt`，拼装快照；
- **纯只读**：不调用 `isConnectionAuthorized()`（它对过期 company_sso 连接有「顺手 close」副作用，`:250-259` 附近）。过期未关连接照常出现在快照里，由既有惰性关闭机制（下一帧收发时关闭）兜底，见 §6.5；
- `device` 字段直接取 `connectionDevice`（含同机多窗口的「非执行连接」）；**不做** deviceExecutors 级别的覆盖——列表页要看到同设备的多条连接，去重口径留给聚合层（§4.3）。

### 3.2 契约类型（`shared/contracts/src/statistics.ts` 新建）

沿用「类型下沉契约、前端汉化表吃编译期穷尽」的既有规范（先例：`usage.ts` 的 `LlmCallScene`）：

```ts
import type { WsClientType } from './ws.js';

/** 单条在线 WS 连接快照 */
export interface OnlineDeviceConnection {
  wsSessionId: string;
  clientType: WsClientType;
  /** epoch ms；前端计算连接时长 */
  connectedAt: number;
  /** epoch ms | null；company_sso 有过期时间，本地密码登录为 null */
  authExpiresAt: number | null;
  authSource: string | null;
  /** 仅 electron / cli 自报；android / browser / embed 为 null */
  device: { id: string; name: string; platform: string } | null;
}

/** GET /v1/statistics/online-devices 响应 data */
export interface OnlineDevicesVo {
  total: { connections: number; users: number; devices: number };
  byClientType: Record<WsClientType, number>;
  users: Array<{
    userId: number;
    username: string;
    displayName: string | null;
    connections: OnlineDeviceConnection[];
  }>;
}
```

`byClientType` 用 `Record<WsClientType, number>` 穷尽声明——`WsClientType` 联合扩张（如未来 android 上报 device、新增类型）时 admin 汉化表与该 Record 都会被 tsc 逼着同步。

### 3.3 统计服务与路由

**Service**（`backend-ts/src/statistics/statistics.service.ts`）：

```ts
export interface WsRegistrySnapshot {
  listConnections(): WsConnectionSnapshot[];
}

export class StatisticsService {
  constructor(store: StatisticsStore, wsRegistry?: WsRegistrySnapshot)

  async getOnlineDevices(): Promise<OnlineDevicesVo>
}
```

- 依赖用**结构化接口** `WsRegistrySnapshot` 注入，statistics 域不 import session/ws 的类实现（registry 与 service 无循环依赖；测试注入假 registry 即可）；
- username / displayName：复用既有 `StatisticsStore.listUsers()`（`statistics.service.ts:25`，`UserRow` 见 `domain/types.ts:81-88`）按 userId 建 Map；已删除用户（`listUsers` 已过滤 `deleted=0`）的连接归入 `username: '(已删除用户)'` 占位展示，不丢连接；
- `wsRegistry` 缺省（feishu-handler 等内部构造场景未传）时 `getOnlineDevices` 返回空快照，行为等同「无人在线」，不抛错。

**组装**：`create-app.ts:673` 的 `wsRegistry` 实例传入 `app-feishu-handler.ts:546` 的 `new StatisticsService(new StatisticsDbStore(db))` 处（create-app 汇总入参），链路 `create-app.ts:918 → app-routes.ts:971 → :627 registerStatisticsRoutes` 不变。

**Route**（`backend-ts/src/statistics/statistics.routes.ts`，与既有 4 个统计端点同模式）：

```ts
app.get('/v1/statistics/online-devices', async (req, reply) => {
  await requireRequestPermission(deps.permissionService, req, 'analytics:read');
  sendJson(reply, 200, ok(await deps.statistics.getOnlineDevices()));
});
```

响应经 `ok()` 包为 `Result<OnlineDevicesVo>`（`code=0`）。

### 3.4 权限决策（D1）：复用 `analytics:read`

- 复用理由：敏感度与既有 `/v1/statistics/users`（按用户列会话数/用量）相当；零迁移、零权限目录改动、既有角色立即生效；「在线设备」语义上属于运营监控/分析域。
- 备选：新增 `device:read` 权限码——需仿 `V121__admin_permission_catalog.sql` 新增迁移 + 角色种子 + admin 路由/菜单权限串同步，成本明显更高。默认取复用；如评审认为设备名/平台属独立敏感域，改走备选（仅影响本节与路由一处字符串 + 一条迁移）。

## 4. 统计口径（§6 前置，独立成节便于评审）

| 指标 | 口径 |
|---|---|
| 连接数 `total.connections` | `userSessions` 全量连接数（五端全部计入，含同用户多端/多标签） |
| 在线用户数 `total.users` | 有 ≥1 条存活连接的去重 userId 数 |
| 去重设备数 `total.devices` | electron/cli 连接按 `(userId, deviceId)` 去重计数（来源 `connectionDevice`，含同机多窗口的非执行连接）＋ android 连接逐条计数（无 deviceId） |
| `byClientType` | 按 clientType 分组的连接数，五类穷尽 |

「在线」**只指 WS 连接存活**：断线即离线，无宽限期；无历史在线记录（历史在线/时段留存为后续可选项，见 §10-D4）。

## 5. admin 前端设计

### 5.1 路由与菜单

| 改动点 | 内容 |
|---|---|
| `admin/src/router/index.ts` | 新增 `path: 'online-devices'`，`meta: { title: '在线设备', keepAlive: true, permission: 'analytics:read' }`（与相邻页面同构） |
| `admin/src/utils/menuNav.ts:44-49` | overview 组（现有仅「用量分析」一项）追加 `{ index: '/online-devices', label: '在线设备', icon: Cellphone, permission: 'analytics:read' }`；icon 不与既有项重复（`Monitor` 已被 Agent 管理占用） |
| 菜单可见性 | 新页面默认可见；运维可用既有「菜单隐藏」配置（`V182__admin_menu_visibility.sql` + `admin/src/stores/menu.ts`）隐藏，无需改动 |
| 联动检查 | `admin/src/utils/home.ts`（首页降级链消费 menuGroups）与 `menuNav.spec.ts` 若含菜单项穷尽断言，需同步补一条 |

### 5.2 页面（`admin/src/views/statistics/OnlineDevicesView.vue`）

- **顶部统计卡**：连接数 / 在线用户数 / 去重设备数，以及按 clientType 的分组计数；
- **主表**（按用户分组，组内连接子表或展开行）：

| 列 | 来源 | 说明 |
|---|---|---|
| 用户 | `username` + `displayName` | displayName 为空只显 username |
| 客户端类型 | `clientType` | el-tag，文案走汉化表（§5.3） |
| 设备名 | `device?.name` | 仅 electron/cli 有；无则 `-` |
| 平台 | `device?.platform` | win32 / darwin / linux |
| 设备 ID | `device?.id` | 截断展示 + 一键复制（超长 id） |
| 连接时长 | `Date.now() - connectedAt` | 前端格式化（「3 分钟」「1 小时 02 分」）；渲染时基于页面加载时刻即可，随轮询自然刷新 |
| 认证到期 | `authExpiresAt` | JWT exp，所有连接都有值（实现核实后修正：设计初稿误记「仅 company_sso 有值」） |
| 来源 | `authSource` | 仅非空时展示（company_sso；本地登录为空显示 `-`） |

- **刷新**：`setInterval` 15s 自动刷新 + 手动刷新按钮 + 「最后更新时间」显示；`onActivated`/`onDeactivated`（keepAlive）与 `onUnmounted` 严格清理定时器；请求失败静默保留旧数据（`skipErrorToast` 由页面自行提示，避免轮询噪音）；
- 无人在线时展示空态（管理员自己不连 WS，`/api/ws/stream` 仅业务端连接，见 §6.4）。

### 5.3 汉化表（规范强制）

新建 `admin/src/utils/wsClientTypeLabels.ts`：

```ts
import type { WsClientType } from '@mao/contracts'

const WS_CLIENT_TYPE_LABELS: Record<WsClientType, string> = {
  electron: '桌面客户端',
  android: '安卓 App',
  cli: '终端 CLI',
  browser: '浏览器 (Web)',
  embed: '页面嵌入'
}
```

`Record<WsClientType, string>` 穷尽声明吃编译期检查（与 `llmCallLabels.ts` 同一模式）；契约侧 `WsClientType` 联合若扩张，此处 tsc 立即报错。

## 6. 边界与风险

### 6.1 连接数 ≠ 设备数（口径明示）

| clientType | 去重 | 说明 |
|---|---|---|
| electron | 按 deviceId | 同机多窗口 / 多实例多条连接、同 deviceId，去重为 1 台 |
| cli | 按 deviceId | 同机桌面端与 CLI 共用 `device.json`，两进程两条连接算同一台设备 |
| android | 不去重 | 每条连接算一台（Capacitor 壳单实例，基本 1:1；未自报 device） |
| browser | 不去重、**不计入设备数** | 多开一个标签页即多一条连接；Web 端无设备指纹（device 只在 LOCAL 端自报） |
| embed | 不去重、**不计入设备数** | 页面嵌入连接，随宿主页面开关 |

统计卡必须同时展示「连接数」与「去重设备数」两个数字，避免管理员拿浏览器连接数当设备数。

### 6.2 android / browser 不自报设备（D5，本期不做）

`WsAuthFrame.device` 目前仅 electron / cli 发送（`LOCAL_CAPABLE_CLIENTS` 索引也只认这两类，`streaming-ws-registry.ts:20`）。若要 android 也上报 `{id, name, platform}`，需动 auth 帧契约并同步 desktop / agent-cli / sdk 四端序列化 + registry 登记条件，收益仅是「安卓设备去重与命名」。列为后续可选，本期 android 逐条计数。

### 6.3 单实例约束

快照是**本进程内存态**。生产当前为单实例后端（:9080），成立；若未来水平扩容，本接口只反映接收该请求的节点，需引入跨实例汇聚（Redis pub/sub 或粘性路由）——本期明确不支持，注释与文档注明。

### 6.4 管理后台自身不在快照中

admin 后台纯 REST（`admin/src/api/index.ts` axios），不连 `/api/ws/stream`，管理员打开本页面不会把自己算进在线设备。

### 6.5 过期未关连接

company_sso 连接过期后由 `isConnectionAuthorized()` 在**下一次收发**时惰性关闭（`streaming-ws-registry.ts:250-259`）；快照不触发该副作用，因此可能短暂出现「认证已过期但仍在列表」的连接。展示 `authExpiresAt` 即可自查；不在此清理是为了保持读路径纯只读（清理引发的 close 事件顺序不可控）。

### 6.6 性能与规模

快照为单次 O(n) 内存遍历（n = 在线连接数，百级以内），15s 轮询一个 admin 页面，无 DB 查询以外的放大（`listUsers()` 一次全量用户表，既有 `listUsers` 已按 `deleted=0` 过滤，规模 = 注册用户数）。无风险。

## 7. 测试

| 层 | 用例 |
|---|---|
| `streaming-ws-registry.spec.ts` | ① register 后 `listConnections()` 返回完整字段（clientType/device/connectedAt/authExpiresAt）；② unregister 后不再出现，`connectedAt` 清理无泄漏；③ 同 socket 重复 register 刷新 connectedAt；④ 同机多窗口两条连接同 deviceId 均出现在快照；⑤ browser/android/embed 连接 `device=null`；⑥ 过期 SSO 连接出现在快照（不被读路径关闭） |
| `statistics.service.spec.ts` | ① 假 registry → VO 聚合正确（total 三值、byClientType 五类穷尽、devices 去重口径）；② username 映射、已删除用户占位；③ 未注入 registry 返回空快照不抛错 |
| `statistics.routes.ts`（既有 routes spec 模式） | ① 无权限 403；② `analytics:read` 通过返回 `code=0` |
| admin（`menuNav.spec.ts` / 视图单测若有） | 菜单穷尽断言同步；汉化表 Record 穷尽由 tsc 保证 |
| Playwright（可选，D6） | admin 登录 → 打开「在线设备」断言页面可见 + 空态；不断言具体连接数（E2E 桌面登录链路是否建 WS 与用例编排相关，避免脆弱） |

命令：`cd backend-ts && npm test > /tmp/x.log 2>&1; echo exit=$?`（grep 摘要）；admin 验证 `cd admin && npm run build`（`vue-tsc -b && vite build`，勿用 `npx vue-tsc --noEmit` 假通过）。

## 8. 实施清单

| 文件 | 改动 |
|---|---|
| `backend-ts/src/session/ws/streaming-ws-registry.ts` | `connectionConnectedAt` 字段 + register/unregister 生命周期 + `listConnections()` |
| `backend-ts/src/session/ws/streaming-ws-registry.spec.ts` | §7 用例 |
| `shared/contracts/src/statistics.ts` | 新建：`OnlineDeviceConnection` / `OnlineDevicesVo`；`index.ts` 导出 |
| `backend-ts/src/statistics/statistics.service.ts` | `WsRegistrySnapshot` 接口 + 可选依赖注入 + `getOnlineDevices()` |
| `backend-ts/src/statistics/statistics.service.spec.ts` | §7 用例 |
| `backend-ts/src/statistics/statistics.routes.ts` | `GET /v1/statistics/online-devices` |
| `backend-ts/src/app-feishu-handler.ts`（`:546` 构造处，入参由 `create-app.ts` 汇总传入） | `StatisticsService` 构造注入 `wsRegistry` |
| `admin/src/utils/wsClientTypeLabels.ts` | 新建：`Record<WsClientType, string>` 汉化表 |
| `admin/src/views/statistics/OnlineDevicesView.vue` | 新建页面（统计卡 + 分组表格 + 轮询） |
| `admin/src/router/index.ts` | `/online-devices` 路由 |
| `admin/src/utils/menuNav.ts` | overview 组菜单项 |
| `admin/src/utils/menuNav.spec.ts` / `home.ts` | 菜单穷尽断言 / 首页降级链同步 |
| `CHANGELOG.md` | 顶部新版本 `admin` 小节：「管理后台新增在线设备页（实时 WS 连接数/列表，15s 刷新）」 |
| `README.md` | 功能清单/管理后台段落补一句（如有对应段落） |

无 DB 迁移、无 desktop/android/agent-cli/sdk 改动、无 OTA。

## 9. 发布

常规后端 + admin 发版：`backend-ts` 部署重启（无迁移步骤），`bash scripts/deploy-admin.sh`（admin 前端 rsync，无需重启）。前端刷新即可见（`version.json` 机制）。

## 10. 待确认项

| # | 事项 | 默认方案 |
|---|---|---|
| D1 | 权限码：复用 `analytics:read` vs 新增 `device:read` | 复用（§3.4） |
| D2 | 页面形态：独立菜单页 vs 「用量分析」内新增 Tab | 独立菜单页（实时轮询页与历史分析页混在一 Tab 容器里会互相干扰 keepAlive/定时器） |
| D3 | 轮询间隔 | 15s（可调；不做 WS 推送——admin 不连业务 WS，为此单开管理 WS 通道不值得） |
| D4 | 是否需要历史在线记录（时段留存、在线时长报表） | 本期不做（需新表 + 上报链路，另行立项） |
| D5 | android/browser 是否上报 device 实现设备去重 | 后续可选（§6.2，动 auth 帧契约四端同步） |
| D6 | Playwright 冒烟是否纳入 | 视 e2e 编排成本决定，非阻塞 |
