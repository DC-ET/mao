# Mao 桌面客户端

Electron + Vue 3 桌面客户端，提供 Agent 对话、LOCAL 模式本地工具执行与终端能力。

## 开发

```bash
npm install
npm run dev           # 浏览器预览 http://localhost:5201
npm run dev:electron  # Electron 模式（完整本地工具能力）
```

## 构建

```bash
npm run build   # Web 静态资源
npm run dist    # Electron 打包（需自行处理代码签名）
```

部署前请修改 `.env.production` 中的 `VITE_API_BASE_URL` 为你的后端地址。

> 仓库仅提供源码，不提供官方签名安装包。详见根目录 [README.md](../README.md)。

## 相关文档

- [DEPLOY.md](../DEPLOY.md) — 生产部署
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献指南
