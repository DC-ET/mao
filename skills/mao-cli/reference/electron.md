# Electron 桌面端与 LOCAL 模式

仓库提供 Electron **源码**，不提供官方签名安装包。LOCAL 模式下工具通过 Electron Main 在本机执行：Shell、读写文件、glob/grep、MCP，并支持工具审批。

Web 端能力与 CLOUD 说明见 [desktop.md](desktop.md)。

## 何时用 Electron

- 需要 **LOCAL** 模式访问本机项目目录
- 需要本机 Shell、文件编辑、本地 MCP
- 需要 LOCAL 工具审批流程
- 需要 LOCAL 发送本机附件（文件拷贝到 `~/.mao/attachments` 后以绝对路径引用）
- 需要托盘驻留、系统通知、全局快捷键等桌面壳能力
- 需要飞书内嵌窗口登录（内网 redirect 场景）

浏览器 `npm run dev` **不能** LOCAL。

## 开发运行

```bash
cd desktop
npm install
npm run dev:electron
```

API 地址由 `desktop/.env.development` 配置（默认 `http://localhost:9080/api/v1`）。

## 生产打包

在**开发机**（非必须服务器）：

```bash
cd desktop
# 通用包：无需为每套 Mao 改域名；运行时在客户端内配置服务器
# 若仍要出厂绑定默认站：可设置 MAO_DESKTOP_SERVER_URL，或首次启动在配置页填写
npm ci
npm run build
npm run dist
```

产物在 `desktop/release/`。代码签名与内部分发自行处理。

### 多服务器 / 通用安装包（0.0.164+）

一个桌面安装包可连接多套 Mao 私有化部署：

| 项 | 说明 |
|----|------|
| 配置存储 | Electron `userData/server-config.json`（站点根、更新源策略、是否允许 HTTP） |
| 首次启动 | 未配置时展示本地服务器配置页，填写站点地址并保存 |
| 配置入口 | 应用菜单「服务器设置…」；桌面端设置 →「服务器」 |
| 环境变量 | `MAO_DESKTOP_SERVER_URL` 锁定站点（优先于配置文件）；`MAO_DESKTOP_UPDATE_URL` 覆盖更新源 |
| 地址归一化 | 接受站点根、`/api`、`/api/v1`；无协议默认 `https://` |
| 切换行为 | 清除登录态；关闭终端/MCP/本地 Shell；LOCAL 目录按 host 隔离：`~/.mao/runtime/<host>/<sessionId>` |
| 自动更新 | `follow-site`（默认，跟随当前站 `/api/uploads/releases/`）/ `package-default` / `disabled` |

**私有部署前提**：每套 Mao 仍需在本域构建并部署桌面 Web（`VITE_API_BASE_URL=https://<本域>/api/v1`），壳只负责加载该站 SPA。各站 `version.json` 与前端资源同域即可。

API 地址由该站前端构建产物注入；壳内 skill-sync 等主进程请求从当前站点推导 `{origin}/api`。

## 自动更新

Electron 壳支持自动更新。默认检查 `https://mao.example.com/uploads/releases/`（与 Web 同域 `uploads`）。私有部署修改 `desktop/package.json` 的 `build.publish[0].url` 后再打包。

通用包推荐更新源策略 `follow-site`：从**当前配置的服务器**拉取壳安装包；若某站未托管 releases，更新会失败并降级提示，可在设置中改为 `package-default` 或关闭。

Web 前端更新：部署 `desktop/dist` 后刷新；Electron 壳更新需用户安装新包（或走自动更新）。

## 托盘、通知与快捷键（0.0.351+）

| 能力 | 说明 |
|------|------|
| 关窗到托盘 | 关闭窗口默认最小化到托盘，任务继续执行；托盘菜单「显示/隐藏主窗、新建任务、退出」，双击托盘图标显示/隐藏 |
| 关窗行为 | 设置 →「桌面」可切换「最小化到托盘 / 直接退出」；切换为直接退出时提示退出后收不到系统通知。Windows/Linux 上 Alt+F4 等同关窗 |
| 系统通知 | 任务完成 / 待审批 / 待提问由主进程投递，窗口隐藏也能收到；点击通知回到对应会话（应用未启动时点击也会在窗口就绪后补跳转）；macOS dock 角标跟随未读数 |
| 全局快捷键 | 默认 `Alt+Shift+M` 唤起/隐藏主窗口；设置 →「桌面」可录制新组合键或清除，占用时提示更换 |
| 开机自启 | 隐藏模式驻留托盘；仅打包后可用（开发模式禁用，避免把开发 electron 写进登录项） |
| 单实例锁 | 重复启动聚焦已运行实例 |
| 偏好存储 | `userData/desktop-prefs.json`，机器级：不随服务器切换、登出不清除 |

## LOCAL 附件（0.0.351+）

LOCAL 模式下可发送非图片文件：发送时懒拷贝到 `~/.mao/attachments/<服务器host>/<会话id>/`，消息文本追加 `@绝对路径@`，Agent 经绝对路径读取（文件不出本机）。

- 上限取后端上传配置（`FILE_MAX_SIZE_MB` / 设置项，默认 1024MB），主进程另硬封顶 512MB/文件；超限、空文件、目录、符号链接、不存在路径被拒绝并有提示；重名自动追加 `-1`、`-2`。
- 拷贝为异步执行，大文件不再阻塞主进程（界面保持可交互）。
- 按服务器 host 与会话隔离；更换服务器地址形态（域名 ↔ IP、http/https）后旧附件按新 host 隔离，不随迁。
- 图片仍走 CLOUD 上传链路（多模态需服务端可读）；CLOUD 模式行为不变。
- 部分文件失败时不阻断发送其余内容（弹确认）；全部失败取消发送。

## LOCAL 执行架构

1. 用户在 Electron 中创建 LOCAL 会话并选本机工作区
2. WebSocket 连接后端 `/api/ws/stream`
3. Harness 将工具调用通过 `tool_execute` 事件发给 Electron
4. `electron/main.cjs` 执行 Shell/文件/MCP，结果回传后端
5. 高风险操作按权限档位弹出审批（preload 桥接）

## 权限与审批

与 Web 端档位一致：只读 / 读写 / 智能预审 / 替我审批 / 完全权限。审批前检查命令目录、删除、远程 git、未知依赖等。

审批规则（0.0.239 起）：需要审批的 shell / MCP 调用，审批卡片会给出第三个选项「总是允许」（副标题展示确切模式，如 `npm run`），点击后当次照常执行并在服务端创建**会话级**放行规则，同会话内命中该模式的后续调用静默放行，工具卡片显示「规则放行」徽标。规则语义：

- shell 前缀规则取命令前两个词（词边界匹配，`npm run` 不放行 `npm runx`）；完整命令全等；MCP 工具按全名（`mcp__server__tool`）授权其全部参数。
- denylist 双保险：命令含受保护 token（内置 `rm`/`sudo`/`dd`/`--force` 等，admin 可经系统设置 `approval.rule.denyTokens` 扩展）时不出现「总是允许」、已建规则也不放行，照常弹卡。
- 档位准入：规则只在读写 / 智能预审 / 替我审批档生效；只读档审批是边界本身、完全权限无审批，规则在这两档不参与。
- 设置 → 审批规则 可管理**用户级**跨会话规则（启停 / 编辑 / 删除 / 新增），按命中次数（= 省掉的审批次数）排序；会话级规则随会话删除自动清理。
- 旧版 Electron 壳收不到 hint 时卡片退化为两按钮，只执行不建规则（方向安全）。

`mao-agent --local` 在终端实现类似 LOCAL 能力（工作区信任、默认拒绝清单、`--yolo`），见 [mao-agent.md](mao-agent.md)。

## 技能与 MCP 同步

LOCAL 会话启动时 Electron 可同步技能 zip 与用户 MCP 配置，与云端 Harness 工具列表对齐。

## 终端面板

底部终端按任务模式分流：LOCAL 任务开本机 shell（Electron 独有），CLOUD 任务开服务端 bash（0.0.97 起，需 `terminal:use` 权限）。两者共用同一面板与标签，标签按任务隔离。详见 [desktop.md](desktop.md#终端)。

## 与 mao-agent LOCAL 的区别

| | Electron | mao-agent --local |
|---|----------|-------------------|
| 界面 | 完整桌面 UI | 终端 REPL |
| 审批 | 图形审批卡片 | TTY 确认 / 规则 |
| 典型用户 | 日常研发协作 | CI、脚本、无 GUI 环境 |

两者均可作为 LOCAL 工具执行端连接同一后端。

## 飞书登录

Electron 使用内嵌窗口完成飞书 OAuth，避免手机扫码无法访问内网 `redirect_uri` 的问题。
