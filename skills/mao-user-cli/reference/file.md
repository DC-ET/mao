# 文件模块（file）

## 模块职责

附件上传/列表/下载/删除，以及会话工作区与云端项目文件浏览。

## 命令选择

| 场景 | 命令 |
|------|------|
| 上传附件 | `file upload` |
| 附件列表 | `file list` |
| 删除附件 | `file delete` |
| 下载附件 | `file download` |
| 工作区文件搜索列表 | `file workspace-list` |
| 工作区目录浏览 | `file workspace-directory` |
| 读取工作区文件内容 | `file workspace-read` |
| 云端项目文件列表 | `file project-list` |

---

## 命令：mao-user file upload

### 用途

multipart 上传单个文件，字段名 `file`，可选关联会话。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--file` | 是 | 路径 | 本地文件路径 |
| `--session-id` | 否 | 数字 | 关联会话 → 表单字段 `sessionId` |

### 返回结果

`id`、`originalName`、`fileSize`、`mimeType`、`sessionId`、`url`、`createdAt`。

### 示例

```bash
mao-user file upload --file ./note.pdf --session-id 12
```

---

## 命令：mao-user file list

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--session-id` | 否 | 数字 | 按会话过滤 → `sessionId` |

### 示例

```bash
mao-user file list --session-id 12
```

---

## 命令：mao-user file delete

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 文件 ID |

### 示例

```bash
mao-user file delete --id 8
```

---

## 命令：mao-user file download

### 用途

下载附件二进制到本地文件。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 文件 ID |
| `--out` | 是 | 路径 | 本地输出路径 |

### 示例

```bash
mao-user file download --id 8 --out /tmp/a.pdf
```

---

## 命令：mao-user file workspace-list

### 用途

在会话工作区内按过滤条件列出文件。会话必须属于当前用户且已配置 workspace。

### 参数说明

| 参数 | 必填 | 类型 | 默认值 | 含义 |
|------|------|------|--------|------|
| `--session-id` | 是 | 数字 | — | 会话 ID |
| `--filter` | 否 | 字符串 | — | 过滤关键字 → `filter` |
| `--limit` | 否 | 整数 | 服务端默认 20 | 返回条数上限 → `limit` |

### 返回结果

`{ "files": [ ... ] }`

### 示例

```bash
mao-user file workspace-list --session-id 12 --filter '*.ts' --limit 50
```

---

## 命令：mao-user file workspace-directory

### 用途

列出工作区某目录下的条目。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--session-id` | 是 | 数字 | 会话 ID |
| `--dir` | 否 | 字符串 | 相对工作区的目录，默认根目录 → `dir` |

### 示例

```bash
mao-user file workspace-directory --session-id 12 --dir src
```

---

## 命令：mao-user file workspace-read

### 用途

读取工作区文本文件片段。

### 参数说明

| 参数 | 必填 | 类型 | 默认值 | 含义 |
|------|------|------|--------|------|
| `--session-id` | 是 | 数字 | — | 会话 ID |
| `--path` | 是 | 字符串 | — | 相对工作区路径 → `path` |
| `--offset` | 否 | 整数 | 0 | 起始偏移 → `offset` |
| `--limit` | 否 | 整数 | 5000 | 读取长度上限 → `limit` |

### 示例

```bash
mao-user file workspace-read --session-id 12 --path README.md --offset 0 --limit 2000
```

---

## 命令：mao-user file project-list

### 用途

列出用户云端项目目录下的文件（不依赖会话）。

### 参数说明

| 参数 | 必填 | 类型 | 默认值 | 含义 |
|------|------|------|--------|------|
| `--project-key` | 是 | 字符串 | — | 项目目录名 → `projectKey` |
| `--filter` | 否 | 字符串 | — | 过滤关键字 |
| `--limit` | 否 | 整数 | 20 | 条数上限 |

### 示例

```bash
mao-user file project-list --project-key demo --limit 30
```

## 注意事项

- 工作区相关命令在会话无 workspace 时会失败
- `download` 为二进制写文件，不是 Result JSON
