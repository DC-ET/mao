# 部署指南

本文档说明如何将 Mao 平台部署到阿里云 ECS 服务器。

## 架构概览

| 组件 | 部署方式 | 端口 | 域名 |
|------|---------|------|------|
| Java 后端 | jar + systemd | 9080 | - |
| 管理后台 | Nginx 静态文件 | 80/443 | maoadmin.etarch.cn |
| 桌面端 web | Nginx 静态文件 | 80/443 | mao.etarch.cn |
| MySQL | 已有服务 | 3306 | - |
| Redis | 已有服务 | 6379 | - |

## 一、服务器环境准备

```bash
# 安装 Java 17
sudo apt update
sudo apt install -y openjdk-17-jdk

# 安装 Nginx
sudo apt install -y nginx

# 验证
java -version
nginx -v
```

## 二、目录结构

```bash
mkdir -p /root/soft/mao/backend
mkdir -p /root/soft/mao/admin
mkdir -p /root/soft/mao/desktop
mkdir -p /data/logs/mao
mkdir -p /data/workbench/workspace
mkdir -p /data/workbench/skills
mkdir -p /data/workbench/userskills
```

## 三、后端部署

### 1. 打包 jar

```bash
# 本地执行
cd backend
mvn clean package -DskipTests

# 上传到服务器
scp target/mao-server.jar root@<ECS_IP>:/root/soft/mao/backend/
```

### 2. 配置文件

在服务器创建 `/root/soft/mao/backend/application-prod.yml`：

```yaml
spring:
  datasource:
    url: jdbc:mysql://<DB_HOST>:3306/agentworkbench2?useUnicode=true&characterEncoding=utf-8&useSSL=false&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true
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

harness:
  workspace-root: /data/workbench/workspace
  skills-dir: /data/workbench/skills
  user-skills-dir: /data/workbench/userskills

# 禁用 LDAP（如不需要）
ldap:
  url: ${LDAP_URL:}
```

### 3. 启动脚本

创建 `/root/soft/mao/backend/restart.sh`：

```bash
#!/bin/bash

APP_NAME="mao-server"
APP_JAR="/root/soft/mao/backend/mao-server.jar"
PID_FILE="/root/soft/mao/backend/mao-server.pid"
LOG_DIR="/data/logs/mao"
LOG_FILE="$LOG_DIR/app.log"

mkdir -p "$LOG_DIR"

# 日志轮转：超过 100M 时备份
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
    nohup java -jar "$APP_JAR" --spring.profiles.active=prod -DLDAP_URL="" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Started (PID: $(cat $PID_FILE))"
    echo "Log: tail -f $LOG_FILE"
}

stop
start
```

```bash
chmod +x /root/soft/mao/backend/restart.sh
```

### 4. 启动服务

```bash
cd /root/soft/mao/backend
./restart.sh
```

验证：`curl http://localhost:9080/api/swagger-ui.html`

## 四、前端部署

### 1. 管理后台

```bash
# 本地打包
cd admin
npm install
npm run build

# 上传到服务器
scp -r dist/* root@<ECS_IP>:/root/soft/mao/admin/
```

### 2. 桌面端 web

```bash
# 本地打包
cd desktop
npm install
npm run build

# 上传到服务器
scp -r dist/* root@<ECS_IP>:/root/soft/mao/desktop/
```

## 五、Nginx 配置

### 管理后台 - maoadmin.conf

创建 `/etc/nginx/conf.d/maoadmin.conf`：

```nginx
server {
    listen 80;
    server_name maoadmin.etarch.cn;

    client_max_body_size 50m;

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        root /root/soft/mao/admin;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        root /root/soft/mao/admin;
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
}
```

### 桌面端 web - mao.conf

创建 `/etc/nginx/conf.d/mao.conf`：

```nginx
server {
    listen 80;
    server_name mao.etarch.cn;

    client_max_body_size 50m;

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        root /root/soft/mao/desktop;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        root /root/soft/mao/desktop;
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

## 六、HTTPS 配置（可选）

使用 certbot 申请 Let's Encrypt 证书：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mao.etarch.cn -d maoadmin.etarch.cn
```

## 七、安全组配置

在阿里云控制台 → ECS → 安全组，添加以下规则：

| 协议 | 端口 | 源 | 说明 |
|------|------|-----|------|
| TCP | 22 | 你的 IP | SSH |
| TCP | 80 | 0.0.0.0/0 | HTTP |
| TCP | 443 | 0.0.0.0/0 | HTTPS |

## 八、Electron 桌面端打包

桌面端打包后会加载生产环境 URL `https://mao.etarch.cn`。

```bash
cd desktop
npm install
npm run dist
```

产物在 `desktop/release/` 目录（macOS 为 .dmg，Windows 为 .exe）。

## 九、访问地址

| 用途 | 地址 |
|------|------|
| 管理后台 | https://maoadmin.etarch.cn |
| 桌面端 web | https://mao.etarch.cn |
| Swagger API | https://mao.etarch.cn/api/swagger-ui.html |

默认管理员账号：admin / admin123

## 十、运维命令

```bash
# 后端重启
/root/soft/mao/backend/restart.sh

# 查看后端日志
tail -f /data/logs/mao/app.log

# Nginx 重载
sudo systemctl reload nginx

# 查看 Nginx 日志
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```
