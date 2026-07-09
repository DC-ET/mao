# auth — 鉴权

## 用途

登录获取 JWT、刷新 Token、登出、查询当前用户。

## 命令选择

| 场景 | 命令 |
|------|------|
| 首次或重新登录 | `auth login` |
| accessToken 过期 | `auth refresh` |
| 结束会话并清本地缓存 | `auth logout` |
| 查看当前登录用户 | `auth me` / `auth whoami` |

## 命令：auth login

### 用途

用户名密码登录，成功后写入 `~/.mao/auth.json`（与 mao-user-cli 共用；只存 JWT，不存密码）。

### 参数说明

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--username` | 是 | 字符串 | 登录用户名 | `username` |
| `--password` | 是 | 字符串 | 登录密码 | `password` |

### 成功失败判断

- 成功：`code===0`，`data.accessToken` 存在；CLI 已缓存
- 失败：stderr 输出 `message`，exit 1

### 示例

```bash
mao-admin auth login --username admin --password 'admin123'
mao-admin auth login --username admin --password 'admin123' --raw
```

## 命令：auth refresh

### 用途

用 refreshToken 换取新的 accessToken。

### 参数说明

无必填 CLI 参数。Token 来源优先级：

1. `--refresh-token`（可选覆盖）
2. 环境变量 `MAO_REFRESH_TOKEN`
3. 缓存文件中的 `refreshToken`

### 成功失败判断

- 成功：更新缓存中的 token
- 无 refreshToken：stderr 提示后 exit 1

### 示例

```bash
mao-admin auth refresh
```

## 命令：auth logout

### 用途

调用服务端登出并删除本地 `auth.json`。

### 参数说明

无。使用当前 accessToken。

### 示例

```bash
mao-admin auth logout
```

## 命令：auth me / auth whoami

### 用途

获取当前登录用户信息。`whoami` 为 `me` 别名。

### 参数说明

无。

### 接口

`GET /users/me`

### 示例

```bash
mao-admin auth me
mao-admin auth whoami --json
```
