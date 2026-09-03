# 常见问题与排障

按场景索引。部署见 [deploy.md](deploy.md)；配置见 [config.md](config.md)；各端手册见 [admin.md](admin.md)、[desktop.md](desktop.md)、[electron.md](electron.md)。

## 部署与后端

| 现象 | 排查 |
|------|------|
| 启动退出：`APP_GIT_CREDENTIAL_SECRET is not configured` | 检查 `backend-ts/.env` 是否存在且被 `restart.sh` 加载 |
| Nginx 502 / 后端起不来 | `ss -tlnp \| grep 9080`；核对 `MYSQL_*`；看 `logs/backend-ts-*.log` |
| 前端 404 / 旧页面 | 桌面 Nginx root 是否指向 `desktop/dist`；管理后台是否为 `/admin/` 且已按新 base 重新构建；是否已 `npm run build` |
| `/admin/` 白屏但 `/admin/login` 正常 | `curl` 看 `<title>`：若是 `Mao` 则误返回桌面 index。删掉 `rewrite ^/admin/` 与 `try_files ... /admin/index.html`，改用 `scripts/nginx/mao-admin-locations.conf`。见 [single-domain-nginx-migration.md](../../../docs/guides/single-domain-nginx-migration.md) |
| 历史工作区文件找不到 | `WORKSPACE_ROOT` 是否与 `session.workspace` 前缀一致 |
| 蓝绿后仍连旧端口 | 查 `MAO_RUNTIME_DIR/active-backend-port` 与 `mao-upstream.conf` |

## 登录与认证

- 用户名密码、用户是否禁用、后端是否在线
- LDAP/飞书：管理后台「系统设置 → 集成配置」是否启用（0.0.82 起不再用环境变量）、飞书回调地址是否为公网后端回调
- 管理后台菜单缺失：角色权限、登录是否过期

## Agent 无回复

- 模型是否配置、API Key 是否有效、API 地址是否正确
- WebSocket 是否连通（Nginx `/api/ws/` 升级头、超时）
- 刷新页面、换模型、查管理端会话与后端日志

## LOCAL 模式不可用

- 是否 Electron 或 `mao-agent --local`，而非纯浏览器
- Electron/CLI 是否保持运行、是否选了工作区
- 权限档位与审批是否拒绝
- 任务毫无回复且约 60 秒后失败：客户端版本过旧（技能同步信号缺 `syncId`），升级桌面端或 `mao-agent update`

## Git

| 问题 | 处理 |
|------|------|
| clone 失败 | HTTPS 地址；私有库 Git 凭证；主机名完全匹配 |
| SSH 地址报错 | 改为 `https://host/...` |
| push 失败 | Token 写权限；服务器是否装 `git` |

## 图片与视觉

- 模型是否开启「支持视觉」
- 图片过大或格式不支持

## 工具审批过多

与 LOCAL 权限档位有关；提高档位减少审批但增加风险。敏感操作建议保留审批。

## 找不到文件

- CLOUD vs LOCAL 工作区位置不同
- 路径是否相对工作区根；clone 是否成功

## 微信 Bot

- 桌面端是否绑定且未解绑
- `WEIXIN_BOT_ENABLED`、监控是否开启
- 系统设置 Agent/模型；服务器到 ilink 网关网络

## 定时任务

- 是否启用；Cron 是否为 Spring 格式
- 绑定会话是否存在；会话是否长期运行/等待审批
- 状态 `QUEUED`：会话忙，已排队

## 任务完成通知

- 「设置 → 消息通知」已开启且 Webhook 已测通
- 机器人安全设置；`APP_NOTIFICATION_WEBHOOK_SECRET`
- 换渠道须重新填 Webhook

## 上下文压缩

长会话接近窗口上限时自动压缩，界面有提示属正常。遗漏早期细节时可重申关键要求或引用文件。

## mao-cli / mao-agent

| 问题 | 处理 |
|------|------|
| 401 未登录 | 云端 shell 查 `MAO_TOKEN`；本地 `mao auth login` |
| `command not found: mao` | 在 mao-cli 目录 `npm install . -g` 或 `node bin/mao-cli.js` |
| mao-agent 退出码 4 | LOCAL 非 TTY 需审批；用 `--on-approval` 或 TTY |
| 对话应用 mao 发消息 | 错用工具，应换 mao-agent |
| mao-agent 界面错乱 / 边框乱码 | 终端不支持 Unicode 或宽字符：加 `--ascii`；日志采集场景用 `-p --output-format json` |
| mao-agent 终端太小报错 | 交互模式最低 8 行 × 20 列，放大窗口或改用 `-p` |
| mao-agent 提示「会话忙，已排队」 | 该会话有执行在跑，REPL 会自动重发；`-p` 用 `--if-running cancel` 抢占或 `fail` 直接退出 |
| mao-agent LOCAL 报「拒绝访问工作区外的路径」 | 路径沙箱：文件/搜索/`workdir` 必须在信任工作区或本会话 runtime 内，符号链接指向外部同样被拒。到目标目录重新启动 `mao-agent --local` |
| mao-agent LOCAL 报「拒绝服务端下发的工作区」 | 会话 workspace 被改到本地工作区之外。改回本地路径，或在目标目录新建会话 |
| mao-agent LOCAL 报找不到 bash | shell 工具固定用 bash；容器/精简系统需安装 bash |
| LOCAL shell 里 `mao` 报 401 | shell 子进程有意不注入 `MAO_TOKEN`，先在该机 `mao login` 写入 `~/.mao/auth.json` |
| `--approve-rule` 报错退出码 4 | 必须写成 `tool:pattern`；`*`、`*:*`、只写工具名都会被拒绝 |
| LOCAL 任务无任何回复、约 60 秒后失败 | 客户端版本过旧：技能同步完成信号未带 `syncId`，服务端等到超时才判失败。升级桌面端或 `mao-agent update`（修复见 0.0.94）。新版服务端会直接提示「技能同步失败：客户端未回带技能同步标识 syncId」 |
| LOCAL 任务报「技能同步失败：没有可执行本机工具的客户端连接」 | 桌面端 / `mao-agent --local` 未连上或已退出；重新启动客户端后重发 |
| `--model` / `/model` 报「多个模型名为 X」或「找不到名为 X 的模型」 | 取值优先按显示名匹配、厂商串兜底，见 [mao-agent.md](mao-agent.md) 的「模型解析」。用 `mao model list-active` 查候选，必要时直接给 `--model <id>` |

## 获取日志

```bash
tail -f /opt/mao/backend-ts/logs/backend-ts-*.log
tail -f /opt/mao/backend-ts/logs/blue-green-drain.log
```

开发环境日志目录见 `MAO_LOG_DIR` 或 `backend-ts/logs`。
