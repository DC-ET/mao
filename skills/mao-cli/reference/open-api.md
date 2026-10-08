# 开放接口模块（open）

## 模块职责

把 Mao Agent 开放给外部系统，三条通道：

| 方向 | 能力 | 形态 |
|------|------|------|
| 入站（P1） | 外部系统带 API Token 远程触发一次 Agent 运行 | `POST /v1/open/agents/:agentId/run` |
| 入站（P2） | 外部系统（CI、工单、自建脚本）以 HMAC 验签方式 POST 触发 | `POST /v1/open/hooks/:pathToken` |
| 出站（P3） | 任务完成 / 失败、提问待答事件推送到自建 HTTPS 端点 | `task.completed` / `task.failed` / `question.pending` |

管理面（Token / 触发器 / 订阅 CRUD）在桌面端「设置 → 开放接口」与 `mao open` 命令行均可操作；所有管理接口只接受登录会话（JWT），且只能管理本人资源。

鉴权与边界要点：

- **API Token**：`mao_` 前缀 + 48 位随机字符，sha256 落库；明文只在创建响应里出现一次。scope 首期仅 `open:run`，只能在 `/v1/open/**` 端点使用（调用其它 REST 接口一律 401）。每人最多 20 个未吊销 Token，默认 90 天过期，吊销即时生效。
- **Webhook 触发器**：`pathToken` 决定公开 URL，`secret` 用于 HMAC-SHA256 签名（创建 / 轮换时只展示一次）。时间戳容忍 ±300 秒，签名基于原始请求体原文。不存在 / 已停用 / 验签失败统一返回 404 + `{code:3040,message:"not found"}`，不探测资源是否存在。连续 5 次执行失败自动停用，并在收件箱推送「触发器停用」。
- **run 端点**：恒返回 202 异步语义（`sessionId` / `messageId` / `queued`）；目标会话忙时消息自动进入待发送队列（`queued=true`）。指定 `sessionId` 时，会话必须属于路径上的同一个 Agent，不一致返回参数错误，不会改用会话里的另一个 Agent 执行。触发器绑定会话同样要求与触发器的 Agent 一致。限流：每 Token 60 次/分钟，超限 429 + `Retry-After`。
- **出站订阅**：目标 URL 必须 HTTPS（禁止 userinfo 与 hash 片段）；请求带 `X-Mao-Event` / `X-Mao-Timestamp` / `X-Mao-Signature`；失败按 1 / 5 / 25 分钟退避重试，3 次后置 FAILED 保留记录，不无限重投。`GET /v1/open/subscriptions/:id/deliveries` 可查最近投递。

## 明确不包含

- Token 不能调用 `/v1/open` 之外的任何 REST 接口（设计上的最小权限，不是 bug）。
- 管理接口不接受 API Token（防止泄露后自我续期 / 克隆）。
- 发送对话消息仍是 WS / mao-agent 的职责；open 只做「触发一轮」与「事件外发」。

## 命令选择

| 场景 | 命令 |
|------|------|
| 签发 / 查看 / 吊销 Token | `open token create` / `list` / `delete` |
| 建 / 改 / 删 / 启停触发器 | `open trigger create` / `update` / `delete` / `update --enabled` |
| 轮换触发器密钥 | `open trigger rotate-secret` |
| 配 / 启停 / 删出站订阅 | `open subscription create` / `set-enabled` / `delete` |
| 查看投递记录 | `open subscription deliveries` |
| 以 API Token 触发运行 | `open run` |

---

## 命令：mao open token create

### 用途

签发 API Token。**明文只在响应里出现一次**，复制保存；丢失只能吊销重签。

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--name` | 是 | 用途备注，便于列表识别 |
| `--scope` | 否 | 逗号分隔 scope，缺省 `open:run`；首期仅此一个合法值 |

### 示例

```bash
mao open token create --name "ci-trigger" --scope open:run
```

响应 `data.token`（或 `--json` 下的字段）即 `mao_...` 明文，`tokenPrefix` 为前 12 位。

## 命令：mao open trigger create

### 用途

为一个 Agent 创建入站 Webhook 触发器，返回可直接交给外部系统的公开 URL 与签名密钥。

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--name` | 是 | 触发器名称 |
| `--agent-id` | 是 | 目标 Agent ID |
| `--session-id` | 否 | 绑定固定会话；缺省每次触发新建会话 |

### 示例

```bash
mao open trigger create --name "pagerduty" --agent-id 12
```

外部系统随后 POST 该 `url`，头部带 `X-Mao-Timestamp`（Unix 秒）与 `X-Mao-Signature`：

```
signature = `sha256=${hex(hmac_sha256(secret, `${timestamp}.${rawBody}`))}`
```

（时间戳与原始请求体原文以英文句点连接后签名；容忍 ±300 秒。）

Python 示例：

```python
import hashlib, hmac, json, time, urllib.request

secret = "<trigger-secret>"
url = "<trigger-url>"
body = json.dumps({"issue": "disk almost full"}).encode()
ts = str(int(time.time()))
digest = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
req = urllib.request.Request(url, data=body, method="POST", headers={
    "Content-Type": "application/json",
    "X-Mao-Timestamp": ts,
    "X-Mao-Signature": f"sha256={digest}",
})
print(urllib.request.urlopen(req).read())
```

## 命令：mao open subscription create

### 用途

把事件推送到自建 HTTPS 端点。明文 `secret` 只展示一次，用于校验回调签名。

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--event` | 是 | `task.completed` / `task.failed` / `question.pending` |
| `--target-url` | 是 | HTTPS 地址；禁止 URL 内嵌 userinfo（`https://user:pass@host`）与 `#hash` |

### 示例

```bash
mao open subscription create --event task.failed --target-url https://ops.example.com/mao-hook
```

回调请求头：`X-Mao-Event`、`X-Mao-Timestamp`、`X-Mao-Signature`（对实际发送字节签名，算法同触发器）。2xx 视为成功；429 与 5xx 会重试。

## 命令：mao open run

### 用途

不依赖 mao-agent，直接用 API Token 触发一轮 Agent 运行（202 异步）。

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--api-token` | 是 | `mao_` 前缀 API Token（Bearer 直传，不写入本地缓存） |
| `--agent-id` | 是 | 目标 Agent ID |
| `--message` | 是 | 触发消息全文 |
| `--session-id` | 否 | 复用会话；缺省新建 |

### 示例

```bash
mao open run --agent-id 12 --message "跑一遍 nightly 巡检" --api-token mao_xxxx
```

`queued=true` 表示目标会话忙，消息已进待发送队列。

## 排障

| 现象 | 原因与处理 |
|------|-----------|
| `run` 返回 403「该端点仅接受 API Token」 | 用了 JWT 调 run；run 只认 `mao_` Token |
| `run` 返回 401 | Token 过期 / 已吊销，或 Token 用在了 `/v1/open` 之外的端点 |
| hook 返回 404 + `not found` | 触发器不存在、已停用、或签名 / 时间戳不通过（统一措辞，不区分） |
| hook 返回 429 | 该触发器限流；读 `Retry-After` 后重试 |
| 收件箱出现「触发器停用」 | 连续 5 次执行失败，已自动停用；排除外部系统问题后重新启用 |
| 订阅一直重试 | 目标 URL 非 2xx；用 `open subscription deliveries --id <id>` 看 `lastHttpStatus` / `lastError` |

相关文档：桌面端「设置 → 开放接口」页面；设计细节见仓库 `docs/plan/2026-10-05-open-api-webhook-technical-design.md`。
