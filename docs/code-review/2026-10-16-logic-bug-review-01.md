# 代码审查：全仓逻辑 BUG 清查（5 个经测试验证的功能 BUG，另 2 项复核降级见 §6）

> **修复状态（2026-10-16，同日）**：本报告保留的 5 项缺陷（BUG-1/2/3/4/7）已由分支 `fix/logic-bugs-2026-10-16` 全部修复并合入 `main`，记录于 CHANGELOG `0.0.298`。§2/§3 中「当前结果：failed」等数字均为**修复前基线**；修复后 5 个 `*.bugcheck.spec.ts` 全部通过（转为回归测试），另新增 4 个 `*.reviewcheck.spec.ts` 扩大形态/向量回归。修复过程经两轮子代理代码审查：第 1 轮发现并修复 1 个修复引入的低危缺陷（R1-1，agent-cli output-format 纯空白值穿透 `resolveConfig`），第 2 轮复审未发现新 bug（报告：`docs/code-review/2026-10-16-logic-bugfix-review-round1.md`）。

- **日期**：2026-10-16（同日复核更新：原列 7 项，复核后保留 5 项、2 项降级移入 §6；编号沿用原编号以便追溯）
- **基线**：分支 `main` @ `fedab3dc`，工作区干净；本审查仅新增 5 个存在性证明测试文件（`*.bugcheck.spec.ts`），未改动任何产品代码（`git status` 只有 5 个未跟踪新文件）
- **范围**：全仓通读——`backend-ts/src/`（约 9.4 万行：harness 引擎、session、file、auth/user/permission、schedule、skill、feishu/dingtalk/weixin、openapi、usage/statistics、settings/notification/inbox/digest/signal/memory/feedback/budget 等 40 个域）、`desktop/src/`、`admin/src/`、`agent-cli/src/`+`test/`。审查方式：逐文件通读 + 同一概念跨文件语义比对（找不一致）+ 无 spec 覆盖分支重点排查
- **方法**：每个候选必须满足「输入合法即可触发、输出确定错误、有可运行测试证明」；无法构造确定性失败测试的候选一律不列为 bug（排除清单见 §5）。断言一律按「正确行为」书写，当前源码下 **failed** 即证明 bug 真实存在；每条 bug 均附对照组（证明失败不是测试写法问题）
- **测试证据**：
  - `cd backend-ts && npx vitest run <4 个 bugcheck spec>` → **5 failed | 4 passed**（失败全在预期断言上）
  - `cd backend-ts && npx vitest run`（全量）→ **Tests 5 failed | 4088 passed | 13 skipped (4106)**，唯一 5 个失败即本审查 bugcheck，存量用例无一回归
  - `cd agent-cli && npm test`（全量）→ **Tests 3 failed | 503 passed (506)**：2 个为本审查 bugcheck；另 1 个为存量环境相关失败（`repl-slash.spec.ts > /copy 无剪贴板命令时回落打印`，本机存在 `pbcopy` 使代码走剪贴板分支，单独运行该文件同样失败，与本次新增无关）
  - 类型检查：新增 5 个 spec 文件 0 类型错误（`backend-ts` `tsconfig.json` 存量 612 条 spec 类型松散错误与本次无关，`tsconfig.build.json` 本就排除 spec；`agent-cli` `tsconfig.test.json` 全量 0 错误）

---

## 1. 结论表

| 编号 | 严重度 | 位置 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 高 | `backend-ts/src/file/workspace-git.service.ts:388-393` | git numstat 对同目录（同前缀目录）改名输出花括号紧凑形态 `src/{a.txt => b.txt}`，代码切片后残留尾部 `}`，与 name-status 的键匹配不上，该文件增减行数被静默丢弃（恒显示 +0/-0） |
| BUG-2 | 高 | `backend-ts/src/auth/ecp-identity.repository.ts:71-73`、`company-sso-identity.repository.ts:67-69` | SSO / ECP 登录用 `status !== 1` 判定账号状态，把文档化为第三态「未设置」的 `status = NULL` 账号判为已禁用拒绝登录，而同一账号本地密码登录成功——同一账号两种登录入口结论相反 |
| BUG-3 | 高 | `backend-ts/src/skill/skill-doc.service.ts:64-66` | 系统技能上传的落盘守卫只查 `includes('/.')`，`..` 段在路径最前时不被拦截，multipart 文件名 `myskill/../evil.txt` 可把文件写到技能目录之外（三个姊妹实现都按段拒绝，唯独此处遗漏） |
| BUG-4 | 低 | `backend-ts/src/session/session.service.ts:302-304` | 分组展开页 ORDER BY 的活跃相位只列 3 个、漏掉 `CANCELLING`，与侧边栏预览的 `isActivePhase`（注释明示「漏列会把取消中的会话当空闲排到后面」）和同文件 dashboard SQL（注释「含 CANCELLING」）口径矛盾，两视图排序互相打架（取消相位为秒级瞬态，影响窗口小，复核降为低） |
| BUG-7 | 中 | `agent-cli/src/args.ts:372-375` | `MAO_AGENT_OUTPUT_FORMAT` 置空串（Docker `ENV`、CI 继承空值都会造成）时 `'' != null` 成立，`parseEnum` 抛错，任何子命令都无法启动；而同仓 `config-store.ts` 的 `envBool` 与 `resolveConfig` 回落链都把空串当「未设置」 |

---

## 2. BUG 详述

### 2.1 BUG-1｜git numstat 同目录改名花括号形态丢行数（高）

**文件:行号**

- 主缺陷：`backend-ts/src/file/workspace-git.service.ts:388-393`——numstat 路径归一化只做 `path.slice(path.lastIndexOf(' => ') + 4)`，花括号紧凑形态残留尾部 `}`
- 键来源（正确）：同文件 `parseNameStatusLine` R 分支 `:470-475` 取 `parts[2]`，键为 `src/b.txt`（name-status 不做花括号压缩）
- 仓库级统计不受影响：`collectRepoLineStats` `:340-362` 按行累加、不按路径匹配，故 `status.insertions/deletions` 总数仍正确——缺陷精确定位在逐文件统计

**触发条件**（合法且常见的 git 操作）

仓库内把文件移到**同目录或同前缀目录**并修改内容：

```
git mv src/a.txt src/b.txt   # 同目录改名
# 修改 src/b.txt 后 git add -A
```

本机 git（实测）输出：

```
--- name-status ---            --- numstat ---
R066  src/a.txt  src/b.txt      2   1   src/{a.txt => b.txt}
```

`src/{a.txt => b.txt}` 经 `lastIndexOf(' => ') + 4` 切出 `src/b.txt}`（尾部多一个 `}`）→ `files.get('src/b.txt}')` 返回 `undefined` → `continue`，`file.insertions/deletions` 保持 0。跨目录改名（`old/a.txt → new/b.txt`，无共同目录前缀）git 输出简单形态，代码能正确处理——所以这是只在特定（且常见）改名形态下触发的分支漏洞。

**期望 vs 实际**

- 期望：改名文件显示 `RENAMED +2/-1`，与跨目录改名一致
- 实际：文件浏览器 / Git 面板显示 `+0/-0`，用户看不到该改动的真实规模

**复现测试**

- 文件：`backend-ts/src/file/workspace-git-rename-numstat.bugcheck.spec.ts`（真实 git 仓库夹具，复用 `workspace-git.service.spec.ts` 的 `setupRepo` 套路；含夹具自检 `expect(numstat).toContain('src/{a.txt => b.txt}')`，git 不输出花括号形态时用例自动失去前提而非假通过）
- 命令：`cd backend-ts && npx vitest run src/file/workspace-git-rename-numstat.bugcheck.spec.ts`
- 当前结果：`1 failed`，失败在 `expect(renamed!.insertions).toBe(2)`：

```
AssertionError: expected +0 to be 2 // Object.is equality)
```

- 对照组（同文件）：跨目录改名 `old/a.txt → new/b.txt` 的 insertions/deletions 断言 **passed**——证明失败不是夹具或 git 环境问题

**误报排除**：已用真实 git 实测两种形态输出（非推测）；`numstat.trim()` 不会吃掉 `}`；二进制行（`-\t-`）与未跟踪路径不受影响；`git log` 显示该分支自导入起未动过，非有意保守预算（无任何注释说明该差异）。

---

### 2.2 BUG-2｜SSO / ECP 登录把 `status = NULL` 账号判为已禁用（高）

**文件:行号**

- `backend-ts/src/auth/ecp-identity.repository.ts:71-73`——`if (!user || user.deleted !== 0 || user.status !== 1) throw new EcpError('账号已禁用或不存在')`
- `backend-ts/src/auth/company-sso-identity.repository.ts:67-69`——同款 `assertActive`，抛 `account_forbidden`（403）

**权威口径（全仓一致的「停用」语义）**

- `backend-ts/src/user/user.service.ts:15-20`——`validateUserStatus` 注释：「0=禁用 1=启用 **null=未设置**」，且显式放行 null
- `backend-ts/src/permission/permission.service.ts:15-17`——`isActiveAccount(status) { return status !== 0 }`，注释「与登录一致：仅 status===0 停用」
- `backend-ts/src/auth/auth.service.ts:34,50`——本地密码登录 / 刷新 token 只拒 `status != null && status === 0`
- `backend-ts/src/auth/ecp-auth.service.ts:170-173`——`ensureUserEnabled` 同样只拒 0；且 `:89-90` 是先 `identities.resolve()`（严校验）后 `ensureUserEnabled()`（松校验），松校验对 null 情形是死代码——反证本意就是松校验

**触发条件**

1. `PUT /v1/users/:id/status`（`user.routes.ts:108-113`）body 为 `{}` 或 `{"status": null}`：`bodyOf<{status?: number}>` 缺字段即 `undefined`，`validateUserStatus(undefined)` 按设计放行，`updateUserStatus`（`user.service.ts:126-131`）走 `status ?? null` → `updateUserStatusWithAdminGuard(id, uid, null)`；`toSnakeRow`（`common/case.ts:24-32`）只跳过 `undefined` 不跳过 `null`，`user.status` 列可空（`V001__init_schema.sql:13`），落库 `status = NULL`。
2. 该用户走公司 SSO / ECP 飞书登录。

**期望 vs 实际**

- 期望：登录成功（null=未设置，按 `isActiveAccount` 语义是活跃账号）
- 实际：SSO 403 `account_forbidden` / ECP 5002「账号已禁用或不存在」；**同一账号本地密码登录仍然成功**——两种入口结论相反
- 连带（同一根因的三态处理缺失）：管理后台 `user.repository.ts:134-137` 的 `status = ?` 筛选对 NULL 两边都查不到；`admin/src/views/user/UserListView.vue:123-124` 把 NULL 显示为「禁用」；`UserFormDialog.vue` 保存时按显示态写 `status = 0`——一个未设置账号在后台逛一圈会被静默真禁用

**复现测试**

- 文件：`backend-ts/src/auth/identity-status-null.bugcheck.spec.ts`（仿 `company-sso-identity.repository.spec.ts` 的假 Db 事务套路，两个 repository 各一条）
- 命令：`cd backend-ts && npx vitest run src/auth/identity-status-null.bugcheck.spec.ts`
- 当前结果：`2 failed`：

```
AssertionError: promise rejected "Error: SSO access is forbidden { … status: 403, code: 1403 }" instead of resolving
AssertionError: promise rejected "BusinessException: 账号已禁用或不存在 { code: 5002 }" instead of resolving
```

- 对照组：`isActiveAccount(null/undefined/1/0)` 四态断言 **passed**（钉住权威语义）；`status: 0` 与 `deleted: 1` 仍被拒 **passed**（证明失败不是把禁用账号放行了）

**误报排除**：null 不可达已被排除——`validateUserStatus` 文档化三态且 status 路由可写 null；ECP 的松/严校验顺序是内证；本地登录与 SSO 结论相反是确定性的行为分裂。

---

### 2.3 BUG-3｜系统技能上传路径穿越（高）

**文件:行号**

- 主缺陷：`backend-ts/src/skill/skill-doc.service.ts:64-66`——守卫 `if (relativePath.length === 0 || relativePath.includes('/.')) continue;`
- `relativeAfterSkill`（`:103-108`）对 `myskill/../evil.txt` 返回 `../evil.txt`；`'../evil.txt'.includes('/.')` 为 **false**（`..` 在最前、前面没有 `/`）→ 守卫不触发 → `join(skillsDir, 'myskill', '../evil.txt')` 归一化为 `<skillsDir>/evil.txt`，越出技能子目录落盘
- 入口：`skill.routes.ts:181-188`（`POST /v1/skill-docs/upload`，需 `skill:write`）→ `collectAdminSkillUpload` `:314-320` 用 `preservePath: true`，`part.filename` 完全由客户端控制

**期望 vs 实际**

- 期望：拒绝 `..` 段（或至少收敛进技能子目录）。三个姊妹实现都按段拒绝：`user-skill.service.ts:345`（`writeSkillGroup`，段校验 + 解析后路径收口双保险）、`skill/staged-skill-writer.ts:52`、`skill/read-skill-files.ts:66`
- 实际：文件写到 `<skillsDir>/evil.txt`——可覆盖 / 注入到其它技能目录或 skills 根（如用一个同名 `SKILL.md` 污染其它技能的加载）

**复现测试**

- 文件：`backend-ts/src/skill/skill-doc-upload-traversal.bugcheck.spec.ts`（真实 `SkillLoader` + 临时 skillsDir，无 mock 落盘）
- 命令：`cd backend-ts && npx vitest run src/skill/skill-doc-upload-traversal.bugcheck.spec.ts`
- 当前结果：`1 failed`，失败在 `expect(existsSync(join(skillsDir, 'evil.txt'))).toBe(false)`：

```
AssertionError: expected true to be false // Object.is equality
```

- 对照组（同文件）：合法文件 `myskill/SKILL.md` 正常落盘 **passed**——证明失败不是上传机制本身不工作

**误报排除**：已核对全部同族实现，唯独 `uploadSkill` 用弱的 `includes('/.')`；`staged-skill-writer.ts:9-10` 注释明确「SkillDocService.uploadSkill 是直接写入…不可照抄」，说明作者知晓差异。端点需管理员权限，故严重度按「确定性写入越界」计，未按未授权漏洞夸大。

---

### 2.4 BUG-4｜分组展开页 ORDER BY 漏 `CANCELLING`（低，原「中」复核降级）

> **复核结论（2026-10-16）**：缺陷存在性无疑（三处口径注释 + 测试复现），但 `CANCELLING` 是取消流程进行中的秒级瞬态相位，两视图排序差异只在「组内存在取消中会话且用户正在查看该组」的窄窗口内可见，无数据错误、无功能阻断。修复是一行改动，值得顺手修，但不值得按「中」排期——严重度降为低，编号保留以便追溯。

**文件:行号**

- 主缺陷：`backend-ts/src/session/session.service.ts:302-304`——`CASE WHEN phase IN ('RUNNING','RESUMING','WAITING_APPROVAL') THEN 0 ELSE 1 END`

**仓内三处 4 相位口径 vs 此处的 3 相位**

- `session/util/session-group-key.ts:233-236`——`isActivePhase` 含 `CANCELLING`，注释：「与 session-vo.ts 的 isActivePhase 同口径：CANCELLING 是取消流程进行中的活跃相位，**组预览排序漏列会把取消中的会话当空闲排到后面**」
- `session/session-vo.ts:612-614`——VO 层 `isActivePhase` 同样 4 相位
- 同文件 `session.service.ts:1516-1524`——dashboard SQL 注释「运行中口径与 isActivePhase / 删除提升守卫一致，**含 CANCELLING**（取消流程进行中）」，`phase IN ('RUNNING','RESUMING','WAITING_APPROVAL','CANCELLING')`

**触发条件**

同一分组下同时存在：会话 A（`phase='RUNNING'`，`updated_at` 较早）、会话 B（`phase='CANCELLING'`，`updated_at` 较新）、会话 C（`IDLE`）。先看侧边栏分组预览（`listSessionGroups` → `compareSessions` → `isActivePhase`），再点开分组展开页（`listSessionsByGroup` → 本 SQL）。

**期望 vs 实际**

- 期望：两视图同口径——A、B 同属活跃档按 `updated_at DESC`，顺序 `[B, A, C]`
- 实际：SQL 把 `CANCELLING` 落入 `ELSE 1`（与 IDLE 同档），顺序 `[A, B, C]`——预览里排第一的取消中会话，展开后掉到第二位；翻页时第 1 页成员划分也与预览不一致（`total` 相同但排序不同）

**复现测试**

- 文件：`backend-ts/src/session/session-group-order.bugcheck.spec.ts`（复用 `session.service.spec.ts` 的 `makeService` mock 夹具，捕获 `sessionRepo.list` 第三参数 orderSql，用正则抽出 `CASE WHEN phase IN (...)` 相位清单与 `isActivePhase` 口径对集合）
- 命令：`cd backend-ts && npx vitest run src/session/session-group-order.bugcheck.spec.ts`
- 当前结果：`1 failed`：

```
AssertionError: expected [ 'RESUMING', 'RUNNING', 'WAITING_APPROVAL' ] to deeply equal [ 'CANCELLING', 'RESUMING', 'RUNNING', 'WAITING_APPROVAL' ]
```

- 对照组（同文件）：`compareSessions` 把较新的 CANCELLING 排到较旧 RUNNING 之前 **passed**（证明预览侧确实是 4 相位口径，两视图矛盾客观存在）

**误报排除**：`git log -L 302,305` 显示该行自首次导入起未修改，而 `CANCELLING` 是后续几轮复审补进各不变量的——属漏改遗留；同文件 dashboard SQL 的注释把「含 CANCELLING」写成既定口径，本处是有意遗漏的反证。

---

### 2.5 BUG-7｜agent-cli 空串环境变量 / flag 值导致启动即失败（中）

**文件:行号**

- 主缺陷：`agent-cli/src/args.ts:372-375`——`const outputFormatRaw = optionalString(flags, 'output-format') ?? process.env.MAO_AGENT_OUTPUT_FORMAT;` 之后仅判 `outputFormatRaw != null`

**触发条件**

- `MAO_AGENT_OUTPUT_FORMAT= mao-agent -p "hi"`（置空但没 unset：Docker `ENV MAO_AGENT_OUTPUT_FORMAT=`、CI 继承空值都会造成）
- 或 `mao-agent --output-format= -p hi` / `--output-format ""`

**期望 vs 实际**

- 期望：空串按「未显式下发」处理 → `undefined` → 交回 `resolveConfig` 的 `cli.outputFormat || envFormat || project.outputFormat || user.outputFormat || 'text'` 链（`config/config-store.ts:138`）——注意该链本身就把空串当 falsy 回落，与 `envBool`（`config-store.ts:41-47` 明确 `raw === ''` 返回 undefined）同口径
- 实际：`process.env.X` 置空返回 `''`，`'' != null` 成立 → `parseEnum` 抛 `CliError: --output-format 必须是 text|json|stream-json，收到: `——任何子命令都无法启动，且报错指向命令行选项，用户明明只设了环境变量

**复现测试**

- 文件：`agent-cli/test/args-env-empty.bugcheck.spec.ts`（环境变量在 `finally` 中复原，不污染其它用例）
- 命令：`cd agent-cli && npx vitest run test/args-env-empty.bugcheck.spec.ts`
- 当前结果：`2 failed`：

```
→ --output-format 必须是 text|json|stream-json，收到:
```

（空环境变量与 `--output-format=` 内联空值各一条）

- 对照组（同文件）：显式 `--output-format json` 与 `MAO_AGENT_OUTPUT_FORMAT=stream-json` 均正确解析 **passed**

**误报排除**：同仓 `envBool` 与 `resolveConfig` 回落链都把空串当未设置，只有这一条把空串当「已下发」；若团队认定「显式置空应报错」，报错信息不区分 flag/env 且与既有口径分叉，仍属缺陷。

---

## 3. 测试运行方式与结果汇总

```bash
# 本审查新增的存在性证明测试（当前源码下全部按预期失败）
cd backend-ts && npx vitest run \
  src/file/workspace-git-rename-numstat.bugcheck.spec.ts \
  src/auth/identity-status-null.bugcheck.spec.ts \
  src/skill/skill-doc-upload-traversal.bugcheck.spec.ts \
  src/session/session-group-order.bugcheck.spec.ts
# → Test Files 4 failed (4)；Tests 5 failed | 4 passed (9)

cd agent-cli && npx vitest run test/args-env-empty.bugcheck.spec.ts
# → Tests 2 failed | 1 passed (3)

# 回归基线（证明只有 bugcheck 失败、存量用例零回归）
cd backend-ts && npx vitest run          # Tests 5 failed | 4088 passed | 13 skipped (4106)
cd agent-cli && npm test                 # Tests 3 failed | 503 passed (506)
```

`agent-cli` 全量中除本审查 2 条外，另有 1 条存量失败 `repl-slash.spec.ts > handleSlash /copy > falls back to printing the reply when no clipboard command exists`：单独运行该文件同样失败（本机存在 `pbcopy`，代码走剪贴板分支而非打印回落），属环境相关存量问题，与本次新增无关，建议另行按 CI 环境（无剪贴板命令）修或用 stub 隔离。

| Bug | 测试文件 | 失败断言（当前输出） |
| --- | --- | --- |
| BUG-1 | `backend-ts/src/file/workspace-git-rename-numstat.bugcheck.spec.ts` | `expected +0 to be 2`（改名文件 insertions） |
| BUG-2 | `backend-ts/src/auth/identity-status-null.bugcheck.spec.ts` | `promise rejected "SSO access is forbidden {status:403}"` / `"账号已禁用或不存在 {code:5002}"` |
| BUG-3 | `backend-ts/src/skill/skill-doc-upload-traversal.bugcheck.spec.ts` | `expected true to be false`（skills 根出现 evil.txt） |
| BUG-4 | `backend-ts/src/session/session-group-order.bugcheck.spec.ts` | `expected ['RESUMING','RUNNING','WAITING_APPROVAL'] to deeply equal ['CANCELLING','RESUMING','RUNNING','WAITING_APPROVAL']` |
| BUG-7 | `agent-cli/test/args-env-empty.bugcheck.spec.ts` | `--output-format 必须是 text|json|stream-json，收到: `（空串） |

## 4. 修复建议（按优先级）

1. **BUG-2（auth 三态）**：把两处 `assertActive` 统一到 `isActiveAccount` 语义（`status !== 0` 且 `deleted === 0`），并让管理后台三态展示 / 筛选显式处理 null（`IS NULL` 分支），避免未设置账号被显示成禁用、保存时被写成 0。根因单一，建议一次收口。
2. **BUG-3（skill 上传穿越）**：`skill-doc.service.ts` 的落盘守卫补齐与 `writeSkillGroup` 相同的段校验（拒绝 `..` / 空段）+ 解析后路径收口（`resolvedTarget.startsWith(resolvedFolder + sep)`）。
3. **BUG-1（git numstat 花括号）**：numstat 路径归一化增加花括号形态处理——`{a => b}` 取 `}` 前最后一段，或直接用 `-M` 的 name-status 结果回填行数；最小修复是把残留的 `}` 一并剥掉。
4. **BUG-7（agent-cli 空串）**：`args.ts:372-375` 对 flag / 环境变量值统一做「空串视为未提供」归一（与 `envBool` 同口径），再进 `parseEnum`。
5. **BUG-4（分组 ORDER BY）**：`session.service.ts:304` 的 CASE 相位清单补 `CANCELLING`，与 `isActivePhase` / dashboard SQL 对齐（可直接复用同一常量清单防再次漂移）。一行改动，可随上述任一项顺带修。

## 5. 已排查并排除的疑似项（避免重复劳动）

以下候选均推到「构造确定性失败测试」一层后被证伪或降级，不列为 bug：

- `background-task-manager.ts:107` `awaitResult` 比 `consumeCompletedResults` 少判 `entry.sessionId == null`：逻辑确实不一致，但任务 id 不可猜测、无主任务被跨会话领走的实际危害不可构造确定测试，且 `entry.sessionId == null` 仅在 shell 工具无会话上下文 `exec(async:true)` 时产生——列为待观察，不单列为 bug。
- `message-history-normalizer.ts:11` `normalizeEntities` 的 `length < 2` 早退跳过孤儿 TOOL 归一化：需「历史恰好 1 条且为 TOOL」的极端残留状态，触发链依赖软删时序，无法稳定构造。
- `grep-search-tool.ts:128/152` rg 与 JS 路径输出预算口径不一致（约 3 倍差）：依赖机器是否安装 ripgrep，属环境相关分裂而非确定性错误。
- `settings.service.ts:690` `share.tokenLinksEnabled` 因 `endsWith('enabled')` 大小写敏感绕过布尔校验：单键、影响面窄，且需管理员主动存非法值——列为建议（统一改为显式布尔键清单校验）。
- `notification/task/preference.service.ts:36` 非法 channel 值使 GET/PUT 永久 500：正常写入路径不可达，依赖历史脏数据。
- `session.service.ts:1515-1528` dashboard 查询未排除 `SIDE_TASK/SUBAGENT`：违背 `session.routes.ts:129-130` 注释的不变量，但全仓（desktop/admin）当前无前端消费该端点，无可观测影响——建议连同注释一起修。
- `session.service.ts:359-361` 标题搜索 `LIKE` 未转义 `%`/`_`：非注入（参数化查询），仅通配符语义，且与消息搜索的 `escapeLike` 口径不一致——列为建议。
- desktop `useChat.ts:539` 按活跃会话而非发送会话写耗时：姊妹函数 `sendMessageAndWaitForSave` 已用 sid 口径修掉同类问题，但 UI 路径当前不可达（`isActive` 门控），导出 API 可达——列为建议。
- `analytics.routes.ts` `days` 未钳制（`days=100000` 可打满 DB）：边界健壮性问题，端点有权限把守——列为建议。
- `dingtalk/runtime.ts:617`、`openapi/open-api-call-log.logic.ts:119` 按进程本地时区解析上海墙钟串：生产机 TZ 为 Asia/Shanghai 时不表现，属 TZ 脆弱性——列为建议（统一走 `parseShanghaiDateTime`）。
- 已逐行核对确认**无问题**的高危点：`tool-dispatcher` 五级权限状态机与 arity 分派、`agent-loop` 流式 tool_call 合并与轮次回滚、`compaction-service` 的 `isCompletePhysicalPrefix`、`shell-session-manager` 的 marker 解析、`path-sandbox`/`strict-path` 越界收口、`scheduled-task.service.ts` 1500 行状态机（在飞守卫 / CAS 回滚）、`approval-rule` 匹配链、`budget.service` 阈值与换算、`statistics`/`analytics` 各时间窗与聚合、`run-trace.service` 分页与防环、`usage` 成本快照、`crypto` 加解密、`openapi/hmac` 签名校验、`weixin/media-crypto`、`feishu` 卡片动作与合并转发、`message-queue` 重排、`session-export` 聚合、desktop `usageFormat`/`trace-display`/`file-manager`/`useCenterTabs`、admin `datetime.ts`/`embedContext`、agent-cli `local-files`/`local-sandbox`/`approval`/`tabs` 竞态等。

---

## 6. 复核降级项（原 BUG-5 / BUG-6：缺陷存在但修复价值不高，移出正式清单）

同日逐项复核结论：两条缺陷经源码 + 测试二次确认**均真实存在**（原测试按「正确行为」断言确实失败），但按「用户可感影响 × 修复成本」衡量不值得单列为 bug，故从正文移除，其存在性证明测试（`backend-ts/src/file/workspace-browse-empty-file.bugcheck.spec.ts`、`backend-ts/src/harness/tool/impl/scheduled-task-tools.bugcheck.spec.ts`，均含对照组）已同步删除——留着只会让全量测试常红。编号跳空保留以便追溯；若将来相关代码改动，可按本条记录的方向顺手修（测试可按原断言思路重建）。

- **原 BUG-5｜空文件预览 `total_lines = 1`**（`backend-ts/src/file/workspace-browse.service.ts:333-337`）：`"".split('\n')` 得 `[""]`，`"".endsWith('\n')` 为 false 使外层 if 不进，内层 `text.length === 0` 兜底不可达，空文件报 1 行；harness 同职责 `read-file-tool.ts:142-147` 的 `splitLines` 对 `''` 正确返回 0 行。**降级理由**：纯行数元数据 off-by-one，文件内容本身为空、切片不越界，用户可见后果仅限「空文件显示共 1 行」这一处 cosmetic；按本审查 §5 对同类边界/cosmetic 问题的既有口径不列为 bug。**顺手修法**：行数归一化与 `splitLines` 对齐并删掉不可达死分支（一行内）。
- **原 BUG-6｜`list_scheduled_tasks` 的 session→userId 兜底是空语句**（`backend-ts/src/harness/tool/impl/scheduled-task-tools.ts:128-130`）：空 if 体 + 构造器未注入 `SessionService`，结构上无法完成该兜底；姊妹工具 `create_scheduled_task` 同场景正确反查。**降级理由**：唯一生产调用方 `agent-loop` 恒传非空 userId（`harness-service.ts:301` `context.userId = session.userId`），主链路不可触发，属潜伏缺陷；与 §5 中 `background-task-manager.ts:107` 同类（结构不对称但当前不可达）。**顺手修法**：构造器补 `SessionService` 注入（参照 `tool-registry.ts:132-133` 接线），把空语句体实现为与 `create_scheduled_task` 相同的 session 反查。
