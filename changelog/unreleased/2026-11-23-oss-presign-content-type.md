### 后端

- **修复图片附件云直传全部失败（OSS 模式）**：阿里云 OSS 的 V4 预签名会把请求携带的 `Content-Type` 计入 CanonicalHeaders，而票据签发时未签该头，浏览器 `PUT` 上传图片必然带 `Content-Type`，于是全部被 OSS 以 `403 SignatureDoesNotMatch` 拒绝（页面提示「图片上传失败 / 图片全部上传失败，已取消发送」）。现在签发 OSS 票据时按前端实际携带的图片 MIME 把 `content-type` 签入，与官方 `ali-oss` `signatureUrlV4` 行为对齐（已用固定时钟向量对拍），管理后台「集成配置 → 阿里云 OSS 测试连接」的探针同步带上同一口径。COS / OBS 模式不受影响。
