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

## 自动更新

桌面壳使用 `electron-updater` + `electron-builder` 的 generic provider。默认更新地址为：

```text
https://mao.etarch.cn/downloads/desktop/
```

私有部署时请先修改 `package.json` 中 `build.publish[0].url`，再重新打包。发布新版本时需要：

1. 修改 `package.json` 的 `version`。
2. 执行 `npm run build && npm run dist`。
3. 将 `release/` 下安装包、blockmap 与 `latest*.yml` 元数据上传到更新地址。

macOS 自动更新依赖签名后的 zip 产物，正式分发建议同时完成 notarize；Windows 建议签名 NSIS 安装包。

> 仓库仅提供源码，不提供官方签名安装包。详见根目录 [README.md](../README.md)。

## 相关文档

- [DEPLOY.md](../DEPLOY.md) — 生产部署
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献指南
