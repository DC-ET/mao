# 工具模块（tool）

## 模块职责

只读查询服务端已注册的内置工具名称与描述。不执行工具。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列出全部工具 | `tool list` |
| 按名查询 | `tool get` |

---

## 命令：mao-user tool list

### 用途

列出内置工具。

### 参数说明

无。需要鉴权。

### 返回结果

数组元素：`name`、`description`。

### 示例

```bash
mao-user tool list --json
```

---

## 命令：mao-user tool get

### 用途

按工具名获取详情。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--name` | 是 | 字符串 | 工具名称，如 `bash`、`read_file` |

### 示例

```bash
mao-user tool get --name bash
```

## 注意事项

- 本模块仅查询元数据，不会触发 LOCAL/CLOUD 工具执行
- 对话中的工具调用不在本 CLI 范围
