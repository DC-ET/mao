# 部署指南

本文档说明如何将 Mao 平台**自托管**部署到 Linux 服务器（云主机或内网服务器均可）。

## 架构概览

| 组件 | 部署方式 | 端口 | 域名（示例） |
|------|---------|------|-------------|
| Java 后端 | jar + systemd | 9080 | 内网，由 Nginx 反代 |
| 管理后台 | Nginx 静态文件 | 80/443 | `mao-admin.example.com` |
| 桌面端 Web | Nginx 静态文件 | 80/443 | `mao.example.com` |
| MySQL | 自建或云服务 | 3306 | 内网 |

下文中的 `mao.example.com`、`mao-admin.example.com` 请替换为你自己的域名。

## 一、服务器环境准备

```bash
# 安装 Java 17
sudo apt update
sudo apt install -y openjdk-17-jdk

# 安装 Nginx
sudo apt install -y nginx

# 安装 Git（云端模式通过 Git 地址初始化工作区时需要）
sudo apt install -y git

# 验证
java -version
nginx -v
git --version
```

> **Git 说明**
>
> 云端模式（CLOUD）创建会话时，用户可选择通过 **HTTPS** Git 地址初始化工作区，后端会执行 `git clone`；Agent 在 Shell 中执行 `git push` / `git pull` 等远程操作时同样依赖 Git。因此运行后端的机器必须安装 `git` 命令。
>
> **仅支持 HTTPS 地址**（如 `https://git.example.com/xx/xxx.git`），不支持 SSH 格式（`git@host:...`）。私有仓库需在桌面端「设置 → Git 凭证」中按**完整主机名**配置 Personal Access Token（例如 `git.example.com`，不是 `example.com`），系统会自动用于 clone 及 Shell 内的 git 操作。

## 二、目录结构

```bash
mkdir -p /opt/mao/backend
mkdir -p /opt/mao/admin
mkdir -p /opt/mao/desktop
mkdir -p /opt/mao/logs
mkdir -p /opt/mao/data/workspace
mkdir -p /opt/mao/data/skills
mkdir -p /opt/mao/data/userskills
mkdir -p /opt/mao/data/uploads
```

## 三、后端部署

### 1. 打包 jar

```bash
# 本地执行
cd backend
mvn clean package -DskipTests

# 上传到服务器
scp target/mao-server.jar root@<SERVER_IP>:/opt/mao/backend/
```

### 2. 配置文件

在服务器创建 `/opt/mao/backend/application-prod.yml`：

```yaml
spring:
  datasource:
    url: jdbc:mysql://<DB_HOST>:3306/mao?useUnicode=true&characterEncoding=utf-8&useSSL=false&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true
    username: <DB_USER>
    password: <DB_PASSWORD>
    driver-class-name: com.mysql.cj.jdbc.Driver

jwt:
  secret: ${JWT_SECRET}
  # CLOUD shell 工具注入的临时 JWT 有效期（毫秒），默认 2 小时；可用 JWT_SHELL_EXPIRATION 覆盖
  shell-expiration: ${JWT_SHELL_EXPIRATION:7200000}

app:
  git-credential:
    secret-key: ${APP_GIT_CREDENTIAL_SECRET}
  task-notification:
    secret-key: ${APP_NOTIFICATION_WEBHOOK_SECRET}
  harness:
    workspace-root: /opt/mao/data/workspace
    skills-dir: /opt/mao/data/skills
    user-skills-dir: /opt/mao/data/userskills
  upload:
    storage-mode: ${UPLOAD_STORAGE_MODE:local}
    base-url: ${UPLOAD_BASE_URL:https://mao.example.com/api}
  file:
    upload-dir: /opt/mao/data/uploads

# 禁用 LDAP（如不需要）
ldap:
  enabled: ${LDAP_ENABLED:false}
  url: ${LDAP_URL:}
```

创建 `/opt/mao/backend/.env`（**勿提交到 Git**，权限建议 `chmod 600`）：

```bash
# 生成随机密钥
JWT_SECRET=$(openssl rand -base64 32)
APP_GIT_CREDENTIAL_SECRET=$(openssl rand -base64 32)
APP_NOTIFICATION_WEBHOOK_SECRET=$(openssl rand -base64 32)

cat > /opt/mao/backend/.env <<EOF
JWT_SECRET=${JWT_SECRET}
APP_GIT_CREDENTIAL_SECRET=${APP_GIT_CREDENTIAL_SECRET}
APP_NOTIFICATION_WEBHOOK_SECRET=${APP_NOTIFICATION_WEBHOOK_SECRET}
EOF
chmod 600 /opt/mao/backend/.env
```

| 变量 | 必需 | 说明 |
|------|------|------|
| `JWT_SECRET` | **是** | JWT 签名密钥，生产环境必须设置，禁止使用默认值 |
| `JWT_SHELL_EXPIRATION` | 否 | CLOUD shell 临时 JWT 有效期（毫秒），默认 `7200000`（2 小时） |
| `APP_GIT_CREDENTIAL_SECRET` | **是** | 用户 Git Access Token 的 AES 加密密钥；未配置时后端**拒绝启动** |
| `APP_NOTIFICATION_WEBHOOK_SECRET` | 否 | 用户任务通知 Webhook 的 AES-GCM 加密密钥；未配置时使用应用默认密钥，生产环境建议覆盖 |
| `UPLOAD_STORAGE_MODE` | 否 | `local`（默认）或 `oss` |
| `UPLOAD_BASE_URL` | local 模式建议设 | 上传文件的公网访问前缀，如 `https://mao.example.com/api` |
| `LDAP_ENABLED` | 否 | LDAP 登录开关，默认 `false` |
| `LDAP_URL` | 否 | LDAP 服务地址；仅当 `LDAP_ENABLED=true` 且该值非空时启用 LDAP 登录 |

> 首次启动时 Flyway 自动执行迁移并创建默认管理员 `admin` / `admin123`，**登录后请立即改密**。LLM API Key 在管理后台「模型管理」中配置。
>
> **Git 凭证加密密钥轮换**：更换 `APP_GIT_CREDENTIAL_SECRET` 前，需用旧密钥解密、新密钥重新加密所有 `user_git_credential` 表中的 Token，否则已存凭证无法使用。
>
> **通知 Webhook 密钥轮换**：更换 `APP_NOTIFICATION_WEBHOOK_SECRET` 前，需用旧密钥解密、新密钥重新加密通知偏好及未完成投递记录中的 Webhook，否则通知配置无法继续使用。

### 3. 启动脚本

创建 `/opt/mao/backend/restart.sh`：

```bash
#!/bin/bash

APP_NAME="mao-server"
APP_JAR="/opt/mao/backend/mao-server.jar"
PID_FILE="/opt/mao/backend/mao-server.pid"
LOG_DIR="/opt/mao/logs"
LOG_FILE="$LOG_DIR/app.log"

mkdir -p "$LOG_DIR"

rotate_log() {
    if [ -f "$LOG_FILE" ]; then
        local size=$(stat -c%s "$LOG_FILE" 2>/dev/null)
        local max_bytes=$((100 * 1024 * 1024))
        if [ "$size" -gt "$max_bytes" ] 2>/dev/null; then
            mv "$LOG_FILE" "$LOG_FILE.$(date +%Y%m%d%H%M%S)"
            ls -t "$LOG_FILE".* 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null
        fi
    fi
}

stop() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p $PID > /dev/null 2>&1; then
            echo "Stopping $APP_NAME (PID: $PID)..."
            kill $PID
            sleep 3
            if ps -p $PID > /dev/null 2>&1; then
                kill -9 $PID
            fi
        fi
        rm -f "$PID_FILE"
    fi
    pkill -f "$APP_JAR" 2>/dev/null
}

start() {
    echo "Starting $APP_NAME..."
    rotate_log

    ENV_FILE="/opt/mao/backend/.env"
    if [ -f "$ENV_FILE" ]; then
        set -a
        # shellcheck source=/dev/null
        source "$ENV_FILE"
        set +a
    else
        echo "Warning: $ENV_FILE not found. JWT_SECRET and APP_GIT_CREDENTIAL_SECRET must be set."
    fi

    nohup java -jar "$APP_JAR" \
        --spring.profiles.active=prod \
        --spring.config.additional-location=file:/opt/mao/backend/application-prod.yml \
        --ldap.enabled=false \
        --ldap.url="" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Started (PID: $(cat $PID_FILE))"
    echo "Log: tail -f $LOG_FILE"
}

stop
start
```

```bash
chmod +x /opt/mao/backend/restart.sh
```

### 4. 启动服务

```bash
cd /opt/mao/backend
./restart.sh
```

验证：

```bash
# 健康检查（Swagger UI）
curl -s -o /dev/null -w "%{http_code}" http://localhost:9080/api/swagger-ui.html
# 期望返回 200；若启动失败，查看日志中是否提示 APP_GIT_CREDENTIAL_SECRET 未配置
tail -50 /opt/mao/logs/error.log
```

## 四、前端部署

部署前请将 `desktop/.env.production` 中的 `VITE_API_BASE_URL` 改为你的实际域名。

### 1. 管理后台

```bash
cd admin
npm install
npm run build
scp -r dist/* root@<SERVER_IP>:/opt/mao/admin/
```

### 2. 桌面端 Web

```bash
cd desktop
npm install
npm run build
scp -r dist/* root@<SERVER_IP>:/opt/mao/desktop/
```

## 五、Nginx 配置

### 管理后台 — mao-admin.conf

创建 `/etc/nginx/conf.d/mao-admin.conf`：

```nginx
server {
    listen 80;
    server_name mao-admin.example.com;

    client_max_body_size 50m;

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        root /opt/mao/admin;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        root /opt/mao/admin;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:9080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    # 本地上传文件（local 模式）
    location /uploads/ {
        alias /opt/mao/data/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

### 桌面端 Web — mao.conf

创建 `/etc/nginx/conf.d/mao.conf`：

```nginx
server {
    listen 80;
    server_name mao.example.com;

    client_max_body_size 50m;

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        root /opt/mao/desktop;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        root /opt/mao/desktop;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:9080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    location /uploads/ {
        alias /opt/mao/data/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # WebSocket 流式对话
    location /api/ws/ {
        proxy_pass http://127.0.0.1:9080;
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

### 重载 Nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 六、HTTPS（推荐）

使用 certbot 申请 Let's Encrypt 证书：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mao.example.com -d mao-admin.example.com
```

## 七、防火墙 / 安全组

| 协议 | 端口 | 源 | 说明 |
|------|------|-----|------|
| TCP | 22 | 管理员 IP | SSH |
| TCP | 80 | 0.0.0.0/0 | HTTP |
| TCP | 443 | 0.0.0.0/0 | HTTPS |

后端 9080、MySQL 建议仅内网访问，不对外开放。

## 八、Electron 桌面端（可选）

仓库**仅提供 Electron 源码**，不提供官方签名安装包。如需桌面端 LOCAL 模式工具执行：

```bash
cd desktop
# 修改 .env.production 指向你的部署域名
npm install
npm run build
npm run dist
```

产物在 `desktop/release/` 目录。代码签名与内部分发需自行处理。

Electron 壳已接入自动更新。默认检查地址为 `https://mao.etarch.cn/api/uploads/releases/`；私有部署请修改 `desktop/package.json` 的 `build.publish[0].url` 后再打包。发布新版本时提升 `desktop/package.json` 的 `version`，执行 `npm run build && npm run dist`，并将 `desktop/release/` 中的安装包、`.blockmap` 与 `latest*.yml` 上传到该目录。macOS 自动更新需要签名后的 zip 产物，正式分发建议 notarize；Windows 建议签名安装包。

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
/opt/mao/backend/restart.sh

# 查看后端日志
tail -f /opt/mao/logs/info.log
tail -f /opt/mao/logs/warn.log
tail -f /opt/mao/logs/error.log

# Nginx 重载
sudo systemctl reload nginx
```

### 常见问题

| 现象 | 排查 |
|------|------|
| 后端启动后立即退出，日志提示 `APP_GIT_CREDENTIAL_SECRET is not configured` | 检查 `/opt/mao/backend/.env` 是否存在且已被 `restart.sh` 加载 |
| HTTPS 私有仓库 clone / push 认证失败 | 确认用户使用 HTTPS 地址，并在桌面端「设置 → Git 凭证」配置对应**完整主机名**的 Token |
| 提示不支持 SSH 地址 | 将 `git@host:...` 改为 `https://host/...` 格式 |
