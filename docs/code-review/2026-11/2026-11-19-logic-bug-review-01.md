# 2026-11-19 逻辑 BUG 审查 01

- 方法：5 个只读审计代理并行分区扫描（后端杂项域 ×2 轮、harness 引擎、desktop、agent-cli、admin+android）+ 主会话逐行深读（最近两周新合入代码、desktop 核心链路 useChat/useStreamWS、statistics/digest/memory/skill/openapi、harness/tool impl、feishu/dingtalk 入站链路）。候选逐条**亲自对照源码核实机制**后，按「正确契约」编写存在性验证用例：先以普通 `it` 运行捕获真实失败输出，确认为真实缺陷后再以 `it.fails` 固化（保持 CI 绿，修复后转正为普通回归，惯例同 logic-bug-review-2026-11-11/13）。
- 验证落点（随本报告一并入库，全部真实运行过）：
  - `backend-ts/src/logic-bug-review-2026-11-19.spec.ts`（BUG-1、BUG-8、BUG-9；各含对照用例）
  - `agent-cli/test/logic-bug-review-2026-11-19.spec.ts`（BUG-3 ~ BUG-7）
  - `docs/code-review/repro/2026-11-19-logic-bug-review/android-ota/`（BUG-2：仓库原文件 + 最小桩 + JDK 内置 HTTP 服务器的独立 JVM 复现，运行方式见其 README）
- 结论：**确认 9 个**（backend-ts 3 + agent-cli 5 + android 1），全部有失败输出实证；另 4 条候选经核实代码层面存在但未达到「测试实证」标准（见文末「候选未确认」），3 条候选被否决。
- 复核（同日第二轮）：9 条确认项逐行对照源码复核 + 重跑两个 spec（backend 6 / agent-cli 6 全过，expected-failure 形态）+ 实测 BUG-6 的 win32 spawnSync 分支，**全部成立、无删减**；4 条候选未确认的代码位置同样逐点复核成立。顺带修正个别行号漂移与一处描述（BUG-3/5/8/9、候选 1/2，见各条）。

## 确认清单

| # | 端 | 位置 | 严重度 | 一句话 |
|---|---|------|--------|--------|
| 1 | backend-ts | `harness/tool/impl/task-tools.ts:189`（update）、`:292`（delete） | 中 | 非数组 items 静默按空数组处理 → 「假成功」；0.0.341 只修了 task_create 的同款缺陷 |
| 2 | android | `android/.../AppUpdatePlugin.java:104-148` | 中 | OTA 下载无完整性校验：优雅截断的半成品 APK 被改名安装；空响应体把上次残留旧包拉起安装并 resolve ok:true |
| 3 | agent-cli | `src/rest/rest-client.ts:128-153` | 中 | REST 超时只覆盖到响应头，`response.text()` 无超时 → 服务端 stall 时请求永不返回（`/exit` 收尾挂死） |
| 4 | agent-cli | `src/rest/rest-client.ts:153-174` | 中低 | 401 响应体为非 JSON（反代 HTML）时走 `HTTP 401: <原文>` 分支，跳过整个刷新/重登链 |
| 5 | agent-cli | `src/local/executor.ts:467-470,158-164` | 高 | 投票回声等待无超时且断线不清理：`onWsClosed` 只清 remoteWaiters 不清 approvalEchoWaiters，工具卡死到服务端 900s 超时 |
| 6 | agent-cli | `src/commands/update.ts:28-41,120-122` | 中 | Windows 上 `spawnSync('npm')` 无 shell 必 ENOENT（本机实证）；失败点在 `git checkout --force FETCH_HEAD` 之后，留下半更新状态 |
| 7 | agent-cli | `src/auth/auth-store.ts:71,45-58` | 中低 | saveAuth 直写非原子（同仓基线均 tmp+rename）；auth.json 损坏时 loadAuth 复活陈旧 legacy 凭据 |
| 8 | backend-ts | `notification/task/preference.service.ts:47` | 中 | webhook 密文解密失败时 get() 整体抛错：偏好面板打不开、连「关闭通知」的响应都是错误 |
| 9 | backend-ts | `inbox/inbox.service.ts:557-562`（及 5 处同型位点） | 低 | clip() 按 UTF-16 码元截断切断代理对——2026-11-13 已把同缺陷类定性为 bug 并修复 weixin 分片 |

---

## BUG-1（中）task_update / task_delete 非数组 items 静默 no-op 假成功

- **位置**：`backend-ts/src/harness/tool/impl/task-tools.ts:189`（TaskUpdateTool：`Array.isArray(args.items) ? args.items : []`）、`:292`（TaskDeleteTool 同款）。
- **触发条件**：模型把 items 数组字符串化 / 直接传单个对象（参数抖动的常见形态）。
- **错误行为 vs 契约**：update 返回 `{todos}`（无 summary、无 `error` 键）——`normalizeToolResult` 按「JSON 顶层含 error 键」判定失败态，缺键即 success，模型认为更新已生效、实际什么都没发生；delete 返回「已删除 0 个事项」的成功信封。契约出处：同文件 TaskCreateTool 的同款守卫是 2026-10-24 修复（commit 58aec5bd，0.0.341）加上的，注释明说「非数组……必须报错：当成空数组会返回『已创建 0 个』外加引导语，normalizeToolResult 看不到 error 键就会判成功」——同批修复只给 update/delete 换了 `asIntStrict`，这条守卫漏掉。
- **验证**（`backend-ts/src/logic-bug-review-2026-11-19.spec.ts`，stub SessionTodoMapper；含 task_create 对照用例证明脚手架正确）：
  ```
  AssertionError: expected undefined to be defined（两例；对照 task_create 同入参返回 error ✓）
  ```
- **为什么既有测试没抓住**：`integer-arg-truncation.bugcheck.spec.ts` 只覆盖 asIntStrict 的整数语义；items 形状校验只在 task_create 有回归，update/delete 无用例。
- **修复建议**：update/delete 复用 task_create 的守卫文案（`items 必须是数组，收到 …`），删除时对「空数组」也应显式报错或按 0 计数说明，与 create 口径对齐。

## BUG-2（中）android OTA 下载无完整性校验：截断包被安装 / 空响应体安装陈旧残留包

- **位置**：`android/android/app/src/main/java/cn/etarch/mao/app/AppUpdatePlugin.java:104-148`（`downloadToFile`；关键 `:115` `getContentLengthLong()` 从未参与校验、`:138` 只查 `tmp.length() > 0`、`:147` 空产物仍 `return apk`）。
- **触发条件**：两条真实可达路径——(a) 弱网/代理/CDN 在传输中途**正常关流**（TCP FIN 而非 RST）：`in.read()` 返回 -1 不抛异常，半成品 APK 通过 `length() > 0` 检查被改名 `mao-update.apk` 并拉起安装，用户只看到「解析包错误」且重试永远失败；(b) 上传/代理层返回 200 空响应体：rename 被跳过但方法仍返回 `apk`——该文件是**上次升级残留的旧包**（成功改名路径之外的残留从未被清理），被直接拉起安装并 resolve `ok:true`，前端 `useVersionCheck.androidInstallUpdate` 置 `appUpdateDownloaded=true`、轮询条件 `!appUpdateDownloaded.value`（`useVersionCheck.ts:155`）从此停止检查，更新流程假完成。
- **错误行为 vs 契约**：`:121` 注释自述「下载到临时文件，完成后改名，避免残留半成品」——「只有完整下载才允许进入安装」；`total > 0` 时必须校验 `done === total`，空产物必须报错而不是返回残留旧包。
- **验证**（`docs/code-review/repro/2026-11-19-logic-bug-review/android-ota/`，真实业务源码 + 最小桩 + JDK HttpServer，win32/JDK 17 实测）：
  ```
  [A] 200 + Content-Length:1000 + 实际仅 500 字节（正常断流）
      call.resolved=true  mao-update.apk exists=true size=500
      结论：截断的 APK 被改名安装且 resolve ok:true（BUG 实证）
  [B] 200 + Content-Length:0 + 预置旧 mao-update.apk（21 字节）
      call.resolved=true  被安装的 apk size=21（旧残留包）
      结论：空响应体未报错，把上次残留的旧 APK 拉起安装并 resolve ok:true（BUG 实证）
  ```
- **为什么既有测试没抓住**：android 侧无单测基建（src/test 仅 ExampleUnitTest），`downloadToFile` 的分支从未被驱动过。
- **修复建议**：`total > 0 && done !== total` 时删 tmp 并抛 IOException；`tmp.length() === 0` 时抛错而非返回 `apk`；可在改名成功后清理旧包残留。路径 B 的「无残留包」分支会因 FileProvider 对不存在文件抛异常 reject，危害小于残留包分支，一并修掉。

## BUG-3（中）RestClient 超时只覆盖到响应头，body 读取无超时

- **位置**：`agent-cli/src/rest/rest-client.ts:128-153`——`setTimeout(() => controller.abort())` 在 `fetch()` 返回（响应头到达）后即被 `finally { clearTimeout(timer) }` 清掉；`:153` `await response.text()` 完全无超时。
- **触发条件**：任何 REST 调用（me / listSessions / getSession…）遇到「响应头已发、body 永久 stall 或持续 trickle」的服务端/代理。最严重的用户可见后果：REPL `/exit` → `runner.shutdown()`（`session-runner.ts:241-256`，`markRead` 在 `:249`）`await markRead(...)` 挂死，进程无法退出；`-p` 模式同样卡在收尾。
- **错误行为 vs 契约**：`args.ts:81` 把 `--timeout-ms` 描述为「单次 REST 请求超时，默认 30000」；`classifyNetworkError` 也承诺超时报错。同仓基线 `src/local/tools/mcp.ts:289-292` 对 HTTP MCP 修过一模一样的问题并写明契约：「服务端挂死或持续 trickle body 时 fetch 永不返回，整轮任务卡住；**signal 同时覆盖 body 读取**」——REST 客户端未同改。
- **验证**（`agent-cli/test/logic-bug-review-2026-11-19.spec.ts`，stub fetch 返回永不结束的 ReadableStream body，timeoutMs=300，1s 探针）：
  ```
  AssertionError: expected 'still-pending' to match /请求超时/
  ```
- **为什么既有测试没抓住**：`rest-client.spec.ts` 的超时用例走「fetch 直接 reject」路径，body 停滞形态无覆盖。
- **修复建议**：把 `timer` 的生命周期延到 `response.text()` 结束（abort 同时覆盖 body），或对 text() 同样 race 一个 deadline；错误经 `classifyNetworkError` 归一为「请求超时」。

## BUG-4（中低）401 非 JSON 响应体跳过整个刷新/重登链

- **位置**：`agent-cli/src/rest/rest-client.ts:153-174`——JSON 解析（155-164）先于 401 分支（168）执行；401 且 body 非 JSON 命中 `:159-160` `throw new CliError('HTTP 401: …')`。
- **触发条件**：站点挂在反代/网关后，代理层返回自己的 401 HTML 页（nginx basic auth、WAF 拦截页）或任何非 JSON 401。
- **错误行为 vs 契约**：同函数对空 body 401（text 为空跳过解析）与 JSON 401 都会走 `onUnauthorized`（刷新 → 交互重登，2026-11-18 刚加的 relogin 流程，`main.ts:132-133` 注释「access / refresh 都失效时直接问用户名密码」）；非 JSON body 是漏网分支——交互终端本应弹「重新登录」，实际输出 `HTTP 401: <html>…` 后退出。
- **验证**（同 spec，`onUnauthorized` spy + HTML 401 响应）：
  ```
  AssertionError: promise rejected "CliError: HTTP 401: <html>401 Forbidden</… { …(2) }" instead of resolving
  ```
- **修复建议**：401 分支提到 body 解析之前（或解析失败时仍保留 status 判定路径），保证三种 body 形态行为一致。

## BUG-5（高）审批投票回声等待无超时且断线不清理

- **位置**：`agent-cli/src/local/executor.ts:467-470`（`raceVoteAndEcho` 全体 `:447-473`；echo Promise 无超时上限）；`:158-164`（`failRemoteWaits` 只清 `remoteWaiters`，不清 `approvalEchoWaiters`）；配套 `:551-570`（重发仅 `APPROVAL_ECHO_MAX_RETRIES=2` 次，常量在 `:33`，用尽后无人收尾）。
- **触发条件**：`--on-approval=ask` 且 `approvalRelaySupported=true`：本地按键投票上行成功后，回声丢失（服务端重启丢 pending / 连接断开 / 重发 2 次均失败）。`chat` 模式下 `setOnDisconnect` 甚至未接线（仅 daemon 模式 `commands/local.ts:129` 接了；chat 的 LocalExecutor 在 `chat.ts:153` 构建，未接线），`onWsClosed` 不会被调。
- **错误行为 vs 契约**：两条声明契约都未兑现——(a) `onWsClosed` 注释（`:140-144`）「**等待远端审批的请求立刻失败**，不等满超时」：实现只覆盖 await-remote 路径，投票回声路径的等待者在断线后依旧悬挂；(b) 回声永久丢失时该 Promise 永不 settle，`onToolExecute` 卡在 `await finalizeApproval(...)`，工具既不执行也不报错，直到服务端 900s 工具超时判负整轮。桌面端同场景有明确收尾（`useStreamWS.releaseApprovalsOnTerminal` / 断线 drain），CLI 侧缺同款兜底。
- **验证**（同 spec：askApproval 触发真实投票上行 → `onWsClosed()` → 500ms 探针）：
  ```
  AssertionError: expected 'still-pending' not to be 'still-pending'
  ```
- **为什么既有测试没抓住**：`local-remote-approval.spec.ts` 覆盖 await-remote 路径的超时与回声；「投票上行后等回声 + 断线」组合无用例。
- **修复建议**：`failRemoteWaits` 同时以拒绝/本地选择收尾 `approvalEchoWaiters`（对齐注释契约）；并给 echo 等待加总时长上限（重发用尽 + 宽限期后按本地选择收尾，与 Ink 模态 30s 兜底语义衔接——当前 Ink 兜底只是关模态，executor 会重新进入无上限等待）。

## BUG-6（中）`mao-agent update` 在 Windows 上必然失败，且失败前已把源码切到远端

- **位置**：`agent-cli/src/commands/update.ts:28-41`（`run` 用裸 `spawnSync`，无 `shell`）；`:120-122`（`run('npm', ['ci'|'install'])` / `['run','build']` / `['install','-g']`）。
- **触发条件**：Windows 上执行不带 `--check` 的 `mao-agent update`（本机 Node v24 / win32 实测 `spawnSync('npm',['--version'])` → `ENOENT`）。
- **错误行为 vs 契约**：Windows 上 `npm` 是 `npm.cmd`，`spawnSync` 走 CreateProcess 不做 PATHEXT 解析 → `执行 npm 失败: spawnSync npm ENOENT`。三个 `run('npm')` 全部失败；且失败点在 `git fetch + checkout --force FETCH_HEAD`（`:101-102`）**之后**——源码目录已被强制切到远端、依赖未装、全局包未重装，留下半更新状态。契约：`args.ts:519` 帮助文本「拉取最新源码并重装」；`paths.ts:41-42` `findBash` 明确按 win32 适配（`update --check` 用 git.exe 正常），说明 Windows 是受支持平台。
- **验证**（同 spec，win32 真实环境实证、非 mock；非 Windows CI 自动跳过）：
  ```
  ✓ 裸 spawnSync('npm') error.code === 'ENOENT'，shell:true 对照 status === 0
  ```
- **为什么既有测试没抓住**：`test/update.spec.ts` stub 了 `run`，平台差异被 mock 掉。
- **修复建议**：`run` 对 win32 + 非 .exe 命令改用 `shell: true`（或显式解析 `npm.cmd`）；npm 步骤放到源码切换之前预检（有 npm 才动源码树），避免半更新状态。

## BUG-7（中低）saveAuth 非原子写；auth.json 损坏时复活陈旧 legacy 凭据

- **位置**：`agent-cli/src/auth/auth-store.ts:71`（`fs.writeFileSync` 直写）；`:45-58`（loadAuth 的 legacy 回退与迁移——迁移从不删除 legacy 文件）。
- **触发条件**：写 `~/.mao/auth.json` 中途崩溃 / 磁盘满 / 多进程并发写（CLI + desktop + mao-cli 共用同一文件，auth-store.ts:6 注释）留下截断 JSON；下一次任意命令触发 loadAuth。
- **错误行为 vs 契约**：截断 JSON 被 `readJsonFile` 吞成 null 后落入 legacy 回退：把 `~/.mao-cli/auth.json` 等旧文件里**可能是数月前过期、甚至属于他人会话**的旧 token 迁移回 `~/.mao/auth.json` 并返回——登录态被静默替换成陈旧凭据（后续全部 401）。契约：同仓三处基线对同一失败模式都做了 tmp+rename 原子写并写明理由——`config-store.ts:73-75`「直接就地写会在中途崩溃时留下截断的 JSON（下次 readJson 静默回落成 {}）」、`device-identity.ts:40-43` 同款；auth-store 是唯一漏改的凭据写入点。
- **验证**（同 spec：vi.mock node:os 隔离临时家目录 + 隔离前置断言；损坏 auth.json + legacy 文件）：
  ```
  AssertionError: expected { accessToken: 'legacy-stale', …(4) } to be null
  （对照：auth.json 正常时返回 current-token ✓）
  ```
- **修复建议**：saveAuth 改 tmp+rename（对齐 config-store）；loadAuth 的 legacy 回退仅在「auth.json 不存在」时生效（区分「不存在」与「存在但损坏」，损坏时告警并返回 null）。

## BUG-8（中）任务通知偏好读路径在密文解密失败时整体不可用

- **位置**：`backend-ts/src/notification/task/preference.service.ts:47`（get() 内 `this.cipher.decrypt(row.webhookCiphertext!)` 无容错）。
- **触发条件**：`APP_NOTIFICATION_WEBHOOK_SECRET` 轮换 / 未配置后，任何已有 webhook/email 通知偏好的用户打开偏好面板（GET `/v1/user-preferences/task-notification`）、保存偏好（save() 最后一行 `return this.get(userId)`，`:108`）、sendTest 的 resolveEmailTarget（`:192-195`）。
- **错误行为 vs 契约**：解密抛 `BusinessException(INTERNAL_ERROR,'Webhook 解密失败')`（`webhook-secret-cipher.ts:17`）直接向上传播。关闭路径按 `:70` 注释「关闭（enabled=false 且非切渠道）时**保留旧密文直接落库**」——密文未清，save() 写库成功后 `get()` 仍解密失败：**用户连「关闭通知」都做不到**。投递侧 `findEnabled()`（`:164-167`）只判密文非空，投递行照建、deliver() 解密失败标不可重试 FAILED——收不到通知也修不了设置。契约：同仓全部 secret 消费方对「解密失败」统一降级不阻断读路径——`settings.service.ts:699-709` decryptSecret（catch 后按未设置处理，注释 "treat as unset (SETTINGS_SECRET changed?)"）、`ecp-session.repository.ts:61-63` decryptToken（失败返回 null 调用方跳过）、`system-git-credential.service.ts:84-94`（逐行 try/catch skip+warn）。
- **验证**（backend spec，throwing cipher + stub store）：
  ```
  AssertionError: promise rejected "BusinessException: Webhook 解密失败 { code: 5001 }" instead of resolving（get 与 save-disable 两例）
  ```
- **为什么既有测试没抓住**：`preference.service.spec.ts` / `preference-email-disable.bugcheck.spec.ts` 的 cipher stub 都以成功解密为前提，「密钥轮换」场景无覆盖。
- **修复建议**：get() 对 decrypt try/catch，失败时 `maskedWebhook: null`（保留 enabled/channel/webhookConfigured）+ warn 日志；顺带评估 findEnabled 对解密失败行跳过投递（避免每次都建 FAILED 投递行）。

## BUG-9（低）inbox clip 系按 UTF-16 码元截断，边界切断代理对

- **位置**：`backend-ts/src/inbox/inbox.service.ts:557-562`（`clip`：`trimmed.slice(0, maxLength)`；TITLE_MAX=200 `:65`、CONTENT_MAX=500 `:66`）。同型位点：`notification/task/delivery.service.ts:233-240`（truncate）、`delivery.scheduler.ts:322-325`（truncate）、`notification/task/feishu-notification-card.ts:178-180`（truncate）、`src/feishu-cards.ts:30`、`src/feishu-media.ts:47-49`（truncateQuoted）。
- **触发条件**：任务标题 / 失败原因 / 摘要含 emoji（LLM 生成的会话标题常见）且恰好停在截断边界——单条概率低，随量必然出现。
- **错误行为 vs 契约**：第 200/500 个码元落在代理对中间时产出孤立高代理，`Buffer.from(...,'utf8')` 落库变 U+FFFD 乱码，收件箱标题/正文、飞书卡片尾部出现乱码字符。契约：本仓已把同一缺陷类定性为 bug 并修复——`logic-bug-review-2026-11-13.spec.ts` BUG-2「splitTextForWeixin 不切断代理对（回归）」，通知链路截断应使用同一「回退到完整码点边界」口径。
- **验证**（backend spec，`writeDigestEntry` 真实链路：`'a'.repeat(199) + '😀后续内容'`，stub repo 捕获落库行）：
  ```
  AssertionError: expected true to be false（落库标题以孤立高代理结尾）
  ```
- **为什么既有测试没抓住**：inbox/digest 既有用例的标题样本全是 BMP 内字符。
- **修复建议**：抽公共 `clipByCodePoints`（或检查末尾 0xD800-0xDBFF 回退 1 码元），6 处位点同改；修复后与 weixin 侧同款断言转正为回归。

---

## 候选未确认（代码层面成立，未达「测试实证」标准，留档待测）

1. **飞书/ECP OAuth state 的 SUCCESS 终态 CAS 用 `CURRENT_TIMESTAMP` 比较上海墙钟字符串**（`backend-ts/src/auth/feishu-oauth.repository.ts:45`、`ecp-oauth.repository.ts:69`）：`expires_at` 由 JS 侧 Asia/Shanghai 墙钟字符串写入，同文件 `claimPending`/`consumeSuccess` 均绑定 JS `formatNow()` 比较，唯独 SUCCESS 回执子句用 MySQL `CURRENT_TIMESTAMP`（会话 time_zone）。代码库未对 MySQL 会话 `SET time_zone`：`db/db.ts:111` 的 mysql2 `timezone: '+08:00'` 只是客户端 JS Date 解释选项（且 `dateStrings: true` 下读取即原样字符串），connection 钩子只 `SET SESSION innodb_ft_user_stopword_table`，会话时区跟随 MySQL 服务端全局值；连接串 `serverTimezone` 是 Java 驱动遗留参数（`app-config.ts:189`）。MySQL 会话时区 ≠ +08:00 时：UTC 部署下该防线对最后 8 小时失效（fail-open）；+08 以东则 5 分钟窗口内全部成功回执被误拒（fail-closed，「二维码已使用或已过期」）。**未实证原因**：需要真实 MySQL 且能 `SET time_zone` 的集成环境；验证路径已给出（仿 `company-sso.mysql.integration.spec.ts`：会话时区 UTC + 上海钟过期样本 → `updateByState(...,SUCCESS)` 断言 affectedRows=0）。
2. **admin 信号哨兵「属主 ID」筛选非数字静默失效**（`admin/src/views/signal/SignalWatcherListView.vue:477-486`）：`userId: userId === '' ? undefined : Number(userId)`，输入 `abc` → `Number('abc')=NaN` → axios 序列化 `userId=NaN` → 后端 `queryOptInt`（`common/request.ts:25-32`）对非有限值刻意返回 undefined → 列表返回**全部用户**的哨兵，输入框仍显示 `abc`。同仓基线：`views/llm-call/LlmCallView.vue:366` 对 ID 输入有 `rejectInvalidFilters` 校验提示。**未实证原因**：buildParams 是 `<script setup>` 内部函数，admin 无 @vue/test-utils，需 Playwright（拦截 `userId=NaN` 请求 + 断言跨用户数据返回）或先抽纯函数。
3. **android reload 自愈后 FORCE_TOP_NAV_JS 注入与页面加载竞态**（`android/.../MainActivity.java:199-214`）：三次固定墙钟时刻（post / 300ms / 1000ms）注入，无加载完成钩子；远程页 reload 超过 1s 时三次注入全部落在旧文档，新文档拿不到 topnav-fix 样式——reload 自愈恰是「弱网下 TopNav 不显示」的场景。**未实证原因**：时序类缺陷需限速代理 + 真机/模拟器目测，无法固化为自动化断言（修复成本低：对齐初始加载的 2500ms 注入铺点或 progress 钩子）。
4. **agent-cli 并发 `mcp_sync_required` 产生孤儿 stdio 子进程**（`session-runner.ts:454-461` fire-and-forget + `local/tools/mcp.ts:248-251` close/set 竞态）：同会话两条 sync 重叠时（服务端重连补发即可造成），sync B 的 `close` 先于 sync A 的 `sessions.set` 执行 → A 建立的连接脱离注册表，`closeAll` 不可达 → stdio 子进程孤儿化；两帧 `mcp_tools_report` 竞速还可能回错报告。**未实证原因**：需要耗时受控的假 stdio server + 并发时序构造（`test/local-mcp.spec.ts` 有可参考的基建），本轮时间预算内未完成。

## 已核查并排除（否决候选）

1. **desktop `parseDateTime`/`new Date('yyyy-MM-dd HH:mm:ss')` 按浏览器本地时区解析后端上海墙钟串**（含 `OpenApiView.vue:450` isExpired）——全仓统一口径（后端序列化即上海墙钟、前端按本地解析），目标是 UTC+8 用户群；按「测试证实真实存在」标准属既有设计取舍，非孤例缺陷。留档：若产品面向其他时区，需整链路改造而非单点修。
2. **`resolveContainedWorkspacePath` / `isWorkspaceWithin` 对 `..foo` 这类以 `..` 开头的合法文件名误判越界**——`rel.startsWith('..')` 的经典误报；真实工作区几乎不会出现该命名，修复反而要动三端 containment 口径，价值不足。
3. **本地文件读取 lstat→readFile TOCTOU（符号链接竞态）**——三端同口径的通用文件系统竞态，读路径已先过 realpath containment，非本层逻辑缺陷。
4. 各分区代理的否决清单（约 30 条）详见代理审计底稿：notification/inbox/settings/auth 域的 EcpRenewScheduler fail-safe、TASK_FAILED 门控复用、delivery 外层 catch 语义、http-tool 掩码头拒存、approval-rule 引号权衡、permission 软删计数、flyway 注释切割、InboundMergeWindow/withLock 并发原语、飞书绑定语义等——均与注释契约一致或属声明取舍。

## 后续

- **修复记录（2026-11-19 同日）**：9 条确认项已全部修复——BUG-1/8/9（backend-ts）、BUG-3~7（agent-cli）、BUG-2（android AppUpdatePlugin），两个 spec 的 `it.fails` 用例已转正为普通 `it` 回归（backend 6 例 / agent-cli 7 例，含 BUG-4 新增「刷新后仍 401」对照例），BUG-2 的 Java harness 转正为「期望 reject」回归（修复后实测输出见 repro README）。全量回归：backend-ts 除 Windows 环境预存差异（Unix socket EACCES / chmod 000 / POSIX 路径期望 / 进程组 EPERM 等 6 文件 10 例，与本轮改动文件零依赖）外全过；agent-cli 70 文件 786 例全过。用户可见改动已记 `changelog/unreleased/2026-11-19-logic-bug-fixes-01.md`。
- 修复前的原记录（2026-11-19 审查轮）：9 条确认项未在本轮修复（遵循「审查不改产品代码」惯例）：`it.fails` 用例修复后转正为普通 `it` 回归（`bugIt` 常量已在两个 spec 文件头部注明转正方式）；BUG-2 的 Java harness 修复后同样以「期望 reject」断言转正。
- 候选未确认 1（OAuth 时钟）建议优先安排 MySQL 集成验证——一旦部署环境会话时区为 UTC（容器默认），该缺陷是**静默防御失效**而非显式报错。
- 全量回归（2026-11-19 实测，含本轮新增 spec，`it.fails` 形态）：
  - `backend-ts npm test`：485 passed / **5 files failed（9 tests，全部为本机 Windows 环境预存差异，与本轮无关且在干净树上同样失败）**：`runtime-channel-server.spec.ts` ×2（Unix domain socket 在 Windows EACCES）、`workspace-write.service.spec.ts`（symlink 删除竞态语义）、`host-status.service.spec.ts`（磁盘枚举顺序）、`logic-bug-review-2026-11-13.spec.ts`（chmod 000 对 Windows 管理员不生效——该例在本轮任何文件创建之前的冒烟运行中已失败）；
  - `agent-cli npm test`：69 passed / **1 file failed（`local-delivery-fetch.spec.ts`：用例把 `C:\...` 反斜杠绝对路径喂给按设计拒绝反斜杠的校验器，Windows 预存环境差异）**；
  - 本轮新增的两个 spec（backend 6 例 / agent-cli 6 例）在各自套件中全部通过（expected-failure 5+4 例、真实通过对照 1+2 例）。

