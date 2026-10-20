# 自定义 HTTP 工具（懒加载集成）代码审查报告 · Round 01

- 日期：2026-10-20
- 范围：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/custom-http-tools`（分支 custom-http-tools）未提交改动，对照设计文档 `docs/plan/2026-10-19-custom-http-tools-technical-design.md`。
- 审查方式：通读全部相关源码 + 既有 spec；对每个疑似 bug 编写独立临时测试（`/tmp/code-review-verify/`，未改动仓库文件）验证真实存在。
- 结论：发现 **5 个 bug**（中 2 / 低 3），均附可复现验证。懒加载宪法、属主隔离、SSRF 基础面、mysql2 写语句口径、管理统计口径等核心机制未发现问题（见文末「已覆盖未发现」清单）。

---

## Bug 1【中】SSRF 放行判定「任一 IP 命中即整体放行」，未放行私网 IP 可被连接

- **文件:行号**：
  - `backend-ts/src/harness/tool/impl/http-api-executor.ts:161-169`（`guardUrl` 放行分支）
  - `backend-ts/src/common/ssrf.ts:142-150`（`isIpInCidrAllowlist`，任一命中即 true）
- **问题描述**：`guardUrl` 对解析出的 IP 列表做判定时，`isIpInCidrAllowlist(ips, cidrs)` 只要**任意一个** IP 命中管理员放行名单就整体放行；其余不在名单内的私网 IP 没有任何拦截，而 fetch 实际连接哪个解析结果由运行时决定（undici 多地址择优），因此请求可能落到未放行的私网地址。
- **为什么是 bug（触发场景）**：设计 §5.5 明确「其余私网 / 链路本地 / 保留段：命中放行名单才放行」。攻击/误用场景：管理员按需只放了 `10.0.0.0/8`；用户配置的 URL 主机名 DNS 可控（自建域名或 rebinding 服务），同时返回 `10.1.2.3`（命中名单）与 `192.168.1.5`（不在名单）。当前实现直接放行，fetch 可能连到 `192.168.1.5`——即连接到了管理员从未批准的内网段。方案二撤销审批门后，SSRF 判定是这条服务端代发路径上仅剩的强制闸口（设计 §8 风险 2），该口径削弱了闸口的完整性。
- **验证测试**（`/tmp/code-review-verify/ssrf-allowlist.spec.ts`，命令见下）：注入 `resolveIps → ['10.1.2.3','192.168.1.5']`、`allowlist: ['10.0.0.0/8']`，执行 `http://mixed.example.com/api`。
  - 期望（逐 IP 判定）：`192.168.1.5` 不在名单 → 拒绝；
  - 实际：`execute` 返回成功（`'error' in result === false`），`fetchImpl` 被调用 1 次。
  - 反向对照（解析结果全不在名单时）确实拒绝，排除"整体失效"类误报。
- **严重程度**：中（有前置条件：管理员已配 allowlist 且主机名 DNS 可控；但直接违背设计判定口径）。

```bash
cd /Users/yangjiayi/AiProjects/mao/.worktrees/custom-http-tools/backend-ts && \
npx vitest run --config /tmp/code-review-verify/vitest.verify.config.ts
# ✓ ssrf-allowlist.spec.ts (3 tests) ｜ Test Files 4 passed (4) ｜ Tests 10 passed (10)
```

---

## Bug 2【中】编辑工具（PUT）不传 `enabled` 会把停用的工具静默重新启用；上限已满时直接无法编辑

- **文件:行号**：
  - `backend-ts/src/user-tool/user-tool.service.ts:309`（`validateDraft`：`const enabled = draft.enabled === false ? 0 : 1;`）
  - `backend-ts/src/user-tool/user-tool.routes.ts:155`（`toDraft`：缺省映射为 `undefined`，落入上一行默认 1）
- **问题描述**：`validateDraft` 对缺省 `enabled` 一律取 1（启用）。PUT 是全量替换语义，于是任何省略 `enabled` 字段的编辑都会把用户主动停用的工具重新启用；若该用户启用数已达上限，同一次编辑会先撞上 `assertEnabledBelowLimit` 直接报 `USER_TOOL_ENABLED_LIMIT_EXCEEDED`，导致"只想改个 URL"都做不到。
- **为什么是 bug（触发场景）**：设计 §8 风险 6 建议「危险工具默认建为停用、试运行验证后再启用」——停用是用户的安全姿态，编辑动作不应悄悄改写它。受影响调用方：
  - 任意省略 `enabled` 的 REST 客户端；
  - 一方 CLI `mao user-tool me-update`（`skills/mao-cli/lib/commands/user-tool.js:78-80`，`readBody(flags)` 原样透传，JSON 里不带 `enabled` 即触发重新启用）。
  - 桌面 UI 不受影响（`UserToolsView.vue` 的 `toPayload` 始终显式携带 `enabled`）。
- **验证测试**（`/tmp/code-review-verify/user-tool-service.spec.ts`）：
  1. 仓库中 `enabled=0` 的工具，`update(9, 2, draftWithoutEnabled)` → 返回 VO `enabled: true`，落库行 `enabled` 由 0 变 1（静默启用得证）；
  2. `maxEnabled=1` 且已有 1 个启用工具时，编辑那个停用工具（不传 `enabled`）→ 抛 `USER_TOOL_ENABLED_LIMIT_EXCEEDED`（编辑被阻断得证）；
  3. 显式传 `enabled:false` 时保持停用（对照组，说明前端路径无碍）。
- **严重程度**：中（桌面 UI 主链路不受影响，但 API/CLI 客户端存在静默状态变更与编辑受阻）。

---

## Bug 3【低】超出启用上限被目录隐藏的工具，仍可经 `http_call` 执行

- **文件:行号**：
  - `backend-ts/src/harness/core/harness-service.ts:422-436`（装配：`buildCustomHttpToolCatalog(userTools, maxEnabled)` 只截断目录并记 `hiddenCount`）
  - `backend-ts/src/user-tool/user-tool.service.ts:163-179`（`resolveForExecution` 只校验「属主 + enabled」，不校验前 N 名截断）
- **问题描述**：设计 §5.4 要求超上限时「目录与**可调用集合**取前 N（name ASC）」。实现只截断了提示词目录，执行解析层未同步截断：被 `hiddenCount` 隐藏的工具依然能被 `http_call` 按名调用。
- **为什么是 bug（触发场景）**：管理员把 `tools.http.maxEnabledPerUser` 从 20 调小到 1（或历史上启用数超过新上限），用户会话目录只展示第 1 个工具并提示「另有 N 个未加载」，但模型仍可调用其余工具——上限对"可调用集合"实际不生效，管理员的治理动作被部分架空。
- **验证测试**（`/tmp/code-review-verify/user-tool-service.spec.ts`）：2 个启用工具 + `maxEnabled=1`，`resolveForExecution(9, 'orders')`（目录中被隐藏的那个）仍返回完整可执行定义（非 null）。
- **严重程度**：低（需管理员下调上限才会出现；上限本身定位是可用性配置而非安全门）。

---

## Bug 4【低】列表入口「测试调用」对含敏感请求头的工具必然失败

- **文件:行号**：
  - `desktop/src/views/settings/UserToolsView.vue:548-553`（`openTestDrawer` 用列表 VO 填充表单，敏感头值为掩码 `******`）
  - `desktop/src/views/settings/UserToolsView.vue:610-619`（`runTest` 把掩码值原样提交 `/v1/user-tools/test`）
  - `backend-ts/src/user-tool/user-tool.service.ts:190-211`（`resolveDraftForExecution` 明确拒绝掩码值）
- **问题描述**：列表 VO 的敏感请求头按设计只回显掩码（密钥不回显），而试运行内核又明确拒绝掩码值（防脏数据）。两条都是正确设计，但组合起来意味着：工具卡片上的「测试调用」按钮对**任何带敏感头的工具**（最常见的 Authorization 形态）永远不可能成功，只会拿到「请求头 X 不允许提交掩码值，请填写真实值或清空」的错误。
- **为什么是 bug（触发场景）**：用户在列表页对已保存的带 Token 工具点「测试调用」→ 抽屉里确实有 `hasMaskedHeader` 警告并引导「回编辑器填写后再测试」，但按钮本身未禁用、且从编辑器入口填写真实值后能从对话框Footer试跑——即该入口是个注定失败的 affordance，只能靠用户自行绕道。功能可用性受损（非数据损坏）。
- **验证测试**（`/tmp/code-review-verify/test-drawer-mask.spec.ts`）：复现前端链路——`listForUser` 返回 `{key:'Authorization', value:'******', sensitive:true}` → 按组件 `toPayload` 组表单 → `resolveDraftForExecution` 抛 `/掩码/` 错误。
- **严重程度**：低（有警告与替代路径，不丢数据；但入口功能实际不可用）。

---

## Bug 5【低】放行清单校验文案声称「环回与云元数据永不允许放行」，校验并不拦截

- **文件:行号**：`backend-ts/src/settings/settings.service.ts:744-764`（`validateValue` 的 `HTTP_TOOL_PRIVATE_ALLOWLIST_KEY` 分支，仅校验 CIDR 格式，错误文案却包含「环回与云元数据端点永不允许放行」）；同类提示也在 `admin/src/views/settings/cidrAllowlist.ts:32`。
- **问题描述**：管理员保存 `["127.0.0.0/8"]` 或 `["169.254.169.254"]` 会被接受并落库，尽管文案宣称这两类永不放行。执行内核有硬拒绝兜底（`http-api-executor.ts:152-160` 先于放行判定），因此**无安全影响**，但管理员会得到"配了但静默无效"的项，没有任何反馈。
- **为什么是 bug（触发场景）**：管理员排查「为什么放了环回段还是不通」时，系统既不拒绝也不提示，错误文案与行为不一致，构成误导性 UX 与校验缺口。
- **验证测试**（`/tmp/code-review-verify/settings-allowlist.spec.ts`）：`update('tools.http.privateAllowlist', '["127.0.0.0/8"]')` 与 `'["169.254.169.254"]'` 均 resolve 且值原样落库。
- **严重程度**：低（无安全后果，属校验/文案不一致）。

---

## 已覆盖未发现问题的部分（防回归重点均验证通过）

1. **懒加载宪法**：自定义工具 schema 不进 LLM `tools` 数组——`tool-registry.spec.ts`（schema 断言）、`prompt-engine.spec.ts`（分节无 `properties`/`inputSchema`、空目录零输出、顺序稳定、manifest 计数）、`harness-service.spec.ts`（剔除+条件推入、未注入零差异）均通过；`/v1/tools` 仅暴露两外壳工具（设计 §9.5 允许）。
2. **越权**：用户侧全部方法属主校验（`findByIdAndUserId`/`findEnabledByUserIdAndName`），routes spec 覆盖跨用户 update/delete 返回 3051；`http_describe`/`http_call` 的 userId 只从 sessionId 解析，`listEnabled(null)` 零查库。
3. **SSRF 基础面**：环回/云元数据硬拒绝先于放行判定（含 allowlist 显式包含时）；重定向每跳重新判定、超 2 跳停止、303 降级 GET 丢 body；非 http/https 拒绝；IPv6 字面量拒绝。WHATWG URL 归一化形态（十进制 `2130706433`、简写 `127.1`、十六进制 `0x7f.0.0.1`、八进制 `0177.0.0.1`、`localhost`、`169.254.169.254`）均被拒绝（`/tmp/code-review-verify/ssrf-allowlist.spec.ts` 反向对照用例）。
4. **执行内核**：占位单遍替换不递归、未声明占位原样保留、URL 值 `encodeURIComponent`、GET 丢 body、用户头覆盖默认头、非 2xx 片段化错误、64KB 截断、二进制响应 notice、网络错误脱敏、arguments 64KB 上限与未定义参数拒绝。
5. **数据层**：写语句全部走 `db.execute`（`user-tool.repository.spec.ts` 锁死该约定）；建/改/删跨两表走事务；删除级联参数行；`uk_user_tool_name` 唯一 + 保留字（内置工具名 / `mcp__` / 两入口自身）校验。
6. **加解密**：敏感头逐值 `enc:` AES-GCM、掩码回显、掩码=不修改/空=删除/新值=覆盖三态、解密失败失败闭合（`http_call` 转可读错误）；`APP_USER_TOOL_SECRET` 已列入敏感环境变量。
7. **管理统计口径**：`type='TOOL' AND target IS NOT NULL` 恰好只圈住 `http_call` 行——read_file/write_file/edit_file 映射为 READ/EDIT、shell 映射为 RUN（`activity-type-mapper.ts`），且无工具名为 `glob`/`list`（`extractActivityTarget` 中这两个 case 是死分支），设计 §9.4 的前提成立。
8. **迁移 V161**：两表 + 设置 seed + 权限 seed/授权，对齐 V151/V160 既有范式。

## 测试与构建基线

- `backend-ts && npm test`：`Test Files 1 failed | 369 passed`、`Tests 1 failed | 4419 passed`。唯一失败为 `harness/container/runtime-agent.spec.ts` 的 unix socket `EADDRINUSE`（环境抖动，与本功能无关）。
- `desktop && npm run build`：exit 0；`npm run test:unit`：vitest 74 文件 671 用例全过（node --test 部分 `electron/gitOperations.test.cjs`、`electron/localShell.test.cjs` 有 2 个失败，均为本分支未改动的 Electron 侧环境相关用例）。
- `admin && npm run build`：exit 0。
- 本报告全部验证测试位于 `/tmp/code-review-verify/`（`ssrf-allowlist.spec.ts`、`user-tool-service.spec.ts`、`settings-allowlist.spec.ts`、`test-drawer-mask.spec.ts`，共 10 用例全过），未改动任何仓库文件。
