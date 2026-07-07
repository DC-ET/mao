# 贡献指南

感谢你对 Mao 的关注。本项目是**企业自托管 AI Agent 管理平台**，维护方仅提供源码与部署文档，不提供官方 SaaS 或托管实例。

## 开始之前

- 阅读 [README.md](README.md) 了解架构与快速开始
- 阅读 [DEPLOY.md](DEPLOY.md) 了解生产部署
- 许可证为 [MIT](LICENSE)

## 开发环境

### 前置依赖

- JDK 17+
- Maven 3.8+
- Node.js 18+
- MySQL 8.x

### 后端

```bash
# 1. 创建数据库
mysql -e "CREATE DATABASE mao CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 2. 复制并编辑本地配置
cp backend/src/main/resources/application-example.yml \
   backend/src/main/resources/application-local.yml
# 修改 MySQL、JWT_SECRET 等

# 3. 确保 application.yml 中 spring.profiles.active 为 local

# 4. 启动（Flyway 自动执行迁移）
cd backend && mvn spring-boot:run
```

### 前端

```bash
cd admin && npm install && npm run dev    # http://localhost:5200
cd desktop && npm install && npm run dev  # http://localhost:5201
```

默认管理员：`admin` / `admin123`。LLM 需在管理后台「模型管理」中自行配置 API Key（项目不提供官方模型服务）。

### 端到端测试

需先启动 backend、admin、desktop 三个服务，再执行：

```bash
npm test
```

## 提交规范

- 保持改动聚焦，避免无关重构
- 遵循项目现有代码风格（见 [CLAUDE.md](CLAUDE.md)）
- 涉及 API 或数据库变更时，补充 Flyway 迁移脚本
- 当前界面仅支持中文，新增 UI 文案请使用中文

## Pull Request

1. Fork 仓库并创建特性分支
2. 确保 `cd backend && mvn compile` 与 `cd admin && npm run build` 通过
3. 如涉及用户可见行为变更，在 PR 描述中说明
4. 等待维护者 Review

## 不在范围内的贡献

以下能力暂不接受大规模改造 PR（可在 Issue 中先讨论）：

- 官方托管 / SaaS 化
- 多语言国际化（当前仅中文）
- 官方签名的 Electron 安装包分发

## 问题反馈

- **Bug / 功能建议**：使用 GitHub Issue
- **安全漏洞**：请参阅 [SECURITY.md](SECURITY.md)，勿公开披露
