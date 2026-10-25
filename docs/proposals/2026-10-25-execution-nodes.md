# 提案：执行节点注册 —— 把 LOCAL 边界从「这台电脑」泛化到「我的所有机器」

> 自托管用户从来不止一台机器：公司工作站、家里 NAS、一台 VPS、一个树莓派。今天 Agent 只能在「挂着桌面端的那台」干活，其他机器对 Mao 来说不存在。

- 状态：已否决（2026-10-25），存档勿再评审
- 日期：2026-10-25
- 提案总览：见 [docs/proposals/README.md](README.md)
- 规模：中~大（新域 + agent-cli 常驻模式 + WS 路由维度改造；不动 harness 执行内核）
- 关联：`session/ws/streaming-ws-registry.ts`、`agent-cli/src/local/`（executor / sandbox / trust）、`schedule`（定时任务可靠性）、`harness/core/`（LocalToolExecutor 委托）

## 1. 背景与现状

### 1.1 LOCAL 是「单连接」模型，没有「机器」的概念

当前 LOCAL 执行的实现事实：

- 桌面 Electron 或 `mao-agent --local` 以**用户身份**连 WS（`streaming-ws-registry.ts` 的 `userSessions: Map<userId, Set<WsSocket>>`），服务端把事件广播给该用户的**所有**连接，不区分连接来自哪台机器。
- LOCAL 会话的工具调用委托给「该用户当前连着的本地客户端」，没有连接时直接报错：`Local client is not connected. Please ensure the desktop app is running.`（streaming-ws-handler.ts）。
- 同一用户多端同时在线时行为是含混的（`agent-cli/src/ws/event-filter.ts` 的注释记录了真实痛点：desktop 上另一个会话结束会让 `-p` 提前退出，CLI 只能靠本地过滤自保）。

也就是说：**「LOCAL」实际是「正在用桌面端的那台电脑」**。想让 Agent 在公司工作站上跑构建、在 NAS 上整理文件、在 VPS 上做巡检，唯一办法是在那台机器上挂一个完整客户端并祈祷它一直在前台连着。

### 1.2 一个真实场景

用户有公司工作站（编译环境齐全）和一台家用 NAS（存照片和下载）。他想：

- 白天在公司，让 Agent 直接在**工作站**上改代码、跑测试（LOCAL 的原意）；
- 每天凌晨 2 点，让定时任务在 **NAS** 上整理下载目录、去重照片（无人值守 LOCAL）；
- 周末人在外面，临时让 Agent 在 **VPS** 上查一个服务日志。

今天三条都做不到或很别扭：工作站必须挂着 Electron；NAS 装 Electron 不现实；VPS 上的 `mao-agent --local` 是一次性会话模式且与本机连接混在一起。

### 1.3 为什么现在做

- `agent-cli` 的 local 执行栈已经齐了：executor（工作区沙箱 `isWorkspaceWithin` 校验）、sandbox、trust、deny-list、approval——缺的只是「常驻注册 + 服务端路由」这层皮。
- WS 长连接、心跳重连（5s/30s）、断线恢复（crash recovery）都是既有能力，节点模式全部复用。
- 定时任务可靠性（错过补偿 / 失败重试 / 连续失败暂停）已实施，节点离线时的处置直接接入既有语义。
- 这是自托管场景对云托管产品的**结构性差异化**：云产品的执行边界在它们的机房里，Mao 的执行边界可以在用户自己的每一台机器上。

## 2. 目标 / 非目标

**目标**

1. `mao-agent --register --name <节点名> --server <实例地址>`：以**节点凭据**（独立 token，非用户密码）常驻连接，注册为该用户的命名执行节点。
2. 节点有身份与档案：名称、工作区根目录、权限档位（只读 / 读写 / …五档复用）、工具 deny-list、在线状态、最后心跳。
3. 新建 LOCAL 会话时选择目标节点（默认「本机」= 现有行为完全不变）；工具调用按会话路由到指定节点的连接。
4. 审批与通知语义不变：节点上触发的高风险操作照常推给**节点所属用户**的客户端与收件箱。
5. 定时任务可绑定节点：到点时节点离线则按既有「错过补偿 / 失败重试」语义处理并通知。
6. 节点管理页：在线状态、吊销（吊销即断开且不可重连）、按节点收紧权限。

**非目标**

- 不做远程桌面 / 端口转发 / 通用 SSH 隧道（只走既有 WS 工具协议，不新增网络通道类型）。
- 不做节点间任务迁移 / 调度均衡（用户显式选节点，不自动挑机器）。
- 不做管理员代管的全局节点池（节点是个人资产，P1 不做共享节点）。
- 不做环境预置 / 快照（工作区模板已否决；节点上的环境由用户自己准备）。
- 不改 CLOUD 模式任何行为。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 多 Agent 协作 DAG（2026-10-05 否决） | 不做 Agent 编排与队友语义；单 Agent 单会话，只是「在哪台机器上执行」多了一个选择 |
| 工作区环境模板与快照（2026-10-11 否决） | 不复制 / 分发环境，节点环境用户自备；提案只建立连接与路由 |
| 执行中引导 / 批量任务（2026-10-24 否决） | 不改执行形态（单会话单任务）；改的是执行位置的物理分布 |
| 出网边界 / 防泄漏（2026-10-09 否决） | 节点是**用户自己注册的机器**，outbound WS 出网连接（与桌面端同方向），不新增服务端入站面 |
| CLOUD 容器隔离（已实施） | 互不影响：CLOUD 隔离服务端执行；本提案扩展 LOCAL 的可达范围，安全模型仍由权限档位 + 审批 + deny-list 收口 |

## 4. 技术方案

### 4.1 节点凭据与注册

- 桌面端「设置 → 执行节点」点「添加节点」→ 生成节点 token（一次性明文展示，加密留存 hash，与 API Token 同款模式）。
- `mao-agent --register --name work-pc --server https://mao.example.com --token <节点token>`：校验通过后常驻（进程守护建议 systemd / launchd，文档给模板），上报档案（工作区根、OS、能力如 docker 可用性）。
- WS 注册帧带 `clientType='node'` + 节点 id；registry 新增**节点路由维度**：`Map<nodeId, WsSocket>`，与既有 `userSessions` 并存。

### 4.2 数据模型（迁移按实施顺序顺延，当前最新 V170）

```sql
CREATE TABLE `execution_node` (
  `id`             BIGINT PRIMARY KEY AUTO_INCREMENT,
  `owner_user_id`  BIGINT NOT NULL,
  `name`           VARCHAR(64) NOT NULL,
  `token_hash`     VARCHAR(128) NOT NULL COMMENT '节点凭据 hash，明文只在创建时展示',
  `workspace_root` VARCHAR(512) NOT NULL DEFAULT '' COMMENT '节点上报的工作区根，executor 沙箱校验用',
  `permission_level` VARCHAR(16) NOT NULL DEFAULT 'READ_ONLY' COMMENT '沿用 LOCAL 五档',
  `deny_tools_json` JSON NULL,
  `status`         VARCHAR(16) NOT NULL DEFAULT 'OFFLINE' COMMENT 'ONLINE/OFFLINE/REVOKED',
  `last_seen_at`   DATETIME NULL,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_node_owner_name` (`owner_user_id`, `name`),
  KEY `idx_node_owner` (`owner_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户执行节点';

ALTER TABLE `session` ADD COLUMN `node_id` BIGINT NULL COMMENT 'LOCAL 目标节点；NULL=本机（现状语义）', KEY `idx_session_node` (`node_id`);
```

### 4.3 会话路由与生命周期

- 新建会话：LOCAL 模式出现节点选择（「本机」+ 本人在线节点列表）；选中节点离线则拒绝创建并提示。
- 工具调用：`LocalToolExecutor` 的委托目标从「用户任一本地连接」改为「会话绑定的节点连接（node_id 非空时）」；`node_id` 为空走现状，**零行为变化**。
- 执行中断线：复用既有 crash recovery（会话进恢复态，节点重连后可继续 / 用户可在网页查看）。
- 定时任务：任务配置新增可选 `nodeId`；到点节点离线 → 记失败一次（进既有重试 / 暂停 / 通知链路），不断然放弃。
- 资源竞争：同节点并发会话数默认上限 1（节点配置可调），排队走既有 message_queue 排队语义。

### 4.4 安全模型

- 节点 token = 「在这台机器上以该用户身份执行命令（权限档位内）」的凭据：加密留存、随时吊销、吊销后 token 失效且连接立即断开。
- 节点侧沿用 `agent-cli/src/local/` 全套：工作区沙箱（服务端下发的工作区必须在 `workspace_root` 内）、deny-list、审批拦截（审批请求推给 owner 的桌面端 / 收件箱，owner 批准才执行）。
- 管理员可在 admin「用户详情」看到该用户节点数与在线情况（只读 + 可强制吊销），纳入既有审计。

### 4.5 前端

- 桌面端「设置 → 执行节点」：添加（出 token + 一行注册命令复制）、列表（在线状态 / 权限档位 / 最近心跳）、吊销。
- 新建会话 LOCAL：节点下拉（含「本机」默认）；节点离线置灰并提示。
- 定时任务编辑：LOCAL 任务多一个「执行节点」选项。
- `skills/mao-cli/reference/mao-agent.md` 增补节点模式与 systemd/launchd 守护模板。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | 节点表 + token + 注册常驻 + WS 节点路由 + 会话绑定节点执行 + 离线拒绝 + 吊销 + 桌面端节点管理页 | 8-10 人日 |
| P2 | 定时任务绑节点 + 节点离线补偿语义 + 并发上限与排队 + 断线恢复打磨 | 4-6 人日 |
| P3 | 节点档案增强（能力探测：docker / python / 磁盘余量，展示给模型作上下文）、节点侧日志回传、按节点用量统计 | 4-6 人日 |

**改动面（P1）**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 后端 | 新域 `backend-ts/src/node/`（注册 / 心跳 / 吊销 / 路由） | 新增 |
| 后端 | `session/ws/streaming-ws-registry.ts` + `streaming-ws-handler.ts` | 节点路由维度（本机路径零变化，回归测试护栏） |
| 后端 | `session` 创建链路 + VO | `node_id` 透传 |
| agent-cli | `--register` 常驻模式 + 节点凭据存储 | 新增 |
| desktop | 设置页节点管理 + 新建会话节点选择 | 新增 |
| 迁移 | `V171__execution_node.sql`（+ `session.node_id`，与同批提案顺延） | 一表一列 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| 节点 token 泄漏 = 他人在该机器执行命令 | 高 | 与 API Token 同级保管语义；权限档位默认只读；吊销即时生效；审计逐条留痕 |
| 家庭网络抖动导致长任务频繁中断 | 高 | 复用 crash recovery + P2 断线续跑打磨；文档建议 LAN / 有线 |
| 与「本机」语义的兼容回归 | 高 | `node_id NULL` 走现状路径的回归护栏测试必须先行（含 event-filter 既有注释场景） |
| 多会话挤占一台机器 | 中 | 默认并发 1，排队复用 message_queue |
| 节点被冒名注册 | 中 | token 一次性展示 + 绑定 owner；注册与吊销都进审计 |

**待确认决策**

1. 节点能否共享给团队其他成员（如公司公用构建机）？建议 P1 不做，观察需求。
2. 节点默认权限档位？建议只读，用户显式调高。
3. `mao-agent --local`（一次性模式）是否保留？建议保留不动，节点是新增形态而非替代。
4. Electron 桌面端本身是否注册为默认节点？建议不（保持「本机」隐式语义），避免两套身份。

## 7. 测试要点

- 注册 / 心跳 / 吊销：token 明文只在创建时返回；hash 校验；吊销后 WS 立即断开且重连被拒。
- 路由：node_id 会话的工具调用只达目标节点连接；`node_id NULL` 会话行为与现状逐字节一致（重点回归 event-filter 注释的多端互扰场景）；节点离线时创建被拒、运行中断线进恢复态。
- 沙箱：服务端下发工作区不在节点 `workspace_root` 内被 executor 拒绝（既有 `isWorkspaceWithin` 用例扩展）。
- 审批：节点上高危操作推 owner 收件箱 / 桌面端，批准前不执行；权限档位与 deny-list 生效。
- 定时任务（P2）：到点节点离线记失败进重试链路；错过补偿不重复执行。
- 并发上限：第二个会话排队而非并发挤入。

## 8. 验收标准与观察指标

**验收**

1. 两台机器分别 `--register` 后，桌面端节点列表显示两个在线节点；同一用户在两个会话里分别选不同节点发任务，工具在各自目标机器上执行，互不串扰。
2. NAS 节点凌晨定时任务在节点离线时按既有失败语义通知，节点恢复后下一次正常执行。
3. 吊销某节点后：连接断开、token 失效、该节点历史会话只读可查。
4. 不使用节点的用户（全部「本机」会话）行为与升级前无任何差异（E2E 全量回归）。

**指标（上线后 8 周）**

- 注册节点数、活跃节点数、每节点日均会话数；
- 节点离线导致的失败 / 恢复成功率；
- LOCAL 模式中「节点会话」占比（验证是否真有增量而非本机迁移）。
