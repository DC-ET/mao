# 部署指南

本文档说明如何将 Mao 平台**自托管**部署到 Linux 服务器（云主机或内网服务器均可）。

## 架构概览

| 组件 | 部署方式 | 端口 | 域名（示例） |
|------|---------|------|-------------|
| Java 后端 | jar + systemd | 9080 | 内网，由 Nginx 反代 |
| 管理后台 | Nginx 静态文件 | 80/443 | `mao-admin.example.com` |
| 桌面端 Web | Nginx 静态文件 | 80/443 | `mao.example.com` |
| MySQL | 自建或云服务 | 3306 | 内网 |
| Redis | 自建或云服务 | 6379 | 内网 |

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

> **Git 说明**：云端模式（CLOUD）创建会话时，用户可选择通过 Git 仓库地址初始化工作区，后端会执行 `git clone`。因此运行后端的机器必须安装 `git` 命令。若需克隆私有仓库（SSH 协议），还需在**运行 Java 进程的用户**下配置 SSH 密钥，并将公钥添加到 GitLab 等平台的 Deploy Key / SSH Key。
>
> SSH 首次连接某 Git 主机时，交互式终端会提示确认 host fingerprint。后端以非交互方式执行 `git clone`，会在 clone 前自动调用 `ssh-keyscan` 写入运行 Java 进程用户的 `~/.ssh/known_hosts`，无需人工输入 `yes`。也可在部署时预先执行：
>
> ```bash
> # 以运行后端的同一用户执行（示例用户 root，请按实际替换）
> ssh-keyscan -H github.com >> ~/.ssh/known_hosts
> ```

## 二、目录结构

```bash
mkdir -p /opt/mao/backend
mkdir -p /opt/mao/admin
mkdir -p /opt/mao/desktop
mkdir -p /data/logs/mao
mkdir -p /data/workbench/workspace
mkdir -p /data/workbench/skills
mkdir -p /data/workbench/userskills
mkdir -p /data/workbench/uploads
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

  data:
    redis:
      host: <REDIS_HOST>
      port: 6379
      password: <REDIS_PASSWORD>
      database: 1

jwt:
  secret: <运行 openssl rand -base64 32 生成>

app:
  harness:
    workspace-root: /data/workbench/workspace
    skills-dir: /data/workbench/skills
    user-skills-dir: /data/workbench/userskills
  upload:
    storage-mode: ${UPLOAD_STORAGE_MODE:local}
    base-url: ${UPLOAD_BASE_URL:https://mao.example.com/api}
  file:
    upload-dir: /data/workbench/uploads

# 禁用 LDAP（如不需要）
ldap:
  url: ${LDAP_URL:}
```

> 首次启动时 Flyway 自动执行迁移并创建默认管理员 `admin` / `admin123`，**登录后请立即改密**。LLM API Key 在管理后台「模型管理」中配置。

### 3. 启动脚本

创建 `/opt/mao/backend/restart.sh`：

```bash
#!/bin/bash

APP_NAME="mao-server"
APP_JAR="/opt/mao/backend/mao-server.jar"
PID_FILE="/opt/mao/backend/mao-server.pid"
LOG_DIR="/data/logs/mao"
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
    nohup java -jar "$APP_JAR" \
        --spring.profiles.active=prod \
        --spring.config.additional-location=file:/opt/mao/backend/application-prod.yml \
        -DLDAP_URL="" >> "$LOG_FILE" 2>&1 &
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

验证：`curl http://localhost:9080/api/swagger-ui.html`

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
        alias /data/workbench/uploads/;
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
        alias /data/workbench/uploads/;
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

后端 9080、MySQL、Redis 建议仅内网访问，不对外开放。

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
tail -f /data/logs/mao/app.log

# Nginx 重载
sudo systemctl reload nginx
```
