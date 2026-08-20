# skill-docs — 全局 Skill 文档

## 用途

管理服务端全局技能目录（`skill-docs`）：列表、详情、multipart 上传、删除。供 Agent 的 `skillNames` 引用。

## 命令选择

| 场景 | 命令 |
|------|------|
| 查看全部技能 | `skill-docs list` |
| 查看正文 | `skill-docs get` |
| 从本地目录上传 | `skill-docs upload` |
| 删除技能文件夹 | `skill-docs delete` |

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

`POST /skill-docs/upload`，multipart 字段名 `files`。每个 part 的 filename 为相对路径，例如 `my-skill/SKILL.md`。

目录规则：

1. 若 `--dir` 下直接有 `SKILL.md`：将该目录视为单个技能，技能名=目录名，上传路径形如 `目录名/SKILL.md` 及子文件。
2. 若 `--dir` 为多技能根：递归子目录，相对路径须含 `技能名/...`。

成功：`data` 为已导入技能名字符串数组。

```bash
mao skill-docs upload --dir ./my-skill
mao skill-docs upload --dir ./skills-root
```

## 命令：skill-docs delete

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--name` | 是 | 字符串 | 技能名 |

`DELETE /skill-docs/{name}`

```bash
mao skill-docs delete --name my-skill
```

## 成功失败判断

- 上传无文件 / 无合法相对路径 → CLI 或服务端报错
- 删除不存在 → 业务错误 message（如 Skill not found）
- 成功：`code===0`

## 注意事项

- 不要上传隐藏文件（`.` 开头）；CLI 会跳过
- 根级单文件（无 `技能名/` 前缀）会被服务端忽略
