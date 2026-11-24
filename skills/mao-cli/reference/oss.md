# OSS 与上传配置（oss / upload-config）

## 模块职责

申请对象存储预签名直传票据，以及查询当前上传存储配置。

## 命令选择

| 场景 | 命令 |
|------|------|
| 申请上传票据 | `oss ticket` |
| 查看上传配置 | `upload-config get` |

---

## 命令：mao oss ticket

### 用途

申请预签名 PUT 直传票据（`POST /v1/upload/ticket`）。服务端按存储模式（oss / cos / obs）签发对应云厂商的预签名 URL；本地存储（local）模式无需票据，图片走服务端 `/files/upload` 接口。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--content-type` | 否 | 字符串 | 图片 MIME（png/jpeg/gif/webp），缺省 image/jpeg |
| `--file-name` | 否 | 字符串 | 原始文件名，用于生成对象 key |

### 返回结果

| 字段 | 含义 |
|------|------|
| `uploadUrl` | 含签名的完整 PUT URL，有效期内直传该对象 |
| `key` | 服务端生成的对象 key（uploads/{userId}/{ts}_{name}） |
| `publicUrl` | 上传成功后的公网访问 URL（bucket 公共读口径） |
| `expiration` | 票据过期时间（ISO 8601） |

### 示例

```bash
mao oss ticket --content-type image/png --file-name avatar.png --json
mao oss ticket
```

---

## 命令：mao upload-config get

### 用途

查询服务端上传配置（存储模式与对外 baseUrl）。

### 参数说明

无。

### 返回结果

| 字段 | 含义 |
|------|------|
| `storageMode` | 存储模式：local / oss / cos / obs |
| `baseUrl` | 上传资源对外访问基址 |
| `maxSizeMb` | 单文件上限 (MB) |

### 示例

```bash
mao upload-config get --json
```

## 注意事项

- `oss sts-token`（STS 临时凭证）已随多云预签名直传改造下线，调用会得到明确报错提示
- 票据有效期固定 10 分钟，一票一对象；实际 PUT 直传不在本 CLI 范围内，本命令只负责取票
- 对象存储配置 0.0.82 起在管理后台「系统设置 → 文件与存储」维护（凭证 AES 加密、支持探针连通性测试），环境变量仅在升级首次启动时自动导入
- **发送附件快照的私有前缀 `send-files/` 必须不可公开读**：`send_image` / `send_file` 发送时会把字节 PUT 到该前缀，下载由服务端签短时 GET 代读，云地址不进消息 JSON。若桶策略是整桶 public-read，私有前缀名存实亡——必须把策略改成前缀级（OSS / COS / OBS 的 `GetObject` 放行 `uploads/*`、拒绝 `send-files/*`）。未确认之前，云模式下的发送会整体失败并返回「对象存储不可用 / 写入失败」，不会退回公开 URL
