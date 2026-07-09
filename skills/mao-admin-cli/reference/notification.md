# notification — 通知

## 用途

管理站内通知：列表、创建、标记已读。

## 命令选择

| 场景 | 命令 |
|------|------|
| 分页筛选 | `notification list` |
| 创建通知 | `notification create` |
| 标记已读 | `notification mark-read` |

## 命令：notification list

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--page` | 否 | 整数 | 1 | 页码 | `page` |
| `--size` | 否 | 整数 | 20 | 每页 | `size` |
| `--type` | 否 | 字符串 | — | 通知类型 | `type` |
| `--is-read` | 否 | 整数 | — | 是否已读：`1`/`0` | `isRead` |
| `--user-id` | 否 | 整数 | — | 接收用户 ID | `userId` |

`GET /notifications`

```bash
mao-admin notification list --user-id 1 --is-read 0 --page 1
```

## 命令：notification create

| 参数 | 必填 | 类型 | 含义 | 后端字段 |
|------|------|------|------|----------|
| `--user-id` | 是 | 整数 | 接收用户 ID | `userId` |
| `--type` | 是 | 字符串 | 通知类型 | `type` |
| `--title` | 是 | 字符串 | 标题 | `title` |
| `--content` | 是 | 字符串 | 正文 | `content` |

`POST /notifications`

```bash
mao-admin notification create \
  --user-id 1 \
  --type system \
  --title '维护通知' \
  --content '今晚 22:00 维护'
```

## 命令：notification mark-read

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 整数 | 通知 ID |

`PATCH /notifications/{id}/read`

```bash
mao-admin notification mark-read --id 12
```

## 成功失败判断

- 列表成功：`records`/`total`/`page`/`size`
- 创建成功：返回通知实体
- 标记已读成功：`code===0`，`data` 可能为 null
