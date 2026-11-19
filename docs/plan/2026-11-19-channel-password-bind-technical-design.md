# 飞书/钉钉通道「账号密码登录绑定」技术方案

- 日期：2026-11-19
- 状态：待实施（本文档不含实现）
- 需求方：杨佳毅
- 关联代码：`backend-ts/src/feishu/`（ecp-inbound-gate、pending-binding.repository、pending-replay）、`backend-ts/src/feishu-cards.ts`、`backend-ts/src/dingtalk/`（runtime、inbound-processor、binding.routes、pending-binding.repository）、`backend-ts/src/auth/`、`desktop/src/views/auth/LoginView.vue`、`desktop/src/router/index.ts`
- 关联方案：钉钉绑定先例 `backend-ts/src/dingtalk/binding.routes.ts`（登录后回跳绑定）、`docs/plan/2026-05-20-technical-design.md`（渠道绑定总体设计）
- 决策记录：2026-11-19 定夺 ①绑定页必须带一次「确认绑定」（不做全自动、不提供开关）；②钉钉密码绑定纳入本期，与飞书同期交付

## 1. 背景与目标

IM 通道（飞书、钉钉）的新用户（未绑定 Mao 账号的发送者）发消息时，机器人发引导卡完成绑定。绑定授权链接目前只有两类来源：飞书侧为 ECP 飞书登录、飞书 OAuth（`backend-ts/src/feishu/ecp-inbound-gate.ts:20`，ECP > 飞书 OAuth > 无）；钉钉侧只有钉钉 OAuth（`backend-ts/src/dingtalk/inbound-processor.ts:199` 未配置直接回退 `OAUTH_MISSING_TEXT`）。

**问题**：只开通账号密码登录、未开通对应 IM OAuth/ECP 的部署里，两个通道都没有任何绑定入口——飞书回退「请打开 Mao 桌面或网页完成操作」的文本（截图场景），钉钉回退「管理员尚未配置钉钉登录，暂时无法绑定」；设置页的绑定按钮同样依赖各自 OAuth（`POST /v1/feishu/binding`、`POST /v1/dingtalk/binding`），彻底无法使用。

**目标**：未开通 IM 登录（飞书 OAuth/ECP、钉钉 OAuth）但账号密码登录开启时，引导卡按钮改为打开 Mao 账号密码登录页；用户登录成功后进入绑定确认页，**核对双方身份并点一次「确认绑定」后完成绑定、补投刚才那条消息**（即开始处理 IM 会话），全程不离开浏览器页面。确认步是安全要求（见 §6.1），不做全自动。已开通各通道 OAuth/ECP 的部署行为不变。飞书、钉钉同期交付，共用一套确认页与绑定编排。

**可行性结论：可行，且双通道高度对称**。绑定落库、待重放消息、补投、身份冲突检查在两个通道域都已存在且与授权方式解耦——它们只关心「userId ↔ 发送者 unionId ↔ 待补投消息」三元组，与用户如何证明身份无关。密码登录只是第三种身份证明方式；而「发送者身份」本就来自入站事件（平台签名背书），**不需要任何 IM OAuth**。无新表、无迁移。改动集中在各通道引导卡链接生成 + 各通道一对绑定接口 + 桌面端一个通用确认页。

## 2. 现状调研

### 2.1 飞书通道

1. 入站消息找不到绑定（`findUserIdByUnionId(senderUnionId)` 为空）→ `FeishuInboundProcessor.sendUnauthorizedGuide`（`feishu/inbound-processor.ts:602`）。
2. `createSendUnauthorizedCardHelper`（`feishu-cards.ts`）取链接：`startFeishuChannelAuthLink`（ECP > 飞书 OAuth > `null`）；`null` 或发卡失败 → 文本回退 `feishuUnauthorizedFallbackText`（`ecp-inbound-gate.ts:36`），即截图文案。
3. 拿到链接时：`persistFeishuPendingAuth` 写 `feishu_pending_binding_message`（state → appId/messageId/event/cardMessageId，状态机 PENDING→SENT→CLAIMED→COMPLETED/FAILED），卡片带「重新获取链接」回调（`feishu_ecp_auth` / renew）。
4. 授权完成后：`claim(state)` → 绑定 → `replayFeishuPendingMessage` 补投（`bypassWindow`，进度卡接管引导卡）→ `complete(state)`。启动恢复扫描 `listRecoverable`（`app-lifecycle.ts:113`）兜底补投。

### 2.2 钉钉通道

1. 未绑定 → `DingtalkInboundProcessor.sendBindingGuide`（`dingtalk/inbound-processor.ts:199`）：**先检查 `oauthConfigured`**，未配置直接回复 `OAUTH_MISSING_TEXT`（「管理员尚未配置钉钉登录…」）；配置了才调 `sendBindingCard` 发 actionCard，链接指向 `/api/v1/dingtalk/bind/:state`。
2. 该路由（`dingtalk/binding.routes.ts:46`）：未登录 302 到 `{origin}/login?redirect=/dingtalk/bind/:state` → 登录回跳 → `DingtalkBindRedirect.vue` 带 `?token=` 回后端 → `attachUser(state, userId)` → 302 钉钉 OAuth 授权页 → 回调 `onCallback`（`dingtalk/runtime.ts:544`）：`code` 换 unionId → `bind(userId, unionId, userid)` → `pending.claim(state)` → `processor.process(bypassWindow)` 补投 → `complete`。
3. **身份证明来自 OAuth 换票**（绑的是 OAuth 登录者的钉钉身份），这是与飞书密码方案的本质差异；钉钉入站事件同样携带 `senderUserid/senderUnionId` 且经平台签名校验（`runtime.ts:402` 的 `resolveUserId` 即按事件身份查绑定），具备改为事件身份绑定的条件。
4. 基建：`dingtalk_pending_binding_message`（V120，state UNIQUE、`expires_at DATETIME NOT NULL`、payload 存事件）、`MysqlDingtalkBindingRepository`（`findUserIdByUnionId` / `bind(userId, unionId, userid)`，改绑语义与飞书一致）。

### 2.3 双通道可复用基建对照

| 基建 | 飞书 | 钉钉 |
|---|---|---|
| 待重放消息表 | `feishu_pending_binding_message`（无 expires_at 列） | `dingtalk_pending_binding_message`（**有 expires_at 列**，insert 即带 TTL） |
| 绑定仓储 | `bind(userId, unionId)`；`findUserIdByUnionId` | `bind(userId, unionId, userid)`；`findUserIdByUnionId` |
| 补投 | `replayFeishuPendingMessage` → `process(skipClaim, bypassWindow)` | `pending.claim` → `process(skipClaim, bypassWindow)`（同构） |
| 登录后回跳 | 路由守卫 + `safeRedirect`（`login-redirect.ts`）现成 | 同一套登录页（先例即出自钉钉） |
| 通用绑定编排 | `completeFeishuPendingAfterEcp`（`ecp-inbound-gate.ts:141`，全回调注入，返回 no-pending/replayed/identity-mismatch/replay-failed 四档） | 无独立编排，逻辑内联在 `onCallback` |
| 服务端结果页先例 | ECP 通道回调页三档渲染（`auth/ecp-channel-callback-page.ts`） | —（密码档走 SPA 确认页，不需要服务端结果页） |

### 2.4 缺口

| 环节 | 飞书 | 钉钉 |
|---|---|---|
| 链接生成 | 缺密码档（三档里第三档为空） | 缺密码档（未配置 OAuth 直接回退文本） |
| 引导文案 | 缺密码档变体 | 缺密码档变体（现只有 `OAUTH_MISSING_TEXT`） |
| 绑定完成入口 | 缺密码登录触发 | 缺密码登录触发（现绑定强绑 OAuth 回调） |
| 桌面端 | 缺绑定确认页 | OAuth redirect 页有，确认页缺 |

## 3. 方案选型

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 复用桌面 Web 登录页 + 通道通用绑定确认页 | 卡片链接指向 SPA 路由，路由守卫未登录自动跳登录页（带 `redirect`），登录成功回跳确认页，展示双方身份并由用户点「确认绑定」后调绑定接口完成 + 补投 | **采用** |
| B. 服务端渲染独立登录表单（仿 ECP 通道回调页） | 后端出 HTML 登录表单，POST 账密校验后绑定，不下发 JWT | 备选 |

选 A 的理由：

1. 需求即「打开 Mao 的账号密码登录页面」——A 打开的就是现有登录页（`LoginView.vue`），登录表单、`password.login.enabled` 开关、LDAP 兜底全部复用。
2. 登录后回跳机制现成；`/feishu/*`、`/dingtalk/bind-pwd/*` 均不在保留前缀（`/admin`、`/api`、`/uploads`）内。
3. 钉钉已有完全同构的「登录后回跳绑定」先例，飞书直接对齐。
4. 登录成功顺带获得网页会话，可在网页查看会话（深链已有）。
5. B 需自建登录周边（防爆破、表单维护），收益低；仅当实测「飞书/钉钉内置浏览器跑不动 SPA」时再降级（届时只换登录入口，绑定接口不变）。

**前提**：桌面 Web 部署在 `site.baseUrl`（V170）下；`password.login.enabled` 开启。两通道链接生成统一改用 `getSiteBaseUrl()`（钉钉现状从 `oauth.redirectUri` 推 origin，密码档无 OAuth 可依赖，必须换 siteBaseUrl）。注意 `getSiteBaseUrl()` 的语义是「site.baseUrl 优先、留空回落 upload.baseUrl」（V170 迁移注释），触发条件按「返回值非空」计，不要另查配置项——绑定链接落在回落域名是可接受的（同一站点）。

桌面 Web 端路由为 history 模式（`createAppHistory()` 仅 Electron file:// 与旧安卓内嵌包用 hash），`{siteBaseUrl}/feishu/bind/:state` 形状成立；卡片在 IM 内置浏览器/外部浏览器打开，恒走 Web 路径。

## 4. 详细设计

### 4.1 共用绑定编排（后端，通道无关）

把 `completeFeishuPendingAfterEcp` 泛化为通道无关的编排模块 **`backend-ts/src/channel-bind/bind-flow.ts`**（新目录；实施时若想少动文件，可先留在 feishu 域改名共享——dingtalk 已有引用 feishu 类型的先例——但推荐独立目录，避免跨域语义混淆）：

```ts
// 形状与现 completeFeishuPendingAfterEcp 一致，改名去 ECP 化
completePendingAfterBind(params: {
  state: string;
  bindUserId: number;
  claim(state): Promise<PendingRow | null>;
  findUserIdByUnionId(unionId): Promise<number | null>;
  bind(userId, unionId): Promise<void>;
  replay(pending): Promise<void>;
  complete(state): Promise<void>;
  release(state): Promise<void>;
  failClaimed(state): Promise<void>;
  notifyMismatch?(pending): Promise<void>;
}): Promise<'no-pending' | 'replayed' | 'identity-mismatch' | 'replay-failed'>
```

调用方三处：ECP 回调（`create-app.ts:339`，原逻辑原样迁入）、飞书密码 complete、钉钉密码 complete。unionId 一律取待重放事件里的发送者身份（飞书 `senderUnionId ?? senderId`；钉钉 `senderUnionId`，`bind` 第三参传 `senderUserid`）。

**本期不做「批量补投同发送者的其它待重放消息」**（原飞书版方案中的增强项降级为后续任务）：两侧 pending 表均无 sender 索引列，做它需要迁移；单条补投已满足本期需求，连发多条时未补投的行由启动恢复兜底（飞书已核实 `app-lifecycle.ts:113`；钉钉已核实**无** pending 启动恢复——`inbound-queue.repository` 的 `listRecoverable` 是入站队列，另一回事——用户重发一条即正常）。

另注：飞书启动恢复对 SENT 行的 claim+replay **不区分授权档位**——密码档 pending 行若在 TTL 内遇到重启，会被重放并再次发送引导卡（用户仍未绑定）。语义是「兜底再引导」而非「完成绑定」，与 ECP/OAuth 现状一致，不额外处理。

### 4.2 链接生成与引导卡（分通道）

**触发条件**（各通道独立判断）：`对应 OAuth/ECP 未启用 && passwordEnabled && getSiteBaseUrl() 非空` → 生成密码绑定链接；任一不满足 → 维持现状文本回退（飞书文案提示「请联系管理员配置站点地址」）。

**飞书**（`ecp-inbound-gate.ts` + `feishu-cards.ts`）：

1. `startFeishuChannelAuthLink` 扩为三档：ECP 开 → ECP（不变）；飞书 OAuth 开 → 飞书 OAuth（不变）；密码登录开且 siteBaseUrl 有 → `startPassword()`；否则 `null`。`startPassword` 无需任何 OAuth state 表：`state = randomUUID()`，链接 `{siteBaseUrl}/feishu/bind/{state}`，调用方仍走 `persistFeishuPendingAuth` 落库。
2. `feishuUnauthorizedGuide` 加密码档：title「新用户绑定」；p2p body「登录 Mao 账号后核对信息并确认绑定，即可继续刚才的消息（15 分钟内有效）。」；group body「请先登录 Mao 账号并确认绑定，获得群内使用权限后再试（15 分钟内有效）。」；buttonLabel「登录 Mao 并绑定」。
3. `buildFeishuAuthGuideCard` 不改（open_url 按钮 + 「重新获取链接」回调照常）；`createRenewAuthLinkHelper` 复用 `startFeishuChannelAuthLink` 自动获得密码档，三档全无时提示语微调为「当前未开启任何登录方式，请联系管理员」。
4. 文本回退 `feishuUnauthorizedFallbackText` 密码档附链接（复用 `withFeishuAuthLink(body, link, '登录')`）。
5. 依赖注入：`createSendUnauthorizedCardHelper` / `createRenewAuthLinkHelper` 增加 `getSiteBaseUrl`、`passwordEnabled`（`app-feishu-handler.ts:429` 装配处传入）。

**钉钉**（`dingtalk/inbound-processor.ts` + `dingtalk/runtime.ts`）：

1. `sendBindingGuide` 改为：OAuth 已配置 → `sendBindingCard`（不变）；未配置 → 尝试新增的 `sendPasswordBindCard`，失败再回退 `OAUTH_MISSING_TEXT`（文案改为「管理员尚未开启可用登录方式…」）。
2. `sendPasswordBindCard`（`runtime.ts` 装配处新增，仿 `sendBindingCard`）：`state = randomUUID()` → `pending.insert({ state, botId, event }, new Date(Date.now() + PASSWORD_BIND_LINK_TTL_MS))`（钉钉 pending 表自带 expires_at，直接用）→ 复用 `bindingCardParam` 发 actionCard，链接 `{siteBaseUrl}/dingtalk/bind-pwd/{state}`，按钮文案「登录 Mao 并绑定」。无 OAuth、无 `dingtalk_oauth_state` 记录。**完整序列必须照抄 `sendBindingCard`（`runtime.ts:408`）**：发卡成功后 `pending.markSent(state)`——钉钉 claim 只认 status='SENT'（`pending-binding.repository.ts:54`），漏了这步 complete 永远 no-pending；发送失败 `pending.fail(state)`。
3. 密码档引导文案单档（钉钉现有引导不分群聊/单聊）：「登录 Mao 账号后核对信息并确认绑定，即可继续刚才的消息（15 分钟内有效）。」
4. 钉钉 actionCard 无卡片回调按钮，**没有「重新获取链接」**：链接过期后用户重发一条消息即可拿到新卡（与现状 OAuth 卡过期行为一致）。

### 4.3 后端绑定接口（每通道一对，挂各自 binding.routes）

均走 `requireUserId` 鉴权（两通道 `/v1/*/binding/**` 本就是 JWT 路径，无需动 `jwt-hook.ts`）：

| 接口 | 飞书 | 钉钉 |
|---|---|---|
| 预览 | `GET /v1/feishu/binding/pending?state=` | `GET /v1/dingtalk/binding/pending?state=` |
| 完成 | `POST /v1/feishu/binding/complete` body `{ state }` | `POST /v1/dingtalk/binding/complete` body `{ state }` |

- **预览**（失败不落库）：返回 `{ senderName, chatType, expiresAt, currentUser, willRebind }`。按 state 查 pending 行（状态 SENT、未过期；飞书按 `created_at + PASSWORD_BIND_LINK_TTL_MS` 判断，钉钉按 `expires_at` 列）；`willRebind` = 当前账号已有其它 unionId 绑定（`bind` 改绑语义的前置明示）。
- **完成**：调 §4.1 编排，结局映射 `replayed → success`、`replay-failed → partial`、`identity-mismatch → failed`（文案复用 `FEISHU_ECP_IDENTITY_MISMATCH_TEXT` 同口径并触发 notifyMismatch——飞书走现有 `notifyFeishuPendingMismatch`；钉钉本期通知可先落结果页文案，飞书侧通知机制平移为后续增强）、`no-pending → failed`（「链接已失效或已使用」）。响应带 `senderName`。
- **TTL 校验在预览与 complete 两处都做**：飞书 `claim` 只查 status（SENT，或 CLAIMED 超 10 分钟可被接管恢复），**不拦 created_at 过期**；钉钉 claim 自带 `expires_at` 判断。飞书 complete 在调编排前按 `created_at + PASSWORD_BIND_LINK_TTL_MS` 复查，超期直接返回 failed——否则「预览已过期仍可 complete」。
- 并发/幂等：`claim(state)` SENT→CLAIMED 原子更新（affectedRows 检查），重复提交返回 `no-pending`；飞书启动恢复已兜底。

### 4.4 桌面端通用确认页（desktop）

1. **新组件** `ChannelBindConfirmView.vue`（`desktop/src/views/auth/`，通道无关）：按路由 meta 的 channel 调对应域接口。流程：
   - 进入调预览 → 展示确认卡「飞书用户 张三 → Mao 账号 bob」（钉钉同构），`willRebind` 时明示「将替换现有飞书/钉钉绑定」；`senderName` 飞书侧可为 undefined（`FeishuNormalizedMessage.senderName?`，钉钉必有），缺失姓名时兜底显示（如「飞书用户」+ unionId 尾段），不得直接渲染空；
   - **用户点「确认绑定」**才调 complete，进行中态「正在绑定…」，完成后按三档渲染结果（success / partial / failed，文案与 ECP 通道回调页口径一致）；
   - 预览失败直接展示失败结果，不出现确认按钮。
2. **路由**（`desktop/src/router/index.ts`，Layout 子路由，均不设 `meta.public`）：`feishu/bind/:state`（新增）、`dingtalk/bind-pwd/:state`（新增，密码档专用）。钉钉既有 OAuth 流路由 `dingtalk/bind/:state`（`DingtalkBindRedirect.vue`）**不动**。未登录时现有守卫自动跳 `Login?redirect=...`，登录成功 `finishLogin` 回跳，零改动复用。
3. 严格 TS + `<script setup>`，有可见文本按钮，不涉纯图标 aria-label 规范；配组件测试。

### 4.5 状态机与有效期

- 无新表、无迁移。飞书 state 复用 `feishu_pending_binding_message.state`（VARCHAR(768)），生命周期照旧，TTL 用代码常量 `PASSWORD_BIND_LINK_TTL_MS = 15 * 60_000` 按 created_at 判断；钉钉复用 `dingtalk_pending_binding_message`（state VARCHAR(64)，UUID 够用），TTL 直接写 `expires_at` 列。
- 15 分钟：比 OAuth 的 3 分钟宽（用户要打字）；「重新获取链接」（仅飞书）换发新 state 并 `failOthersForCard` 作废旧链，与现状一致。

### 4.6 身份冲突与改绑语义（双通道一致）

| 情形 | 行为 |
|---|---|
| unionId 已绑其它 Mao 账号 | 拒绝（identity-mismatch），置 FAILED；确认页/结果页给出「该飞书/钉钉身份已绑定其它 Mao 账号」文案 |
| 当前 Mao 账号已绑其它 IM 身份 | 允许改绑（两侧 `bind()` 现语义），确认卡 `willRebind` 明示「将替换现有绑定」 |
| 账号已禁用 | complete 前按各自现有校验拒绝（飞书 `ensureUserEnabled` 同款；钉钉沿用 `bind` 链路上的账号校验） |
| 未登录调 complete | JWT 门槛 401（路由守卫先跳登录页，正常流程到不了） |

### 4.7 会话语义（不改）

补投走各自 `process(skipClaim, bypassWindow)`，飞书 p2p 多会话（V101）、话题会话（V114）、群上下文、进度卡接管引导卡，钉钉合并窗口绕行，全部照旧——「开始处理 IM 会话」即补投的自然结果，无额外开发。

## 5. 与现有 OAuth/ECP 链路的关系

| 通道 | 优先级 | 行为 |
|---|---|---|
| 飞书 | ECP > 飞书 OAuth > 密码绑定（新增）> 文本回退 | 前两档行为不变 |
| 钉钉 | 钉钉 OAuth > 密码绑定（新增）> 文本回退 | OAuth 档行为不变 |

已开通 OAuth/ECP 的部署完全不受影响；密码档只在 OAuth 缺位时兜底。

## 6. 安全设计

1. **链接即凭证（重点风险）**：拿到链接 = 能把「发送者的 IM 身份」绑到「自己登录的 Mao 账号」。群聊里引导卡公开可见，攻击者可诱导他人点自己的绑定链接。缓解：
   - state 单次使用（claim 原子消费）+ 15 分钟短有效期（钉钉另有 expires_at 列）+ 飞书旧链作废机制；
   - **确认绑定（2026-11-19 已定夺，双通道一致）**：确认卡明示双方身份后由本人点按确认，攻击者仅拿到链接无法静默绑走；不做全自动绑定，也不提供跳过确认的开关；
   - p2p 场景链接只有发送者本人可见，天然安全；群聊为残余风险（社交工程骗点确认），接受并在上线说明写明。
2. **防爆破**：登录走 `POST /v1/auth/login`，与网页登录同一入口、同一暴露面（不新增风险）；complete 接口不做密码校验，无爆破面。可选增强：对 `/v1/auth/login` 加 IP 维度 `FixedWindowRateLimiter`（`openapi/rate-limiter.ts` 现成）。
3. **传输与注入**：全站 HTTPS；确认页展示的 `senderName` 走 Vue 文本插值自动转义，不拼 HTML。
4. **不下发凭证到不可信上下文**：绑定完成只做副作用，成功页不回显 token；密码只进登录表单，防钓鱼靠「用真实 Mao 登录页」。
5. **审计**：绑定事件已随 `user.feishu_user_id` / 钉钉绑定表落库；如需可加 audit 记录，实施时按需。

## 7. 边界与失败处理

| 场景 | 行为 |
|---|---|
| `site.baseUrl` 未配置 | 维持现状文本回退，文案提示「请联系管理员配置站点地址」 |
| `password.login.enabled=false`（且各 OAuth/ECP 也关） | 配置校验 `assertInteractiveLoginRemains`（`settings/settings.service.ts:796`）本就禁止这种组合，不会出现；若库被直改，回退文本不变 |
| 链接过期/已被使用 | 预览或 complete 返回 failed「链接已过期或已使用，请回 IM 重新发送一条消息」；飞书卡「重新获取链接」照常换发，钉钉重发消息 |
| complete 成功但补投异常 | partial 档「绑定已生效，原消息未恢复，请回 IM 重发」；state 由 `release` 置回 SENT 供恢复重试（与 ECP 一致） |
| 用户在确认页停留过久后点确认 | 超过 TTL → failed，引导重发 |
| 用户点取消（预览后不确认） | 不绑定不补投，state 不消费；页面「已取消」，TTL 内可返回重新确认 |
| OAuth/ECP 已开通 | 链接生成优先级不变，密码档不触发 |
| 安卓 Capacitor / Electron 本地 | 卡片链接在外部浏览器/IM 内置浏览器打开，恒为 Web SPA 流程，与壳无关 |

## 8. 测试计划

后端 Vitest（`cd backend-ts && npm test`）：

- `channel-bind/bind-flow.spec.ts`（新）：编排四档结局、身份冲突、改绑注入、TTL 过期判断（飞书 created_at / 钉钉 expires_at 两实现）。
- 飞书：`ecp-inbound-gate.spec.ts` 三档优先级、siteBaseUrl 缺失回退、密码档文案；`feishu-cards` 侧密码档卡片、renew 换发、文本回退附链接。
- 钉钉：`sendBindingGuide` 分支（OAuth 配置/未配置 × 密码档发卡/回退）、`sendPasswordBindCard` 落库与发卡、pending TTL。
- 双通道 route spec：complete 四档结局、并发重复提交幂等（第二次 no-pending）、未登录 401、pending 预览（含 willRebind）、禁用账号。

桌面（`cd desktop && npm run build` 必过，vitest 单测）：

- `ChannelBindConfirmView.test.ts`：确认卡展示双方身份与改绑提示、「确认绑定」后才调 complete（未确认不发请求）、取消不消费 state、三档结果渲染、预览失败短路。
- 路由守卫回归：未登录访问 `/feishu/bind/x`、`/dingtalk/bind-pwd/x` 跳登录且 `redirect` 回跳正确；钉钉 OAuth 旧路由不受影响。

E2E（可选，`bash scripts/e2e-setup.sh` 后跑 Playwright）：IM 入口属外部平台，E2E 只覆盖「登录页 redirect → 确认页」一段；通道端到端人工验证。

## 9. 实施清单

| # | 改动 | 文件 |
|---|---|---|
| 1 | 通用编排抽离（泛化 `completeFeishuPendingAfterEcp` → `completePendingAfterBind`，ECP 调用点迁移） | `backend-ts/src/channel-bind/bind-flow.ts`（新）、`create-app.ts:339`、`ecp-auth.service.ts` |
| 2 | 飞书：链接第三档 + guide 文案 + TTL 常量 + 依赖注入 | `backend-ts/src/feishu/ecp-inbound-gate.ts`、`feishu-cards.ts`、`app-feishu-handler.ts` |
| 3 | 飞书：pending 预览 / complete 路由（含 TTL 判断、notifyMismatch） | `backend-ts/src/feishu/binding.routes.ts` |
| 4 | 钉钉：`sendBindingGuide` 分支 + `sendPasswordBindCard` + 密码档文案 | `backend-ts/src/dingtalk/inbound-processor.ts`、`runtime.ts` |
| 5 | 钉钉：pending 预览 / complete 路由 | `backend-ts/src/dingtalk/binding.routes.ts` |
| 6 | 桌面：通用确认页 + 两条路由 | `desktop/src/views/auth/ChannelBindConfirmView.vue`（新）、`desktop/src/router/index.ts` |
| 7 | 单测 | 上述各文件 `.spec` / `.test` |
| 8 | changelog 碎片 `changelog/unreleased/2026-11-19-channel-password-bind.md`（### 后端 + ### 前端 两节） | 同任务新增 |
| 9 | 文档同步：README（登录方式/绑定说明）、DEPLOY（`site.baseUrl` 前提）、`skills/mao-cli/` 渠道绑定章节 | 同任务更新 |

无 DB 迁移、无契约变更（不涉 `@mao/contracts` 枚举）、不新增 LLM 调用场景、不新增内置工具。

## 10. 范围外（不做）

- **不改设置页绑定按钮（`POST /v1/feishu/binding`、`POST /v1/dingtalk/binding`）的密码档**：§1 列举的「设置页无法绑定」问题本期不解决——设置页绑定没有待重放消息，pending 表复用不了，需要另一种 state 载体（如复用 oauth_states / 新状态表），单独立任务。
- 不改飞书 OAuth / ECP / 钉钉 OAuth 既有链路的优先级与行为（钉钉 OAuth 卡片的登录回跳骨架原样保留）。
- 不做账号自助注册（无账号用户仍需管理员开号，结果页可提示）。
- 不做 IM 身份的反向核验（密码登录无法证明「登录者 = IM 发送者」，安全靠 §6.1 的身份明示 + 确认点击）。
- 不做「绑定成功后批量补投同发送者的其它待重放消息」与钉钉侧 identity-mismatch 飞书式主动通知（后续增强，见 §4.1）。
- 不动安卓壳、管理后台（admin 如需展示绑定来源属另一任务）。
- 不引入新的 OAuth 提供方。
