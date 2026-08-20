# 桌面 Web 端使用

桌面端是普通用户主入口：选 Agent、建任务、对话、工作区、定时任务、通知与设置。开发默认 `http://localhost:5201`；生产多为 `https://mao.example.com`。

LOCAL 本机工具需 Electron，见 [electron.md](electron.md)。对话执行也可用 [mao-agent.md](mao-agent.md)。

## 进入方式

| 方式 | 适用 |
|------|------|
| 浏览器 Web | CLOUD 云端模式、Git 工作区、浏览器访问 |
| Electron | LOCAL 本地模式、本机目录与命令 |

## 任务列表与任务面板

左侧任务列表按工作区/项目分组；可搜索、折叠、加载更多。右侧任务检查器显示执行模式、权限档位、上下文 token、子任务与子智能体入口。接近上下文上限时会压缩历史。

## 新建任务

1. 选 Agent
2. 选 CLOUD 或 LOCAL（浏览器仅 CLOUD）
3. 选/建工作区
4. 选模型（可选，默认模型）
5. 选权限档位（LOCAL 重要）
6. 输入目标并发送

## CLOUD 云端模式

工具在服务器执行，工作区在 `WORKSPACE_ROOT` 下。

| 工作区来源 | 说明 |
|------------|------|
| 已有工作区 | 复用历史云端目录 |
| 新建 | 可填项目名或临时工作区 |
| Git 初始化 | HTTPS clone，见下文 |

**Git 工作区**：仅 HTTPS；私有库先在「设置 → Git 凭证」配 Token；可指定分支。大仓库 clone 可能 1–2 分钟。

## LOCAL 本地模式

仅 Electron：选本机目录，工具在电脑上执行。浏览器不支持。详见 [electron.md](electron.md)。

## 输入与多模态

清楚描述目标、路径、是否改代码、测试要求。模型开启「支持视觉」时可上传图片分析界面/报错截图。

## 快捷命令与文件引用

可用 `@` 引用工作区文件；个人快捷指令与个人 Skill 参与快捷面板；Agent 绑定 Skill 时会过滤展示范围。

## 回复、思考与工具

会话中可见：普通回复、思考块、工具调用、文件变更、终端输出、上下文/压缩提示。改代码后请检查工具结果与 diff。

## 工作区文件与 Git 差异

浏览文件树、查看内容与 Git 变更（只读，不自动 commit/push）。CLOUD 读服务端；LOCAL 读本机。

CLI 只读诊断：`mao file workspace-*`（见 [file.md](file.md)）。

## 停止与继续

运行中可停止；停止后可继续发消息。Side Task 可并行子会话；子智能体由 `delegate` 工具创建，在检查器中查看。

## 定时任务

Agent 可用自然语言创建定时任务；「设置 → 定时任务」查看启用/暂停/删除。会话忙时可能 `QUEUED`。

## 消息通知

「设置 → 消息通知」：钉钉或飞书机器人 Webhook；先「发送测试通知」再保存。Webhook 加密保存，生产配置 `APP_NOTIFICATION_WEBHOOK_SECRET`。

## 微信 Bot（可选）

「设置 → 微信Bot」扫码绑定；微信内对话，CLOUD 执行工具。Agent/模型由系统设置 `weixin.agentId` / `weixin.modelId` 或默认项决定。

CLI：`mao weixin ...`（见 [weixin.md](weixin.md)）。

## 个人 Skill 与 mao-cli

上传个人 Skill 覆盖同名系统 Skill。「设置」中还可管理 Git 凭证、任务面板偏好等。

REST 非对话操作统一用 `mao` CLI（本 Skill），见 [SKILL.md](../SKILL.md)。

## 权限档位与审批（LOCAL）

| 档位 | 说明 |
|------|------|
| 只读 | 搜索/读自动，写与命令需审批 |
| 读写 | 文件读写自动，命令需审批 |
| 智能审批 | 文件读写自动，命令由 AI 判断 |
| 完全权限 | 全部自动，风险最高 |

审批卡片展示待执行命令或变更，可执行/拒绝/展开查看。批准前检查目录、删除、推送、未知脚本等风险。

## Git 凭证

「设置 → Git 凭证」：按**完整主机名**（如 `git.example.com`）存 Access Token，用于 HTTPS clone 与云端 git 操作。仅 HTTPS；push 需写权限。

CLI：`mao git ...`（见 [git.md](git.md)）。

## 常见任务示例

- **分析项目**：选工作区，要求先读 README 与结构，暂不改文件
- **改代码**：明确目标，要求跑测试，审批必要命令
- **排障**：提供日志、复现步骤、相关模块
- **定时任务**：自然语言说明周期与内容，在设置页确认
- **通知**：配置 Webhook 并测试

更多 FAQ 见 [troubleshooting.md](troubleshooting.md)。
