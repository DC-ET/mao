# skill-docs — 全局 Skill 文档

## 用途

管理服务端全局技能目录（`skill-docs`）：列表、详情、multipart 上传、删除。供 Agent 的 `skillNames` 引用。`assign` 把同一份技能目录写入指定用户的个人技能，不进入全局库。管理后台同页「个人 Skills」Tab 聚合各用户 `/user-skills`（接口 `/admin/user-skills`，支持可选 `userId` 参数仅返回该用户技能），并提供同样的指定用户上传。

## 命令选择

| 场景 | 命令 |
|------|------|
| 查看全部技能 | `skill-docs list` |
| 查看正文 | `skill-docs get` |
| 从本地目录上传到全局库 | `skill-docs upload` |
| 写入指定用户的个人技能 | `skill-docs assign` |
| 删除全局技能文件夹 | `skill-docs delete` |

## 命令：skill-docs list

无参数。`GET /skill-docs`

返回数组，项含 `name`、`description`、`folderPath`、`filePath`。

```bash
mao skill-docs list
```

## 命令：skill-docs get

| 参数 | 必填 | 类型 | 含义 | 后端 |
|------|------|------|------|------|
| `--name` | 是 | 字符串 | 技能名称（文件夹名） | 路径 `{name}` |

`GET /skill-docs/{name}`

成功 `data` 含 `name`、`description`、`body`、`folderPath`、`filePath`。

```bash
mao skill-docs get --name bigdata-cli
```

## 命令：skill-docs upload

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--dir` | 是 | 路径 | 本地技能目录或技能根目录 |

`POST /skill-docs/upload`，multipart 字段名 `files`。每个 part 的 filename 为相对路径，例如 `my-skill/SKILL.md`。需 `skill:write` 权限。

目录规则：

1. 若 `--dir` 下直接有 `SKILL.md`：将该目录视为单个技能，技能名=目录名，上传路径形如 `目录名/SKILL.md` 及子文件。
2. 若 `--dir` 为多技能根：递归子目录，相对路径须含 `技能名/...`。

成功：`data` 为已导入技能名字符串数组。

```bash
mao skill-docs upload --dir ./my-skill
mao skill-docs upload --dir ./skills-root
```

## 命令：skill-docs assign

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--dir` | 是 | 路径 | 本地技能目录或技能根目录，规则与 `upload` 相同 |
| `--user-ids` | 是 | 逗号分隔的用户 ID | 写入这些用户的个人技能，例如 `1,2` |

`POST /admin/user-skills/upload`，multipart 字段 `userIds`（逗号分隔）与 `files`。需 `skill:write`。一次最多 100 个用户。用户必须已存在；同名个人技能会被覆盖，替换失败时保留该用户原来的技能。不会写入全局技能库，其他用户不受影响。这些用户的所有智能体会自动带上该技能；若与系统技能同名，仅这些用户改用这份个人技能。请求中断或文件数超限时整批不写入。管理后台上传还会跳过 `node_modules`、`.git`、`.svn`、`dist`、`__MACOSX`，并限制最多 500 个文件、单文件 20MB、总量 50MB。

成功 `data`：`skills` 为已导入技能名，`users` 为实际写入的用户（`id`、`username`、`displayName`）。

```bash
mao skill-docs assign --dir ./my-skill --user-ids 12,34
```

## 命令：skill-docs delete

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--name` | 是 | 字符串 | 技能名 |

`DELETE /skill-docs/{name}`，需 `skill:write` 权限。

```bash
mao skill-docs delete --name my-skill
```

## 成功失败判断

- 上传无文件 / 无合法相对路径 → CLI 或服务端报错
- `assign` 未指定用户、用户 ID 非法、用户不存在、上传中断或文件数超限 → 业务错误；中断和超限不会写入任何用户。多名用户中途失败时，message 会列出已经写成功的用户
- 删除不存在 → 业务错误 message（如 Skill not found）
- 成功：`code===0`

## 注意事项

- 不要上传隐藏文件（`.` 开头）；CLI 会跳过
- 根级单文件（无 `技能名/` 前缀）会被服务端忽略
