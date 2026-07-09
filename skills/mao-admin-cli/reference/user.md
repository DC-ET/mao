# user — 用户管理

## 用途

管理后台用户：列表、详情、创建、更新、重置密码、启停、分配角色。

## 命令选择

| 场景 | 命令 |
|------|------|
| 分页搜索用户 | `user list` |
| 查看单个用户 | `user get` |
| 新建用户 | `user create` |
| 改资料/角色/状态 | `user update` |
| 仅改状态 | `user set-status` |
| 重置密码 | `user reset-password` |
| 仅分配角色 | `user assign-roles` |

## 命令：user list

### 参数说明

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--page` | 否 | 整数 | 1 | 页码 | `page` |
| `--size` | 否 | 整数 | 20 | 每页条数 | `size` |
| `--keyword` | 否 | 字符串 | — | 关键词（用户名/显示名等） | `keyword` |
| `--status` | 否 | 整数 | — | `1` 启用 / `0` 禁用 | `status` |

### 接口

`GET /users`

### 示例

```bash
mao-admin user list --page 1 --size 20 --keyword admin --status 1
```

## 命令：user get

| 参数 | 必填 | 类型 | 含义 | 后端 |
|------|------|------|------|------|
| `--id` | 是 | 整数 | 用户 ID | 路径 `{id}` |

`GET /users/{id}`

```bash
mao-admin user get --id 1
```

## 命令：user create

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--username` | 是 | 字符串 | 用户名 | `username` |
| `--password` | 是 | 字符串 | 初始密码 | `password` |
| `--display-name` | 否 | 字符串 | 显示名 | `displayName` |
| `--email` | 否 | 字符串 | 邮箱 | `email` |
| `--role-ids` | 否 | 逗号分隔整数 | 角色 ID 列表 | `roleIds` |
| `--status` | 否 | 整数 | `1` 启用 / `0` 禁用 | `status` |

`POST /users`

```bash
mao-admin user create --username alice --password 'Secret1' --display-name 爱丽丝 --role-ids 1,2 --status 1
```

## 命令：user update

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | 用户 ID | 路径 |
| `--display-name` | 否 | 字符串 | 显示名 | `displayName` |
| `--email` | 否 | 字符串 | 邮箱 | `email` |
| `--role-ids` | 否 | 逗号分隔整数 | 角色 ID | `roleIds` |
| `--status` | 否 | 整数 | 状态 | `status` |

`PUT /users/{id}`

```bash
mao-admin user update --id 3 --display-name 新名字 --status 1
```

## 命令：user reset-password

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | 用户 ID | 路径 |
| `--new-password` | 是 | 字符串 | 新密码 | `newPassword` |
| `--confirm-password` | 是 | 字符串 | 确认密码，须与新密码一致 | `confirmPassword` |

`PUT /users/{id}/password`

```bash
mao-admin user reset-password --id 3 --new-password 'NewPass1' --confirm-password 'NewPass1'
```

## 命令：user set-status

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | 用户 ID | 路径 |
| `--status` | 是 | 整数 | `1` 启用 / `0` 禁用 | `status` |

`PUT /users/{id}/status`

```bash
mao-admin user set-status --id 3 --status 0
```

## 命令：user assign-roles

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | 用户 ID | 路径 |
| `--role-ids` | 是 | 逗号分隔整数 | 完整角色 ID 列表（覆盖式） | `roleIds` |

`PUT /users/{id}/roles`

```bash
mao-admin user assign-roles --id 3 --role-ids 1,2
```

## 成功失败判断

- 成功：默认打印 `data`；列表含 `records`/`total`
- 失败：stderr `message`，exit 1（如密码不一致、无权限）
