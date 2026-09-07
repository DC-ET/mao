# 工具模块（tool）

## 模块职责

只读查询服务端已注册的内置工具名称与描述。不执行工具。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列出全部工具 | `tool list` |
| 按名查询 | `tool get` |

---

## 命令：mao tool list

### 用途

列出内置工具。

### 参数说明

无。需要鉴权。

### 返回结果

数组元素：`name`、`description`。

### 示例

```bash
mao tool list --json
```

---

## 命令：mao tool get

### 用途

按工具名获取详情。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--name` | 是 | 字符串 | 工具名称，如 `bash`、`read_file` |

### 示例

```bash
mao tool get --name bash
```

## 对话内搜索：grep_search（CLOUD）

由 Agent 在后端执行，不是 `mao tool` 的执行命令。

- 未安装 ripgrep（`rg`）时，使用异步流式逐行读取，不再因文件超过 10 MiB 而静默跳过；本次流式化不涉及 `rg` 分支或 LOCAL 工具。
- 保留正则表达式 `pattern`、大小写选项 `ignore_case`、文件过滤 `glob`、上下文 `context_lines` 与输出上限 `max_output_chars`；输出截断时返回 `truncated: true`。
- 无 `rg` 分支遇到文件读取或目录访问错误会明确返回 `error`，不应将其视为“没有匹配”。

## 注意事项

- 本模块仅查询元数据，不会触发 LOCAL/CLOUD 工具执行
- 对话中的工具调用不在本 CLI 范围
