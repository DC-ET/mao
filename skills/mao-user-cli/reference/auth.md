# 认证模块（auth）

## 模块职责

用户登录、刷新令牌、登出、查询当前用户与登录能力开关，以及飞书扫码登录相关接口。

## 命令选择

| 场景 | 命令 |
|------|------|
| 密码登录 | `auth login` |
| 刷新 accessToken | `auth refresh` |
| 登出并清缓存 | `auth logout` |
| 当前用户信息 | `auth me` |
| 是否启用飞书 | `auth features` |
| 获取飞书二维码信息 | `auth feishu-qrcode` |
| 轮询飞书登录状态 | `auth feishu-status` |
| 用授权码换 token | `auth feishu-callback` |

---

## 命令：mao-user auth login

### 用途

用户名密码登录，成功后写入 `~/.mao/auth.json`（与 mao-admin-cli 共用；只存 JWT，不存密码）。

### 参数说明

| 参数 | 必填 | 类型 | 默认值 | 含义 |
|------|------|------|--------|------|
| `--username` | 是 | 字符串 | — | 登录用户名，对应请求体 `username` |
| `--password` | 是 | 字符串 | — | 登录密码，对应请求体 `password` |

### 返回结果

`data` 含 `accessToken`、`refreshToken`、`expiresIn`、`user`（`id/username/displayName/email/avatarUrl`）。

### 示例

```bash
mao-user auth login --username demo --password 'secret'
```

---

## 命令：mao-user auth refresh

### 用途

用 refreshToken 换取新的 accessToken，并更新本地缓存。

### 参数说明

| 参数 | 必填 | 类型 | 默认值 | 含义 |
|------|------|------|--------|------|
| `--refresh-token` | 否 | 字符串 | 环境变量或缓存 | 覆盖默认 refreshToken 来源 |

Token 解析顺序：`--refresh-token` > `MAO_REFRESH_TOKEN` > 缓存文件。

### 示例

```bash
mao-user auth refresh
```

---

## 命令：mao-user auth logout

### 用途

调用服务端登出，并删除本地 `auth.json`。即使服务端失败也会尝试清本地缓存。

### 参数说明

无业务参数。需要有效 accessToken（除非仅清本地，但本命令会先请求服务端）。

### 示例

```bash
mao-user auth logout
```

---

## 命令：mao-user auth me

### 用途

获取当前登录用户资料。对应 `GET /users/me`。

### 参数说明

无业务参数。需要鉴权。

### 示例

```bash
mao-user auth me --json
```

---

## 命令：mao-user auth features

### 用途

查询登录能力开关，例如是否启用飞书。无需登录。

### 参数说明

无。

### 返回结果

`data.feishuEnabled`：布尔值。

### 示例

```bash
mao-user auth features
```

---

## 命令：mao-user auth feishu-qrcode

### 用途

获取飞书扫码登录所需 URL 与 state。无需登录。

### 参数说明

无。

### 返回结果

| 字段 | 含义 |
|------|------|
| `authUrl` | 授权页地址 |
| `qrCodeUrl` | 二维码图片地址 |
| `state` | 轮询用状态码 |
| `expiresIn` | 过期秒数 |
| `pollInterval` | 建议轮询间隔（毫秒或秒，以服务端为准） |

### 示例

```bash
mao-user auth feishu-qrcode --json
```

---

## 命令：mao-user auth feishu-status

### 用途

按 `state` 轮询飞书登录结果。若 `status=success` 且含 `login`，自动缓存 token。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--state` | 是 | 字符串 | 来自 `feishu-qrcode` 的 `state` |

### 返回结果

`data.status`、`data.message`、可选 `data.login`（结构同 login）。

### 示例

```bash
mao-user auth feishu-status --state abc123
```

---

## 命令：mao-user auth feishu-callback

### 用途

用飞书授权码直接换取登录结果并缓存 token。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--code` | 是 | 字符串 | 飞书 OAuth 授权码，对应请求体 `code` |

### 示例

```bash
mao-user auth feishu-callback --code AUTH_CODE
```

## 注意事项

- 飞书相关命令依赖服务端开启飞书登录
- 登录成功后后续命令无需再传 `--token`，除非要临时覆盖
