# 部署指南

本文档说明如何将 Mao 平台**自托管**部署到 Linux 服务器（云主机或内网服务器均可）。

## 架构概览

| 组件 | 部署方式 | 端口 | 域名（示例） |
|------|---------|------|-------------|
| TypeScript 后端 | Node.js + restart.sh | 9080 | 内网，由 Nginx 反代 |
| 管理后台 | Nginx 静态文件（仓库内 `admin/dist/`） | 80/443 | `mao-admin.example.com` |
| 桌面端 Web | Nginx 静态文件（仓库内 `desktop/dist/`） | 80/443 | `mao.example.com` |
| MySQL | 自建或云服务 | 3306 | 内网 |

下文中的 `mao.example.com`、`mao-admin.example.com` 请替换为你自己的域名。

## 目录结构

源码与运行数据分离：

```
/opt/mao/                     # git 仓库（源码 + dist/node_modules/.env，均被 gitignore）
├── admin/dist/               # 管理后台构建产物 — Nginx root 指向此处
├── desktop/dist/             # 桌面端 Web 构建产物 — Nginx root 指向此处
├── backend-ts/
│   ├── dist/                 # 后端编译产物（node dist/main.js）
│   ├── node_modules/
│   ├── .env                  # 生产配置（chmod 600，勿提交 Git）
│   ├── restart.sh
│   ├── logs/
│   └── db/migration/         # Flyway 迁移脚本
└── scripts/
    ├── deploy-admin.sh       # 构建管理后台（原地部署，无需 rsync）
    └── deploy-desktop.sh     # 构建桌面端（原地部署，无需 rsync）

/opt/mao-data/                # 运行时数据（仓库外，与代码隔离）
├── workspace/                # Agent 工作区
├── skills/                   # 平台技能
├── userskills/               # 用户技能
├── uploads/                  # 本地上传与 APK OTA（releases/）
├── users/
└── runtime/
```

首次部署时创建运行数据目录：

```bash
mkdir -p /opt/mao-data/{workspace,skills,userskills,uploads,users,runtime}
```

## 一、服务器环境准备

```bash
# 安装 Node.js 22+（推荐使用 NodeSource 或 nvm）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 Nginx
sudo apt install -y nginx

# 安装 Git（云端模式通过 Git 地址初始化工作区时需要）
sudo apt install -y git

# 验证
node -v    # >= 22
npm -v
nginx -v
git --version
```

> **Git 说明**
>
> 云端模式（CLOUD）创建会话时，用户可选择通过 **HTTPS** Git 地址初始化工作区，后端会执行 `git clone`；Agent 在 Shell 中执行 `git push` / `git pull` 等远程操作时同样依赖 Git。因此运行后端的机器必须安装 `git` 命令。
>
> **仅支持 HTTPS 地址**（如 `https://git.example.com/xx/xxx.git`），不支持 SSH 格式（`git@host:...`）。私有仓库需在桌面端「设置 → Git 凭证」中按**完整主机名**配置 Personal Access Token（例如 `git.example.com`，不是 `example.com`），系统会自动用于 clone 及 Shell 内的 git 操作。

## 二、首次部署

### 1. 克隆仓库

```bash
git clone git@gitee.com:yangjiayi/agent-workbench-mimo.git /opt/mao
# 或 git clone git@github.com:DC-ET/mao.git /opt/mao

cd /opt/mao && git checkout main
```

### 2. 三端构建

```bash
# 后端
cd /opt/mao/backend-ts
npm ci
npm run build

# 管理后台
cd /opt/mao/admin
npm ci
npm run build

# 桌面端（部署前确认 desktop/.env.production 中 VITE_API_BASE_URL 为实际域名）
cd /opt/mao/desktop
npm ci
npm run build
```

也可使用脚本（等价于上述 `npm run build`，Nginx 已指向仓库内 `dist/`，构建完即生效）：

```bash
bash /opt/mao/scripts/deploy-admin.sh
bash /opt/mao/scripts/deploy-desktop.sh
```

### 3. 后端配置

创建 `/opt/mao/backend-ts/.env`（**勿提交到 Git**，权限建议 `chmod 600`），模板见仓库 `backend-ts/.env.example`：

```bash
# 生成随机密钥
JWT_SECRET=$(openssl rand -base64 32)
APP_GIT_CREDENTIAL_SECRET=$(openssl rand -base64 32)
APP_NOTIFICATION_WEBHOOK_SECRET=$(openssl rand -base64 32)
APP_MCP_SECRET=$(openssl rand -base64 32)

cat > /opt/mao/backend-ts/.env <<EOF
MAO_TS_PORT=9080
MAO_ROOT_DIR=/opt/mao
MAO_LOG_DIR=/opt/mao/backend-ts/logs
FLYWAY_ENABLED=true
MYSQL_URL='jdbc:mysql://<DB_HOST>:3306/mao?useUnicode=true&characterEncoding=utf-8&useSSL=false&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true&allowMultiQueries=true'
MYSQL_USERNAME=<DB_USER>
MYSQL_PASSWORD=<DB_PASSWORD>
JWT_SECRET=${JWT_SECRET}
APP_GIT_CREDENTIAL_SECRET=${APP_GIT_CREDENTIAL_SECRET}
APP_NOTIFICATION_WEBHOOK_SECRET=${APP_NOTIFICATION_WEBHOOK_SECRET}
APP_MCP_SECRET=${APP_MCP_SECRET}
UPLOAD_STORAGE_MODE=local
UPLOAD_BASE_URL=https://mao.example.com/api
FILE_UPLOAD_DIR=/opt/mao-data/uploads
WORKSPACE_ROOT=/opt/mao-data/workspace
MAO_RUNTIME_DIR=/opt/mao-data/runtime
MAO_USER_HOME_DIR=/opt/mao-data/users
SKILLS_DIR=/opt/mao-data/skills
USER_SKILLS_DIR=/opt/mao-data/userskills
EOF
chmod 600 /opt/mao/backend-ts/.env
```

| 变量 | 必需 | 说明 |
|------|------|------|
| `MAO_TS_PORT` | 否 | 监听端口，默认 `9080` |
| `MAO_ROOT_DIR` | 否 | 仓库根目录，默认 `/opt/mao` |
| `MAO_LOG_DIR` | 否 | 后端日志目录，默认 `/opt/mao/backend-ts/logs` |
| `FLYWAY_ENABLED` | 否 | 启动时是否执行 Flyway 数据库迁移，默认 `true` |
| `MYSQL_URL` / `MYSQL_USERNAME` / `MYSQL_PASSWORD` | **是** | MySQL 连接配置 |
| `JWT_SECRET` | **是** | JWT 签名密钥，生产环境必须设置，禁止使用默认值 |
| `JWT_SHELL_EXPIRATION` | 否 | CLOUD shell 临时 JWT 有效期（毫秒），默认 `7200000`（2 小时） |
| `APP_GIT_CREDENTIAL_SECRET` | **是** | 用户 Git Access Token 的 AES 加密密钥；未配置时后端**拒绝启动** |
| `APP_NOTIFICATION_WEBHOOK_SECRET` | 否 | 用户任务通知 Webhook 的 AES-GCM 加密密钥；未配置时使用应用默认密钥，生产环境建议覆盖 |
| `APP_MCP_SECRET` | 否 | MCP 服务器环境变量加密密钥；使用 MCP 功能时建议设置 |
| `UPLOAD_STORAGE_MODE` | 否 | `local`（默认）或 `oss` |
| `UPLOAD_BASE_URL` | local 模式建议设 | 上传文件的公网访问前缀，如 `https://mao.example.com/api` |
| `MAO_RUNTIME_DIR` | 否 | 运行时状态目录（蓝绿 `deploy.lock`、会话 runtime 等），默认 `/opt/mao-data/runtime` |
| `MAO_USER_HOME_DIR` | 否 | CLOUD 模式用户 HOME 目录（npm/pip 缓存等），默认 `/opt/mao-data/users` |
| `MAO_BLUE_GREEN_DRAIN_SEC` | 否 | 蓝绿切换后延迟停止旧实例秒数，默认 `60` |
| `MAO_NGINX_UPSTREAM_CONF` | 否 | Nginx upstream 文件路径，默认 `/etc/nginx/conf.d/mao-upstream.conf` |
| `SKILLS_DIR` / `USER_SKILLS_DIR` | **是** | 技能目录 |
| `FILE_UPLOAD_DIR` | **是** | 本地上传目录，如 `/opt/mao-data/uploads` |
| `LDAP_ENABLED` / `LDAP_URL` | 否 | LDAP 登录开关，默认 `false` |

> 首次启动时后端执行 Flyway 迁移并创建默认管理员 `admin` / `admin123`，**登录后请立即改密**。LLM API Key 在管理后台「模型管理」中配置。
>
> **Git 凭证加密密钥轮换**：更换 `APP_GIT_CREDENTIAL_SECRET` 前，需用旧密钥解密、新密钥重新加密所有 `user_git_credential` 表中的 Token，否则已存凭证无法使用。
>
> **通知 Webhook 密钥轮换**：更换 `APP_NOTIFICATION_WEBHOOK_SECRET` 前，需用旧密钥解密、新密钥重新加密通知偏好及未完成投递记录中的 Webhook，否则通知配置无法继续使用。

### 4. 启动后端

```bash
chmod +x /opt/mao/backend-ts/restart.sh
/opt/mao/backend-ts/restart.sh
```

`restart.sh` 行为（**蓝绿部署**）：

1. 在备用端口（9080 ↔ 9081）启动新实例并等待健康检查（`/api/swagger-ui.html`）
2. 切换 Nginx `upstream mao_backend` 到新端口
3. 立即返回成功（Shell / 管理端 API 不必等待旧实例退出）
4. 默认 **1 分钟后**异步停止旧端口进程（`MAO_BLUE_GREEN_DRAIN_SEC` 可覆盖）；排水优先由 `systemd-run --on-active` 调度，不依赖 `restart.sh` 调用方的进程树（Agent 云端 shell 部署亦可靠）

状态文件目录默认 `/opt/mao-data/runtime/`（`MAO_RUNTIME_DIR`）：

| 文件 | 说明 |
|------|------|
| `active-backend-port` | 当前对外端口 |
| `deploy.lock` | 蓝绿部署元数据（供崩溃恢复协调） |
| `deploy.flock` | 部署互斥锁 |

日志：按端口分文件 `logs/backend-ts-9080.log` / `backend-ts-9081.log`；排水日志 `logs/blue-green-drain.log`。

验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9080/api/swagger-ui.html
# 或当前 active 端口（见 /opt/mao-data/runtime/active-backend-port）
cat /opt/mao-data/runtime/active-backend-port
tail -50 /opt/mao/backend-ts/logs/backend-ts-*.log
```

## 三、Nginx 配置

前端采用**原地部署**：Nginx root 直接指向仓库内 `dist/`，构建完成即生效，无需 rsync 到独立目录。

upstream 定义（`/etc/nginx/conf.d/mao-upstream.conf`）。蓝绿部署时由 `restart.sh` 自动改写 `server` 端口；初始安装可指向 9080：

```nginx
upstream mao_backend {
    server 127.0.0.1:9080;
}
```

> 9080 / 9081 均仅本机监听，不对外开放；对外流量始终经 Nginx 443/80。

### 管理后台 — maoadmin.conf

```nginx
server {
    listen 80;
    server_name mao-admin.example.com;

    client_max_body_size 50m;

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        root /opt/mao/admin/dist;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        root /opt/mao/admin/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://mao_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

### 桌面端 Web — mao.conf

```nginx
server {
    listen 80;
    server_name mao.example.com;

    client_max_body_size 50m;

    location ~* \.(js|mjs|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        root /opt/mao/desktop/dist;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        root /opt/mao/desktop/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    location ^~ /uploads/ {
        alias /opt/mao-data/uploads/;
        expires 7d;
        add_header Cache-Control "public, immutable";
        add_header Access-Control-Allow-Origin "*" always;
    }

    location /api/ {
        proxy_pass http://mao_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    # WebSocket 流式对话
    location /api/ws/ {
        proxy_pass http://mao_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }
}
```

重载：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 四、HTTPS（推荐）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mao.example.com -d mao-admin.example.com
```

## 五、防火墙 / 安全组

| 协议 | 端口 | 源 | 说明 |
|------|------|-----|------|
| TCP | 22 | 管理员 IP | SSH |
| TCP | 80 | 0.0.0.0/0 | HTTP |
| TCP | 443 | 0.0.0.0/0 | HTTPS |

后端 9080、9081、MySQL 建议仅内网访问，不对外开放。

## 六、日常升级

在服务器 `/opt/mao` 拉取代码后，按改动范围构建。**`.env` 已被 gitignore，拉代码不会覆盖生产配置。**

```bash
cd /opt/mao
git pull origin main
```

| 改动范围 | 命令 | 是否重启后端 |
|---------|------|-------------|
| 仅 `admin/` | `bash scripts/deploy-admin.sh` | 否，刷新页面 |
| 仅 `desktop/` | `bash scripts/deploy-desktop.sh` | 否，刷新页面 |
| `backend-ts/`（含 API、DB 迁移） | `cd backend-ts && npm ci && npm run build && ./restart.sh` | **是** |
| 安卓原生壳 | 更新 `CHANGELOG.md` 后 `cd android && bash build-apk.sh` | 否 |

**前后端同时改动**时：

```bash
cd /opt/mao && git pull
bash scripts/deploy-admin.sh
bash scripts/deploy-desktop.sh
cd backend-ts && npm ci && npm run build && ./restart.sh
```

> **数据库迁移**：`FLYWAY_ENABLED` 默认 `true`，后端每次启动时自动执行 `db/migration/` 下未应用的迁移。升级期间请勿多实例同时启动后端（避免并发迁移）。
>
> 管理端也可通过 `GET /v1/admin/runtime/restart` 触发重启，脚本路径为 `${MAO_ROOT_DIR}/backend-ts/restart.sh`。

## 七、Electron 桌面端（可选）

仓库**仅提供 Electron 源码**，不提供官方签名安装包。如需桌面端 LOCAL 模式工具执行，在**开发机**上：

```bash
cd desktop
# 修改 .env.production 指向你的部署域名
npm ci
npm run build
npm run dist
```

产物在 `desktop/release/` 目录。代码签名与内部分发需自行处理。

Electron 壳已接入自动更新。默认检查地址为 `https://mao.example.com/uploads/releases/`；私有部署请修改 `desktop/package.json` 的 `build.publish[0].url` 后再打包。

## 八、安卓 APP（可选）

Capacitor 壳远程加载桌面端 Web，前端改动走第六节 Web 部署即可；仅原生壳变更时需：

```bash
cd /opt/mao/android
bash build-apk.sh
```

APK 发布到 `/opt/mao-data/uploads/releases/`。签名凭据可通过环境变量 `MAO_KEYSTORE_*` 或 keystore 凭据文件配置。

## 九、访问地址（示例）

| 用途 | 地址 |
|------|------|
| 管理后台 | `https://mao-admin.example.com` |
| 桌面端 Web | `https://mao.example.com` |
| Swagger API | `https://mao.example.com/api/swagger-ui.html` |

默认管理员：`admin` / `admin123`（**请立即修改**）

## 十、运维命令

```bash
# 后端重启
/opt/mao/backend-ts/restart.sh

# 查看后端日志
tail -f /opt/mao/backend-ts/logs/backend-ts.log

# Nginx 重载
sudo systemctl reload nginx

# 检查后端进程
ss -tlnp | grep 9080
```

## 常见问题

| 现象 | 排查 |
|------|------|
| 后端启动后立即退出，日志提示 `APP_GIT_CREDENTIAL_SECRET is not configured` | 检查 `/opt/mao/backend-ts/.env` 是否存在且已被 `restart.sh` 加载 |
| 后端起不来 / Nginx 502 | 确认 Node 进程监听 9080（`ss -tlnp \| grep 9080`）、`.env` 中 `MYSQL_*` 配置正确 |
| 前端 404 / 旧页面 | 确认 Nginx root 指向 `/opt/mao/admin/dist` 或 `/opt/mao/desktop/dist`，且已执行 `npm run build` |
| 历史会话工作区文件找不到 | 确认 `WORKSPACE_ROOT=/opt/mao-data/workspace`，且 `session.workspace` 路径前缀一致 |
| HTTPS 私有仓库 clone / push 认证失败 | 确认用户使用 HTTPS 地址，并在桌面端「设置 → Git 凭证」配置对应**完整主机名**的 Token |
| 提示不支持 SSH 地址 | 将 `git@host:...` 改为 `https://host/...` 格式 |
