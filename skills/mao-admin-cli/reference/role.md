# role / permission — 角色与权限

## 用途

管理角色、给角色赋权限点、列出全部权限点。用户绑角色见 `reference/user.md` 的 `user assign-roles`。

## 命令选择

| 场景 | 命令 |
|------|------|
| 查看所有角色 | `role list` |
| 新建角色 | `role create` |
| 改角色名/描述 | `role update` |
| 给角色设权限 | `role assign-permissions` |
| 查看权限点目录 | `permission list` |

## 命令：role list

无业务参数。`GET /roles`

```bash
mao-admin role list
```

返回角色列表，项含 `id`、`name`、`code`、`description`、`permissionIds`、`userCount`。

## 命令：role create

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--name` | 是 | 字符串 | 角色显示名 | `name` |
| `--code` | 是 | 字符串 | 角色编码（稳定标识） | `code` |
| `--description` | 否 | 字符串 | 描述 | `description` |

`POST /roles`

```bash
mao-admin role create --name 运营 --code ops --description '运营人员'
```

## 命令：role update

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | 角色 ID | 路径 |
| `--name` | 是 | 字符串 | 新名称 | `name` |
| `--description` | 否 | 字符串 | 描述 | `description` |

`PUT /roles/{id}`

```bash
mao-admin role update --id 2 --name 高级运营 --description '更新说明'
```

## 命令：role assign-permissions

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--id` | 是 | 整数 | 角色 ID | 路径 |
| `--permission-ids` | 是 | 逗号分隔整数 | 权限点 ID 完整列表 | `permissionIds` |

`PUT /roles/{id}/permissions`

先用 `permission list` 取得权限 ID。

```bash
mao-admin permission list
mao-admin role assign-permissions --id 2 --permission-ids 1,2,3,5
```

## 命令：permission list

无业务参数。`GET /permissions`

```bash
mao-admin permission list
```

返回权限点：`id`、`name`、`code`、`description`。

## 成功失败判断

- `code===0` 成功
- 赋权为覆盖式：传入的 ID 列表即最终权限集
