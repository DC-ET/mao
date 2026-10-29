# 复现脚本 · 2026-10-29 长文本用户消息「文件化」· 第 3 轮（agent-cli 增量）

复核对象：`mao-agent --local` 补上 `write_local_text_file` 本地落盘能力（`agent-cli/src/local/{paths,tools/files,executor}.ts`）。
**本轮未发现功能缺陷**（故无 `...-cli-round1.md` 报告），本目录只保留验证脚本与实测输出。

## 四个待确认点的结论

| # | 待确认 | 结论 | 证据（`cli-contract-and-guards.test.cjs`） |
|---|---|---|---|
| 1 | 审批链路是否被绕过 | **没有**。`evaluateApproval` 先跑硬门禁（`--approve-rule` 合法性 → 工作区信任 → 默认拒绝清单），通过后才轮到 `needApproval=false` 短路；`checkToolDeny` 只扫 `command`/`input` 与 `path`/`file`… 等字段，**不扫** `content`（否则含 `rm -rf` 的原文会被误杀）；`LocalExecutor` 端到端在未信任工作区下不落盘、回 `tool_error` | C1 / C2 / C3 |
| 2 | 路径是否可能逃出 `userMessages/` | **不会**（注入与非法会话号均收敛或报错）。`path.basename` + 剥控制字符/首尾点空格 + ≤100 长度上限 + `path.relative` 断言；`sessionId` 必须正整数；目标本身是符号链接时拒绝写入（链外文件未被改写） | B1 / B2（B3 为父级软链的记录性核查，见下） |
| 3 | 与服务端 `DumpUserMessagesTool` 的回包契约 | **一致**。用**真实** `DumpUserMessagesTool`（读 `backend-ts/dist`）经 CLI handler 落盘：`files[0].path` = `~/.mao/agent-cli/runtime/<sid>/userMessages/user-message-1042.txt`，内容一致；重复导出同路径、单文件、内容更新（幂等覆盖）；`{ error }` 时服务端按该条失败记录、不冒充成功。CLI 与桌面端的差异仅在于**没有渲染层粘贴附件**，故不需要 `dedupe` 分支 | A1 / A2 |
| 4 | 新增 `case` 是否影响既有工具 | **不影响**。改动纯追加：`runTool` 的新 case 插在 `default` 前且各 case 均返回（无贯穿），import 仅扩展；`shell` 的 `delegatedToShell`/`shellPrompts` 分支与审批入口零改动。CLI 全量 `npx vitest run` 587/587 通过；dump 出的路径可被既有 `read_file` 直接读取 | D1 + 全量套件 |

补充说明（不计为 bug）：**B3** 记录——若 `userMessages` 目录整体被替换为软链，写入会跟随该软链落到链外目录（`assertNotSymlink` 与既有 `write_file`/`edit_file` 一样只看目标本身）。这与桌面端 `writeLocalTextFileAsync`、以及仓库既有「只拒绝目标本身是 symlink」的模型完全一致，且需要先获得同等用户写权限才能布置软链，故不作为本次缺陷。

## 运行方式

```bash
cd <仓库根>/mao
# 依赖：agent-cli 已 npm run build（读 dist/local/**）、backend-ts 已 npm run build（读 dist/harness/**）
node --test docs/code-review/repro/2026-10-29-long-user-message-file-export-cli-round1/cli-contract-and-guards.test.cjs
```

脚本会用临时 HOME（重写 `process.env.HOME` 并清掉 `agent-cli/dist` 的 require 缓存）隔离 `~/.mao/agent-cli`，并预置 `trustedWorkspaces`；不影响真实用户配置。

## 本机实测输出（节选）

```
ok 1 - A1 契约：CLI 回包被真实 DumpUserMessagesTool(LOCAL) 解析为绝对路径，内容一致
ok 2 - A2 契约：CLI 失败态回 { error } 时服务端工具按「该条失败」记录，不冒充成功
ok 3 - B1 路径收敛：fileName 注入 / 非法会话号全部收敛在 userMessages 内或直接报错
ok 4 - B2 符号链接：目标文件是软链时拒绝写入，链外文件不被改写
ok 5 - B3 记录性核查：userMessages 目录整体被替换为软链时（父级软链）落点在哪
ok 6 - D1 端到端：dump 出的路径可被 CLI 的 read_file 直接读取（既有工具行为不变）
ok 7 - C1 硬门禁优先于 needApproval=false：未信任工作区一律拒绝
ok 8 - C2 已信任 + needApproval=false → 放行；拒绝清单只看 command/input/path 类字段，不看 content
ok 9 - C3 LocalExecutor 端到端：未信任工作区下 write_local_text_file 不落盘、回 tool_error
# pass 9 / fail 0
```

注入用例的实际落点（`sanitizeUserMessageFileName` 行为）：

| 输入 fileName | 结果 |
|---|---|
| `../../escape-a.txt` / `a/b/../../escape-b.txt` / `....//escape-d.txt` | 收敛为 `escape-a.txt` / `escape-b.txt` / `escape-d.txt`（均在 userMessages 内） |
| `/etc/passwd` | 收敛为 `userMessages/passwd` |
| `..\\..\\escape-c.txt`（POSIX） | 含反斜杠的字面文件名，仍在 userMessages 内；Win32 下 `path.basename` 直接剥成 `escape-c.txt` |
| `\u0000con\u001ftrol.txt` | 剥控制字符 → `control.txt` |
| `user-message-1.txt␠`（尾空格） | 剥尾空格 → `user-message-1.txt`（幂等性不受影响） |
| 101 字符 | `{ error: '文件名无效' }` |

## 回归（本轮实跑）

- `agent-cli`：`npm run build` 通过；`npx vitest run` **50 文件 / 587 用例全绿**（含新增 `test/local-user-messages.spec.ts` 5 例）。
- `desktop`：`npx vitest run src/utils/toolDisplay.test.ts` 45/45 通过（本轮新增的 `dump_user_messages` 展示用例）。
- 服务端未改动（`git status` 后端文件与第 2 轮一致），第 1/2 轮复现脚本仍全绿。
