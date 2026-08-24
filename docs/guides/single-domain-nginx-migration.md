# 单域名 Nginx 迁移说明

给**已经在跑双域名**的服务器用。执行位置一律 **`/opt/mao`**，不要在会话工作区改 Nginx。本改动**不重启后端**。

目标：

| 用途 | 地址 |
|------|------|
| 桌面 Web | `https://<桌面域名>/` |
| 管理后台 | `https://<桌面域名>/admin/` |
| API / WS | `https://<桌面域名>/api/` |

新装完整 `server` 见 [deploy.md 第三节](../../skills/mao-cli/reference/deploy.md)。管理后台 location 的权威片段：仓库 `scripts/nginx/mao-admin-locations.conf`。

---

## 若已经迁过：`/admin/` 白屏、`/admin/login` 正常

这是旧文档里 `rewrite ^/admin/(.*)$ /$1` + `try_files ... /admin/index.html` 的已知坑，**只改 Nginx，不必重建、不必重启后端**。

原因：`/admin/` 被 rewrite 成 `/` 后，`try_files` 的内部跳转被桌面端 `location /` 接管，返回的是桌面 `index.html`（标题 `Mao`）。管理后台 JS 跑在错误的 HTML 上就是白屏。`/admin/login` 往往还能命中后台入口，所以看起来「只有根路径坏了」。

判别：

```bash
HOST=https://mao.acg.team   # 换成实际桌面域名
curl -sS "$HOST/admin/" | grep -o '<title>[^<]*</title>'
curl -sS "$HOST/admin/index.html" | grep -o '<title>[^<]*</title>'
curl -sS "$HOST/admin/login" | grep -o '<title>[^<]*</title>'
```

| 标题 | 含义 |
|------|------|
| `<title>Mao 管理后台</title>` | 后台入口，正确 |
| `<title>Mao</title>` | 误返回桌面 Web，就是本坑 |

处理：打开桌面 host 的 nginx 配置，**删掉**所有 `rewrite ^/admin/` 和 `try_files ... /admin/index.html`，换成下面「正确 location」，然后 `sudo nginx -t && sudo systemctl reload nginx`。再用上面三条 `curl` 确认标题都是 `Mao 管理后台`。

---

## 1. 看清现网

```bash
ls /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null
grep -R "server_name" /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null
grep -n "base:" /opt/mao/admin/vite.config.ts   # 应有 base: '/admin/'
```

记下桌面 host 配置文件、旧管理后台 host 配置文件、`ssl_certificate` 路径。若还没有 `base: '/admin/'`：先 `cd /opt/mao && git pull origin main`。

## 2. 备份

```bash
sudo cp -a /etc/nginx/conf.d /etc/nginx/conf.d.bak.$(date +%Y%m%d%H%M)
```

## 3. 正确 location（保留原证书，只改 location）

**不要整文件覆盖。** HTTPS 时保留 `listen 443 ssl`、`ssl_certificate*`、`server_name`（桌面域名）、`/api/`、`/api/ws/`、`/uploads/`。

把下面整段放进桌面 host 的 `server { }`，且**必须在**桌面端 `location ~* \.(js|css|...)$` 和 `location /` **之前**。可直接复制 `scripts/nginx/mao-admin-locations.conf`。

```nginx
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
```

要点：

- `/admin/`、`/admin/index.html` 用 `location =` **直接 alias 到后台 html**，不要 rewrite、不要 try_files
- `/admin/login` 等前端路由：文件不存在 → `error_page 404 = @admin`（named location **不会**再走 `location /`）
- 禁止 `rewrite ^/admin/(.*)$ /$1`（`/admin/` 会变成 `/`）
- 禁止 `try_files` 最后一项写成 URI（`/index.html` 或 `/admin/index.html` 都会重新匹配 location）

## 4. 重建管理后台（首次合并时；只修白屏则跳过）

首次从双域名切过来时，旧产物 JS 在 `/assets/`，新产物在 `/admin/assets/`。改 Nginx 与构建应连续做完：

```bash
cd /opt/mao && git pull origin main
bash /opt/mao/scripts/deploy-admin.sh
grep -o '/admin/assets/[^"]*' /opt/mao/admin/dist/index.html | head
sudo nginx -t && sudo systemctl reload nginx
```

只修白屏、产物里已经是 `/admin/assets/` 时，不必构建，reload Nginx 即可。桌面端、后端都不必动。

## 5. 旧管理后台域名 301

保留旧 vhost 的证书，整站跳到新路径：

```nginx
server {
    listen 443 ssl;
    server_name <旧管理后台域名>;
    ssl_certificate     <沿用该 vhost 原路径>;
    ssl_certificate_key <沿用该 vhost 原路径>;

    location / {
        return 301 https://<桌面域名>/admin/;
    }
}
```

HTTP 80 同样 301。然后 `sudo nginx -t && sudo systemctl reload nginx`。

## 6. 验收（必须看标题，不要只看 HTTP 200）

```bash
HOST=https://<桌面域名>

# 三条都必须是 <title>Mao 管理后台</title>，不能是单独的 Mao
curl -sS "$HOST/admin/" | grep -o '<title>[^<]*</title>'
curl -sS "$HOST/admin/index.html" | grep -o '<title>[^<]*</title>'
curl -sS "$HOST/admin/login" | grep -o '<title>[^<]*</title>'

# 桌面首页仍是 Mao
curl -sS "$HOST/" | grep -o '<title>[^<]*</title>'

# 后台 JS 200
curl -sI "$HOST$(grep -oE '/admin/assets/[^"]+\.js' /opt/mao/admin/dist/index.html | head -1)"
```

浏览器：`/` 桌面可用；`/admin/`、`/admin/index.html`、`/admin/login` 都能进管理后台；旧域名跳到 `/admin/`。

## 7. 回滚

```bash
sudo cp -a /etc/nginx/conf.d.bak.<时间戳>/. /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx
```

回滚后若后台仍是新构建（资源在 `/admin/assets/`），旧「根路径托管 admin」的 vhost 会 404。应修好单域 location，不要把 `base` 改回去。

## 不要做

- 不要在 `/opt/mao-data/workspace/...` 里 `git pull` 或改 `/etc/nginx`
- 不要 `rewrite ^/admin/(.*)$ /$1`
- 不要 `try_files $uri $uri/ /index.html` 或 `... /admin/index.html` 做后台 fallback
- 不要为这次迁移重启 `backend-ts`
- 不要改 `desktop/.env.production` 为相对路径 `/api/v1`（Electron 仍需要绝对 API 地址）
