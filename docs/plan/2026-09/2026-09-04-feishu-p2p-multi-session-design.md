# 飞书私聊多会话（`---` 新建 / 引用切换）技术方案

## 一、需求背景

飞书私聊中用户与机器人对话时，所有消息都落在同一个 mao 会话（session）里。用户在不同时间发送的任务意图各不相同——昨天发任务 A，今天发任务 B——导致同一个会话的上下文中混杂了多个不相关任务的对话内容：

- 任务 A 的残留上下文干扰任务 B 的执行质量；
- 用户无法「另起炉灶」开始一个干净的新任务；
- 用户想回到某个历史任务继续追问时，只能把该任务的历史重新描述一遍。

根源：`feishu_chat` 表以 `(app_id, chat_id)` 唯一键将一个私聊（`chat_id = p2p:union:{unionId}`）永久绑定到一个 `session_id`（`message.repository.ts` `findGroupConversation`），私聊 chatId 由 `p2pChatIdOf()` 按发送者 unionId 固定生成。

## 二、需求描述

### 2.1 要做的（P2P 私聊，chatType === 'p2p'）

1. **`---` 新建会话**：用户发送的文本 trim 后匹配 `^[-—]{3,}$`（3 个及以上半角连字符 `-` 或全角破折号 `—` 的宽松变体集合），即触发新建会话：
   - 创建全新 session，当前私聊的「活跃会话指针」切换到新 session；
   - 该消息本身**不进入**任何 session 的消息流（不落 USER 消息、不触发 Agent 执行）；
   - 机器人回复确认文案：「已开启新会话，后续消息将在新的上下文中处理。」；
   - 后续消息进入新会话处理。
2. **引用消息自动切换会话**：入站消息携带 `parentId`（回复/引用了某条飞书消息）时：
   - 以 `(app_id, parentId)` 查询「消息 → 会话映射表」定位被引用消息所属的 session；
   - 命中且 ≠ 当前活跃会话 → 指针切换到目标会话，回复确认：「已切换到该消息所在的会话，后续消息将以该会话上下文为准。」；
   - 命中且 = 当前活跃会话 → 静默，正常处理；
   - 查不到（上线前的历史消息、群聊消息、跨机器人消息、映射缺失）→ 静默保持当前会话不变，仅记日志，**不报错、不回复**；
   - 切换后本条消息作为目标会话的新消息正常执行；引用内容注入（【引用的消息】）保持现状。
3. **消息 → 会话映射**：记录四类飞书消息的归属（`INSERT IGNORE` 防重）：
   - 用户入站消息（入站时写入）；
   - 机器人文本回复（发送成功后取回 `message_id` 写入）；
   - 任务进度卡片（卡片创建成功后写入）；
   - 排队卡片（同上）。
4. **并行执行**：切换/新建只改指针，不干预旧会话——旧会话执行中的任务继续跑完、旧会话排队消息照常消费；新旧会话各自独立进行忙碌检查与队列，允许同时各跑各的任务（飞书侧出现两套进度卡片是预期行为）。
5. **新会话命名**：以触发新建之后第一条用户消息的前 20 个字符作为会话标题（沿用现有标题生成时机，仅替换命名来源）。
6. **共享工作区（私聊根工作区）**：同一私聊的所有会话共享首次创建的工作区目录；`---` 新建会话时把当前活跃会话的 `workspace` 传入 session 创建流程。存量活跃会话 `workspace` 为 null 时，新会话走现有默认分配逻辑。

### 2.2 明确不做的

| 不做项 | 说明 |
| --- | --- |
| 群聊任何改动 | 群聊 @机器人 发 `---` 照现状作为普通文本进入群会话交给 Agent；群聊引用消息照现状只注入引用内容；所有新逻辑用 `chatType === 'p2p'` 守卫 |
| 会话查询/管理指令 | 不做「当前在哪个会话」「列出历史会话」「切到会话 N」等命令 |
| 切换时取消/迁移旧任务 | 旧会话 RUNNING 或队列有积压时禁止/取消切换——均不做 |
| 切换时摘要注入 | 切到目标会话后不额外注入该会话历史摘要（session 上下文本就完整） |
| 历史映射回填 | 存量会话的历史消息飞书 `message_id` 本就未落库，无数据源，不做任何回填脚本 |
| 映射表定期清理 | 私聊消息量可控，不做清理任务 |
| 引用跨机器人/跨聊天消息的切换 | 查不到归属即静默，不做特殊提示 |
| 桌面/Web 端功能改动 | 多会话在现有会话列表中自然呈现，不改前端 |
| 安卓原生改动 | 无 |

## 三、技术选型与方案比选

**数据模型选型：活跃指针 + 消息映射表**（已定）。

- 备选 A「`feishu_chat` 多行 + is_active 标志」：需改 `(app_id, chat_id)` 唯一键，所有按单行查询的现有代码（群聊路径也依赖该表）都要适配，迁移风险大。**否决**。
- 选定方案 B：`feishu_chat` 行结构、唯一键均不变，`session_id` 语义升级为「当前活跃会话指针」；新增映射表承担「任意飞书消息 → session」的定位职责。群聊路径零影响；busy/队列/进度卡片/崩溃恢复全部以 sessionId 为粒度，天然兼容多会话并行。

指令识别选型：**入站链路前置拦截**（在构建 Agent 消息、入队之前判定 `---` 与引用切换），而非交给 Agent 通过提示词理解——指令必须确定性生效，不能依赖模型。

## 四、详细设计

### 4.1 数据库迁移（`backend-ts/db/migration/V101__feishu_p2p_multi_session.sql`）

新表 `feishu_p2p_message`：

```sql
CREATE TABLE IF NOT EXISTS `feishu_p2p_message` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `app_id` VARCHAR(64) NOT NULL COMMENT '飞书 bot id（feishu_bot.id 的字符串形态）',
  `message_id` VARCHAR(64) NOT NULL COMMENT '飞书消息 message_id（om_xxx），入站与出站消息统一',
  `session_id` BIGINT NOT NULL COMMENT '归属的 mao 会话 id',
  `direction` VARCHAR(8) NOT NULL DEFAULT 'IN' COMMENT 'IN=用户入站 / OUT=机器人出站（文本回复、进度卡片、排队卡片）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_feishu_p2p_message` (`app_id`, `message_id`),
  KEY `idx_feishu_p2p_message_session` (`app_id`, `session_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '飞书私聊消息→会话归属映射';
```

`feishu_chat` 表结构不变，`saveConversation` 现有 `ON DUPLICATE KEY UPDATE session_id = VALUES(session_id)` 已支持指针更新，复用即可。

### 4.2 模块与职责划分（沿用现有 `src/feishu/` 领域分层）

| 模块 | 改动 |
| --- | --- |
| `message.repository.ts` | 新增 `recordP2pMessage(appId, messageId, sessionId, direction)`、`findP2pMessageSession(appId, messageId): Promise<number \| null>` |
| `message.service.ts` | 暴露上述两个能力的 service 方法；新增 `switchP2pSession(accountId, context, targetSessionId)`（锁内更新指针） |
| `agent-inbound-handler.ts` | `onMessage` 入口增加 p2p 指令分支（4.3 详述）；`FeishuSessionAdapter` 接口扩展 |
| `inbound-processor.ts` | p2p 路径把 `parentId` 原样传入 context（现已归一化，确认无丢失即可） |
| `create-app.ts` | sessionService 适配器实现新接口；`sendFeishuText` 取回 `message_id`；文本回复/进度卡片/排队卡片创建成功后回调记录映射 |
| `event-normalizer.ts` | 无改动（`parentId` 已提取） |

### 4.3 入站流程改造（`agent-inbound-handler.ts`）

`onMessage(context)` 在 `chatType === 'p2p'` 时插入前置分支，整体顺序：

```
p2p 入站消息
  ├─ 文本匹配 ^[-—]{3,}$ ？
  │    ├─ 是 → 创建新 session（workspace 传当前活跃会话的 workspace）
  │    │       → 更新 feishu_chat.session_id 指针（chat 级锁内）
  │    │       → 映射表记录该 '---' 消息 → 新 session（direction=IN）
  │    │       → 回复确认文案（出站映射照常记录）→ return null
  │    └─ 否 ↓
  ├─ context.parentId 非空 ？
  │    ├─ 查映射表命中且 ≠ 当前活跃 → 指针切到目标 session（chat 级锁内）→ 回复切换确认
  │    ├─ 命中且 = 当前活跃 → 静默
  │    └─ 未命中 → 静默（记日志），走当前活跃会话
  │    （该消息的映射记录归属 = 切换后的目标会话）
  └─ 正常路径：getOrCreateSession（返回指针会话）→ 记入站映射 → 忙碌检查/入队/执行（全部现状不动）
```

要点：

- **chat 级互斥**：新增 per `(accountId, p2pChatId)` 互斥锁（复用现有 `withLock` 的 Map 模式，key 从 sessionId 换成 chatKey），覆盖「读指针 → 判定指令 → 切换指针 → 确定目标 sessionId」临界区，防止并发入站消息切换/新建时的指针乱序。执行阶段仍按 sessionId 粒度 busy，不做 chat 级串行。
- **忙碌判断时机**：指令判定在忙碌检查之前——旧会话 RUNNING 时用户发 `---`/引用切换依然立即生效（只改指针，毫秒级），新消息在新会话里走空闲路径直接执行，两个会话并行互不干扰。
- `FeishuSessionAdapter` 扩展方法：`createP2pSession(accountId, context, workspace): Promise<number>`、`switchActiveSession(accountId, context, targetSessionId): Promise<void>`、`findSessionByMessageId(accountId, messageId): Promise<number | null>`、`recordP2pMessageMapping(accountId, messageId, sessionId, direction): Promise<void>`。
- 新会话标题：在确认文案发出后、首条真实消息执行前设置。实现为「新建后第一条消息进入该 session 时，若标题为默认值则以消息文本前 20 字更新标题」（`sessionRepo.updateFields`），仅 p2p 新建链路生效，群聊标题逻辑不动。

### 4.4 出站映射记录（`create-app.ts`）

- `sendFeishuText`：现有 `client.im.v1.message.create` 的响应中取 `data.message_id`（发送失败返回 null，不记录）。
- 记录时机与归属 session：
  - 文本回复：`AgentFeishuInboundHandler` 在调用 `onReply` 处已知 sessionId，通过新注入回调 `onReplySent(context, messageId, sessionId)` 记录（`direction=OUT`）。未建会话的绑定引导类回复（processor 层直接 `sendReply`）无 session，跳过记录。
  - 进度卡片：`createFeishuProgressCard` 成功返回 `cardMessageId` 处记录（归属该次执行的 sessionId）。
  - 排队卡片：`createFeishuQueueCard` 成功返回处记录（归属排队目标 session）。
- 三个记录点全部经 `recordP2pMessageMapping`（`INSERT IGNORE`），重复发送/重试不产生重复行。

### 4.5 边界情况

| 场景 | 行为 |
| --- | --- |
| 引用机器人上一条回复切回旧会话 | 机器人回复有映射 → 正常切换 |
| 引用进度卡片/排队卡片 | 卡片有映射 → 正常切换 |
| 引用上线前历史消息 | 无映射 → 静默，保持当前会话 |
| `---` 后紧接着引用旧会话消息 | 引用切换覆盖新建，回到旧会话（以最后操作为准） |
| 同一飞书消息重复入站 | 飞书事件去重（现有 claim 机制）+ 映射 `INSERT IGNORE` 双保险 |
| 映射查询失败（DB 异常） | 静默降级为不切换，仅记日志，不影响消息正常执行 |
| 用户换绑到其他 mao 用户 | 沿用现有 ownerUserId 隔离逻辑，指针更新不改变 owner_user_id |

## 五、实现步骤

1. **迁移脚本**：编写 `V101__feishu_p2p_multi_session.sql`。
2. **仓储层**：`message.repository.ts` 新增 `recordP2pMessage` / `findP2pMessageSession`。
3. **服务层**：`message.service.ts` 暴露映射读写与 `switchP2pSession`（chat 级锁内更新指针）。
4. **指令分支**：`agent-inbound-handler.ts` 增加 p2p 前置分支（`---` 匹配、引用定位、指针切换、确认回复）、chat 级互斥、`FeishuSessionAdapter` 接口扩展、新会话首条消息命名。
5. **装配层**：`create-app.ts` 实现新 adapter 方法（含共享 workspace 传入）、`sendFeishuText` 取回 message_id、三个出站记录点接入。
6. **测试**：单测 + 回归（见第六节）。
7. **文档**：CHANGELOG 顶部新版本条目；`skills/mao-cli/SKILL.md` 与 `USER_GUIDE.md` 中飞书私聊用法补充说明（若存在相关章节）。

## 六、测试计划

新增/扩展单测（Vitest）：

- `agent-inbound-handler.spec.ts`：
  - `---` 严格集匹配（`---`、`———`、`-----` 命中；`--`、`--- abc`、空文本不命中）；
  - `---` 触发：新 session 创建并共享 workspace、指针更新、确认回复、消息不入 session 消息流；
  - 引用切换：命中且异会话→切换+确认；命中且同会话→静默；未命中→静默不切换；
  - 并行：旧会话 RUNNING 时新建/切换照常生效，新会话消息独立执行；
  - 入站/出站映射记录的归属正确性（含队列消费路径 `executeQueued`）。
- `message.service.spec.ts`：映射读写、`switchP2pSession` 指针更新、owner 隔离不受影响。

回归（现有用例必须全绿）：

- `cd backend-ts && npm test`（含 feishu 全部 spec：inbound-processor、event-normalizer、inbound-queue、card-action 等）；
- 根 `npm test` Playwright 抽查 admin/desktop 不受影响（本需求不触前端，抽查即可）。

## 七、落地清单

| # | 交付物 | 文件 |
| --- | --- | --- |
| 1 | 迁移脚本 | `backend-ts/db/migration/V101__feishu_p2p_multi_session.sql` |
| 2 | 映射表仓储 | `backend-ts/src/feishu/message.repository.ts` |
| 3 | 映射服务+指针切换 | `backend-ts/src/feishu/message.service.ts` |
| 4 | 入站指令分支+互斥 | `backend-ts/src/feishu/agent-inbound-handler.ts` |
| 5 | parentId 透传确认 | `backend-ts/src/feishu/inbound-processor.ts`（如有缺口） |
| 6 | 装配+出站映射记录 | `backend-ts/src/create-app.ts` |
| 7 | 类型定义 | `backend-ts/src/feishu/types.ts`（adapter 接口扩展） |
| 8 | 单测 | `agent-inbound-handler.spec.ts`、`message.service.spec.ts` 扩展 |
| 9 | CHANGELOG | 根 `CHANGELOG.md` 顶部新版本条目 |
| 10 | 用户文档同步 | `skills/mao-cli/SKILL.md`、`USER_GUIDE.md`（飞书相关章节） |

## 八、风险与对策

| 风险 | 对策 |
| --- | --- |
| 并发消息下指针乱序（用户连发消息跨新旧会话） | chat 级互斥锁保证「判定→切换→定归属」原子；消息按飞书事件到达顺序进入锁 |
| 双会话并行执行导致资源（模型/Shell）压力翻倍 | 现有 per-session busy/取消标志/Shell 管理均已按 sessionId 隔离，无共享状态；不额外设并发上限 |
| 用户对「切换」无感知导致误发消息进错会话 | 切换确认文案即时反馈；引用内容注入提供任务线索 |
| 映射表写入失败 | 写入失败仅记日志不阻断链路（与进度卡片持久化同策略）；引用切换查不到时静默兜底 |
