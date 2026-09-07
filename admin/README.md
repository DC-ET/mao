# Mao 管理后台

Vue 3 + TypeScript + Element Plus 管理后台，用于 Agent、模型、用户、技能与会话管理。

## 开发

```bash
npm install
npm run dev    # http://localhost:5200
```

API 通过 Vite 代理转发到 `http://localhost:9080`。

## 构建

```bash
npm run build   # 产物在 dist/
```

生产环境通常由 Nginx 托管静态文件并反代 `/api`。详见根目录 [DEPLOY.md](../DEPLOY.md)。

## 时间展示

后台列表、详情、消息记录及移动卡片统一显示 `yyyy-MM-dd HH:mm:ss`（北京时间）。无时区的接口时间按北京时间解释，带 `Z` 或偏移量的时间转换为北京时间；空值显示 `-`，非法值显示「无效时间」。纯日期的统计图坐标与耗时不受影响。

开发时复用 `src/utils/datetime.ts` 的 `formatDateTime`，Element Plus 表格列使用 `formatDateTimeColumn`，不要直接输出原始时间字符串。

## 相关文档

- [README.md](../README.md) — 项目总览
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献指南
