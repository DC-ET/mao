# 信号哨兵（signal-watcher）

## 模块职责

按固定间隔由后端主动探测判定对象，判定值发生变化时**新建一次 Agent 会话**并把变化摘要交给 Agent 处理。适合「有变化才需要处理」的场景：汇率、库存、发布状态、接口健康度、竞品页面更新等。探针二选一：**HTTP 接口**（单请求取响应体）或 **Shell 脚本**（V189：执行用户项目工作区里的 bash 脚本、stdout 为判定值，支持多步采集 / 多源聚合 / 服务器本机状态检查）。

与开放接口的分工：Webhook 触发器是「外部推事件进来」，信号哨兵是「Mao 主动出去看」，两者都会新建会话，但哨兵没有公开 URL、不需要对方配合。

管理面在桌面端「设置 → 信号哨兵」自助完成；管理后台（`signal:read` 权限）只提供只读清单。全部接口只接受登录会话（JWT），且只能操作本人数据（决策 15）。

## 核心规则

| 项 | 规则 |
|----|------|
| 探测方式 | HTTP：后端主动出站，`node:http/https`，不跟随重定向（3xx 判失败），连接超时 10s / 读取超时 15s，响应体上限 1MB。SCRIPT：后端宿主以 `bash <脚本>` 执行（与运行环境模式无关），stdout 上限 1MB、stderr 收集 8KB、超时可配 5~300s（默认 60） |
| 地址限制 | 仅 `http`/`https`，禁止内嵌凭据（`user:pass@host`），禁止私网 / 回环 / 保留地址（复用 `common/ssrf.ts` 判定）；**不做管理员放行配置** |
| 判定模式 | `HASH`（整体内容哈希）/ `JSON_FIELD`（点分路径提取，支持数组下标，如 `data.list.0.price`）/ `STATUS_CODE`（HTTP 状态码，**仅 HTTP 哨兵**——脚本哨兵的 exit code 是成败语义，非 0 计一次失败，不作为判定输入） |
| 提示词模板 | 支持 `{name}` `{url}` `{diff}` 占位；`{diff}` 为旧 / 新值各截断 500 字的文本对比（不做行级 diff） |
| 触发方式 | `NEW_SESSION`（默认）每次触发**新建会话**；`REUSE_SESSION` **复用自己的会话**——首次触发自动建一个专属会话，之后每次变化都接着聊（上下文持续累积）。复用的会话 id 由服务端维护，前端只选模式、不选会话 |
| 频次上限 | 同一哨兵每小时最多 4 次触发；**超出仍照常触发**，仅在轮询记录上打 `TRIGGER_RATE_LIMITED` warning，不计失败（决策 7） |
| 自动停用 | 连续失败 5 次自动停用（`DISABLED`），并在收件箱推送「哨兵已停用」；停用后只能用户手动重新启用。探针失败、判定失败、凭据解密失败，以及变化已发生但触发 Agent 失败（预算拦截、Agent 停用、会话创建失败）都计入连续失败 |
| 失败退避 | `间隔 × min(2^连续失败次数, 32)` 分钟，任一次成功后清零 |
| 数量 / 间隔 | 每用户哨兵数量**无上限**（0.0.361 取消原 20 个限制）；间隔 1~1440 分钟（整数），脚本哨兵下限 5 分钟 |
| 基线重置 | 编辑 url / method / headers / body / compareMode / jsonPath / probeType / scriptPath 会重置基线（下次轮询只建基线不触发）并清空 `lastCheckedAt`，下一轮扫描即可重建基线；改名称、间隔、提示词、脚本超时不影响基线 |
| 保留天数 | 轮询记录保留 `signal.checkRetentionDays` 天（默认 90，管理后台可改） |
| 敏感数据 | 请求头与请求体整体 AES-GCM 加密（密钥 `APP_SIGNAL_SECRET`），列表 / 详情回显时敏感请求头打码为 `******`，body 只回长度 |
| 凭据占位符 | 请求头值支持 `{{MAO_TOKEN}}` / `{{ECP_TOKEN}}`（桌面端表单有「插入凭据」按钮）：**落库的是占位符本身**（随 headers 加密、不含明文），**每次探针执行时由后端替换为当时有效的 token，并随请求自动发往上面配置的 URL**——MAO_TOKEN 为短效 shell JWT（每次现签发，等同该用户 CLOUD shell 凭据），ECP_TOKEN 为 ECP 登录态（12 小时自动续期）。配置前请确认目标服务可信。占位符精确匹配（大小写敏感、内部不能有空格），出现未识别的 `{{XXX}}` 保存时直接拒绝。解析失败（MAO 用户异常 / ECP 票过期未重新登录）时**跳过该请求头继续探针**：不计连败、不停用，目标服务的 401 本身就是有效信号。值只由占位符组成的敏感头回显不打码（能看到自己配了什么）；`Bearer {{MAO_TOKEN}}` 这类混合值仍打码、留空保存即沿用 |

## 端点

用户级（登录态，本人数据）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/signal-watchers` | 我的哨兵列表（脱敏） |
| POST | `/v1/signal-watchers` | 新建；body 支持 `triggerMode`（`NEW_SESSION` 默认 / `REUSE_SESSION`）与 `copyFrom`（源哨兵 id，敏感请求头与请求体由后端从源行解密继承，前端不接触明文） |
| GET | `/v1/signal-watchers/:id` | 详情（脱敏） |
| PUT | `/v1/signal-watchers/:id` | 编辑；命中判定字段则重置基线 |
| DELETE | `/v1/signal-watchers/:id` | 删除（级联删轮询记录，已产生的会话不删） |
| POST | `/v1/signal-watchers/:id/status` | 启停，body `{ "status": "ACTIVE" \| "PAUSED" }`；`DISABLED → ACTIVE` 时清零失败、重置基线并清空 `lastCheckedAt`（失败退避写过的未来时刻不再挡住下一轮）。`PAUSED → ACTIVE` 时若上次检查仍是未来时刻，同样清空 |
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
| `oldValueSnippet` / `newValueSnippet` | 本次判定所对照的上次值 / 本次值片段（V185，与触发 prompt 的 `{diff}` 同口径，各截 500 字）；探针失败 / 判定失败行为 null，上线前历史行为 null |
| `changed` | 1 = 与上次判定值不同 |
| `triggeredSessionId` | 本次变化触发新建的会话 ID |
| `error` | 失败原因（已脱敏，只含错误码，不含目标 URL） |
| `warning` | 非失败告警，当前仅 `TRIGGER_RATE_LIMITED` |
| `durationMs` | 探针耗时 |

哨兵列表行透出 `lastValueSnippet`（上次判定内容片段，失败行「上次正常值」用；失败不覆盖它）与 `lastChangeOldSnippet` / `lastChangeNewSnippet`（上一次**成功触发**的旧/新值，与 `lastChangedAt` 同义；触发失败不改这两列，本轮新旧值只留在该条轮询记录。从未变化 / 基线重置 / 重新启用后为 null，整句不渲染；暂停不清）。管理后台列表同时返回 `jsonPath`，JSON 字段模式的「上次变化内容」带上取值路径。

## Shell 脚本探针（V189）

脚本哨兵的判定对象是**本人项目工作区内**的脚本文件：路径为相对路径 `<项目slug>/<子路径>`，保存与执行前都做属主校验（resolve + realpath 后必须落在本人 projects 根内，软链逃逸直接拒绝），保存时要求文件已存在且 ≤256KB。

- **执行模型**：后端宿主以 `bash <脚本绝对路径>` 执行（不要求可执行位；与用户运行环境的 docker 模式无关——HTTP 探针同为服务端出站行为）；cwd 为脚本所在目录；stdin 关闭（脚本读 stdin 得 EOF）；执行「当前内容生效」，改脚本即改哨兵行为，删除脚本 → 探针失败走退避。
- **脚本契约**：stdout 是判定值（HASH=全文哈希，JSON_FIELD=按提取路径取值）；exit code 0=成功，非 0 记一次失败（error 取 stderr 尾部 200 字符）；超时按进程组 SIGKILL 判失败（含脚本派生的全部子进程）。后台常驻子进程会在脚本退出后被整组回收，脚本不要依赖子进程存活。
- **环境变量**：白名单注入 `PATH` / `HOME`（属主运行时目录）/ `TZ` / `MAO_WATCHER_ID` / `MAO_WATCHER_NAME`，**不继承后端进程全量 env**（`APP_SIGNAL_SECRET` 等对脚本不可见）；凭据占位符机制对脚本不生效，需要凭据的脚本自行从工作区文件读取。
- **安全姿态**：脚本探针与云端 Agent 的 Shell 工具同层级——host 运行模式下 Agent 本就可在服务端执行任意命令，脚本探针未新增执行性质，但它是**无人值守**的定时执行；部署方若依赖 docker 模式隔离用户执行，请注意脚本探针仍在宿主执行（可对 mao-backend 服务配置 ulimit 约束进程数）。

## 常见排障

- **哨兵一直不触发**：首轮轮询只建基线不触发；确认 `lastCheckedAt` 有更新说明调度正常。
- **连续失败后停用**：看轮询记录里的 `error`；常见为地址不可达、私网地址被拒、`JSON_FIELD` 路径写错（判定失败也计入连败）。
- **重新启用后仍不触发**：`DISABLED → ACTIVE` 会重置基线并立刻重新参与轮询，首轮只建基线，需再一次变化才会触发（符合预期）。
- **凭据解不开**：`APP_SIGNAL_SECRET` 轮换或密文损坏时，本轮记为失败并退避，不会丢掉鉴权头照发探针。列表仍可打开，需要重新填写请求头 / 请求体。
- **提示词里看不到旧值**：`{diff}` 依赖上次判定值片段，基线刚重置后的首次变化旧值侧为空。
- **复用模式下每轮都像第一次聊**：看轮询记录的「触发/告警」列是否每次都是新的会话 id；若是指针反复失效（常见原因是复用的会话被手动删除，或哨兵换了目标 Agent），下次触发会自动重建，属预期行为。
- **复制出来的哨兵请求头 / 请求体是空的**：敏感值没有明文可回显，留空保存即从源哨兵继承；确实不想要请求头时把请求头行全部删掉再保存。
- **哨兵 401 但凭据配了占位符**：先分清是哪一侧失效。占位符在每次探针时由后端现取 token——ECP 票过期（超过 12 小时未重新 ECP 飞书登录）时后端会**跳过该凭据头**再发请求，目标服务看到的是无凭据请求，401 来自目标服务侧；此时重新登录 ECP 即恢复。MAO_TOKEN 每轮现签发、不会过期在配置里，若仍 401 多为目标服务侧的校验口径问题。两种情况都不计入哨兵连败，可在后端日志按 `skip probe header` 确认凭据头是否被跳过；若日志出现「no credentialResolver is wired」说明该实例未装配凭据签发依赖，需检查部署。
