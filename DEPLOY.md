# 部署指南

生产自托管部署的**完整正文**已迁入可独立分发的 Mao 产品文档：

| 主题 | 文档 |
|------|------|
| 服务器目录、Nginx、HTTPS、蓝绿重启、升级、运维 | [skills/mao-cli/reference/deploy.md](skills/mao-cli/reference/deploy.md) |
| 已有双域名环境合并为单域名 | [docs/guides/single-domain-nginx-migration.md](docs/guides/single-domain-nginx-migration.md) |
| 环境变量与数据目录 | [skills/mao-cli/reference/config.md](skills/mao-cli/reference/config.md) |
| Electron / 安卓可选部署 | [skills/mao-cli/reference/electron.md](skills/mao-cli/reference/electron.md)、[skills/mao-cli/reference/android.md](skills/mao-cli/reference/android.md) |
| 部署排障 | [skills/mao-cli/reference/troubleshooting.md](skills/mao-cli/reference/troubleshooting.md) |
| 首次部署与上线清单 | [skills/mao-cli/business_process.md](skills/mao-cli/business_process.md) |

**维护者注意**：服务器上真实部署目录为 `/opt/mao`（与云端 Agent 会话工作区路径不同）。`git pull`、构建、`restart.sh` 应在 `/opt/mao` 执行。

本地开发安装见 [skills/mao-cli/reference/install.md](skills/mao-cli/reference/install.md)。

Agent 执行部署任务时应阅读 `skills/mao-cli` 内上述文档，而非依赖本短入口。
