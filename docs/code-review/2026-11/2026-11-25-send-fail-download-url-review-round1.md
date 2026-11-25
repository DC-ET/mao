# 通道发送失败兜底下载链接（send_image / send_file）代码审查

- 日期：2026-11-25
- 审查对象：当前 git 工作区未提交改动（`git diff`），代码文件：
  - `backend-ts/src/harness/tool/impl/send-media-tool.ts`
  - `backend-ts/src/harness/tool/tool-registry.ts`
  - `backend-ts/src/app-harness-engine.ts`
  - `backend-ts/src/create-app.ts`
  - `backend-ts/src/file/send-download-ticket.service.ts`
  - `backend-ts/src/file/file.routes.ts`（仅注释）
  - 单测：`send-media-tool.spec.ts`、`send-download-ticket.service.spec.ts`
  - 文档变更（DEPLOY.md / changelog / skills）不纳入审查
- 审查方式：
  - 逐行静态审查 + 调用链反查（tool → registry → harness 装配 → 路由 → jwt-hook → 审计/日志 → 会话摘要/进度卡）
  - `cd backend-ts && npx tsc -p tsconfig.build.json --noEmit` → **通过**
  - `npx vitest run src/harness/tool/impl/send-media-tool.spec.ts src/file` → **320 passed**
  - 用 node 复算 `toStaticUploadBase` 输入矩阵（见第三节第 3 点）
- 不覆盖：页面样式、桌面/前端渲染实现细节、生产配置取值（见第六节核验项）

## 一、总体结论

**无 P0、无 P1，业务功能正确，可合并。** 6 个重点关注项逐条核对均符合预期（第三节），
另有 5 条 P2 级建议（第四节），均不影响本次交付的功能正确性。

- 签发时机严格限定在「通道会话 + push 失败 + 快照成功」，chat / 通道成功 / 快照失败 / 原地引用分支都不会多签票。
- `success` / `channelStatus` / `delivery` 语义未变，`downloadLink` 缺省 `null` 时输出与旧版逐字节一致。
- URL 拼接无 `/api/api`、无双斜杠；`baseUrl` 为空返回 `null`（不返回相对路径）。
- 依赖注入时序正确（`create-app.ts:664` 构造 → `:977` 装配），未注入时工具行为同旧版。
- TTL 12 小时在常量、注释、`ttlHours`、桌面换票链路上一致；Range 续传窗口 12 小时成立。

## 二、P0（阻断）

无。

## 三、逐项核对结论

### 3.1 签发时机（只在一处签发）

- 唯一签发点：`backend-ts/src/harness/tool/impl/send-media-tool.ts:1000-1002`
  ```ts
  const downloadLink = strategy != null && !push.ok && snapshot.ok
    ? await this.issueDownloadLink(snapshot.id, userId)
    : null;
  ```
  - `strategyFor()`（同文件 `:652-657`）对 `chat` 返回 `null` → chat 会话不签发；
  - `push.ok === true` → 不签发（通道成功）；
  - `snapshot.ok === false` → 不签发（没有可签的 `send_file` 行）。
- 原地引用分支（`decision.action === 'ref'`）在 `:891` 直接 `return combineSendRefResult(...)`，不会走到签发点，也不会重复签票。
- `issueDownloadLink()`（`:828-836`）自带 try/catch，签发失败只 warn + 返回 null，不影响发送结果。
- 新增单测已覆盖三种「不该签发」的场景（`send-media-tool.spec.ts` 第二条用例）与「该签发」的正向场景（第一条用例）。

### 3.2 `combineSendResult` 新参数对既有分支的影响

- `downloadLink` 为第 6 个可选参数、默认 `null`（`send-media-tool.ts:432`），既有 5 参调用（`send-media-tool.spec.ts:954-973`）输出不变。
- 原有 `success` / `channelStatus` / `delivery` / `error` 计算块（`:438-463`）一行未改；新增块（`:466-472`）只追加 `downloadUrl` / `downloadUrlExpiresAt` 并在 `error` 末尾追加「；下载链接（…）」。
- 唯一可达路径是 `channel !== 'chat' && snapshot.ok && !push.ok`，此时 `error` 原值必为 `已放入当前对话，<通道>发送失败：…`（非 null），所以 `error = error == null ? note : ...` 的兜底分支实际不会命中；`success` 仍为 `true`，`channelStatus` 仍为 `failed`，与既有「副本成功 + 推送失败」口径一致。
- `no-progress` 的语义白名单只取 `['success','channel','channelStatus','filename']`（`harness/core/no-progress-notice.ts:71`），新增字段不进签名 —— 反复失败的同一发送仍会被判为无进展，不会被随机票据掩盖。这点做得对。

### 3.3 URL 拼接

- 位置：`backend-ts/src/app-harness-engine.ts:306-311`
  ```ts
  const baseUrl = (await d.settingService.getUploadConfig()).baseUrl;
  const origin = toStaticUploadBase(baseUrl ?? '', apiPrefix);
  if (origin === '') return null;
  const url = `${origin}${apiPrefix}/v1/files/send-download?id=..&ticket=..`;
  ```
- `upload.baseUrl` 的真实语义确认为「站点 origin + servlet contextPath」（形如 `https://<域名>/api`），
  与 `generate-image-tool.ts:64-71`、`app-container-runtime.ts:187-193` 两处既有派生口径一致；`toStaticUploadBase` 会剥掉结尾的 contextPath 段。
- 实测输入矩阵（node 复算，`apiPrefix='/api'`）：

  | upload.baseUrl | 派生 origin | 最终 URL |
  | --- | --- | --- |
  | `https://mao.example.com/api` | `https://mao.example.com` | `https://mao.example.com/api/v1/files/send-download?...` |
  | `https://mao.example.com/api/` | `https://mao.example.com` | 同上 |
  | `https://mao.example.com` | `https://mao.example.com` | 同上 |
  | `https://mao.example.com/mao/api` | `https://mao.example.com/mao` | `https://mao.example.com/mao/api/v1/files/send-download?...` |
  | ``（空） | `` | `null`（不返回相对路径） |

  无 `/api/api`、无双斜杠、不返回相对路径，与需求一致。
- 路由侧佐证：文件路由挂在 `{ prefix: apiPrefix }` 下（`app-routes.ts:428、790`），`/v1/files/send-download` 实际可达路径就是 `${apiPrefix}/v1/files/send-download`；`auth/jwt-hook.ts:29-39` 对该路径带 `ticket` 的 GET/HEAD 放行（票据由路由自校验），所以链接无需 JWT 即可下载。

### 3.4 注入时序与缺省行为

- `create-app.ts:664` 构造 `SendDownloadTicketService`（与 `file.routes` 下载端点共用**同一实例**，`:1187`），
  `:977` 传入 `assembleHarnessEngine`；装配函数 `app-harness-engine.ts:209` 用 `d.sendDownloadTickets ?? null` 兜底，
  `:302-316` 构造闭包，`tool-registry.ts:221 / 233` 透传给两个工具的第 10 个可选参数。
- 未注入（如单测、其它装配路径）：闭包为 `null` → `issueDownloadLink()` 早返回 `null` → 结果与旧版完全一致。
- 依赖均为运行时解引用（`d.settingService` 在闭包内调用），不存在早期引用/未初始化问题。

### 3.5 TTL 12 小时一致性

- 常量：`file/send-download-ticket.service.ts:17` `12 * 60 * 60 * 1000`；类注释同步改为 12 小时。
- 端点注释：`file/file.routes.ts:880` 改为 12 小时。
- 文案有效期：`app-harness-engine.ts:312` `ttlHours = Math.round(SEND_DOWNLOAD_TICKET_TTL_MS / 3_600_000)` = 12，与 `send-media-tool.ts:470` 的「12 小时内有效」一致。
- 续传/桌面下载：桌面每次点下载都**重新换票**（`desktop/src/composables/workspace-file-provider.ts:818`），不缓存票据；
  Range 续传复用同一个 URL，12 小时内可续传，与 R7 设计不冲突。`send-download.routes.spec.ts:42` 自建 24h TTL 的实例，与常量解耦，测试不受影响。

### 3.6 ticket 的泄漏面

- 审计 / 请求日志：`common/structured-logger.ts:110-119` 的 `redactCredentialQuery` 已把 `ticket` 参数置为 `[REDACTED]`，
  审计落库（`app-hooks.ts:150`）与 pino 请求序列化（`structured-logger.ts:128`）都用它 → **不落日志**。
- 工具结果本身不打日志（`harness/` 下无结果内容日志）。
- 但存在一条「工具结果之外」的二次传播路径，见 P2-2。

## 四、P2（建议，不阻塞）

### P2-1 `baseUrl` 只取 `upload.baseUrl`，`site.baseUrl`-only 的部署会静默无链接

- 位置：`backend-ts/src/app-harness-engine.ts:306-307`
- 问题：需求/变更日志写的是「站点 `baseUrl` 未配置时不返回链接」，代码实际只读 `upload.baseUrl`。
  仓库已有 `settingService.getSiteBaseUrl()`（site.baseUrl 优先、留空回落 upload.baseUrl，`settings.service.ts:398-406`）。
  两类合法部署会与预期不符：
  1. 只配了「站点根地址」`site.baseUrl`（用于 IM 深链）、`upload.baseUrl` 留空（本地存储走相对 `/uploads/`）→ 本功能静默不生效；
  2. `upload.baseUrl` 指向 CDN/对象存储等非本站域名 → 拼出的链接 host 指向 CDN，下载 404。
- 影响：不报错、无日志，用户与 Agent 都只会看到「没有链接」，排查成本高。
- 建议：优先用 `getSiteBaseUrl()`（返回站点根），再 `toStaticUploadBase(siteBase, apiPrefix)`；顺带对返回值 `trim()`
  （`toStaticUploadBase` 不 trim，`upload.baseUrl` 若带尾部空格会被 `getText` 原样返回，拼出带空格的坏链接）。
- 上线前核验：`GET /api/v1/upload/config` 的 `baseUrl` 在生产是否非空（本次无法读取生产设置值）。

### P2-2 `error` 里的票据会二次传播进 `toolCalls[].summary` / 飞书进度卡

- 位置：`send-media-tool.ts:470`（票据写进 `error`）→ `session/util/tool-result-summarizer.ts:527`
  （`部分成功: ${String(node.error)}`，整段原样返回）→ `harness/core/agent-loop.ts:744-746` 写入 `tc.summary`
  （随 assistant 消息持久化）→ `feishu/card-progress-listener.ts:135、317` 渲染进飞书进度卡（此处不再截断，card 上限 6000 字）。
- 影响：
  - 票据在「工具结果」之外多了一份持久化副本（消息 `tool_calls` JSON）与一个外部展示面（飞书进度卡，
    群会话里等于把 12 小时可用的 bearer 链接发给全群）；受众与文件本应送达的对象一致，**不构成越权扩散**，但与
    「票据不进消息 JSON」的既有口径（`desktop/.../workspace-file-provider.ts:867` 注释）相左，且属于需求之外的新增面。
  - 桌面工具卡同一 summary 会显示一长行带链接文本（纯文本、不可点），可读性差；错误文案较长时飞书卡里可能被 240 字兜底截断
    （`card-progress-listener.ts:136` 分支只在 summarizer 返回 null 时生效，本场景走 summarizer，不截断）。
- 建议：在 `summarizeSendMedia` 里对 `send_image` / `send_file` 的 `error` 做归一化 —— 识别 `downloadUrl` 字段时改用
  `${label}: ${name} (部分成功: 已放入当前对话，<通道>发送失败；已附下载链接，${ttl} 小时内有效)`，不内联 URL。
  这样既保留「部分成功」语义，也避免票据进进度卡与消息摘要。

### P2-3 原地引用（uploads 活引用）分支通道失败时不带 `downloadUrl`，与统一口径不一致

- 位置：`send-media-tool.ts:869-891`（`combineSendRefResult`，`:535-548`）
- 问题：`send_file` 发送本人 `uploads/{userId}` 里体积超通道上限的文件（如 25MB PDF）会命中原地引用分支
  （`decideLiveRef` 只按 1GB 上限回退快照，见 `:784-790`），此时通道失败只返回 `delivery.url`（公开静态直链）而没有 `downloadUrl`，
  `error` 也不带链接。而 `send_file` 的提示词（`:1114`）写「超过通道上限时…此时结果里会带可下载的 downloadUrl」，与实际不符。
- 影响：功能上用户仍有可下载地址（`delivery.url`），只是模型可能仍按旧话术让用户「自己去网页/客户端找」，
  需求里「通道失败就给链接」的口径在该分支不成立。该分支没有 `send_file` 行，**签不了票据**（下载端点按行存在性 + 属主鉴权），属设计限制而非实现错误。
- 建议：二选一 —— 1) 在 `combineSendRefResult` 里把 `delivery.url` 作为 `downloadUrl` 返回（注明「无票据、长期有效」，或干脆不加字段只在 `error` 里带一句）；
  2) 至少把提示词改成「有 downloadUrl 时务必转给用户；只有 delivery.url 时也可直接转」。

### P2-4 桌面端注释仍写 24 小时

- 位置：`desktop/src/composables/workspace-file-provider.ts:867`（`HMAC 票据（24 小时）`）
- 影响：仅注释失真（行为由服务端 TTL 决定，桌面每次重新换票）。属本次 TTL 24h→12h 的漏改点，建议一并改成 12 小时，避免后续误判。

### P2-5 新增闭包无单测覆盖

- 位置：`backend-ts/src/app-harness-engine.ts:302-316`
- 现状：单测只覆盖了工具侧（issuer 注入/不注入、抛错），`app-harness-engine` 这一层的三个分支（baseUrl 空 → null、
  `getUploadConfig()` 抛错 → null、正常拼接 → `origin+apiPrefix+v1/files/send-download`）没有用例。
- 建议：补 1-2 条用例（可直接对导出的纯函数/闭包做注入测试），把 P2-1 若采纳的 `getSiteBaseUrl` 口径一起锁住。

## 五、与旧版行为差异清单（确认无回归）

| 场景 | 旧版 | 本次改动后 |
| --- | --- | --- |
| chat 会话发送 | `success=true, channelStatus=skipped` | 不变（不签发） |
| 通道成功 | `success=true, channelStatus=sent` | 不变（不签发） |
| 快照成功 + 通道失败 | `success=true, channelStatus=failed, error=已放入当前对话，<通道>发送失败：…` | 追加 `downloadUrl` / `downloadUrlExpiresAt`，`error` 末尾追加链接与有效期；`success` 仍 true |
| 快照失败 + 通道成功/失败 | 原样 | 不变 |
| 未装配 issuer（旧装配路径 / 单测） | — | 与旧版逐字段一致 |
| 原地引用分支 | 原样 | 不变（仍无 `downloadUrl`，见 P2-3） |

## 六、已检查范围与剩余风险

已检查：`send-media-tool.ts` 全文（含 `combineSendResult` / `combineSendRefResult` / `executeWithUser` 两条分支）、
`tool-registry.ts` 装配、`app-harness-engine.ts` 装配与闭包、`create-app.ts` 注入、`send-download-ticket.service.ts`、
`file.routes.ts` 两个端点、`auth/jwt-hook.ts` 公开路径、`common/structured-logger.ts` 脱敏、`no-progress-notice.ts` 语义字段、
`tool-result-summarizer.ts` + `feishu/card-progress-listener.ts` + `agent-loop.ts` 的 summary 传播链、桌面换票链路、
`send-download.routes.spec.ts`。

剩余风险（未在本次改动引入，仅提示）：

1. 自定义 servlet contextPath（`server.servlet.context-path` 非 `/api`）时，`jwt-hook.ts:10` 的
   `replace(/^\/api/, '')` 归一化不会命中 `/v1/files/send-download`，票据链接会 401。当前仓库默认与生产
   `application.yml:4` 均为 `/api`，暂不影响；若将来放宽 contextPath，需要一起改归一化逻辑（该问题在 1GB 票据下载那一版已存在）。
2. 生产 `upload.baseUrl` 的实际取值无法从代码侧确认（DB 设置），上线前按 P2-1 的核验项确认一次即可。
3. `SendDownloadTicketService` 支持自定义 `ttlMs`（构造第二参），而文案里的 `ttlHours` 取的是模块常量
   （`app-harness-engine.ts:312`）。当前唯一生产构造用默认值（`create-app.ts:664`），无实际影响；将来若改成可配置，
   应改为由 `expiresAt - now` 推导。