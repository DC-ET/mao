### 后端

- **浏览器依赖按需安装（browser-use 技能）**：CLOUD 服务器的浏览器内核 + `@playwright/cli` 不再强制预装——管理员在 Agent 上勾选 `browser-use` 保存、或在 Skills 管理页点「安装依赖」时，后端自动在服务器执行安装（npm 全局 CLI → 系统 Chrome deb，失败降级 npmmirror 镜像源 chromium 免 root 下载；下载源可经 `MAO_BROWSER_CHROME_DEB_URL` / `MAO_PLAYWRIGHT_DOWNLOAD_HOST` 覆盖）；**没有任何 Agent 勾选该技能则零安装**；已预装的部署检测秒过、行为不变。docker 模式的「安装依赖」触发 `mao-runtime` 镜像自动重建并验证。就绪状态经 `GET /v1/admin/browser-deps/status`（skill:read）查询，安装动作 `POST /v1/admin/browser-deps/install`（skill:write），状态落 `system_setting.browser_deps.status`（V200 迁移）
- **修复 `Dockerfile.runtime` 的 `INSTALL_CHROME` 构建参数失效**：`ARG` 声明位于使用它的 `RUN` 之后，导致按提交 fffc5dab 构建的运行时镜像实际未装 Chrome（与默认值意图相反）；已把 ARG 前移，需重建镜像生效

### 管理后台

- **Skills 管理页新增「浏览器依赖」列与「安装依赖」入口**：browser-use 行显示依赖就绪状态（未安装 / 安装中 / 就绪（chromium）/ 失败，悬浮显示详情），一键安装后自动轮询进度（2.5s），完成后自动刷新；手机卡片同步；权限复用 `skill:read` / `skill:write`
