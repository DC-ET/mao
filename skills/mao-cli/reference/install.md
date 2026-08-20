# 本地开发安装

在开发机克隆仓库并启动后端、管理后台、桌面端。生产服务器部署见 [deploy.md](deploy.md)。

## 环境要求

- Node.js 22+
- npm 10+
- MySQL 8.x

## 仅对话、不部署整套平台

```bash
curl -fsSL https://raw.githubusercontent.com/DC-ET/mao/main/scripts/install-mao-agent.sh | bash
mao-agent login
mao-agent
```

需 Node.js ≥ 20。默认对接 `https://mao.etarch.cn/api`，可用 `MAO_AGENT_BASE_URL` 指向自己的后端。详见 [mao-agent.md](mao-agent.md)。

## 1. 获取源码

```bash
git clone https://github.com/DC-ET/mao.git
cd mao
```

## 2. 初始化数据库

```bash
mysql -e "CREATE DATABASE mao CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

复制后端环境模板（可选，不复制则使用内置默认值）：

```bash
cp backend-ts/.env.example backend-ts/.env
```

编辑 `backend-ts/.env`，至少配置 `MYSQL_URL`、`MYSQL_USERNAME`、`MYSQL_PASSWORD`。生产或对外暴露时请设置 `JWT_SECRET`。完整变量见 [config.md](config.md)。

## 3. 启动后端

```bash
cd backend-ts
npm install
npm run start:dev
```

- 服务：`http://localhost:9080`
- Swagger：`http://localhost:9080/api/swagger-ui.html`
- Flyway 迁移在启动时自动执行（`FLYWAY_ENABLED` 默认 true）

## 4. 配置 LLM 模型

用默认管理员登录管理后台，进入「模型管理」，添加模型并填入真实 API Key。迁移会插入占位模型 `deepseek-v4-flash`（`sk-xxxxxxxxxxxx`），**必须替换后才能对话**。操作说明见 [admin.md](admin.md)。

## 5. 启动管理后台

```bash
cd admin
npm install
npm run dev
```

访问 `http://localhost:5200`

## 6. 启动桌面端

```bash
cd desktop
npm install
npm run dev           # 浏览器 http://localhost:5201
npm run dev:electron  # Electron（LOCAL 工具）
```

## 一键启停（可选）

已完成上述配置后：

```bash
./scripts/start-all.sh   # backend + admin + desktop
./scripts/stop-all.sh
```

## 默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 系统管理员 |

生产环境部署后请立即改密。

## 本地前端环境变量

**管理后台** `admin/`：`.env.development` 使用 `/api/v1`（Vite 代理到 9080）；`.env.production` 为 `/api/v1`（Nginx 反代）。

**桌面端** `desktop/`：`.env.development` 为 `http://localhost:9080/api/v1`；`.env.production` 改为部署域名如 `https://mao.example.com/api/v1`。

可用 `.env.local` 覆盖（已被 gitignore）。

## 测试

```bash
cd backend-ts && npm test          # 后端单测
cd backend-ts && npm run build     # 编译检查
```

根目录 Playwright E2E 需先启动三端：`npm test`。

## 安装 mao-cli（本 Skill）

```bash
cd skills/mao-cli   # 或你拿到的独立 mao-cli 目录
npm install . -g
mao auth login --username admin --password admin123 --base-url http://localhost:9080/api/v1
```
