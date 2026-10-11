# 信号哨兵（signal-watcher）

## 模块职责

按固定间隔由后端主动探测外部 HTTP(S) 接口，判定值发生变化时**新建一次 Agent 会话**并把变化摘要交给 Agent 处理。适合「有变化才需要处理」的场景：汇率、库存、发布状态、接口健康度、竞品页面更新等。

与开放接口的分工：Webhook 触发器是「外部推事件进来」，信号哨兵是「Mao 主动出去看」，两者都会新建会话，但哨兵没有公开 URL、不需要对方配合。

管理面在桌面端「设置 → 信号哨兵」自助完成；管理后台（`signal:read` 权限）只提供只读清单。全部接口只接受登录会话（JWT），且只能操作本人数据（决策 15）。

## 核心规则

| 项 | 规则 |
|----|------|
| 探测方式 | 后端主动出站，`node:http/https`，不跟随重定向（3xx 判失败），连接超时 10s / 读取超时 15s，响应体上限 1MB |
| 地址限制 | 仅 `http`/`https`，禁止内嵌凭据（`user:pass@host`），禁止私网 / 回环 / 保留地址（复用 `common/ssrf.ts` 判定）；**不做管理员放行配置** |
| 判定模式 | `HASH`（整体内容哈希）/ `JSON_FIELD`（点分路径提取，支持数组下标，如 `data.list.0.price`）/ `STATUS_CODE`（HTTP 状态码） |
| 提示词模板 | 支持 `{name}` `{url}` `{diff}` 占位；`{diff}` 为旧 / 新值各截断 500 字的文本对比（不做行级 diff） |
| 触发方式 | 每次触发**新建会话**，不复用会话（决策 5）；消息来源标记为 `SIGNAL` |
| 频次上限 | 同一哨兵每小时最多 4 次触发；**超出仍照常触发**，仅在轮询记录上打 `TRIGGER_RATE_LIMITED` warning，不计失败（决策 7） |
| 自动停用 | 连续失败 5 次自动停用（`DISABLED`），并在收件箱推送「哨兵已停用」；停用后只能用户手动重新启用 |
| 失败退避 | `间隔 × min(2^连续失败次数, 32)` 分钟，任一次成功后清零 |
| 数量 / 间隔 | 每用户最多 20 个；间隔 1~1440 分钟（整数） |
| 基线重置 | 编辑 url / method / headers / body / compareMode / jsonPath 会重置基线（下次轮询只建基线不触发）；改名称、间隔、提示词不影响基线 |
| 保留天数 | 轮询记录保留 `signal.checkRetentionDays` 天（默认 90，管理后台可改） |
| 敏感数据 | 请求头与请求体整体 AES-GCM 加密（密钥 `APP_SIGNAL_SECRET`），列表 / 详情回显时敏感请求头打码为 `******`，body 只回长度 |

## 端点

用户级（登录态，本人数据）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/signal-watchers` | 我的哨兵列表（脱敏） |
| POST | `/v1/signal-watchers` | 新建 |
| GET | `/v1/signal-watchers/:id` | 详情（脱敏） |
| PUT | `/v1/signal-watchers/:id` | 编辑；命中判定字段则重置基线 |
| DELETE | `/v1/signal-watchers/:id` | 删除（级联删轮询记录，已产生的会话不删） |
| POST | `/v1/signal-watchers/:id/status` | 启停，body `{ "status": "ACTIVE" \| "PAUSED" }`；`DISABLED → ACTIVE` 时清零失败并重置基线 |
| GET | `/v1/signal-watchers/:id/checks` | 轮询记录分页（`page` / `size`，默认 20，上限 100） |
| POST | `/v1/signal-watchers/:id/test` | 立即执行一次探针，返回判定预览；**不触发、不写库** |

管理级（只读）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/admin/signal-watchers` | 全站分页清单，筛选 `status` / `userId` / `compareMode`，需 `signal:read` 权限 |

## 轮询记录字段

| 字段 | 含义 |
|------|------|
| `httpStatus` | 探针 HTTP 状态码（探针失败时为 null） |
| `valueHash` | 本次判定值哈希（判定失败时为 null） |
| `changed` | 1 = 与上次判定值不同 |
| `triggeredSessionId` | 本次变化触发新建的会话 ID |
| `error` | 失败原因（已脱敏，只含错误码，不含目标 URL） |
| `warning` | 非失败告警，当前仅 `TRIGGER_RATE_LIMITED` |
| `durationMs` | 探针耗时 |

## 常见排障

- **哨兵一直不触发**：首轮轮询只建基线不触发；确认 `lastCheckedAt` 有更新说明调度正常。
- **连续失败后停用**：看轮询记录里的 `error`；常见为地址不可达、私网地址被拒、`JSON_FIELD` 路径写错（判定失败也计入连败）。
- **重新启用后仍不触发**：`DISABLED → ACTIVE` 会重置基线，需再一次变化才会触发（符合预期）。
- **提示词里看不到旧值**：`{diff}` 依赖上次判定值片段，基线刚重置后的首次变化旧值侧为空。
