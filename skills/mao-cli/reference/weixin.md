# 微信 Bot 模块（weixin）

## 模块职责

管理当前用户的微信 Bot 绑定流程：查看绑定状态、获取绑定二维码数据、轮询扫码状态、确认绑定、解绑。

## 命令选择

| 场景 | 命令 |
|------|------|
| 查看绑定状态 | `weixin binding-status` |
| 获取二维码数据 | `weixin qrcode` |
| 查询二维码状态 | `weixin qrcode-status` |
| 确认绑定 | `weixin binding-confirm` |
| 解绑 | `weixin unbind` |

---

## 命令：mao weixin binding-status

### 返回结果

`bound`、`accountId`、`boundAt`。

### 示例

```bash
mao weixin binding-status --json
```

---

## 命令：mao weixin qrcode

### 用途

获取绑定二维码的原始数据。`qrDataUrl` 是微信登录页 URL；桌面端会再用二维码库渲染成图片。

### 返回结果

`sessionKey`、`qrDataUrl`、`message`。

### 示例

```bash
mao weixin qrcode --json
```

---

## 命令：mao weixin qrcode-status

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--session-key` | 是 | 字符串 | 来自 `weixin qrcode` |

### 返回结果

`status` 常见值：`wait`、`scaned`、`confirmed`、`expired`。确认后可能包含 `botToken`、`baseUrl`、`ilinkUserId`，用于下一步 `binding-confirm`。

### 示例

```bash
mao weixin qrcode-status --session-key abc --json
```

---

## 命令：mao weixin binding-confirm

### 用途

保存扫码确认后的微信 Bot 凭证并清理二维码会话。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--session-key` | 是 | 字符串 | 二维码 sessionKey |
| `--bot-token` | 是 | 字符串 | 扫码状态返回的 botToken |
| `--ilink-base-url` | 是 | 字符串 | 扫码状态返回的 baseUrl |
| `--ilink-user-id` | 是 | 字符串 | 扫码状态返回的 ilinkUserId |

注意：这里使用 `--ilink-base-url`，避免和 CLI 全局 `--base-url` 冲突。

### 示例

```bash
mao weixin binding-confirm --session-key abc --bot-token token --ilink-base-url https://... --ilink-user-id wxid
```

---

## 命令：mao weixin unbind

### 用途

解绑当前用户微信 Bot；服务端会先停止该账号消息监控。

### 示例

```bash
mao weixin unbind
```

---

## 文本控制命令

微信 Bot 单会话模型下的文本命令（trim 后全等匹配、大小写敏感；命令不落会话消息流、不触发 Agent、不产生进度卡，回复走既有文本通道）：

| 命令 | 行为 |
|------|------|
| `/new` | 归档当前活跃会话并新建（后续消息进入新会话）；旧会话在跑的任务不打断，跑完写回旧会话 |
| `/stop` | 停止当前会话的进行中任务（跨通道执行同样可停）；空闲时回复「当前没有进行中的任务。」 |
| `/tasks` | 列出本人微信渠道最近 5 个未归档会话（序号 + 标题 + 进行中徽标 + 相对时间） |
| `/tasks <序号>` | 切换活跃会话到对应会话（1-9；归属校验、越界回退列表；切换先打断旧会话在跑执行，与「新消息打断」心智一致） |
| `/help` | 输出命令一览 |

命令不参与入站防抖合并：与其他消息连续发出时命令立即单独触发，不会被并进批次当任务执行。

---

## 消息媒体处理（0.0.77 起）

微信入站图片转多模态直传模型，同时落盘会话工作区 `weixin-files/{yyyy-MM-dd}/` 按日期归档，消息文本追加「图片已保存到会话工作区：{路径}」提示（工作区相对路径，0.0.289 起），Agent 可用工具二次读取原图。
