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

## 相关文档

- [README.md](../README.md) — 项目总览
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献指南
