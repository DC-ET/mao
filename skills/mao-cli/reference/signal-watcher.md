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
| 触发方式 | `NEW_SESSION`（默认）每次触发**新建会话**；`REUSE_SESSION` **复用自己的会话**——首次触发自动建一个专属会话，之后每次变化都接着聊（上下文持续累积）。复用的会话 id 由服务端维护，前端只选模式、不选会话 |
| 频次上限 | 同一哨兵每小时最多 4 次触发；**超出仍照常触发**，仅在轮询记录上打 `TRIGGER_RATE_LIMITED` warning，不计失败（决策 7） |
| 自动停用 | 连续失败 5 次自动停用（`DISABLED`），并在收件箱推送「哨兵已停用」；停用后只能用户手动重新启用 |
| 失败退避 | `间隔 × min(2^连续失败次数, 32)` 分钟，任一次成功后清零 |
| 数量 / 间隔 | 每用户哨兵数量**无上限**（0.0.361 取消原 20 个限制）；间隔 1~1440 分钟（整数） |
| 基线重置 | 编辑 url / method / headers / body / compareMode / jsonPath 会重置基线（下次轮询只建基线不触发）；改名称、间隔、提示词不影响基线 |
| 保留天数 | 轮询记录保留 `signal.checkRetentionDays` 天（默认 90，管理后台可改） |
| 敏感数据 | 请求头与请求体整体 AES-GCM 加密（密钥 `APP_SIGNAL_SECRET`），列表 / 详情回显时敏感请求头打码为 `******`，body 只回长度 |

## 端点

用户级（登录态，本人数据）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/signal-watchers` | 我的哨兵列表（脱敏） |
| POST | `/v1/signal-watchers` | 新建；body 支持 `triggerMode`（`NEW_SESSION` 默认 / `REUSE_SESSION`）与 `copyFrom`（源哨兵 id，敏感请求头与请求体由后端从源行解密继承，前端不接触明文） |
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

## CLI 用法（mao-cli）

全部命令走用户级登录态（JWT），操作本人哨兵，不需要管理权限；`admin-list` 为管理端只读清单，需 `signal:read`。

| 命令 | 端点 |
|------|------|
| `mao signal-watcher list` | GET `/v1/signal-watchers` |
| `mao signal-watcher get --id <id>` | GET `/v1/signal-watchers/:id` |
| `mao signal-watcher create ...` | POST `/v1/signal-watchers` |
| `mao signal-watcher update --id <id> ...` | PUT `/v1/signal-watchers/:id` |
| `mao signal-watcher delete --id <id>` | DELETE `/v1/signal-watchers/:id` |
| `mao signal-watcher status --id <id> --status ACTIVE\|PAUSED` | POST `/v1/signal-watchers/:id/status` |
| `mao signal-watcher checks --id <id> [--page N] [--size N]` | GET `/v1/signal-watchers/:id/checks` |
| `mao signal-watcher test --id <id>` | POST `/v1/signal-watchers/:id/test` |
| `mao signal-watcher admin-list [--page N] [--size N] [--status ...] [--user-id N] [--compare-mode ...]` | GET `/v1/admin/signal-watchers` |

create 必填 `--name` / `--agent-id` / `--url` / `--prompt-template`；可选 `--method`（默认 GET）、`--headers`（JSON 对象或 `[{key,value}]` 数组）、`--body` / `--body-file`、`--interval`（默认 30）、`--compare-mode`（默认 HASH）、`--json-path`、`--trigger-mode`（默认 NEW_SESSION）、`--copy-from`。

```bash
# 新建：每 15 分钟探测库存接口，按 JSON 字段判定，变化时新建会话交给 Agent
mao signal-watcher create --name '库存监控' --agent-id 3 \
  --url 'https://api.example.com/stock' \
  --compare-mode JSON_FIELD --json-path 'data.list.0.price' \
  --interval 15 --prompt-template '库存价格变化：{diff}'

# 复制已有哨兵：敏感请求头与请求体由后端从源行解密继承，CLI 不接触明文
mao signal-watcher create --name '库存监控 副本' --agent-id 3 \
  --url 'https://api.example.com/stock' --prompt-template '同上' --copy-from 12

# 日常维护：改间隔 / 暂停 / 重新启用 / 轮询记录 / 立即试跑一次探针（不触发、不写库）
mao signal-watcher update --id 12 --interval 60
mao signal-watcher status --id 12 --status PAUSED
mao signal-watcher status --id 12 --status ACTIVE
mao signal-watcher checks --id 12 --page 1 --size 20
mao signal-watcher test --id 12
```

update 为部分更新：未传的字段保持原值；`--headers '{}'`、`--body ''`、`--json-path ''` 是显式清空。回显中掩码为 `******` 的敏感请求头可原样回传，后端只对本次下发的键用库内原值替换，不会把掩码当凭据落库。create 时 GET 带 `--body`、POST 缺请求体、间隔越界、JSON_FIELD 缺 `--json-path`、禁改请求头（host 等）、URL 非 http/https 或内嵌凭据，均在本地直接报错，请求不会发出。

## 复用会话与复制（0.0.361）

| 项 | 规则 |
|----|------|
| 复用指针 | `reuse_session_id` 由服务端维护，**不接受前端指定**（路由层不解析该字段），只能由触发链路写入 |
| 指针失效 | 会话不存在（含已删）、已归档、归属用户不符、会话类型是 SUBAGENT / SIDE_TASK、非 CLOUD 或 Agent 已换，均判失效：清空指针、本次改新建，下次触发重建，且不计入连续失败 |
| 切换模式 | `NEW_SESSION → REUSE_SESSION` 不清指针（可能接着旧会话聊）；`REUSE_SESSION → NEW_SESSION` 清指针 |
| 复制继承 | `copyFrom` 命中时：未修改的敏感请求头按掩码占位从源行还原，POST 且请求体缺省时继承源请求体；`reuseSessionId` 不继承 |
| 会话来源 | 哨兵会话 `source = signal`，归入独立分组「信号哨兵」（后端 `SIGNAL_GROUP_KEY`），不计未读但收件箱 / 出站订阅照常 |

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
- **复用模式下每轮都像第一次聊**：看轮询记录的「触发/告警」列是否每次都是新的会话 id；若是指针反复失效（常见原因是复用的会话被手动删除，或哨兵换了目标 Agent），下次触发会自动重建，属预期行为。
- **复制出来的哨兵请求头 / 请求体是空的**：敏感值没有明文可回显，留空保存即从源哨兵继承；确实不想要请求头时把请求头行全部删掉再保存。
