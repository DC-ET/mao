# 技能模块（skill）

## 模块职责

管理当前用户的个人 Skill（`/user-skills`），以及下载 LOCAL 模式技能同步包（`/skills/sync-package`，二进制 zip）。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列出个人技能 | `skill list` |
| 查看技能详情 | `skill get` |
| 上传技能目录 | `skill upload` |
| 删除技能 | `skill delete` |
| 下载同步包 zip | `skill sync-package` |

---

## 命令：mao-user skill list

### 用途

列出当前用户已上传的个人技能。

### 参数说明

无。需要鉴权。

### 返回结果

元素含 `name`、`description`、`folderPath`。

### 示例

```bash
mao-user skill list --json
```

---

## 命令：mao-user skill get

### 用途

按名称获取技能详情（含正文 body）。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--name` | 是 | 字符串 | 技能名称（目录名 / frontmatter name） |

### 示例

```bash
mao-user skill get --name my-skill
```

---

## 命令：mao-user skill upload

### 用途

将本地技能目录以 multipart 上传。目录必须包含 `SKILL.md`，且 frontmatter 含 `name`、`description`。

CLI 会把目录内文件打包为字段名 `files`，文件名形如 `目录名/相对路径`（与桌面端上传约定一致）。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--dir` | 是 | 路径 | 本地技能根目录（该目录本身作为技能名） |

### 参数约束

- 目录必须存在且含 `SKILL.md`
- 隐藏文件（以 `.` 开头）不会上传
- 同名技能会被覆盖

### 返回结果

`data` 为成功导入的技能名字符串数组。

### 示例

```bash
mao-user skill upload --dir ./my-skill
```

---

## 命令：mao-user skill delete

### 用途

删除个人技能目录。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--name` | 是 | 字符串 | 技能名称 |

### 示例

```bash
mao-user skill delete --name my-skill
```

---

## 命令：mao-user skill sync-package

### 用途

按会话下载该会话 Agent 对应的技能同步 zip（LOCAL 桌面端同步用）。**响应是二进制 zip，不是 Result JSON。**

### 参数说明

| 参数 | 必填 | 类型 | 默认值 | 含义 |
|------|------|------|--------|------|
| `--session-id` | 是 | 数字 | — | 会话 ID → 查询参数 `sessionId` |
| `--out` | 否 | 路径 | `skills-sync-{sessionId}.zip` | 本地保存路径 |

### 返回结果与状态判断

- 成功：文件写出；默认打印「已保存 N 字节到路径」
- `--json` 时输出 `{ path, bytes, contentType }`
- HTTP 失败：非零退出

### 示例

```bash
mao-user skill sync-package --session-id 12 --out /tmp/skills.zip
```

## 注意事项

- 同步包依赖会话存在且 Agent 有效
- 本模块不管理系统级 Skill 文档库的管理端上传
