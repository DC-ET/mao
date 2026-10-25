# 生产自托管部署

将 Mao 部署到 Linux 服务器（云主机或内网）。本地开发见 [install.md](install.md)。配置项见 [config.md](config.md)。

## 架构概览

同一域名、按路径分流（将 `mao.example.com` 替换为你的域名）：

| 组件 | 方式 | 端口 | 路径 |
|------|------|------|------|
| TypeScript 后端 | Node + restart.sh | 9080/9081 本机 | `/api/`、`/api/ws/` |
| 桌面 Web | Nginx 静态 `desktop/dist` | 80/443 | `/` |
| 管理后台 | Nginx 静态 `admin/dist`（Vite `base: '/admin/'`） | 80/443 | `/admin/` |
| 本地上传 / OTA | Nginx `alias` | 80/443 | `/uploads/` |
| MySQL | 自建/云 | 3306 | 内网 |

桌面路由勿占用 `/admin`、`/api`、`/uploads`。已有**双域名**环境的 Nginx 调整见仓库 [`docs/guides/single-domain-nginx-migration.md`](../../../docs/guides/single-domain-nginx-migration.md)。

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
sudo apt install -y nodejs nginx git python3 make g++

node -v    # >= 22
nginx -v
git --version
```

**Git 说明**：CLOUD 模式通过 HTTPS Git 初始化工作区需要 `git` 命令。仅支持 HTTPS 地址；私有仓库用户在桌面端配置 Git 凭证（完整主机名）。

**构建工具链说明**：`python3 make g++` 用于后端安装 `node-pty`（云端终端的 PTY 支持）时编译原生模块，缺失会导致 `npm ci` 失败。

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
SETTINGS_SECRET=$(openssl rand -base64 32)

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
SETTINGS_SECRET=${SETTINGS_SECRET}
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

首次启动创建 `admin/admin123`，**立即改密**。LLM Key 在管理后台「模型管理」配置。登录后顶栏「就绪横幅」会逐项提醒改密 / 配模型 / 建 Agent（可从入门模板开始），全绿即就绪。

**集成配置说明（0.0.82+）**：LDAP、飞书登录、上传、Tavily/TinyFish 搜索、OSS 已迁入管理后台「系统设置 → 集成配置」，运行期修改无需重启、不改 `.env`。`SETTINGS_SECRET` 用于这些配置中密钥项的 AES 加密，建议首次部署即配置。升级部署时旧环境变量值会在首次启动自动导入 DB，此后以管理后台为准。

### 4. 启动后端

```bash
chmod +x /opt/mao/backend-ts/restart.sh
/opt/mao/backend-ts/restart.sh
```

**蓝绿部署**：在 9080↔9081 备用端口启动新实例 → 健康检查 → 切换 Nginx upstream → 延迟停旧进程（`MAO_BLUE_GREEN_DRAIN_SEC` 默认 60s，建议 ≥20s）。0.0.211 起旧实例轮询 `deploy.lock`，确认切流完成（`status=switched` + `active-backend-port` 已指向新端口）后即静默飞书/微信/钉钉入站、等在途执行收尾（上限 40s，且随 `MAO_BLUE_GREEN_DRAIN_SEC` 收敛）、把仍被中断的会话标记 `RESUMING` 后自行退出——不再依赖 drain 定时器准点（systemd timer 可能晚几十秒）。承接流量的实例每 30s 巡检孤儿会话自动续跑；部署后的启动期延迟恢复也改为等排空窗口结束再执行，以杜绝与旧实例并发重跑。

崩溃恢复：新实例启动时若处于部署窗口，仅推迟恢复初始扫描到的 RUNNING 会话（快照重放）；快照重放后 15s 做一次全库补扫，兜住部署窗口内新建、随旧实例停止而卡 RUNNING 的会话。飞书在途任务续跑会按会话加载进度卡映射并继续 PATCH；结束后把原卡片收成完成/失败/取消。若升级前卡片停在重启时的状态，是映射字段名读错导致监听没挂上（0.0.116 已修），已卡住的卡片不会自动刷新。

状态文件在 `MAO_RUNTIME_DIR`：`active-backend-port`、`deploy.lock`、`deploy.flock`。

验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9080/api/swagger-ui.html
cat /opt/mao-data/runtime/active-backend-port
tail -50 /opt/mao/backend-ts/logs/backend-ts-*.log
```

### 5. 开机自启

后端进程由 `restart.sh` 以 `nohup` 拉起，不随 systemd 常驻。安装下面的单元后，开机在 MySQL、Nginx 就绪后按 `active-backend-port` 冷启动；该端口已经健康则跳过，不会触发蓝绿切换。

```bash
chmod +x /opt/mao/scripts/mao-backend-boot.sh /opt/mao/scripts/mao-backend-stop.sh
cp /opt/mao/scripts/systemd/mao-backend.service /etc/systemd/system/mao-backend.service
systemctl daemon-reload
systemctl enable --now mao-backend.service
```

`systemctl stop mao-backend` 会停掉 9080 和 9081。日常发版仍用 `restart.sh`（或 `scripts/restart-backend.sh`）做蓝绿，不要改成 `Restart=always`：蓝绿会主动停掉旧端口，systemd 再把它拉起来会和切流抢进程。进程自己崩溃不会被这个单元重新拉起。

## 三、Nginx

upstream（`/etc/nginx/conf.d/mao-upstream.conf`），`restart.sh` 会自动改端口：

```nginx
upstream mao_backend {
    server 127.0.0.1:9080;
}
```

9080/9081 仅本机监听；对外经 Nginx 443/80。一份 `server` 同时托管桌面 Web 与管理后台。

**管理后台 location 必须原样使用下面这一段**（仓库 `scripts/nginx/mao-admin-locations.conf`）。不要 `rewrite ^/admin/(.*)$ /$1`：`/admin/` 会被写成 `/`，`try_files` 内部跳转进桌面端 `location /`，页面标题变成 `Mao`、管理后台白屏；`/admin/login` 却可能正常。也不要把 SPA fallback 写成 URI `/index.html` 或 `/admin/index.html`，改用 named location `@admin`。`^~ /admin` 必须写在桌面端后缀匹配和 `location /` **之前**。

```nginx
server {
    listen 80;
    server_name mao.example.com;
    client_max_body_size 1024m;

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
    location /api/ {
        proxy_pass http://mao_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;

        # JSON 响应压缩：messages/列表类接口 5–10× 出流量缩减
        gzip on;
        gzip_comp_level 5;
        gzip_min_length 1024;
        gzip_types application/json text/plain text/css application/javascript;
        gzip_vary on;
    }
    location ^~ /uploads/ {
        alias /opt/mao-data/uploads/;
        expires 7d;
        add_header Cache-Control "public, immutable";
        add_header Access-Control-Allow-Origin "*" always;
    }

    # 文件服务返回的图片类 file.url 形如 {baseUrl}/uploads/x.png = /api/uploads/x.png，
    # 必须用 ^~ 前缀 location 压过下面的扩展名正则 location，否则会被 desktop/dist 吞掉变 404。
    # /api/uploads/releases/ 同理禁缓存（自动更新清单），且必须写在 /api/uploads/ 之前。
    location ^~ /api/uploads/releases/ {
        alias /opt/mao-data/uploads/releases/;
        add_header Cache-Control "no-cache" always;
        add_header Access-Control-Allow-Origin "*" always;
    }
    location ^~ /api/uploads/ {
        alias /opt/mao-data/uploads/;
        expires 7d;
        add_header Cache-Control "public, immutable";
        add_header Access-Control-Allow-Origin "*" always;
    }

    # 自动更新清单内容会变且被客户端轮询（Electron autoUpdater / 安卓 OTA），禁缓存。
    # 注意：必须用 ^~ 前缀 location 且写在 ^~ /uploads/ 之前；正则 location 会被 ^~ 压制不生效。
    location ^~ /uploads/releases/ {
        alias /opt/mao-data/uploads/releases/;
        add_header Cache-Control "no-cache" always;
        add_header Access-Control-Allow-Origin "*" always;
    }

    location = /admin {
        return 302 /admin/;
    }
    location = /admin/ {
        default_type text/html;
        alias /opt/mao/admin/dist/index.html;
    }
    location = /admin/index.html {
        default_type text/html;
        alias /opt/mao/admin/dist/index.html;
    }
    location ^~ /admin/assets/ {
        alias /opt/mao/admin/dist/assets/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
    location ^~ /admin/ {
        alias /opt/mao/admin/dist/;
        error_page 404 = @admin;
    }
    location @admin {
        root /opt/mao/admin/dist;
        rewrite ^ /index.html break;
    }

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
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

`location /api/ws/` 覆盖全部 WebSocket 通道：Agent 流式 `/api/ws/stream` 与云端终端 `/api/ws/terminal`，新增终端功能无需改 Nginx。

## 四、HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d mao.example.com
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

两个 deploy 脚本均**不接受任何参数**：`deploy-desktop.sh` 的 `--dry-run` 从未生效（参数会被静默忽略并直接执行真实构建），`deploy-admin.sh` 的 `--dry-run` 预览能力已一并移除。现传入参数一律报错退出（exit 2），不会有「以为在预览、其实已上线」的情况。安卓壳 `build-apk.sh --dry-run` 仍可用（不发布，仅构建）。

前后端同时：

```bash
cd /opt/mao && git pull
bash scripts/deploy-admin.sh
bash scripts/deploy-desktop.sh
cd backend-ts && npm ci && npm run build && ./restart.sh
```

只更新管理后台时，部署前已经打开的页面不必先手动刷新：点到尚未打开过的菜单时，若旧脚本已经不在服务器上，会自动整页打开该菜单并加载新版本（0.0.180 起）。已经打开过的菜单照常切换。若自动跳转后仍不对，再强制刷新一次。

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
| 桌面 Web | `https://mao.example.com/` |
| 管理后台 | `https://mao.example.com/admin/` |
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

## 全文检索索引（V146）

首次包含 V146 的后端发版会在启动迁移里给 `message.content` 建 ngram 全文索引。MySQL 建这个索引时会挡住整表写入（读不受影响），而且新进程要等索引建完才开始监听端口。

发版前在生产库执行：

```sql
SHOW VARIABLES LIKE 'ngram_token_size';
SELECT COUNT(*) AS rows, SUM(LENGTH(content))/1024/1024 AS content_mb
FROM message WHERE deleted = 0;
```

`ngram_token_size` 必须是 2。耗时大约按 30MB 正文一分钟估算，数据目录空闲空间不小于 `message` 表的 `data_length`。把 `MAO_BLUE_GREEN_HEALTH_RETRIES` 设成大于预估秒数（间隔 1 秒），再跑 `bash scripts/restart-backend.sh`。健康检查默认只等 60 秒，超时会杀掉正在建索引的新进程，索引会回滚，重跑会再来一次，不会跳过。

只有日志出现 `Flyway migrated V146__message_content_fulltext.sql` 才算迁移完成。切流后抽查一次两字以上的中文搜索，以及一次点开助手回复后的定位。若全文查询异常，设 `SEARCH_FULLTEXT_ENABLED=false` 后重启，查询退回模糊匹配，不要删索引。

## 容器隔离运行时（V0.0.295）

`MAO_CLOUD_RUNTIME=docker` 启用用户运行时容器隔离：该用户的 CLOUD 会话中，shell、文件工具（read/write/edit/glob/grep）、MCP stdio、云端终端在每用户独立 Docker 容器内执行，容器内只挂载该用户自己的数据目录，跨用户数据不可读；MySQL / JWT secret / LLM key / 平台级 IM appSecret 不进容器，用户级凭据（Git token、MAO_TOKEN 等）由宿主机每次派发时下发。`MAO_CLOUD_RUNTIME=host`（默认）行为与历史版本完全一致。

**全局开关也可在管理后台切换**：系统设置 → 平台与运维 → 运行环境 → 「用户运行时模式」。DB 值（`system_setting.runtime.mode`，V160）优先于 `MAO_CLOUD_RUNTIME`，保存后无需重启、5 秒内生效；切到 `docker` 时后端先执行容器预检（Docker 可用 + 镜像存在 + socket 根目录可写），预检失败直接拒绝保存并返回原因，不会出现「配置已是 docker 但机器上跑不起来」。`MAO_CLOUD_RUNTIME` 从此只作为缺省值（DB 行缺失 / 值非法 / 查询失败时使用）。

### 前置条件

1. **Docker**：生产机安装 Docker（`docker version` 可用）。容器使用默认 bridge 网络，可出网（npm/pip 安装、curl 外部 API），不对外暴露任何端口，进出只走 Unix socket。
2. **运行时镜像**：构建 `mao-runtime` 镜像（Node + bash + git + coreutils + 与镜像 Node ABI 匹配的 `sharp`/`node-pty`）：

   ```bash
   bash scripts/build-runtime-image.sh        # 产出 mao-runtime:latest
   ```

   版本从 `backend-ts/package.json` 读取。**宿主机 Node 升级后必须同步重建镜像**，否则容器内读图（sharp）与终端（node-pty）静默失败。
3. **数据目录**：`/opt/mao-data/runtime/channels`（socket 根）与 `/opt/mao-data/deps`（持久依赖）需存在且后端进程可写（首次启动预检会校验，不满足直接启动失败，不静默降级）。
4. **上传目录**：图片产物（`generate_image` / `edit_image`）落 `{FILE_UPLOAD_DIR}/{userId}/`（宿主机按用户隔离、同名挂入容器），外网经 Nginx `^~ /uploads/` 与 `^~ /api/uploads/` 两个前缀访问；按用户隔离后请确认 Nginx 配置含这两个 location（见上文 Nginx 片段），否则图片类 `file.url` 会被扩展名正则 location 吞掉变 404。
5. **公共共享目录**：`/opt/mao-data/share`（`MAO_SHARE_DIR` 可覆盖）由后端启动自动创建，无需手工准备。管理员向其中投放文件后，全体 CLOUD 用户的 Agent 即可读取；其 `agent-experience/` 子目录为 **Agent 团队经验库**（0.0.342 起，按 Agent 分库 `<agentId>/`，Agent 会话可读写沉淀经验，管理后台可维护）。**0.0.342 起容器模式该目录改为 rw 挂载**（经验库需容器内写入；挂载 mode 参与容器指纹，升级后存量容器自动重建），管理员投放内容的防误删从挂载层退化为信任 + 备份兜底。投放即时生效（目录级挂载，新增/修改文件无需重启或重建容器）；建议属主与后端运行用户一致、权限 755。**共享即公开**：请勿向该目录投放敏感内容。目录不计入任何用户配额，占满磁盘影响全体服务，建议纳入 `df` 监控；经验库为 Agent 自动写入且整根可写，建议每日快照兜底（示例：`0 3 * * * tar -czf /opt/mao-data/backup/share-$(date +\%F).tgz -C /opt/mao-data share && find /opt/mao-data/backup -name 'share-*.tgz' -mtime +14 -delete`）。

### 配置（环境变量，见 config.md）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAO_CLOUD_RUNTIME` | `host` | 部署缺省值：`docker` 为容器模式。管理后台「系统设置 → 运行环境 → 用户运行时模式」优先，后台未配置 / 值非法时回落此值 |
| `MAO_CONTAINER_IDLE_MINUTES` | `60` | 空闲回收阈值。**必须大于管理后台「系统设置」的 shell 会话空闲超时（默认 30）**：容器先停会把容器内全部 shell 会话与后台任务杀掉 |
| `MAO_CONTAINER_MAX_LIFETIME_HOURS` | `72` | 强制重建阈值 |
| `MAO_CONTAINER_MEMORY_MB` / `MAO_CONTAINER_CPUS` / `MAO_CONTAINER_PIDS_LIMIT` | 2048 / 2 / 512 | 单容器资源上限 |
| `MAO_CONTAINER_IMAGE` | `mao-runtime:latest` | 运行时镜像 |
| `MAO_CONTAINER_CHANNEL_DIR` | `/opt/mao-data/runtime/channels` | socket 根目录（每用户子目录） |
| `MAO_CONTAINER_DEPS_DIR` | `/opt/mao-data/deps` | 持久依赖目录（npm -g / pip 安装位置，容器重建不丢） |
| `MAO_CONTAINER_TMP_DIR` | `/opt/mao-data/tmp` | 每用户 /tmp 持久根：`{tmpDir}/{userId}` 挂到容器 `/tmp`（stop/重建不丢），目录权限 1777 |
| `MAO_CONTAINER_TMP_RETENTION_DAYS` | `7` | /tmp 过期清理阈值（按 mtime，天）；容器创建与空闲巡检时顺带清理，0/负数按 7 处理 |

### 灰度与回收

- 全局切换：管理后台「系统设置 → 平台与运维 → 运行环境 → 用户运行时模式」（host / docker），保存即生效、无需重启；切到 docker 时先预检，失败拒绝保存。DB 值优先于 `MAO_CLOUD_RUNTIME`。
- 用户级覆盖：管理后台「用户管理 → 编辑用户 → 运行时模式」（跟随全局 / 容器隔离 / 宿主机）。先对内部账号开启观察，再逐步放大。
- 空闲回收只 `docker stop` 不删（数据在挂载卷，秒级恢复）；容器内有活跃 shell 会话 / 未消费后台任务 / attach 中终端时不回收。异常容器兜底清理：`scripts/container-gc.sh`（建议 cron 每 10 分钟）。
- 切换（全局或单用户）到 docker 模式时，其宿主机上仍活着的旧 shell 会话会被终止，不做迁移。

### 运维排查

- 容器名 `mao-user-{userId}`；socket 位于 `{MAO_CONTAINER_CHANNEL_DIR}/{userId}/runtime.sock`，容器接入需通过该目录下的 token 校验（其他用户的容器挂载不到该目录）。
- 挂载清单由后端集中生成并审计（启动日志 `[container-mount]`），含每行容器内路径、宿主机源路径与 rw/ro。
