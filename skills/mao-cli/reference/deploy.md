# 生产自托管部署

将 Mao 部署到 Linux 服务器（云主机或内网）。本地开发见 [install.md](install.md)。配置项见 [config.md](config.md)。

## 架构概览

| 组件 | 方式 | 端口 | 域名示例 |
|------|------|------|----------|
| TypeScript 后端 | Node + restart.sh | 9080/9081 本机 | Nginx 反代 |
| 管理后台 | Nginx 静态 `admin/dist` | 80/443 | `mao-admin.example.com` |
| 桌面 Web | Nginx 静态 `desktop/dist` | 80/443 | `mao.example.com` |
| MySQL | 自建/云 | 3306 | 内网 |

将 `mao.example.com`、`mao-admin.example.com` 替换为你的域名。

## 目录结构

```
/opt/mao/                     # git 仓库
├── admin/dist/
├── desktop/dist/
├── backend-ts/
│   ├── dist/
│   ├── node_modules/
│   ├── .env                  # chmod 600，勿提交
│   ├── restart.sh
│   ├── logs/
│   └── db/migration/
└── scripts/
    ├── deploy-admin.sh
    └── deploy-desktop.sh

/opt/mao-data/                # 运行时数据（仓库外）
├── workspace/
├── skills/
├── userskills/
├── uploads/                  # releases/ 放 APK OTA
├── users/
└── runtime/
```

首次创建数据目录：

```bash
mkdir -p /opt/mao-data/{workspace,skills,userskills,uploads,users,runtime}
```

## 一、服务器环境

```bash
# Node.js 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx git

node -v    # >= 22
nginx -v
git --version
```

**Git 说明**：CLOUD 模式通过 HTTPS Git 初始化工作区需要 `git` 命令。仅支持 HTTPS 地址；私有仓库用户在桌面端配置 Git 凭证（完整主机名）。

## 二、首次部署

### 1. 克隆

```bash
git clone https://github.com/DC-ET/mao.git /opt/mao
cd /opt/mao && git checkout main
```

### 2. 构建三端

```bash
cd /opt/mao/backend-ts && npm ci && npm run build
cd /opt/mao/admin && npm ci && npm run build
cd /opt/mao/desktop && npm ci && npm run build   # 先改 desktop/.env.production
```

或：

```bash
bash /opt/mao/scripts/deploy-admin.sh
bash /opt/mao/scripts/deploy-desktop.sh
```

### 3. 后端 `.env`

创建 `/opt/mao/backend-ts/.env`（`chmod 600`）：

```bash
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

首次启动创建 `admin/admin123`，**立即改密**。LLM Key 在管理后台「模型管理」配置。

### 4. 启动后端

```bash
chmod +x /opt/mao/backend-ts/restart.sh
/opt/mao/backend-ts/restart.sh
```

**蓝绿部署**：在 9080↔9081 备用端口启动新实例 → 健康检查 → 切换 Nginx upstream → 延迟停旧进程（`MAO_BLUE_GREEN_DRAIN_SEC` 默认 60s）。

状态文件在 `MAO_RUNTIME_DIR`：`active-backend-port`、`deploy.lock`、`deploy.flock`。

验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9080/api/swagger-ui.html
cat /opt/mao-data/runtime/active-backend-port
tail -50 /opt/mao/backend-ts/logs/backend-ts-*.log
```

## 三、Nginx

upstream（`/etc/nginx/conf.d/mao-upstream.conf`），`restart.sh` 会自动改端口：

```nginx
upstream mao_backend {
    server 127.0.0.1:9080;
}
```

9080/9081 仅本机监听；对外经 Nginx 443/80。

### 管理后台 maoadmin.conf

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

### 桌面端 mao.conf

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

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 四、HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mao.example.com -d mao-admin.example.com
```

## 五、防火墙

| 端口 | 说明 |
|------|------|
| 22 | SSH（限制源 IP） |
| 80/443 | HTTP/HTTPS |
| 9080/9081、3306 | 仅内网，不对外 |

## 六、日常升级

在 `/opt/mao` 拉代码（`.env` 不会被覆盖）：

```bash
cd /opt/mao && git pull origin main
```

| 改动 | 命令 | 重启后端 |
|------|------|----------|
| 仅 admin | `bash scripts/deploy-admin.sh` | 否 |
| 仅 desktop | `bash scripts/deploy-desktop.sh` | 否 |
| backend-ts | `cd backend-ts && npm ci && npm run build && ./restart.sh` | **是** |
| 安卓原生壳 | 更新 CHANGELOG 后 `cd android && bash build-apk.sh` | 否 |

前后端同时：

```bash
cd /opt/mao && git pull
bash scripts/deploy-admin.sh
bash scripts/deploy-desktop.sh
cd backend-ts && npm ci && npm run build && ./restart.sh
```

Flyway 在启动时自动迁移；升级期间勿多实例并发启动后端。

管理端也可 `GET /v1/admin/runtime/restart` 触发 `${MAO_ROOT_DIR}/backend-ts/restart.sh`。

## 七、Electron（可选）

在**开发机**打包 LOCAL 桌面端：

```bash
cd desktop
# 修改 .env.production 为部署域名
npm ci && npm run build && npm run dist
```

产物在 `desktop/release/`。自动更新默认检查 `https://mao.example.com/uploads/releases/`；私有部署改 `desktop/package.json` 的 `build.publish[0].url`。详见 [electron.md](electron.md)。

## 八、安卓 APK（可选）

仅原生壳变更时：

```bash
cd /opt/mao/android && bash build-apk.sh
```

APK 发布到 `/opt/mao-data/uploads/releases/`。详见 [android.md](android.md)。

## 九、访问地址

| 用途 | 地址 |
|------|------|
| 管理后台 | `https://mao-admin.example.com` |
| 桌面 Web | `https://mao.example.com` |
| Swagger | `https://mao.example.com/api/swagger-ui.html` |

## 十、运维命令

```bash
/opt/mao/backend-ts/restart.sh
tail -f /opt/mao/backend-ts/logs/backend-ts-*.log
sudo systemctl reload nginx
ss -tlnp | grep 9080
```

## 部署后检查

按 [business_process.md](business_process.md) 管理员上线清单验证。常见问题见 [troubleshooting.md](troubleshooting.md)。
