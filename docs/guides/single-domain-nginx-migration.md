# 单域名 Nginx 迁移说明

给**已经在跑双域名**的服务器用（桌面 Web 一个 host，管理后台另一个 host）。新装请直接按 [deploy.md](../../skills/mao-cli/reference/deploy.md) 配一份 `server`。

执行位置一律是 **`/opt/mao`**，不要在会话工作区里改 Nginx 或构建。本改动**不重启后端**。

目标路径：

| 用途 | 地址 |
|------|------|
| 桌面 Web | `https://<桌面域名>/` |
| 管理后台 | `https://<桌面域名>/admin/` |
| API / WS | `https://<桌面域名>/api/` |

## 1. 先看清现网

```bash
ls /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null
grep -R "server_name" /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null
```

记下：

- **桌面 host**（例如 `mao.etarch.cn`）所在文件
- **管理后台 host**（例如 `mao-admin.etarch.cn`）所在文件
- 是否已有 `listen 443 ssl` 以及 `ssl_certificate` 路径

```bash
# 确认仓库已含新构建约定
grep -n "base:" /opt/mao/admin/vite.config.ts
# 应看到 base: '/admin/'
```

若还没有这行：先在 `/opt/mao` `git pull origin main`，再继续。

## 2. 备份

```bash
sudo cp -a /etc/nginx/conf.d /etc/nginx/conf.d.bak.$(date +%Y%m%d%H%M)
sudo mkdir -p /root/nginx-mao-backup
sudo cp -a /etc/nginx/conf.d /root/nginx-mao-backup/
```

## 3. 改桌面 host 的 location（保留原证书）

**不要整文件覆盖。** 已有 HTTPS 时保留 `listen 443 ssl`、`ssl_certificate*`、`server_name`（桌面域名）、`client_max_body_size`。只调整 `location`。

必须同时满足：

1. `location ^~ /admin/`（以及 `/admin/assets/`）写在桌面端 `location ~* \.(js|css|...)$` **之前**，并用 `^~`，避免管理后台静态资源落到 `desktop/dist`
2. 管理后台 SPA fallback 是 **`/admin/index.html`**，不是 `/index.html`
3. `/api/`、`/api/ws/`、`/uploads/` 保持原样

在桌面 host 的 `server { }` 里加入（或替换旧的 admin 相关 location）：

```nginx
    location = /admin {
        return 302 /admin/;
    }
    location ^~ /admin/assets/ {
        rewrite ^/admin/(.*)$ /$1 break;
        root /opt/mao/admin/dist;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
    location ^~ /admin/ {
        rewrite ^/admin/(.*)$ /$1 break;
        root /opt/mao/admin/dist;
        index index.html;
        try_files $uri $uri/ /admin/index.html;
    }
```

完整单 `server` 示例（HTTP；HTTPS 把 `listen` / 证书按现网保留）见 [deploy.md 第三节](../../skills/mao-cli/reference/deploy.md)。

## 4. 重建管理后台（与 Nginx 同一窗口做完）

旧产物的 JS 在 `/assets/`，新产物在 `/admin/assets/`。先改 Nginx 或先构建都会有短暂后台不可用，应连续执行：

```bash
cd /opt/mao && git pull origin main
bash /opt/mao/scripts/deploy-admin.sh
# 确认产物带 /admin/ 前缀
grep -o '/admin/assets/[^"]*' /opt/mao/admin/dist/index.html | head
sudo nginx -t && sudo systemctl reload nginx
```

桌面端、后端都不必因本次迁移而重建/重启。

## 5. 旧管理后台域名 301

把原来的管理后台 `server`（只服务于旧 host 的那一份）改成跳转，**保留它的证书**，避免证书告警：

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

HTTP 80 的旧 host 同样 301。改完再 `sudo nginx -t && sudo systemctl reload nginx`。

确认跳转可用后，可再停用旧 host 配置文件（`mv xxx.conf xxx.conf.disabled`），证书续期若不再需要旧域名，之后从 certbot 里去掉即可。

## 6. 验收

```bash
# 将 HOST 换成桌面域名
HOST=https://mao.example.com

curl -sI "$HOST/" | head
curl -sI "$HOST/admin/" | head
curl -sI "$HOST/admin/login" | head
# 下面应返回 200，且 Content-Type 为 JavaScript
curl -sI "$HOST$(grep -oE '/admin/assets/[^"]+\.js' /opt/mao/admin/dist/index.html | head -1)" | head

curl -s -o /dev/null -w "%{http_code}\n" "$HOST/api/swagger-ui.html"
```

浏览器：

- 桌面 Web 首页仍可用
- `https://<桌面域名>/admin/login` 能打开管理后台登录页
- 旧管理后台域名应跳到 `/admin/`

## 7. 回滚

```bash
sudo cp -a /etc/nginx/conf.d.bak.<时间戳>/. /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx
```

回滚 Nginx 后，管理后台仍是新构建（资源在 `/admin/assets/`），旧「根路径托管 admin/dist」的 vhost 会继续 404。若必须立刻恢复旧独立域名，需要把 `admin/vite.config.ts` 的 `base` 改回 `'/'` 并重新 `bash scripts/deploy-admin.sh`（不推荐；应修好单域 location）。

## 不要做

- 不要在 `/opt/mao-data/workspace/...` 里 `git pull` 或改 `/etc/nginx`
- 不要用 `alias` + `try_files` 指向 `admin/dist`（Nginx 组合容易 404）
- 不要把 `/admin/` 的 fallback 写成 `/index.html`
- 不要为这次迁移重启 `backend-ts`
- 不要改 `desktop/.env.production` 为相对路径 `/api/v1`（Electron 打包仍需要绝对 API 地址）
