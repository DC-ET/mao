# 贡献指南

感谢你对 Mao 的关注。本项目是**企业自托管 AI Agent 管理平台**，维护方仅提供源码与部署文档，不提供官方 SaaS 或托管实例。

## 开始之前

- 产品说明、部署与使用问答： [skills/mao-cli/SKILL.md](skills/mao-cli/SKILL.md)
- 本地开发安装： [skills/mao-cli/reference/install.md](skills/mao-cli/reference/install.md)
- 许可证为 [MIT](LICENSE)

## 开发环境

### 前置依赖

- Node.js 22+
- npm 10+
- MySQL 8.x
- C/C++ 构建工具链（`python3 make g++` / Xcode CLT）：后端 `node-pty` 编译原生模块所需

### 后端

```bash
# 1. 创建数据库
mysql -e "CREATE DATABASE mao CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 2. 复制并编辑环境配置（可选，不复制则使用内置默认值）
cp backend-ts/.env.example backend-ts/.env
# 修改 MYSQL_URL、JWT_SECRET 等

# 3. 安装依赖并启动（Flyway 启动时自动执行迁移）
cd backend-ts
npm install
npm run start:dev    # 开发模式（tsx 热重载），监听 9080
```

### 前端

```bash
cd admin && npm install && npm run dev    # http://localhost:5200/admin/
cd desktop && npm install && npm run dev  # http://localhost:5201
```

默认管理员：`admin` / `admin123`。LLM 需在管理后台「模型管理」中自行配置 API Key（项目不提供官方模型服务）。

### 端到端测试

需先启动 backend、admin、desktop 三个服务，再执行：

```bash
npm test
```

### 桌面端人工冒烟（Electron）

自动化测试覆盖不到的壳行为，改动 `desktop/electron/` 或桌面设置后请在 **macOS 与 Windows 各跑一遍**：

- **LOCAL 附件**：LOCAL 会话拖入/选择非图片文件发送 → 消息含 `@绝对路径@`，文件出现在 `~/.mao/attachments/<host>/<会话id>/`；超 100MB、空文件、目录、符号链接有明确拒绝提示；同名文件二次发送不覆盖。
- **托盘与关窗**：点 X 隐藏到托盘（任务继续跑，完成时有系统通知，点击回到会话）；托盘菜单「新建任务 / 退出」可用。Windows/Linux 上 Alt+F4 同为隐藏；托盘模式下彻底退出用托盘菜单。设置 →「桌面」切「直接退出」时有确认提示，关闭窗口即退出。
- **快捷键与自启**：默认 `Alt+Shift+M` 唤起/隐藏；设置里录制新组合键即时生效；被占用时提示。开机自启开关仅在打包版可开（`npm run dev:electron` 下为禁用态）。
- **通知与角标**：设置 →「桌面」发送测试通知可见；macOS dock 角标随未读数增减。

## 提交规范

- 保持改动聚焦，避免无关重构
- 遵循项目现有代码风格（见 [AGENTS.md](AGENTS.md)）
- 涉及 API 或数据库变更时，补充 Flyway 迁移脚本
- 当前界面仅支持中文，新增 UI 文案请使用中文

## Pull Request

1. Fork 仓库并创建特性分支
2. 确保 `cd backend-ts && npm run build` 与 `cd admin && npm run build` 通过
3. 如涉及用户可见行为变更，在 PR 描述中说明
4. 等待维护者 Review

## 不在范围内的贡献

以下能力暂不接受大规模改造 PR（可在 Issue 中先讨论）：

- 官方托管 / SaaS 化
- 多语言国际化（当前仅中文）
- 官方签名的 Electron 安装包分发

## 问题反馈

- **Bug / 功能建议**：使用 GitHub Issue
- **安全漏洞**：请参阅 [SECURITY.md](SECURITY.md)，勿公开披露
