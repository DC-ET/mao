# 代码审查：logic-bugfix 修复轮（5 个 BUG 修复的正确性验证 + 新引入缺陷排查）

- **日期**：2026-10-16
- **基线**：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/logic-bugfix`，分支 `fix/logic-bugs-2026-10-16`，未提交改动 12 个产品文件 + 5 个 `*.bugcheck.spec.ts` 回归测试（修复 `docs/code-review/2026-10-16-logic-bug-review-01.md` 保留的 BUG-1/2/3/4/7）
- **范围**：只审功能逻辑（CHANGELOG.md 等文档变更不看）。逐修复核对正确性、完整性、边界条件，并用真实 git 仓库 / 真实 SkillDocService / 真实 resolveConfig 链路构造验证测试
- **方法**：每个候选必须「输入合法即可触发、输出确定错误、有可运行测试证明」；测试统一命名 `*.reviewcheck.spec.ts`，跑完后保留在 worktree 中，未改动任何产品代码

---

## 1. 结论表

| 编号 | 严重度 | 位置 | 一句话 |
| --- | --- | --- | --- |
| R1-1 | 低 | `agent-cli/src/args.ts:376` × `agent-cli/src/config/config-store.ts:130,138` | BUG-7 修复把「纯空白」的 output-format 源按「未下发」处理不再报错，但 `resolveConfig` 回落链直接重读 env 原值、`' '` 是 truthy，最终 `resolved.outputFormat = ' '`（非法枚举值），chat 打印模式会静默改用 JsonRenderer；修复前该输入是启动即报错 |

**5 个既有修复本身全部验证正确**（§3），未发现其它新引入缺陷；全量回归零新增失败（§4）。

---

## 2. R1-1｜BUG-7 修复后纯空白环境值产出非法 outputFormat（低）

### 位置

- 修复行：`agent-cli/src/args.ts:376`——`outputFormatRaw != null && outputFormatRaw.trim() !== ''` 把纯空白值也归为「未显式下发」
- 诱因行：`agent-cli/src/config/config-store.ts:130,138`——`resolveConfig` 内 `const envFormat = process.env.MAO_AGENT_OUTPUT_FORMAT`（直接重读 env 原值，不经 args.ts 的归一），回落链 `cli.outputFormat || envFormat || project.outputFormat || user.outputFormat || 'text'`
- 下游消费：`agent-cli/src/main.ts:85`（`cfg.outputFormat = resolved.outputFormat`）→ `agent-cli/src/commands/chat.ts:106-110`（`cfg.outputFormat === 'text'` 才用 TextRenderer，否则 JsonRenderer）

### 触发条件

`MAO_AGENT_OUTPUT_FORMAT` 被置为**纯空白串**（如 `" "` / `"\t"`；Docker `ENV MAO_AGENT_OUTPUT_FORMAT=" "`、CI 里 `export MAO_AGENT_OUTPUT_FORMAT=" "` 均可造成），或 `--output-format ' '` 传纯空白值。纯空串 `''` 不受影响（falsy，被 `||` 链正确跳过）。

### 期望 vs 实际

- 期望（按修复注释自述的口径「空串按未显式下发处理，回落 resolveConfig 链，与 envBool / resolveConfig 回落链口径一致」）：纯空白与空串同口径，最终拿到项目/用户配置或默认 `'text'` 等**合法**取值
- 实际：`parseCliConfig` 不再抛错（`cfg.outputFormat === undefined`），但 `resolveConfig` 重读 env 得 `' '`——truthy——`resolved.outputFormat === ' '`。该值不在 `text|json|stream-json` 内，`-p` 打印模式下 `cfg.outputFormat === 'text'` 为 false，静默走 `JsonRenderer`（`stream: false`），用户拿到 JSON 行输出而非文本
- 修复前行为：`parseEnum` 抛 `CliError`，任何子命令启动即失败（响亮失败）——修复把「响亮失败」换成了「静默使用非法格式」

### 验证测试

- 文件：`agent-cli/test/args-env-whitespace.reviewcheck.spec.ts`（2 条：空串对照组走合法回落 + 纯空白组抓到 `resolved.outputFormat === ' '` 且不在合法枚举内）
- 命令：`cd agent-cli && npx vitest run test/args-env-whitespace.reviewcheck.spec.ts`
- 结果：**2 passed**（含对照组，证明空串路径不受影响、失败点精确在纯空白）

```
 ✓ test/args-env-whitespace.reviewcheck.spec.ts (2 tests)
      Test Files  1 passed (1)
           Tests  2 passed (2)
```

### 修复方向（未动手，供参考）

二选一：(a) `resolveConfig` 的 `envFormat` 读取处也做空串/纯空白归一（`const v = process.env.MAO_AGENT_OUTPUT_FORMAT?.trim(); const envFormat = v ? (v as OutputFormat) : undefined`），与 args.ts 口径对齐；(b) args.ts 的归一只放行 `=== ''`（不放行纯空白），让纯空白继续走 parseEnum 报错。建议 (a)——与 `envBool` 对纯空白返回 undefined 的既有语义完全一致。

### 严重度评定

低。触发需要纯空白 env 值（退化输入，正常部署只会置空串或合法值）；后果是打印模式输出格式静默变为 JSON，不崩溃、不写错数据；但属修复引入的可观察行为变化，且修复注释对「口径一致」的声称在纯空白值上不成立，按审查口径应记录。

---

## 3. 五个修复的正确性验证记录

### BUG-1（numstat 花括号紧凑形态）——正确且完整

- `numstatNewPath`（`backend-ts/src/file/workspace-git.service.ts:456-467`）对 git 2.50.1 实测的全部**现实**紧凑形态均正确还原：
  - `prefix/{old => new}`（同目录，公共前缀）✓
  - `{old => new}suffix`（仅公共后缀，目录改名 `a/x.txt => b/x.txt` 实测输出 `{a => b}/x.txt`）✓
  - `prefix/{old => new}suffix`（前后缀都公共，`dir/a/same.txt => dir/b/same.txt` 实测输出 `dir/{a => b}/same.txt`）✓
  - 简单形态 `old => new` ✓（bugcheck 对照组）
- 验证测试：`backend-ts/src/file/workspace-git-numstat-shapes.reviewcheck.spec.ts`，6 条全过（上述四种形态 + 同目录换扩展名 + 目录名含空格 + 深层嵌套 + 一次变更多个改名互不串味），每条带夹具自检（断言 git 确实输出预期紧凑形态，失去前提不会假通过）
- `braceEnd > arrow` 条件正确处理「旧名含 `{` 但无共同前缀」的简单形态；`--cached`（无 HEAD）路径不会出现改名（实测为 A），无需处理

### BUG-2（SSO/ECP 三态）——口径一致

- 两处 `assertActive` 改为 `!isActiveAccount(user.status)`，与全仓权威口径等价：`permission.service.ts:15`（`status !== 0`）、`auth.service.ts:34,50` 本地登录/刷新（`status != null && status === 0` 才拒）、`ecp-auth.service.ts:170` `ensureUserEnabled` 同款；`status=0` / `deleted!=0` 仍按原语义拒绝（bugcheck 对照组过）
- admin 侧：`UserListView.vue` 表格+移动端卡片 null 显示「未设置」；筛选「启用」经后端 `user.repository.ts:137-139` `(status = 1 OR status IS NULL)` 含 null；「禁用」仍是 `status = 0`（SQL 中 NULL 不匹配，语义正确）；`UserFormDialog.vue:231` `status !== 0` 使未设置用户开关落「启用」，保存写 `status: 1`（与 null 同为活跃，CHANGELOG 已文档化该行为）；行内/批量启停按钮对 null 用户均正确发 `status: 1`
- 全仓无其它用户态 `!== 1` 残留（grep 确认剩余命中均为 model/agent 域，与用户态无关）

### BUG-3（技能上传穿越）——收口完整

- 修复为「段校验（拒 `..`/空段）+ 解析后路径收口（`resolvedTarget` 必须在 `skillFolder` 内）」双保险，与姊妹实现 `user-skill.service.ts writeSkillGroup` 同款
- 验证测试：`backend-ts/src/skill/skill-doc-upload-traversal.reviewcheck.spec.ts`，12 个穿越向量（前导 `..`、多级 `..`、`./..`、反斜杠、双斜杠、裸 `..`、`../`、skillName 为 `..`/`.`、绝对前导 `/`、`..%2f`）全部被拒且 skills 根无越界产物；合法文件（含嵌套子目录）正常落盘，上传整体返回 code 0 不 500；`%2e%2e`/`./` 等不解码形态收敛在技能子目录内

### BUG-4（分组 ORDER BY 漏 CANCELLING）——派生等价

- `ACTIVE_PHASE_SQL_LIST` 派生值 `'RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'`（引号、逗号、空格）与旧 dashboard IN/NOT IN 字面量**逐字符一致**；新分组 ORDER BY = 旧 3 相位 + CANCELLING，符合修复意图
- `isActivePhase` 由同一常量派生，`session-vo.ts` 改为转出，4 个既有导入方（scheduled-task / open-run / weixin / streaming-ws-handler）不受影响；无循环导入（session-group-key 仅类型依赖）
- bugcheck（捕获真实 orderSql 与 isActivePhase 对集合）通过

### BUG-7（agent-cli 空串）——主路径正确

- 空串 env / `--output-format=` 内联空值均按「未下发」回落，`resolveConfig` 链对 `''`（falsy）正确跳过，最终得合法格式；显式合法值行为不变（bugcheck 3 条全过）。遗留纯空白边界缺口即 §2 R1-1

---

## 4. 回归与构建（全部绿）

```bash
cd backend-ts && npm run build                              # tsc exit 0
cd backend-ts && npx vitest run                             # Test Files 340 passed | 1 skipped; Tests 4101 passed | 13 skipped (4114)，0 failed
cd agent-cli && npm run build                               # tsc exit 0
cd agent-cli && npm test                                    # Tests 1 failed | 507 passed (508)
cd admin && npm run build                                   # vue-tsc + vite exit 0
```

- `agent-cli` 唯一失败 `repl-slash.spec.ts > /copy 无剪贴板命令时回落打印` 为**存量环境问题**（本机有 pbcopy，代码走剪贴板分支），单独运行同样失败，与本次改动无关
- 后端全量含 5 个 bugcheck + 本轮 8 个 reviewcheck 断言，零失败；admin 前端三态改动类型检查通过

---

## 5. 已评估、未列为 bug 的项（避免重复劳动）

- **git 文件名本身含 `{`/`}`/` => ` 的字面量形态**（如改名 `brace/{weird}.txt => brace/normal.txt`，numstat 输出 `brace/{{weird}.txt => normal.txt}`）：`numstatNewPath` 解析不出正确键（实测得 `brace/{normal.txt`），但**旧代码同样匹配不上**（得 `normal.txt}`），属修复前既存边界、非本次引入；唯一理论新增风险是「修改态文件名含 ` => ` 且同变更集存在碰撞名文件」时行数错配（实测修改态 `arrow/{a => b}.txt` 被解析成 `arrow/b.txt`），构造条件极度病态，低于报告门槛
- **`admin/src/views/user/UserDetailDrawer.vue:25-26`** 仍把 null 显示为「禁用」：属修复前既存展示不一致，且不在原 BUG-2 的连带清单（原清单只列了 UserListView/UserFormDialog/user.repository），非本次引入；如需彻底三态可顺手改
- **`skill-doc.service.ts` 分组阶段未像 `writeSkillGroup` 那样拒绝 skillName 含 `\0`**：最坏落入 try/catch 返回 500，无穿越、无越权，与姊妹实现的差距仅在错误路径
- **`myskill/sub/../SKILL.md` 这类「本可归一进目录内」的路径被一并拒绝**：与三个姊妹实现同口径，合法客户端不会发送 `..`，不构成功能损失

---

## 6. 测试文件清单（本轮新增，保留在 worktree）

| 文件 | 覆盖 | 结果 |
| --- | --- | --- |
| `backend-ts/src/file/workspace-git-numstat-shapes.reviewcheck.spec.ts` | BUG-1 四种现实紧凑形态 + 边界 | 6 passed |
| `backend-ts/src/skill/skill-doc-upload-traversal.reviewcheck.spec.ts` | BUG-3 12 个穿越向量 + 合法对照 | 2 passed |
| `agent-cli/test/args-env-whitespace.reviewcheck.spec.ts` | R1-1 纯空白 env + 空串对照 | 2 passed |
