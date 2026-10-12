# Mao 开放接口文档

以机器身份把外部系统接入 Mao Agent。API Token 在「设置 → 开放接口」页面签发；本文档说明拿到 Token 之后如何调用。

## 基础约定

| 项 | 值 |
|----|----|
| Base URL | `https://<你的 Mao 域名>/api/v1`（自托管实例换成自己的域名） |
| 鉴权 | 请求头 `Authorization: Bearer mao_xxx`（API Token 明文） |
| 响应格式 | `{ "code": 0, "message": "", "data": {}, "timestamp": 0 }`，`code === 0` 表示成功 |
| Token 权限 | scope 仅 `open:run`，只能调用本文档中的 `/open/**` 端点，调用其它接口一律 401 |
| 限流 | 每 Token 60 次/分钟，超限返回 429 并带 `Retry-After` 头 |

Token 的签发、查看、吊销，以及触发器与订阅的管理只接受登录会话（JWT），不接受 API Token，请在「设置 → 开放接口」页面操作。

## 一、触发一次 Agent 运行

`POST /open/agents/:agentId/run`

异步触发一轮 Agent 执行，恒返回 202：消息进入执行队列后立即返回，不等待执行结果。执行结果可通过 WebSocket / mao-agent 查看，或配置出站订阅推送到你的系统（见第三节）。

请求头：

- `Authorization: Bearer mao_xxx`
- `Content-Type: application/json`

请求体：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 触发消息全文 |
| `sessionId` | integer | 否 | 复用会话；必须是该 Agent 名下的会话，不一致返回参数错误。缺省每次新建会话 |

响应（202）`data`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | integer | 执行所在会话 |
| `messageId` | integer | 本轮消息 ID |
| `queued` | boolean | `true` 表示目标会话正忙，消息已进入待发送队列 |

curl 示例：

```bash
curl -X POST 'https://mao.example.com/api/v1/open/agents/12/run' \
  -H 'Authorization: Bearer mao_xxxxxxxx' \
  -H 'Content-Type: application/json' \
  -d '{"message": "跑一遍 nightly 巡检"}'
```

## 二、入站 Webhook 触发器

`POST /open/hooks/:pathToken`

公开端点，不使用 Bearer Token，改用 HMAC-SHA256 验签。URL 与 Secret 在「设置 → 开放接口」创建触发器时生成，Secret 只展示一次，泄露可轮换。

请求头：

| 头 | 说明 |
|----|------|
| `X-Mao-Timestamp` | Unix 秒级时间戳，容忍 ±300 秒 |
| `X-Mao-Signature` | `sha256=<hex(HMAC-SHA256(secret, "<timestamp>.<原始请求体>"))>` |

签名串为时间戳与请求体原文以英文句点连接，服务端按收到的原始字节校验。请求体原文会作为事件内容交给 Agent（超过 8000 字符截断）。

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

响应（202）`data`：`{ "sessionId": 12, "queued": false }`。

失败返回：

- 404 + `{ "code": 3040, "message": "not found" }`：触发器不存在、已停用或验签失败（统一措辞，不区分）
- 429：触发器限流（绑定会话 30 次/分钟，未绑定 10 次/分钟），读 `Retry-After` 后重试

连续 5 次执行失败会自动停用触发器，并在站内收件箱推送「触发器停用」通知。

## 三、出站事件订阅（Mao → 你的系统）

在「设置 → 开放接口」配置订阅后，任务完成/失败或 Agent 提问时，Mao 向你的 HTTPS 端点 POST 事件。

请求头：

| 头 | 说明 |
|----|------|
| `X-Mao-Event` | 事件类型 |
| `X-Mao-Timestamp` | Unix 秒级时间戳 |
| `X-Mao-Signature` | 签名算法同触发器，对实际发送的字节计算 |

`task.completed` / `task.failed` 请求体：

```json
{
  "event": "task.completed",
  "sessionId": 12,
  "userId": 3,
  "executionId": "exec-xxx",
  "phase": "COMPLETED",
  "title": "会话标题",
  "failureReason": null,
  "source": "API",
  "sentAt": "2026-10-12 10:00:00"
}
```

`question.pending` 请求体：

```json
{
  "event": "question.pending",
  "sessionId": 12,
  "userId": 3,
  "requestId": "req-xxx",
  "sentAt": "2026-10-12 10:00:00"
}
```

投递语义：返回 2xx 视为成功；429 与 5xx 按 1 / 5 / 25 分钟退避重试，3 次后置为失败并保留记录，不会无限重投。最近投递记录可在订阅卡片上查看。

## 四、错误码

| code | 含义 | 处理 |
|------|------|------|
| 1001 | 未登录 / Token 无效 | 检查 Token 是否过期或已吊销，或用在了 `/open` 之外的端点 |
| 1002 | 无权限 | 用登录会话 JWT 调了 run 端点；run 只接受 `mao_` Token |
| 1007 | 请求过于频繁 | 超过每 Token 60 次/分钟，读 `Retry-After` 后重试 |
| 2001 | 参数校验失败 | 检查 `message` 为字符串、`sessionId` 为正整数且属于该 Agent |
| 3040 | 触发器不存在 | 不存在 / 已停用 / 验签失败，统一措辞不区分 |
| 3043 | Token 已自动停用 | 一小时内连续失败达到阈值；在设置页「重新启用」后恢复 |

## 五、排障

| 现象 | 原因与处理 |
|------|-----------|
| run 返回 403「该端点仅接受 API Token（mao_）调用」 | 用了登录会话 JWT 调 run；run 只认 `mao_` Token |
| run 返回 401 | Token 过期 / 已吊销，或 Token 用在了 `/open` 之外的端点 |
| run 返回 403「Token 已因连续失败被自动停用」 | 一小时内失败达到阈值；在设置页「重新启用」后恢复 |
| hook 返回 404 + `not found` | 触发器不存在、已停用，或签名 / 时间戳不通过 |
| hook 返回 429 | 触发器限流；读 `Retry-After` 后重试 |
| 收件箱出现「触发器停用」 | 连续 5 次执行失败已自动停用；排除外部系统问题后重新启用 |

每次调用（含参数错误、鉴权失败、限流拒绝）都会留下流水：Token / 触发器卡片上的「调用记录」看自己的，管理后台「开放调用」看全量。默认只记录消息长度与字段名，不记正文；如需完整请求体，可在 Token 卡片上开启「完整记录」（可能含敏感信息，操作留审计）。
