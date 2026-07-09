# OSS 与上传配置（oss / upload-config）

## 模块职责

获取对象存储临时凭证（STS），以及查询当前上传存储配置。

## 命令选择

| 场景 | 命令 |
|------|------|
| 获取 STS | `oss sts-token` |
| 查看上传配置 | `upload-config get` |

---

## 命令：mao-user oss sts-token

### 用途

申请短期 OSS 上传凭证。可选绑定会话以确定上传目录。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--session-id` | 否 | 数字 | 会话 ID → 请求体 `sessionId` |

### 返回结果

常见字段：

| 字段 | 含义 |
|------|------|
| `accessKeyId` | 临时 AK |
| `accessKeySecret` | 临时 SK |
| `securityToken` | STS token |
| `expiration` | 过期时间 |
| `bucket` | 桶名 |
| `region` | 区域 |
| `uploadDir` | 允许上传的目录前缀 |

### 示例

```bash
mao-user oss sts-token --session-id 12 --json
mao-user oss sts-token
```

---

## 命令：mao-user upload-config get

### 用途

查询服务端上传配置（存储模式与对外 baseUrl）。

### 参数说明

无。

### 返回结果

| 字段 | 含义 |
|------|------|
| `storageMode` | 存储模式（如本地或 OSS） |
| `baseUrl` | 上传资源对外访问基址 |

### 示例

```bash
mao-user upload-config get --json
```

## 注意事项

- STS 凭证含敏感信息，勿写入日志或提交到仓库
- 实际直传 OSS 的 SDK 调用不在本 CLI 范围内；本命令只负责取票
