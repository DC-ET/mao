# 2026-10-22 逻辑 BUG 审查报告（二）

> 审查范围：`backend-ts`（后端）、`desktop`（前端共用 UI）、`agent-cli`（终端 CLI mao-agent）、`skills/mao-cli`（终端 CLI mao-cli）。
> 审查方式：分区通读源码 → 逐条构造可复现场景 → **为每条缺陷新增验证用例并实跑，确认其真实存在** → 复核轮逐条核对「测试是否打在产品代码真身、期望行为是否有仓库内口径佐证、是否值得修」，剔除误报与低价值条目。
> 结论：**确认 20 个逻辑 BUG**（P1 7 条、P2 13 条），另有 3 条候选经复核剔除（1 条判定为误报、2 条修复价值不高，详见第四节）。
> 本次审查**未修改任何产品代码**，只新增 20 个验证用例文件与本报告；按仓库既有约定，测试与报告先行落地，修复与 CHANGELOG 留待后续提交。
>
> **修复状态（2026-10-23 闭环）**：20 条 BUG 已全部修复，20 个验证用例全部转绿并留在默认测试套件，CHANGELOG 记 0.0.336，详见下方「修复记录」一节。
>
> 排重基线：`docs/code-review/` 下已有 361 份历史审查报告，本轮对每条缺陷都做了 `grep` 排重与 `git log --oneline -20` 复核，未与历史条目重复（详见每条的「排重」小节）。

---

## 修复记录（2026-10-23 闭环）

**20 条 BUG 已全部修复**，验证用例从「预期失败」转为通过，三端全量套件实跑全绿（backend-ts 397 文件 / 4663 条、agent-cli 48 文件 / 550 条、desktop 86 文件 / 741 条），三个包构建（tsc / vue-tsc + vite）通过。修复提交未做 git commit，留在工作区由维护者审定后提交。

| # | 修复位置 | 关键改动 |
|---|---------|---------|
| BUG-C1 | `skills/mao-cli/lib/commands/llm-call.js:47,56` | 两处 `emitResult(ctx, result)` 改为 `emitResult(result, { raw: ctx.raw })`，与全仓其余命令一致 |
| BUG-C2 | `backend-ts/src/audit/audit.interceptor.ts`（`resolveIp`） | 接入 `loadTrustedProxyAddresses()`：仅当对端（归一化 IPv4-mapped IPv6 后）是已配置的可信代理时才采信 XFF / X-Real-IP，否则回落直连对端；配置读取异常按「无可信代理」处理 |
| BUG-C3 | `backend-ts/src/auth/jwt-hook.ts` + `app-hooks.ts` + `app-ws-handler.ts` + `streaming-ws-handler.ts` + `create-app.ts` | `authenticateRequest` 新增 `AccountStatusChecker` 参数，JWT 路径解析出 userId 后校验账号状态；app-hooks 注入基于 userRepo 的检查器（30 秒停用负缓存，按 app 实例隔离）；WS 首帧 auth 与连接内 `auth_refresh` 接入同一检查（此前同样只验 JWT） |
| BUG-C4 | `backend-ts/src/harness/runtime/runtime-cleanup-scheduler.ts` | 目录级 `statSync` 收敛进 `isDirectory()` helper（try/catch，取不到 stat 跳过条目）；`start()` 的 setInterval 回调与启动即跑改走 `runCleanupSafely()`（`.catch()` + warn 日志） |
| BUG-C5 | `backend-ts/src/weixin/media.service.ts`（`downloadImage`） | 节点选取改用 `resolveMediaNode(imageItem)`，AES key 经 `resolveAesKey(imageItem, media)` 取同一节点，与 `downloadFile` 完全同口径 |
| BUG-C6 | `agent-cli/src/local/tools/files.ts` | 新增 `parseLineIndex`（负数/非整数/空串抛错），`handleReadFile` 的 offset/limit 改校验而非静默钳制，错误经既有 catch 转 `readError`（带 error 键） |
| BUG-C7 | `desktop/src/composables/useVersionCheck.ts` | 轮询分支删除 `writeStoredVersion` / `currentVersion` 赋值（基线只在加载时同步一次）；`hasUpdate`/`newVersion` 每轮按「基线 vs 远端」重算并补 else 撤销分支 |
| BUG-D1 | `backend-ts/src/session/session.service.ts:1615` | 私有 `isTerminalPhase` 去掉 `'IDLE'`，对齐仓内其余终态口径；耗时累计的 else if 分支不受影响 |
| BUG-D2 | `backend-ts/src/notification/task/preference.service.ts` | EMAIL 分支的 SMTP / 邮箱要求收敛进 `enabled || channelChanged`：关闭（且非切渠道）时保留旧密文直接落库 |
| BUG-D3 | `backend-ts/src/harness/tool/impl/task-tools.ts` | update / delete 的 id 改 `asInt` + 显式 `> 0` 校验；delete 先取会话内未删除事项快照，只对真实存在的 id 执行删除并计数（同一 id 重复入参只计第一次） |
| BUG-D4 | 同上（`:203`） | `fields.content = asText(item.content) ?? ''`，与 `TaskCreateTool:73` 同口径 |
| BUG-D5 | `backend-ts/src/app-hooks.ts` | `setErrorHandler` 包装一层：`BusinessException` 的 message 暂存到 request，onResponse 写入审计 `errorMessage`（success 判定随之落为 0） |
| BUG-D6 | `backend-ts/src/harness/tool/impl/read-file-tool.ts` | `offset > totalLines` 时走 `readError()` 显式报错；`offset == total_lines` 的合法空尾窗口保持不动 |
| BUG-D7 | `agent-cli/src/ws/event-types.ts:36` | `ACTIVE_PHASES` 补齐四相位（RUNNING / RESUMING / WAITING_APPROVAL / CANCELLING） |
| BUG-D8 | `agent-cli/src/args.ts` | 新增 `optionalText` 谓词（空串/纯空白按「未下发」），permission-level / on-question / on-approval / if-running 改用它，`positiveInt` 内部同步，`parseResume` 补空串口径 |
| BUG-D9 | `skills/mao-cli/lib/commands/session.js` + `reference/session.md` + `reference/mao-agent.md` | `PERMISSION_LEVELS` 补 `PROXY`，create / update 两处错误文案同步；参考文档的四档枚举与档位表补齐 PROXY |
| BUG-D10 | `skills/mao-cli/lib/args.js` | 新增 `globalBool` helper（`optionalBoolean` + 非布尔文本按真），`extractGlobalOptions` 的 json / raw 改用它 |
| BUG-D11 | `desktop/src/utils/toolDisplay.ts` | `page_inspect` 取 `includeHidden`、`page_observe` 取 `snapshotId`（`page_screenshot` 保持 reason），通用兜底补 `url` |
| BUG-D12 | `desktop/src/stores/session/trace.ts` + `composables/useStreamWS.ts` | `getLiveExecutionId` 改取最后一个匹配键（最新执行）并修正过时注释；`session_snapshot` 终态分支补 `clearLiveState(sessionId)`（根因修复，与 `session_status` 分支对齐） |
| BUG-D13 | `desktop/src/stores/session/subagent.ts` | `agentType` 过滤 0 命中时直接 `return null`，不再回退全部候选；`task` 过滤的有意放宽不变 |

有意收敛与差异（均为修复时的明确取舍）：

- **BUG-C3** 负缓存只缓存「已确认停用」：禁用即时生效（下一请求即拒），重新启用最多 30 秒后生效；状态查询异常时放行本次请求不误伤；缓存按 app 实例隔离（测试各自建 app 不互相污染）。WS 两个鉴权点（首帧 auth、连接内 auth_refresh）也接入同一检查——文档根因里记载的「WS 同样只验 JWT」一并消除。
- **BUG-C2** 未配置可信代理的部署会把终端审计 IP 记为反代地址：这是仓库既定策略（`trusted-proxy.ts` 注释与 config.md）的取舍而非回退，`skills/mao-cli/reference/config.md` 已补充该行为说明。
- **BUG-C6** 的 `limit:'abc'` 报错与上一轮固化的旧测试 `agent-cli/test/local-files.spec.ts`（非数字回落读全文件）冲突，按新口径同步更新了该旧测试——这是口径变更而非纯同步，文档 BUG-C6 节已预先记载。
- **BUG-D3** 的 delete 计数口径：mapper 不返回命中行数，故先取「会话内当前未删除事项」快照按 id 存在性判定，未命中条目不计入「已删除 N 个」。
- **BUG-D5** 只覆盖抛 `BusinessException` 的路径（仓库主流约定）；直接 `sendJson(reply, 200, fail(...))` 不抛异常的写法不进错误处理器，暂不覆盖。
- **BUG-D10** 未改 `parseArgs`（无 flag 类型信息，无法区分 `--page 2` 取值与 `--raw session` 吞参）：非布尔文本按「真」处理，完整保持旧 `Boolean()` 行为；附带差异是 `--raw=` 内联空串由 false 变 true，与同文件 `hasFlag` 把 `''` 视为「flag 已传」的口径一致。

---

## 一、结论摘要

| # | 位置 | 严重度 | 一句话描述 | 验证用例 |
|---|------|--------|-----------|---------|
| BUG-C1 | `skills/mao-cli/lib/commands/llm-call.js:47,56` | **P1** | `emitResult` 参数顺序颠倒 → `mao llm-call` 打印的是 CLI 上下文（含 access token），接口结果完全丢失 | `mao-cli-llm-call-emit-result.bugcheck.spec.ts` |
| BUG-C2 | `backend-ts/src/audit/audit.interceptor.ts:86` | **P1** | 终端审计 IP 无条件采信 `X-Forwarded-For`，绕过仓库自己的可信代理策略 → 审计 IP 可任意伪造 | `terminal-audit-ip.bugcheck.spec.ts` |
| BUG-C3 | `backend-ts/src/auth/jwt-hook.ts:113` | **P1** | 鉴权只验签不查账号状态 → 管理员禁用用户后，其未过期 access token（24h）仍可调用全部接口 | `app-hooks.disabled-account.bugcheck.spec.ts` |
| BUG-C4 | `backend-ts/src/harness/runtime/runtime-cleanup-scheduler.ts:64` | **P1** | 清理扫描 `statSync` 无 try/catch → 悬空软链等取不到 stat 的条目让整轮 reject → `unhandledRejection` 把后端进程带崩 | `runtime-cleanup-scheduler.bugcheck.spec.ts` |
| BUG-C5 | `backend-ts/src/weixin/media.service.ts:57` | **P1** | 入站图片只回退「media 节点缺失」，不回退「media 节点无 `encrypt_query_param`」→ 缩略图可用时图片被静默丢弃 | `media-image-node-fallback.bugcheck.spec.ts` |
| BUG-C6 | `agent-cli/src/local/tools/files.ts:268` | **P1** | LOCAL 侧 `read_file` 对负数/非法 `limit`/`offset` 静默钳制 → 返回「空内容 + success」，与云端口径分裂，有整文件被覆写清空的风险 | `local-read-file-limit.bugcheck.spec.ts` |
| BUG-C7 | `desktop/src/composables/useVersionCheck.ts:101` | **P1** | 版本轮询把「本地运行版本基线」改写成尚未安装的远端版本 → 其它仍跑旧版本的窗口再也收不到更新提示 | `useVersionCheck.bugcheck.test.ts` |
| BUG-D1 | `backend-ts/src/session/session.service.ts:1615` | P2 | 私有 `isTerminalPhase` 把 `IDLE` 当终态 → 未读既会误写也会漏写，且与 WS 广播口径打架 | `session-terminal-phase-unread.bugcheck.spec.ts` |
| BUG-D2 | `backend-ts/src/notification/task/preference.service.ts:66` | P2 | 关闭邮件通知时仍强制要求「个人资料有邮箱 + SMTP 可用」→ 用户永远关不掉邮件通知 | `preference-email-disable.bugcheck.spec.ts` |
| BUG-D3 | `backend-ts/src/harness/tool/impl/task-tools.ts:187,284` | P2 | `Number(item.id)` 把 `null`/`""` 强转成 `0` → 待办 #0 被当成真实任务回报成功 | `task-tools-invalid-id.bugcheck.spec.ts` |
| BUG-D4 | `backend-ts/src/harness/tool/impl/task-tools.ts:203` | P2 | `asText` 对对象/数组返回 `null` → 把 `null` 写进 `session_todo.content`（NOT NULL 列）→ 整条 UPDATE 连 `status` 一起回滚 | `task-tools-null-content.bugcheck.spec.ts` |
| BUG-D5 | `backend-ts/src/audit/audit.interceptor.ts:105` | P2 | 业务失败按仓库约定返回 HTTP 200 → 审计 `success` 只看状态码 → 失败操作落库成「成功」，失败原因恒为空 | `audit-business-failure.bugcheck.spec.ts` |
| BUG-D6 | `backend-ts/src/harness/tool/impl/read-file-tool.ts:76` | P2 | `offset` 越界被静默钳到 EOF → 返回「空内容 + success」，与同文件注释里承认的数据丢失风险同源 | `read-file-out-of-range-offset.bugcheck.spec.ts` |
| BUG-D7 | `agent-cli/src/ws/event-types.ts:36` | P2 | 活跃相位集合漏 `RESUMING`/`CANCELLING` → 正在恢复/取消的会话被当成空闲 | `ws-active-phases.bugcheck.spec.ts` |
| BUG-D8 | `agent-cli/src/args.ts:381` | P2 | value 型选项遇内联空值直接抛错，CLI 起不来（只有 `--output-format` 被修过） | `args-empty-inline-value.bugcheck.spec.ts` |
| BUG-D9 | `skills/mao-cli/lib/commands/session.js:34` | P2 | `--permission-level` 白名单漏 `PROXY` → 会话切不到代理审批档 | `mao-cli-session-permission-level.bugcheck.spec.ts` |
| BUG-D10 | `skills/mao-cli/lib/args.js:139` | P2 | 全局开关 `--raw=false`/`--json=false` 反而把开关打开 | `mao-cli-global-bool-flags.bugcheck.spec.ts` |
| BUG-D11 | `desktop/src/utils/toolDisplay.ts:120` | P2 | 工具参数预览读的字段后端 schema 里不存在 → `page_observe`/`page_inspect`/`open_web_page` 预览恒为空 | `toolDisplay.bugcheck.test.ts` |
| BUG-D12 | `desktop/src/stores/session/trace.ts:132` | P2 | 轨迹面板取 Map 里第一个匹配键（= 最旧）当当前执行 → 上一次执行的残留行一直显示 | `trace.bugcheck.test.ts` |
| BUG-D13 | `desktop/src/stores/session/subagent.ts:61` | P2 | 按 `agent_type` 过滤子代理时「无匹配」被当成「不筛选」→ delegate 卡片绑到别的子代理 | `subagent.bugcheck.test.ts` |

严重度口径：**P1** = 用户可感知的功能失效、数据被误改、凭据外泄或安全边界被绕过；**P2** = 特定路径/特定入参下的功能失效，或影响面有限但结论错误。

---

## 二、逐条详述

> 本节保留审查当时的代码现状与复现路径（用于对照缺陷成因），**所有缺陷均已在 2026-10-23 修复**，当前行为见「修复记录」与 3.3。

### BUG-C1（mao-cli / P1）`llm-call` 把 CLI 上下文当结果输出，access token 一起打到 stdout

**位置**：`skills/mao-cli/lib/commands/llm-call.js:47`、`:56`；契约见 `skills/mao-cli/lib/output.js:47`

```js
// lib/output.js:47 —— 签名是 (result, { raw })
function emitResult(result, { raw = false } = {}) {
  outputResult(result, { json: true, raw });
}

// lib/commands/llm-call.js:47 / :56 —— 参数写反了
emitResult(ctx, result);
```

**根因**：`ctx` 被当成「待输出结果」，Result 信封被当成 options。全仓其余约 60 处调用（`role.js:43`、`user.js:43`、`analytics.js:80`、`audit.js:42` …）都是 `emitResult(result, { raw: ctx.raw })`，只有这两处是 `ctx` 在前。

后果有三层：

1. `outputResult(ctx, { json: true, raw: false })` → `ctx` 没有 `data` 字段 → 直接 `printJson(ctx)`，**打印出 `{baseUrl, token, timeoutMs, raw}`**，一次调用流水都没有（`skills/mao-cli/reference/llm-call.md` 约定输出应为 `records[]/total/page/size`）。
2. `ctx.token` 随 stdout 一起打印 —— 用 `--token` 或 `MAO_TOKEN` 注入时即**明文凭据泄漏**（输出常被重定向进日志或管道）。
3. `--raw` 标志失效：options 取自 Result 信封，信封里没有 `raw` 字段。

**复现**：`mao llm-call me --page 1 --size 20`（或带 `--token`）→ stdout 是 `{"baseUrl": "...", "token": "...", "timeoutMs": 30000, "raw": false}`。

**验证**：`agent-cli/test/mao-cli-llm-call-emit-result.bugcheck.spec.ts`（复核确认：测试用 `createRequire` 加载真实产品模块、仅桩掉 `http.get`，断言打在真实 stdout 上）

```
AssertionError: expected '{\n  "baseUrl": "https://mao.example.…' to contain '"records"'
AssertionError: expected '{\n  "baseUrl": "https://mao.example.…' not to contain 'super-secret-token'
```

**修复方向**：改成 `emitResult(result, { raw: ctx.raw })`（与全仓其余命令一致）。两行改动、零波及其它链路。

**排重**：`grep -rn "emitResult" docs/code-review/` 零命中；`llm-call` 的历史命中全部指向后端 `usage/llm-call.service.ts`，与 mao-cli 命令层无关。

---

### BUG-C2（后端 / P1）终端审计 IP 无条件采信 `X-Forwarded-For`，可任意伪造

**位置**：`backend-ts/src/audit/audit.interceptor.ts:86`（`resolveIp`）；调用点 `backend-ts/src/session/terminal.routes.ts:64,97`、`backend-ts/src/session/ws/attach-websocket.ts:57`

```ts
export function resolveIp(headers, remoteAddr) {
  const forwarded = headerValue(headers, 'x-forwarded-for');
  if (forwarded && forwarded.trim()) {
    return forwarded.split(',')[0].trim();   // ← 无条件信任
  }
  const realIp = headerValue(headers, 'x-real-ip');
  return realIp && realIp.trim() ? realIp : (remoteAddr ?? undefined);
}
```

**根因**：仓库自己有可信代理策略 —— `backend-ts/src/config/trusted-proxy.ts` 的注释明写「Only exact configured reverse-proxy IPs are trusted; **never trust arbitrary X-Forwarded-* input**」，Fastify 也确实按它装配（`create-app.ts:261` 的 `trustProxy: loadTrustedProxyAddresses()`）。REST 审计走 `app-hooks.ts:101` 的 `request.ip`，受该策略约束；**终端审计是另一条自己实现的路径，直接绕过了策略**。

**复现**：任意调用方带 `X-Forwarded-For: 203.0.113.9` 调 `POST /api/v1/sessions/{id}/terminals` → 审计落库的 IP 就是 `203.0.113.9`，真实来源被抹掉，审计日志失去可信度。复核补充：仓库所有部署脚本与配置（DEPLOY.md、nginx、scripts）均未设置 `TRUSTED_PROXY_ADDRESSES`，即当前默认部署下终端审计 IP 完全由客户端可控。

**验证**：`backend-ts/src/session/terminal-audit-ip.bugcheck.spec.ts`（复核确认：真实 Fastify + 真实 `loadTrustedProxyAddresses` + 真实 `registerTerminalRoutes`，仅桩 terminalManager/sessionService）

```
AssertionError: expected '203.0.113.9' to be '127.0.0.1' // Object.is equality
```

（对照组「对端本身是已配置的可信代理时采信 XFF」当前通过，修复后仍应通过——Fastify 对可信对端同样取 XFF 最左项。）

**修复方向**：`resolveIp` 接入 `loadTrustedProxyAddresses()`，仅当对端地址在可信代理名单内时才采信 `X-Forwarded-For`/`X-Real-IP`，否则回落到 `remoteAddr`；或直接复用 Fastify 的 `request.ip`。仅一处改动、三个调用点自动受益；未配可信代理的部署会把 IP 记为反代地址，这是仓库既定策略的取舍，不是回退。

**排重**：`grep -rn "x-forwarded-for" docs/code-review/` 零命中；`resolveIp` 的历史命中是 SSRF 的 `resolveIps`（不同函数）。

---

### BUG-C3（后端 / P1）账号被禁用后，已签发的 access token 仍可调用全部接口

**位置**：`backend-ts/src/auth/jwt-hook.ts:113`（`authenticateRequest`）、`backend-ts/src/app-hooks.ts:62`（preHandler）

```ts
const token = header ?? query?.token ?? null;
if (!token || !jwt.validateAccessToken(token)) {
  return anonymous();
}
return { userId: jwt.getUserIdFromToken(token), tokenAutoDisabled: false, resolverRejected: false };
// ← 从不查 user.status
```

**根因**：请求鉴权链路只验签 + 判过期，不查账号状态（WS 首帧鉴权 `streaming-ws-handler.ts:366-368` 同样只验 JWT）。而同一套账号状态检查在其它链路是存在的，**口径不一致**：

| 链路 | 是否拒停用账号 |
|------|--------------|
| 登录 `auth/auth.service.ts:34` | ✅ 拒 |
| 刷新 token `auth/auth.service.ts:50` | ✅ 拒 |
| LDAP `auth/ldap-auth.service.ts:61` | ✅ 拒 |
| 飞书 `auth/feishu-auth.service.ts:321` | ✅ 拒 |
| ECP `auth/ecp-auth.service.ts:172` | ✅ 拒 |
| 分享链接 `auth/session-share.service.ts:202` | ✅ 拒 |
| **已有 access token 的普通请求** | ❌ **放行** |

access token 有效期 86400 秒（`auth/auth.service.ts:84`）。管理员在管理后台禁用用户（`permission/permission.service.ts:197` 的 `updateUserStatusWithAdminGuard` 写库 `status=0`）后，该用户手上的旧 token 在最长 24 小时内仍可读写他人数据、建终端、调模型；只有等 token 过期或主动刷新时才会被拦下。

**复现**：管理员把用户 `status` 置 0 → 该用户用一个未过期的 access token 请求受保护接口 → 正常放行。

**验证**：`backend-ts/src/app-hooks.disabled-account.bugcheck.spec.ts`（复核确认：真实 Fastify + 真实 `registerAppHooks`，仅桩 jwt 与 userRepo）

```
AssertionError: expected '放行' to be '拒绝' // Object.is equality
```

（对照组「启用账号正常放行」当前通过。）

**修复方向**：`authenticateRequest` 在解析出 `userId` 后校验账号状态（带短 TTL 的负缓存，避免每个请求都打库；`jwt-hook.ts:79` 的「零额外查询」是 API Token 路径的实现注记，且受审路径本来就有每请求 `findById`，不构成冲突）；或改为「禁用时主动吊销该用户的在途 token」。触及鉴权热路径，风险中等但收益明确。

**排重**：`docs/code-review/2026_08-24-logic-bug-review-02.md` 报过 LDAP 登录漏校验账号状态（已修），与本条「存量 token 仍可用」不是同一问题。

---

### BUG-C4（后端 / P1）runtime 清理调度器遇到取不到 stat 的条目会抛未捕获异常，可把后端进程带崩

**位置**：`backend-ts/src/harness/runtime/runtime-cleanup-scheduler.ts:64`、`:68`、`:41`

```ts
for (const sessionId of sessionDirs) {
  const sessionRoot = resolve(userRoot, sessionId);
  if (!statSync(sessionRoot).isDirectory()) continue;   // ← 取不到 stat → ENOENT 抛出，中断整轮
}
```

```ts
this.timer = setInterval(() => { void this.runCleanup(); }, this.properties.intervalMs);
// ← 无人接 catch
```

**根因**：`statSync` 没有 try/catch。复核确认两条触发路径均真实可达：

1. **悬空软链**（主要路径）：容器模式把 `runtime/<uid>` 以 rw 挂进用户容器（`harness/container/container-mount-planner.ts:83`），容器内（Agent 的 shell）可以在 `runtime/<uid>/` 下造出悬空软链，`statSync` 跟随软链即 ENOENT。
2. **其它 FS 异常**（EACCES/ELOOP 等）随时可触发。

会话目录被并发删除（`app-utils.ts:49` 的 `runtimeSessionCleanup` → `rmSync(runtime/<uid>/<sid>)`）理论上也能撞上，但循环体内除一处同步断言外全是同步代码，竞态窗口比初轮估计的窄得多，不是主要触发路径。整轮 `runCleanup()` reject → `void` 掉的是 Promise，**异常变成 unhandledRejection**，Node ≥15 默认终止进程（复核确认：全仓无 `process.on('unhandledRejection')`，启动命令为裸 `node dist/main.js`）。

**对照**：同一文件内的 `cleanupAgedFiles`（`:97-106`）对每个文件 `try { statSync } catch { continue }`、`safeReadDir`（`:119-125`）也有容错——唯独目录级两处 `statSync` 裸奔，是同一文件内的口径分裂；`docs/code-review/2026-08-23-logic-bug-review-01.md:210` 记录的 glob-search-tool 亦是带保护写法。

**复现**：runtime 目录里放一个悬空软链后跑一轮清理（或删除会话触发 `rmSync` 与定时扫描并发）。

**验证**：`backend-ts/src/harness/runtime/runtime-cleanup-scheduler.bugcheck.spec.ts`（复核确认：直接 `new RuntimeCleanupScheduler(...).runCleanup()`，走真实产品代码）

```
AssertionError: expected Error: ENOENT: no such file or directory,… to be null
```

**修复方向**：`statSync` 包 try/catch 跳过 ENOENT（与 `cleanupAgedFiles`/`safeReadDir` 同款容错）；`setInterval` 回调补 `.catch()` 兜底日志。行为风险为零。

**排重**：`docs/code-review/` 中三处提到本文件均为「已读文件清单」，2026-10-22 报告提到它的是另一条（`MAO_CLEANUP_INTERVAL_MS=` 空串 → `setInterval(0)`），与本条不同。

---

### BUG-C5（后端 / P1）微信入站图片不回退 `thumb_media`，缩略图可用时直接丢图

**位置**：`backend-ts/src/weixin/media.service.ts:57`（`downloadImage`）；规范实现 `backend-ts/src/weixin/media-crypto.ts:8`（`resolveMediaNode`）

```ts
let media = imageItem.media as Record<string, unknown> | undefined;
if (media == null) media = imageItem.thumb_media as Record<string, unknown> | undefined;  // ← 只在 media 整个缺失时回退
...
const encryptQueryParam = textOrNull(media.encrypt_query_param);
if (encryptQueryParam == null || encryptQueryParam.trim() === '') {
  console.warn('图片消息缺少 encrypt_query_param');
  return null;                          // ← 不再尝试 thumb_media
}
```

**根因**：`downloadImage` 自己内联了一套媒体节点选取规则，而仓库里的规范实现 `resolveMediaNode` 的语义是「取**第一个带合法 `encrypt_query_param` 的**节点」：

```ts
export function resolveMediaNode(fileItem) {
  for (const mediaField of ['media', 'thumb_media']) {
    const media = fileItem[mediaField];
    if (media != null) {
      const param = textOrNull(media.encrypt_query_param);
      if (param != null && param.trim() !== '') return media;
    }
  }
  return null;
}
```

**同一份入站消息里两条路径口径不一致**：文件路径 `downloadFile`（`media.service.ts:102`）用的正是 `resolveMediaNode`，图片路径没有。仓库自己的产品测试 `media.service.spec.ts:108-118`（`resolveMediaNode_fallsBackToThumbMediaWhenMediaIncomplete`）固化的正是「media 存在但字段不完整时回退 thumb_media」这一规范语义。

**复现**：构造 image item —— `media: { file_name: 'x.png' }`（无 `encrypt_query_param`）、`thumb_media: { encrypt_query_param: 'thumb-param', aes_key: <base64> }` → `downloadImage` 返回 `null`，图片被静默丢弃（`inbound-processor.ts:346-348` 仅打 warn 后跳过该图；消息无文本无文件时整条被丢弃），Agent 收不到任何图片。

**验证**：`backend-ts/src/weixin/media-image-node-fallback.bugcheck.spec.ts`（复核确认：真实 `WeixinMediaService` + 真 `encryptAes128Ecb` + 假 HTTP client）

```
AssertionError: expected null not to be null
```

**修复方向**：`downloadImage` 改用 `resolveMediaNode(imageItem)` 选节点（并同步用该节点取 AES key），与 `downloadFile` 保持同口径。不改变「media 有 param 时优先用原图」的现有行为，现有 spec（`media.service.spec.ts:157` 的 `{ media: {} }` 无 thumb_media 仍返回 null）不受影响。

**排重**：`2026-08-06-code-review-06.md` 第 3 条讲的是旧 Java 后端**文件**路径「回退到 `thumb_media` 后 AES key 没同步回退」；`2026-08-30-logic-bug-review-01.md` 把「thumb_media AES key 回退」列为无问题。两条都不是 TS 版**图片**路径的节点选取分支。

---

### BUG-C6（agent-cli / P1）LOCAL 侧 `read_file` 的 offset/limit 仍是静默钳制

**位置**：`agent-cli/src/local/tools/files.ts:268`、`:271`；云端对照 `backend-ts/src/harness/tool/impl/read-file-tool.ts:67`（+ `parseLineIndex`）

```ts
const offset = Math.max(0, asInt(args.offset, 0));                                                       // :268
const limit = args.limit != null ? Math.max(0, asInt(args.limit, Number.MAX_SAFE_INTEGER)) : Number.MAX_SAFE_INTEGER;  // :271
```

**根因**：云端 `read_file` 自 0.0.307 起改为**校验**非法值并抛错（返回带 `error` 键的失败结果），LOCAL 端未同步 —— 仍是 `Math.max(0, ...)` 静默钳制。文件里甚至留着一段自述意图的注释：

```ts
// 与云端 read_file 同口径：limit 非法/空串时回落「读全文件」而非 0——
// 返回空 content 会让模型误判文件为空，进而在 write_file 里整体覆写清空它
```

注释说的口径没有实现：`limit = -5` 被钳成 **0**（不是回落到「读全文件」），结果是 `to = from + 0` → `content = ''` → **「空内容 + success」**，正是注释里点名要避免的数据丢失场景。`limit = 'abc'` 则静默读全文件，`offset = -1` 静默钳到 0。

**复现**：5 行文件 → LOCAL `read_file {path:'a.txt', limit:-5}` → 得到 `{"content":"","total_lines":5}` 且无 `error` 键 → 模型判定「文件是空的」→ 后续 `write_file` 整体覆写清空。同样的入参在 CLOUD 会报「参数 limit 必须是非负整数」——**两端行为分裂**。

**验证**：`agent-cli/test/local-read-file-limit.bugcheck.spec.ts`（复核确认：打的是真实 `handleReadFile`，经 `agent-cli/src/local/executor.ts:202` 注册，LOCAL 模式生产可达）

```
AssertionError: expected '' to match /limit/      (limit:-5)
AssertionError: expected '' to match /offset/     (offset:-1)
AssertionError: expected '' to match /limit/      (limit:'abc')
```

**修复方向**：把云端 `parseLineIndex` 的校验口径下沉到 agent-cli 的 LOCAL 实现（负数/非整数 → 返回带 `error` 的失败结果）。**注意**：`limit:'abc'` 报错这一条与既有测试 `agent-cli/test/local-files.spec.ts:113-116`（上一轮 BUG-5 时代的 deliberate 决策：非数字回落读全文件）冲突，修复时需同步更新该旧测试——这是口径变更而非纯同步，勿漏。

**排重**：`2026-10-18-core-logic-bug-review-03.md` BUG 2 报的是**云端** `read_file` 的 `limit` 为负/零，那次只修了 `backend-ts/.../read-file-tool.ts`（提交 `ab244c73`，`git show --stat` 确认无 agent-cli 文件），agent-cli LOCAL 侧至今未同步，属仍未消除的跨端口径分裂。

---

### BUG-C7（前端 / P1）版本轮询把「本地版本基线」改写成尚未安装的远端版本

**位置**：`desktop/src/composables/useVersionCheck.ts:91-102`（基线写入在 `:101`）

```ts
const stored = readStoredVersion()
const versionChanged = !!stored?.version && stored.version !== remoteVersion
const buildChanged  = !!stored?.buildTime && stored.buildTime !== remoteBuildTime
if (versionChanged || buildChanged) { hasUpdate.value = true; newVersion.value = remoteVersion }

writeStoredVersion({ version: remoteVersion, buildTime: remoteBuildTime })   // ← 用远端覆盖本地基线
currentVersion.value = remoteVersion                                        // ← 报的是未安装的版本
```

**根因**：基线（`localStorage['app_version']`）的语义是**本窗口正在运行的版本**（见 `:82-84` 注释「刚完成加载/刷新：以远程版本为基线，避免『已刷到新代码仍提示有更新』」），轮询时**不应该推进它**；`hasUpdate`/`newVersion` 也从不按轮询结果重算。复核确认：`app_version` 键除本模块外零消费方，没有任何东西依赖轮询推进基线。

**复现（跨窗口）**：

1. 打开窗口 A（远端 1.0.0），基线 = 1.0.0。
2. 服务端发版 1.1.0 → A 轮询到变化，顶栏出现「发现页面新版本」（正确）。
3. 但 A 同时把基线改写成 **1.1.0**（它并没有安装 1.1.0）。
4. 同一浏览器再开窗口 B（仍跑 1.0.0 的代码）→ B 轮询时读到基线已是 1.1.0，与远端相同 → **不再提示更新**，B 永远停在旧前端。
5. 反向：服务端回滚到 1.0.0（用户本来就跑 1.0.0）→ 仍弹出「新版本 1.0.0」，且 `hasUpdate` 永不复位，撤不掉。

localStorage 按 origin 在多个标签页 / BrowserWindow 间共享，Web 多标签与 Electron 多窗口均中招。

**验证**：`desktop/src/composables/useVersionCheck.bugcheck.test.ts`（复核确认：动态 import 真实 composable，仅 stub localStorage/fetch）

```
AssertionError: expected '1.1.0' to be '1.0.0' // Object.is equality
AssertionError: expected true to be false // Object.is equality
```

**修复方向**：基线只在「页面加载/刷新」时同步一次，轮询不写；`hasUpdate` 每轮按「基线 vs 远端」重算（远端回落到基线时撤销提示）。两件事必须同时做（只做前者第二条断言仍不过）。

**排重**：`useVersionCheck` 的历史命中全是安卓 OTA（`2026-09-01-frontend-review-02.md` D54 等），`app_version` 零命中。

---

### BUG-D1（后端 / P2）`session.service.ts` 私有 `isTerminalPhase` 把 `IDLE` 当终态

**位置**：`backend-ts/src/session/session.service.ts:1615`（定义）、`:1394`（写入点）

```ts
// 全仓唯一的「IDLE 也算终态」定义
function isTerminalPhase(phase: string | null | undefined): boolean {
  return phase === 'IDLE' || phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
}

// :1394
if (!isTerminalPhase(oldPhase) && isTerminalPhase(phase) && /* 非机器人渠道 */) {
  fields.unread = 1;
}
```

**根因**：仓内其余所有终态定义都是 `{COMPLETED, FAILED, CANCELLED}`：

| 位置 | 口径 |
|------|------|
| `session/task-terminal.service.ts:14` | `TERMINAL = new Set(['COMPLETED','FAILED','CANCELLED'])`（其私有 `isTerminalPhase` `:360-362` 同） |
| `session/ws/streaming-ws-handler.ts:2142` | COMPLETED / FAILED / CANCELLED |
| `session/util/session-group-key.ts:238` | `ACTIVE_PHASES` 四相位，**IDLE 既不活跃也不终态**（`:1507` 注释亦如此写） |

**两个后果**：

1. **误写未读**：`RUNNING → IDLE` 的回滚路径被判成「任务刚结束」→ 写入 `unread = 1`。回滚点恰恰是「用户消息都没落库、助手更没有回复」的失败路径（`openapi/open-run.service.ts:151`、`schedule/scheduled-task.service.ts:680`）→ 会话挂上假红点，还会被 `desktop/src/utils/focusSort.ts` 的未读优先级顶到列表最前。
2. **漏写未读 / DB 与 WS 打架**：`IDLE → 终态` 时 `!isTerminalPhase(oldPhase)` 为假，DB 不写 `unread`；而同一次 `finishExecution` 里 `task-terminal.service.ts:131-136` 的 WS `session_status` 广播 `unread: true`（该行注释自称「与 updatePhase 的 DB 写入保持一致」）→ 前端收到红点，刷新后按 DB 渲染，红点消失。

**验证**：`backend-ts/src/session/session-terminal-phase-unread.bugcheck.spec.ts`（复核确认：驱动真实 `SessionService.updatePhase` 与真实 `TaskTerminalService.finishExecution`，仅 stub repo/registry）

```
× 回滚到 IDLE 不应置未读          → expected 1 to be undefined
× 从 IDLE 进入终态应置未读        → expected undefined to be 1
× 从 IDLE 进入失败终态同样应置未读 → expected undefined to be 1
× DB 的 unread 应与 WS 广播的 unread 一致 → expected { dbUnread: undefined, wsUnread: true } to deeply equal { dbUnread: 1, wsUnread: true }
```

（对照组「RUNNING → COMPLETED 仍置未读」「已是终态不重复置未读」当前通过。）

**修复方向**：把 `session.service.ts:1615` 的终态集合对齐成 `{COMPLETED, FAILED, CANCELLED}`；耗时累计的 `else if` 分支仍保留 `IDLE`，不受影响。一行修复，对照组修复后全部仍成立。

---

### BUG-D2（后端 / P2）关闭邮件通知时仍强制要求「个人资料有邮箱 / SMTP 可用」

**位置**：`backend-ts/src/notification/task/preference.service.ts:66-76`

```ts
if (channel === 'EMAIL') {
  if (enabled || channelChanged || !hasText(ciphertext)) {
    await this.assertEmailSmtpEnabled();     // enabled=false 也会因 !hasText(ciphertext) 命中
  }
  const email = await this.lookupEmail(userId);
  if (!hasText(email)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '请先在个人资料中填写邮箱，再选择邮件通知');
  }
  ciphertext = this.cipher.encrypt(email!);
}
```

**根因**：`enabled` 只在 `:85-90` 才被用来校验「渠道 + 密文」齐备，但 EMAIL 分支在校验**之前**就无条件要求邮箱与 SMTP——同一分支内相隔 3 行自相矛盾。

**这个状态是系统自己造出来的**：用户在个人资料清空邮箱 → `UserService.updateOwnProfile` 回调 `preference.refreshEmailAddress(userId, null)`（`create-app.ts:294` 注入）→ 把 EMAIL 偏好的收件密文清空但保留 `enabled=1 / channel='EMAIL'`（既有 spec `preference.service.spec.ts:191-197` 固化的有意状态）。此后用户在前端关掉邮件通知（`NotificationSettingsView.vue:553-561` 发 `{enabled:false, channel:'EMAIL'}`）→ `PUT /v1/user-preferences/task-notification` → 抛「请先在个人资料中填写邮箱」→ **`enabled` 永远停在 1**；用户稍后补回邮箱，`refreshEmailAddress` 又把地址写回去，邮件通知在用户明确关闭之后重新开始投递。

**复现**：偏好行 `{enabled:1, channel:'EMAIL', webhookCiphertext:null}` → `save(userId, false, 'EMAIL', null)` → 期望正常返回且 `enabled` 落为 0，实际抛 `BusinessException: 请先在个人资料中填写邮箱，再选择邮件通知`。

**验证**：`backend-ts/src/notification/task/preference-email-disable.bugcheck.spec.ts`（复核确认：直接 import 产品类走真实 `save`，mock 的仅是 store/cipher/lookup/smtp 窄接口）

```
× 资料邮箱已被清空时，仍应能关闭邮件通知
  → promise rejected "BusinessException: 请先在个人资料中填写邮箱，再选择邮件通知" instead of resolving
× 资料邮箱已被清空时，只提交 enabled=false（不传渠道）也应能关闭 → 同上
× 资料邮箱已被清空时，关闭不应被 SMTP 开关拦住
  → promise rejected "BusinessException: 邮件通知未启用，请联系管理员" instead of resolving
```

（对照组「邮箱仍在时关闭成功」「无邮箱时开启仍被拒绝」当前通过。）

**修复方向**：EMAIL 分支只在「本次要真正启用（`enabled=true`）或切换到 EMAIL 渠道」时才要求邮箱存在与 SMTP 可用；关闭时保留旧密文即可（与 `:85-90` 只在 `enabled=true` 时校验的口径一致）。

---

### BUG-D3（后端 / P2）`task_update` / `task_delete` 的 `id` 用 `Number()` 强转，`null`/`""` 被当成「待办 #0」

**位置**：`backend-ts/src/harness/tool/impl/task-tools.ts:187`（update）、`:284`（delete）

```ts
const id = Number(item.id);
if (!Number.isFinite(id)) {
  return errorJson(`无效的待办事项 ID: ${item.id}`);
}
```

**根因**：`Number(null) === 0`、`Number('') === 0`、`Number([]) === 0`，都通过 `Number.isFinite` 校验。于是 `{"id":null}` / `{"id":""}` 被当成待办 #0：

- update：`updateFields(0, …)` 命中 0 行，工具却回报 `已将任务 #0 更新为 completed`，并把 `transitionedToCompleted` 置真（进而触发「全部完成」判定分支）；
- delete：连校验都没有，`delete(0, …)` 什么都没删，`count++` 后回报 `已删除 1 个事项`。

**影响**：模型据此认为任务已完成/已删除，真实待办仍留在库里、状态不推进，任务面板与「全部完成」判定与真实状态脱节。

**验证**：`backend-ts/src/harness/tool/impl/task-tools-invalid-id.bugcheck.spec.ts`（复核确认：直接 import 产品 Tool 类走真实 `execute`，mock 的仅是 mapper/store）

```
× rejects a null id instead of reporting task #0 as completed
  AssertionError: expected undefined to be truthy
× rejects an empty-string id instead of reporting task #0 as completed → 同上
× rejects a null id in delete instead of claiming one item was deleted → 同上
```

**修复方向**：id 必须为正整数（复用 `asInt` 并显式校验 `> 0`），`null`/`''`/非数字一律判非法（同文件既有 spec `task-tools.spec.ts:81-89` 已确立「无效 id → errorJson」口径，当时只覆盖 `undefined→NaN`，恰留下 `null/''→0` 缺口；表 id 自增从 1 起，0 永不存在）；delete 侧补同样的校验，并且计数只统计真正命中删除的条目。

**排重**：`2026-08-30` M-9 报的是 `task_update` 的 in_progress 竞态/存在性校验；`2026-10-02` BUG-5 报的是空 status 绕白名单。均未涉及非法 id 被强制为 0。

---

### BUG-D4（后端 / P2）`task_update` 把 `null` 写进 `session_todo.content`（NOT NULL 列），整条 UPDATE 连带 `status` 一起回滚

**位置**：`backend-ts/src/harness/tool/impl/task-tools.ts:203`；配套 `backend-ts/src/harness/todo/session-todo.mapper.ts:70`

```ts
if (item.content != null) fields.content = asText(item.content);   // ← asText 对对象/数组返回 null
```

```ts
// session-todo.mapper.ts:70
await this.db.execute(
  `UPDATE session_todo SET ${keys.map(...)} WHERE id = ? AND session_id = ? AND ${notDeleted()}`,
  [...Object.values(fields), todoId, sessionId],
);
```

**根因**：守卫只判了 `item.content != null`，而 `asText`（`harness/tool/json.ts:17`）对对象/数组返回 `null` —— 模型把 content 误传成对象时，守卫放行、`asText` 给出 null，最终生成 `content = NULL`。而 `session_todo.content` 是 `VARCHAR(1024) NOT NULL DEFAULT ''`（`db/migration/V013__session_todo.sql:7`），MySQL 8 严格模式下整条 UPDATE 报 1048「Column 'content' cannot be null」，**同一条语句里的 `status`（如标记 completed）一并回滚**；工具层不校验字段类型，把 DB 约束错误原样冒给模型。

对照：`TaskCreateTool:73` 用的是 `asText(item.content) ?? ''`，mapper `insert:32` 亦有 `?? ''` 兜底——update 侧漏了同款防御。

**验证**：`backend-ts/src/harness/tool/impl/task-tools-null-content.bugcheck.spec.ts`（复核确认：mock 的 `updateFields` 模拟严格模式，被测的是真实 `TaskUpdateTool`）

```
→ 字段 content 不得为 null：session_todo.content 是 NOT NULL 列，写入 NULL 会让整条 UPDATE（含 status）失败: expected null not to be null
→ expected 'Column \'content\' cannot be null' not to match /cannot be null/i
```

**修复方向**：`asText(item.content) ?? ''`（与 create 侧一致），或对非字符串 content 直接报参数非法。

---

### BUG-D5（后端 / P2）业务失败在审计日志里被记成「成功」，失败原因恒为空

**位置**：`backend-ts/src/audit/audit.interceptor.ts:105`（success 判定）、`backend-ts/src/app-hooks.ts:94-106`（onResponse 从不传 `errorMessage`）

```ts
success: input.errorMessage == null && input.status < 400 ? 1 : 0,   // ← status 恒为 200
errorMessage: input.errorMessage != null ? truncate(input.errorMessage, MAX_ERROR_LENGTH) : null,
```

**根因**：本仓库约定业务错误也返回 HTTP 200（错误放在响应体 `code` 上）——`common/http-error.ts:78-83`：只有 1001/1002 映射成 401/403，其余 `BusinessException` 一律 `sendJson(reply, 200, fail(code, msg))`。而审计判定成功与否**只看 HTTP 状态码**，`errorMessage` 从来没人传（全仓仅 `app-hooks.ts:97-105` 一处调 `recordAudit`）。

**复现**：`DELETE /api/v1/agents/999` → 响应 HTTP 200 / body code 3001（Agent 不存在）→ 审计落库 `status=200 / success=1 / error_message=NULL`。管理后台 `admin/src/views/audit/AuditLogView.vue:154` 的「错误」列恒显示 `-`，成功/失败筛选器（`:58`）同样失灵，失败操作被统计成成功。

**验证**：`backend-ts/src/audit/audit-business-failure.bugcheck.spec.ts`（复核确认：真实 `registerAppHooks` + 真实 `recordAudit` + 真实 `handleError`，先自证前提 `statusCode===200 && body.code===3001` 再断言）

```
AssertionError: expected 1 to be +0 // Object.is equality
```

**修复方向**：onResponse 钩子读取响应体里的 `code`（非 0 即失败）并写入 `errorMessage`；或让审计改判「业务 code != 0」。同仓另两个审计写入方（`app-utils.ts:100-107` 的 `createTerminalAudit`）本就按 errorMessage 判成败。修复需保持 fire-and-forget 不破坏业务请求。

---

### BUG-D6（后端 / P2）`read_file` 的 `offset` 越界被静默钳制，返回「空内容 + success」

**位置**：`backend-ts/src/harness/tool/impl/read-file-tool.ts:76`

```ts
const offset = args && 'offset' in args ? parseLineIndex(args.offset, 'offset') : 0;
const limit  = args && 'limit'  in args ? parseLineIndex(args.limit,  'limit')  : Number.MAX_SAFE_INTEGER;
...
const from = Math.min(offset, totalLines);          // ← 越界被静默钳制
const to   = Math.min(from + limit, totalLines);
let content = allLines.slice(from, to).join('\n');
return toJson({ content, total_lines: totalLines }); // ← 无 error 键 → 判 success
```

**根因**：同一函数上方的注释明确写了这条风险：

```ts
// offset/limit 校验而非静默钳制：负数钳到 0 会让模型拿到「空 content + success」，
// 进而误判文件为空并用 write_file 整体覆写清空它（agent-cli 同源动机）。故显式报错，
```

0.0.307 用 `parseLineIndex` 修掉了**取值非法**（负数/非整数）这一侧，但**取值合法而范围越界**这一侧（`offset > 文件行数`）没有对应校验 —— `Math.min(offset, totalLines)` 把越界 offset 悄悄压到 EOF，返回 `{"content":"","total_lines":N}`，顶层没有 `error` 键 → `harness/tool/tool-result.ts:66` 的 `normalizeToolResult` 判为 **success**，下游审计/统计/UI 全部记成「读成功」。同文件里现成的正确范式就是 `readError()`（`:144`，带 `error` 键）。

**复现**：3 行文件 `one\ntwo\nthree` → `read_file{path:'small.txt', offset:99}` → 期望「带 error 的失败态」，实际 `{"content":"","total_lines":3}`。

**验证**：`backend-ts/src/harness/tool/impl/read-file-out-of-range-offset.bugcheck.spec.ts`（复核确认：真实 `ReadFileTool` + 真实 `PathSandbox` + 真实 `normalizeToolResult`）

```
AssertionError: expected undefined to be defined
```

（对照组「`offset == total_lines` 仍是合法空尾窗口」当前通过，修复时勿误伤。）

**修复方向**：`offset > totalLines` 时显式返回错误（与 `parseLineIndex` 的非法值同级处理），或至少在返回体里带上 `offset_out_of_range` 标记。复核补充：`offset ∈ [0, totalLines]` 都是合法窗口（EOF 空尾用于分页终止判定），边界不任意；响应体带 `total_lines`，「覆写清空」的灾难场景有缓解，本条主要危害在契约与统计口径。

**排重**：`2026-10-18-core-logic-bug-review-03.md` BUG 2 报的是 `limit` 为负/零（已被 `parseLineIndex` 修复）；全库报告未出现「offset 超出 EOF 被钳制」。

---

### BUG-D7（agent-cli / P2）活跃相位集合缺 `RESUMING` / `CANCELLING`

**位置**：`agent-cli/src/ws/event-types.ts:36`

```ts
export const ACTIVE_PHASES = new Set(['RUNNING', 'WAITING_APPROVAL']);
```

**根因**：后端唯一口径是四相位（`backend-ts/src/session/util/session-group-key.ts:238`，注释还专门写了「CANCELLING 是取消流程进行中的活跃相位，漏列会把取消中的会话当空闲排到后面」）：

```ts
export const ACTIVE_PHASES = ['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'] as const;
```

桌面端同口径（`desktop/src/stores/session/types.ts:8`），契约 `shared/contracts/src/ws.ts` 的 `WsTaskPhase` 亦含这两相。后端确实会下发：`session/ws/streaming-ws-handler.ts:1277` 发 `session_status {phase:'RESUMING'}`（重试执行），`weixin/agent-inbound-handler.ts:254` 发 `session_status {phase:'CANCELLING'}`（中止在途执行）。

**影响**：`isRunningPhase` 是 agent-cli 的「会话还在跑吗」判据（`agent-cli/src/session/session-runner.ts:106` `snapshotIsActive`、`:137` `wasActive`、`:385` 快照采纳 executionId）。漏相位后：撞上恢复中/取消中的会话时 `wasActive = false` → 不走 `handleAlreadyActive` → `--if-running=fail` 不再快速失败（`commands/chat.ts:230`）、`--if-running=cancel` 不发取消（`session-runner.ts:337`）；REPL 也会把「还在取消中」显示成空闲（`repl/repl.ts:149,158`）。

**验证**：`agent-cli/test/ws-active-phases.bugcheck.spec.ts`（复核确认：直接 import 产品代码，无复刻逻辑）

```
AssertionError: expected false to be true // Object.is equality        (RESUMING)
AssertionError: expected false to be true // Object.is equality        (CANCELLING)
AssertionError: expected [ 'RUNNING', 'WAITING_APPROVAL' ] to deeply equal [ 'CANCELLING', 'RESUMING', … ]
```

**修复方向**：`ACTIVE_PHASES` 补齐四相位（与 `shared/contracts` / 后端口径一致）。集合补两个字符串，零风险。

**排重**：`2026-08-24-logic-bug-review-02.md:438` 的「`isActive` 与 `ACTIVE_PHASES` 使用同一集合」指的是**桌面端**，已修；本条是 agent-cli 里独立的第二份集合。

---

### BUG-D8（agent-cli / P2）value 型选项遇到内联空值直接抛错，CLI 起不来

**位置**：`agent-cli/src/args.ts:381`、`:399`、`:436`、`:439`

```ts
const permissionLevelRaw = optionalString(flags, 'permission-level');
const permissionLevel = permissionLevelRaw != null        // ← '' 也不为 null
  ? parseEnum('permission-level', permissionLevelRaw, [...], 'READ_WRITE', upper)
  : undefined;
```

**根因**：正确口径**同文件已有先例** —— `:375-379` 的 `output-format` 用 `raw?.trim()` 判空、空串按「未下发」处理，注释还写明了理由：

```ts
// 空串/纯空白（置空但未 unset 的环境变量、`--output-format=` 内联空值）按「未下发」
// 处理，与 config-store 的 envBool / resolveConfig 归一口径一致；否则 `'' != null`
// 成立，parseEnum 抛错导致任何子命令都无法启动。
```

其余同类选项没跟上：`--permission-level=`、`--if-running=`、`--on-question=`、`--on-approval=` 走 `parseEnum('')`（`:305` 抛错），`--timeout-ms=` / `--max-duration=` 走 `positiveInt('')`（`Number('') === 0` → `:275` 抛「必须是正整数」）。

**复现**：`mao-agent --timeout-ms=$EMPTY -p "hi"`（shell 变量未设置时展开为空）→ CLI 报「选项 --timeout-ms 必须是正整数，收到: 」并退出。`--permission-level=`/`--if-running=`/`--on-question=`/`--on-approval=`/`--max-duration=` 同理。`parseCliConfig`（`main.ts:50`）是所有命令的唯一入口，上述抛错意味着任何子命令（含 `status`）都起不来。

**验证**：`agent-cli/test/args-empty-inline-value.bugcheck.spec.ts`（复核确认：直接 import 真实 `parseCliConfig`）

```
AssertionError: expected CliError: --permission-level 必须是 READ_ONL… { exitCode: 1 } to be null
AssertionError: expected CliError: --if-running 必须是 wait|cancel|fa… { exitCode: 1 } to be null
AssertionError: expected CliError: --on-question 必须是 ask|fail，收到:  { exitCode: 1 } to be null
AssertionError: expected CliError: --on-approval 必须是 ask|fail，收到:  { exitCode: 1 } to be null
AssertionError: expected CliError: 选项 --timeout-ms 必须是正整数，收到:  { exitCode: 1 } to be null
AssertionError: expected CliError: 选项 --max-duration 必须是正整数，收到:  { exitCode: 1 } to be null
```

（对照组「显式给值仍生效」当前通过；既有 `args.spec.ts:88` 的 `--max-duration=-1` 抛错不受影响。）

**修复方向**：把 `output-format` 的空串处理抽成公用谓词（`hasText(raw)`），所有 value 型选项统一使用（`config-store.ts:130` 有同口径注释与前序用例 `args-env-empty.bugcheck.spec.ts` 佐证）。顺手覆盖 `--resume=`（`:311-320` 的 `parseResume` 同样抛错，属同一类，测试未覆盖）。

---

### BUG-D9（mao-cli / P2）`--permission-level` 白名单漏了 `PROXY`

**位置**：`skills/mao-cli/lib/commands/session.js:34`（校验点 `:95-96`、`:151-152`）

```js
const PERMISSION_LEVELS = new Set(['READ_ONLY', 'READ_WRITE', 'SMART', 'FULL']);
if (permissionLevel && !PERMISSION_LEVELS.has(permissionLevel)) {
  throw createCliError('--permission-level 必须是 READ_ONLY|READ_WRITE|SMART|FULL');
}
```

**根因**：后端 `PermissionLevel` 是五档，`PROXY` 是正式档位（`backend-ts/src/session/permission-level.ts:1-3`：`'READ_ONLY' | 'READ_WRITE' | 'SMART' | 'PROXY' | 'FULL'`，`session.service.ts:126,1439` 均接受落库），agent-cli 也已同步（`agent-cli/src/args.ts:7`、`:382`），桌面端 `PermissionLevelSwitcher.vue` 向用户提供 PROXY。设计文档 `docs/plan/2026-09-30-proxy-permission-level-design.md:45` 明确决策「仅 `--permission-level` 枚举放行 PROXY 值」——mao-cli 这份白名单漏了。

**复现**：`mao session update --id 7 --permission-level PROXY` → 本地直接报错，请求根本没发出（`session create` 同样）。

**验证**：`agent-cli/test/mao-cli-session-permission-level.bugcheck.spec.ts`（复核确认：`createRequire` 加载真实 `session.js`，仅桩 `http.request`）

```
AssertionError: expected Error: --permission-level 必须是 READ_ONLY|R… { exitCode: 1 } to be null
```

**修复方向**：`PERMISSION_LEVELS` 补 `PROXY`（并同步错误文案与 `skills/mao-cli/reference/session.md:107` 的参数文档——按 AGENTS.md 文档同任务同步约定须一并改）。

**排重**：`2026-09-30-proxy-permission-review-01.md` 第 3 条报的是 **agent-cli** 不接受 `PROXY`（已修），没点 mao-cli。

---

### BUG-D10（mao-cli / P2）全局开关 `--raw=false` / `--json=false` 反而把开关打开

**位置**：`skills/mao-cli/lib/args.js:139-140`

```js
json: Boolean(flags.json),   // :139
raw: Boolean(flags.raw),     // :140
```

**根因**：`parseArgs`（`:20-27`）对 `--raw=false` 解析出 `flags.raw === 'false'`（**字符串**），`Boolean('false') === true` → 开关被打开。同文件的 `optionalBoolean`（`:109-115`）明确支持 `'false'/'0' → false`，agent-cli 的 `parseBooleanValue`（`args.ts:187`）同样支持 —— `extractGlobalOptions` 漏用了它。

**影响**：`globals.raw` 一路传到 `outputResult(result, globals)`（`output.js:19-37`），raw=true 时打印完整 Result 信封 `{code,message,data}` 而非 `data`。于是 `mao --raw=false session list | jq .data` 取不到数据 —— 用户显式写了「不要 raw」却被当成「要 raw」。

**验证**：`agent-cli/test/mao-cli-global-bool-flags.bugcheck.spec.ts`（复核确认：`createRequire` 加载真实 `args.js`，并实跑验证 `['session','list','--raw=false']` → `globals.raw === true`）

```
AssertionError: expected true to be false // Object.is equality     (--raw=false)
AssertionError: expected true to be false // Object.is equality     (--json=false)
AssertionError: expected true to be false // Object.is equality     (--raw=0)
```

**修复方向**：`extractGlobalOptions` 改用 `optionalBoolean(flags, 'raw')` / `optionalBoolean(flags, 'json')`。**注意坑**：`parseArgs:35` 会把裸 `--raw` 后紧跟的位置参数当作值吞掉（`['--raw','session','list']` → `flags.raw === 'session'`），直接换 `optionalBoolean` 会让该形态抛 CliError；修复需把非布尔字符串按真处理或先修 `parseArgs`。惯用写法（flag 放子命令后）不受影响。

---

### BUG-D11（前端 / P2）工具参数预览读的字段后端 schema 里不存在

**位置**：`desktop/src/utils/toolDisplay.ts:120`（page 分支）、`:155`（通用兜底）

```ts
case 'page_inspect':
case 'page_observe':
case 'page_screenshot':
  return typeof input.reason === 'string' ? input.reason : ''
```

**根因**：后端真实 schema（`backend-ts/src/harness/tool/impl/page-tools.ts`）：

| 工具 | 真实入参 | 是否有 `reason` |
|------|---------|----------------|
| `PageInspectTool`（`:105`） | `{ includeHidden }` | ❌ |
| `PageObserveTool`（`:115`） | `{ snapshotId }` | ❌ |
| `PageScreenshotTool`（`:130`） | `{ maskSensitive, reason }` | ✅ |

`open_web_page`（`open-web-page-tool.ts:67`）的入参是 `{ url }`（required），通用兜底只认 `command/pattern/path/file_path/query/agent_type/task`，**不含 `url`**。

**结果**：这三类工具的参数预览恒为空字符串（`page_screenshot` 恰好因为有 `reason` 才正常）。两类工具均无条件注册（`tool-registry.ts:144`、`:177`），生产可达；后端自己的 summarizer 就把 `url` 当作 open_web_page 的核心参数（`tool-result-summarizer.ts:409-411`），桌面端没理由不展示。

**验证**：`desktop/src/utils/toolDisplay.bugcheck.test.ts`（复核确认：直接 import 产品函数 `getToolInputPreview`）

```
AssertionError: expected '' to contain 'snap-42'
AssertionError: expected '' to contain 'https://example.com/guide/intro'
```

**修复方向**：`page_inspect` 取 `includeHidden`、`page_observe` 取 `snapshotId`，通用兜底补 `url`。纯展示层改动、风险极低；按 AGENTS.md「工具展示须与后端 schema 同步」的规范有修复义务。

**排重**：`2026-10-11-core-logic-bug-review-01.md:448` 检查的是**工具中文名**是否齐备（结论「无缺失」），不是入参字段；`2026-10-18-core-logic-bug-review-03.md:295` 的 probe 结论也不涉及 page_* 的参数预览分支。

---

### BUG-D12（前端 / P2）轨迹面板取「最旧」的一次执行当当前执行

**位置**：`desktop/src/stores/session/trace.ts:132`；消费方 `desktop/src/components/center/RunTracePanel.vue:397`

```ts
function getLiveExecutionId(sessionId: string): string | null {
  const prefix = `${String(sessionId)}|`
  for (const key of liveRounds.value.keys()) {
    if (key.startsWith(prefix)) return key.slice(prefix.length)   // ← 第一个命中 = 最旧
  }
  ...
}
```

**根因**：注释写「同一会话同时只有一个执行在跑，取任一临时键即可」—— 该前提不成立：`useStreamWS.ts:716` 的 `session_status` 终态分支会 `clearLiveState(sessionId)`，但**重连路径 `session_snapshot` 的终态分支（`useStreamWS.ts:923-951`）没有清临时行**（`clearLiveState` 全仓仅此一个调用点，`trace.reset()` 只在登出时跑），残留键长期存在。

**复现**：会话执行 A（`round_start` 已到）→ 断线重连，服务端此时已跑完 → 重连走 `session_snapshot` 终态分支，残留键未清 → 再次执行 B（新 executionId）→ 轨迹 Tab 仍显示 A 的「第 1 轮 / 模型调用中」，B 的轮次与工具计时不出现。一旦命中，整个下一轮执行期间轨迹面板都显示上一轮内容。

**验证**：`desktop/src/stores/session/trace.bugcheck.test.ts`（复核确认：import 真实 `createTraceModule`，场景与生产泄漏后的 Map 状态一致）

```
AssertionError: expected 'exec-old' to be 'exec-new' // Object.is equality
```

**修复方向**：根因修复是在 `session_snapshot` 终态分支补 `clearLiveState(sessionId)`（与 `session_status` 分支对齐）；同时把 `getLiveExecutionId` 改为取**最后**一个匹配的键（`Array.from(keys).reverse()`）作纵深防御。建议两者都做。

---

### BUG-D13（前端 / P2）按 `agent_type` 过滤子代理时「无匹配」被当成「不筛选」

**位置**：`desktop/src/stores/session/subagent.ts:61`；消费方 `desktop/src/components/chat/ToolCallCard.vue:135`

```ts
if (opts?.agentType) {
  const byType = candidates.filter(t => t.agentType === opts.agentType)
  if (byType.length > 0) candidates = byType   // ← 0 命中时保留全部候选
}
...
return candidates.length === 1 ? candidates[0].id : null
```

**根因**：同文件的 `task` 过滤是有意放宽（任务文案可能不一致），但 `agent_type` 是**类型判别**，放宽等于「绑错」。0 命中时应当把候选集清空。

**复现**：父会话下只有一个 `agent_type=reviewer` 的运行中子代理；主会话里出现一条 `agent_type=coder` 的 `delegate` 工具卡 → 点「查看子代理过程」打开的是 reviewer 的会话。

**验证**：`desktop/src/stores/session/subagent.bugcheck.test.ts`（复核确认：import 真实 `createSubagentModule`）

```
AssertionError: expected 101 to be null
```

**修复方向**：`agentType` 无匹配时直接 `return null`（或把 candidates 置空）。修复后未绑定的卡片走 `ToolCallCard.vue:144-145` 的「子代理会话尚未就绪」提示，比打开错误会话严格更好。

---

## 三、验证用例

### 3.1 用例文件清单（20 个，新增）

| 文件 | 覆盖 BUG |
|------|---------|
| `backend-ts/src/session/terminal-audit-ip.bugcheck.spec.ts` | BUG-C2 |
| `backend-ts/src/app-hooks.disabled-account.bugcheck.spec.ts` | BUG-C3 |
| `backend-ts/src/harness/runtime/runtime-cleanup-scheduler.bugcheck.spec.ts` | BUG-C4 |
| `backend-ts/src/weixin/media-image-node-fallback.bugcheck.spec.ts` | BUG-C5 |
| `backend-ts/src/session/session-terminal-phase-unread.bugcheck.spec.ts` | BUG-D1 |
| `backend-ts/src/notification/task/preference-email-disable.bugcheck.spec.ts` | BUG-D2 |
| `backend-ts/src/harness/tool/impl/task-tools-invalid-id.bugcheck.spec.ts` | BUG-D3 |
| `backend-ts/src/harness/tool/impl/task-tools-null-content.bugcheck.spec.ts` | BUG-D4 |
| `backend-ts/src/audit/audit-business-failure.bugcheck.spec.ts` | BUG-D5 |
| `backend-ts/src/harness/tool/impl/read-file-out-of-range-offset.bugcheck.spec.ts` | BUG-D6 |
| `agent-cli/test/mao-cli-llm-call-emit-result.bugcheck.spec.ts` | BUG-C1 |
| `agent-cli/test/local-read-file-limit.bugcheck.spec.ts` | BUG-C6 |
| `agent-cli/test/ws-active-phases.bugcheck.spec.ts` | BUG-D7 |
| `agent-cli/test/args-empty-inline-value.bugcheck.spec.ts` | BUG-D8 |
| `agent-cli/test/mao-cli-session-permission-level.bugcheck.spec.ts` | BUG-D9 |
| `agent-cli/test/mao-cli-global-bool-flags.bugcheck.spec.ts` | BUG-D10 |
| `desktop/src/composables/useVersionCheck.bugcheck.test.ts` | BUG-C7 |
| `desktop/src/utils/toolDisplay.bugcheck.test.ts` | BUG-D11 |
| `desktop/src/stores/session/trace.bugcheck.test.ts` | BUG-D12 |
| `desktop/src/stores/session/subagent.bugcheck.test.ts` | BUG-D13 |

用例断言的都是**应有行为**：当前源码下全部失败（失败即证明缺陷存在），修复后全部转绿，并作为回归用例留在默认套件里防止回退。命名沿用仓库既有约定 `*.bugcheck.spec.ts` / `*.bugcheck.test.ts`，因此**已并入默认测试套件**（后端 `src/**/*.spec.ts`、desktop `src/**/*.test.ts`、agent-cli `test/**/*.spec.ts`），无需额外 vitest 配置。

### 3.2 运行方式与实跑结果

```bash
# 后端
cd backend-ts && npx vitest run \
  src/app-hooks.disabled-account.bugcheck.spec.ts \
  src/audit/audit-business-failure.bugcheck.spec.ts \
  src/harness/runtime/runtime-cleanup-scheduler.bugcheck.spec.ts \
  src/harness/tool/impl/read-file-out-of-range-offset.bugcheck.spec.ts \
  src/harness/tool/impl/task-tools-invalid-id.bugcheck.spec.ts \
  src/harness/tool/impl/task-tools-null-content.bugcheck.spec.ts \
  src/notification/task/preference-email-disable.bugcheck.spec.ts \
  src/session/session-terminal-phase-unread.bugcheck.spec.ts \
  src/session/terminal-audit-ip.bugcheck.spec.ts \
  src/weixin/media-image-node-fallback.bugcheck.spec.ts \
  --coverage.enabled=false --reporter=verbose > /tmp/verify-backend.log 2>&1; echo exit=$?
```

```
 Test Files  10 failed (10)
      Tests  18 failed | 9 passed (27)
```

```bash
# 前端
cd desktop && npx vitest run src/utils/toolDisplay.bugcheck.test.ts \
  src/stores/session/subagent.bugcheck.test.ts \
  src/stores/session/trace.bugcheck.test.ts \
  src/composables/useVersionCheck.bugcheck.test.ts > /tmp/verify-desktop.log 2>&1; echo exit=$?
```

```
 Test Files  4 failed (4)
      Tests  6 failed | 4 passed (10)
```

```bash
# 终端 CLI
cd agent-cli && npx vitest run test/args-empty-inline-value.bugcheck.spec.ts \
  test/local-read-file-limit.bugcheck.spec.ts \
  test/mao-cli-global-bool-flags.bugcheck.spec.ts \
  test/mao-cli-llm-call-emit-result.bugcheck.spec.ts \
  test/mao-cli-session-permission-level.bugcheck.spec.ts \
  test/ws-active-phases.bugcheck.spec.ts > /tmp/verify-cli.log 2>&1; echo exit=$?
```

```
 Test Files  6 failed (6)
      Tests  20 failed | 7 passed (27)
```

合计 **44 条断言失败、20 条对照组通过**，全部失败均为具体的断言差异（expected/actual），没有 import 失败、语法错误或环境缺失。失败用例所在的文件之外，其余既有测试保持全绿（agent-cli 既有 42 个测试文件 / 530 条用例、desktop 既有 82 个测试文件 / 735 条用例均未受影响）。

### 3.3 关于「测试先红」

本轮与仓库上一轮（`2026-10-22-logic-bug-review-01.md` → 提交 `05da78d7` → 修复提交 `45f8bedb`）采用同一节奏：**先落用例与报告（红），修复另起提交（绿）**。

修复已于 2026-10-23 闭环（CHANGELOG 0.0.336）：20 个用例全部转绿并留在默认测试套件——全量实跑 backend-ts 397 文件 / 4663 条、agent-cli 48 文件 / 550 条、desktop 86 文件 / 741 条全部通过，三个包构建（tsc / vue-tsc + vite）通过。上方 3.2 的失败快照保留作审查当时的证据。

---

## 四、经复核剔除的候选（避免误报）

| 候选 | 位置 | 剔除理由 |
|------|------|---------|
| 哨兵 prompt 截断后长度超 32000 | `backend-ts/src/signal/watcher.logic.ts:145` | 截断分支**生产不可达**：哨兵 prompt 模板在保存时已被限制为 ≤2000 字（`signal/watcher.service.ts:547`），diff 片段上限 500 字（`watcher.logic.ts:10`），渲染成品最长约 3100 字，远低于 32000。缺陷分支存在，但构不成实际故障，故不计入（用例 `signal/watcher-prompt-truncation.bugcheck.spec.ts` 同步删除）。 |
| `read_file` 的 `offset` 越界 | —— | **保留但降级为 P2**：与 BUG-D6 合并为一条（同一根因：越界未校验）。 |
| `task_update` 的 in_progress 竞态 | —— | `2026-08-30` M-9 已报过，且已修复。 |
| 微信语音 WAV 时长按「声明长度」计算 | `backend-ts/src/weixin/voice-codec.service.ts:134` | 代码缺陷真实存在（已实跑复现：声明 0x7fffffff、实际 32000 字节 → 算出 ≈18.6 小时），但**生产链路不可达**：`estimateWavDurationMs` 的唯一调用链 `wavToSilk → playtimeMs → sendVoice`（写 `voice_item.playtime`）在全仓没有任何生产调用方——真实语音回复走 `voice-reply.service.ts` 的 `wavToMp3` + `sendFile`（MP3 文件），不经 silk/playtime。死代码路径上的潜在雷，不构成实际故障，故不计入（用例 `voice-codec-wav-duration.bugcheck.spec.ts` 同步删除；将来若接线 `wavToSilk`，需先按 `model/model.service.ts:468` 的正确写法修掉再接）。 |
| 钉钉 `limitReply` 截断结果超上限 | `backend-ts/src/dingtalk/send.service.ts:24` | 缺陷算术意义上存在，但**修复价值不高且期望行为与仓库既有契约冲突**：① 默认上限 2000，仅运维把 `DINGTALK_BOT_REPLY_MAX_LENGTH` 误配到 <10 才触发；② 既有产品测试 `send.service.spec.ts:18` 明确锁定 limit=4 时结果以完整 10 字后缀结尾，飞书侧（`feishu-client.ts:61`）同样把后缀当作上限之外的说明开销，「截断结果不得超过上限」并非仓库既定口径，按此修复反而打破现有契约；③ 误配场景下用户收到的仍是语义正确的截断提示，钉钉 API 不会拒发，500 字重试兜底不受影响。故不计入（用例 `send-limit-reply.bugcheck.spec.ts` 同步删除）。 |
| admin `PHASE_LABELS` 缺 `CANCELLING`、`MessageGroup.vue` 的 `ACTIVE_PHASES` 缺 `RESUMING` | `admin/src/utils/labels.ts:8`、`admin/src/views/session/components/MessageGroup.vue:99` | 只影响列表标签展示，不影响功能判定（后端 VO 已给正确字段），按「展示小瑕疵」不计入逻辑 BUG。 |

---

## 五、修复建议顺序

1. **安全与凭据类（P1 优先）**：BUG-C1（mao-cli token 泄漏）、BUG-C2（审计 IP 可伪造）、BUG-C3（禁用账号 token 仍可用）。
2. **进程稳定性**：BUG-C4（清理调度器把后端带崩）。
3. **集成链路丢数据**：BUG-C5（微信丢图）、BUG-C6（LOCAL read_file 覆写清空风险）。
4. **前端提示失效**：BUG-C7（更新提示）。
5. **状态机与数据一致性**：BUG-D1（未读口径）、BUG-D3/BUG-D4（待办工具）、BUG-D5（审计成功判定）。
6. **口径漂移类**：BUG-D7（相位集合）、BUG-D8/BUG-D9/BUG-D10（CLI 参数）、BUG-D11/BUG-D12/BUG-D13（前端展示与绑定）、BUG-D6（边界）。

修复完成后，请把上表 20 个 `*.bugcheck.*` 用例的断言转绿即可，无需再改 vitest 配置（它们已在默认套件内）。（已于 2026-10-23 随 0.0.336 完成，见「修复记录」。）

---

## 六、本次审查的边界

- **审查阶段未修改任何产品源码**：初轮只新增验证用例文件与本报告；复核轮剔除 2 条低价值候选（微信语音 WAV 时长、钉钉 `limitReply`）并同步删除其用例文件，最终确认 20 条。
- **修复阶段（2026-10-23 闭环）**：20 条全部修复（见「修复记录」），含产品代码改动、用例转绿、CHANGELOG 0.0.336、desktop 版本 sync、`skills/mao-cli` 参考文档同步；修复未做 git commit，留在工作区由维护者审定后提交。
- **未做端到端验证**：本轮缺陷均为单元级可复现问题，验证用例直接调用产品代码路径，不依赖真实 MySQL / 网络 / 外部渠道。
