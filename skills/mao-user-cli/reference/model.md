# 模型模块（model）

## 模块职责

查询用户端可用的 LLM 模型信息（只读）。不包含管理端的模型增删改。

## 命令选择

| 场景 | 命令 |
|------|------|
| 列出启用中的模型 | `model list-active` |
| 获取默认模型 | `model default` |
| 按 ID 查询 | `model get` |
| 列出提供商 | `model providers` |

---

## 命令：mao-user model list-active

### 用途

获取状态为启用的模型列表，创建会话时常用。

### 参数说明

无业务参数。需要鉴权。

### 返回结果

数组，元素常见字段：`id`、`name`、`provider`、`modelId`、`supportsVision`、`isDefault`、`contextWindowTokens`、`status`。

### 示例

```bash
mao-user model list-active --json
```

---

## 命令：mao-user model default

### 用途

获取系统默认模型；若无默认可能返回 `null`。

### 参数说明

无。

### 示例

```bash
mao-user model default
```

---

## 命令：mao-user model get

### 用途

按主键 ID 获取模型详情。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--id` | 是 | 数字 | 模型主键 ID，对应路径 `/models/{id}` |

注意：这里的 `--id` 是数据库主键，不是模型厂商的 `modelId` 字符串。

### 示例

```bash
mao-user model get --id 3
```

---

## 命令：mao-user model providers

### 用途

列出已配置的模型提供商名称列表。

### 参数说明

无。

### 示例

```bash
mao-user model providers
```

## 与会话的关系

创建/更新会话时可传 `--model-id`（模型主键）。不传则服务端使用默认模型。
