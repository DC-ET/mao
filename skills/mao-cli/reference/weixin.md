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

## 消息媒体处理（0.0.77 起）

微信入站图片转多模态直传模型，同时落盘会话工作区 `chat-files/{yyyy-MM-dd}/` 按日期归档，消息文本追加「图片已保存到会话工作区：{路径}」提示，Agent 可用工具二次读取原图。
