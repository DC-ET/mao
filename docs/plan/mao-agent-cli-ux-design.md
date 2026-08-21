# mao-agent CLI 用户体验专项优化设计

> 版本: v0.1 | 更新时间: 2026-08-20  
> 状态: U0/U1/U2 已落地；U3（ink）评估后不引入，保持自研轻交互层  
> 定位: 在协议闭环已跑通的前提下，专项提升**交互式 REPL**的可读性、可控性与「像在对话」的体感  
> 关联文档: [mao-agent-cli-technical-design.md](./mao-agent-cli-technical-design.md)、[ask-user-questions-design.md](./ask-user-questions-design.md)、[center-panel-approval-design.md](./center-panel-approval-design.md)  
> 实现目录: `agent-cli/`（`repl/`、`render/`、`commands/`）

---

## 0. 一句话总结

`mao-agent` 已具备 CLOUD/LOCAL 协议能力，但交互层仍是「行式日志 + 简陋 readline」：执行中不可输入、提问/审批打断主循环、工具与正文混在一起、状态栏时常看不见、冷启动无引导。本设计把 UX 从「能跑」推到「愿意天天用」，**不重做协议、不引入全屏 TUI 框架为默认依赖**，用分阶段的输入编排 + 视觉层级 + 中断式交互重构解决问题。

---

## 1. 目标与非目标

### 1.1 目标

1. **对话感**：用户始终知道「现在轮到谁」——自己输入 / Agent 思考 / 工具执行 / 等你确认。
2. **可控感**：长任务可取消、可排队下一条、可看进度；误操作有后悔路径。
3. **可读感**：Assistant 正文、工具轨迹、系统提示三者视觉分离；关键信息一眼扫到。
4. **低摩擦**：首次使用、恢复会话、LOCAL 信任、提问与审批，步骤少、文案短、默认合理。
5. **兼容脚本**：打印模式 / JSON / 非 TTY 行为保持稳定；交互优化**不得**破坏 CI 退出码与 stdout 纪律。

### 1.2 成功标准（可验收）

| 场景 | 验收 |
|---|---|
| 冷启动 | 5 秒内看到身份（谁/什么模式）+ 可输入提示 + 一条最短帮助 |
| 一轮对话 | 工具调用可折叠扫读；正文不被工具日志淹没 |
| 执行中 | 状态始终可见；可 `/cancel`；可预输入下一条（队列） |
| `ask_user_questions` | 序号/方向键/多选可用；不破坏主 REPL 输入状态 |
| LOCAL 审批 | 一眼看清工具+参数摘要；`y/n/always` 语义清晰 |
| 恢复会话 | 最近轮次可读摘要，而非裸 `id/phase` 字符串墙 |
| 非 TTY / `-p` | 与现网一致，无 spinner/无交互假设 |

### 1.3 非目标

- 不做 Electron 式 GUI，不做完整全屏 TUI（多窗格、鼠标拖拽布局）。
- 不在本期引入 React/`ink` 为**硬依赖**（可作为后续可选评估，见 §8）。
- 不重做 `mao-user` 元数据管理；会话删除/置顶等仍引导到 `mao-user`。
- 不做 Side Task 多会话同屏 attach（技术设计 Phase 4）。
- 不改变后端 WS 协议语义（除非为 UX 发现的硬伤单独开后端任务）。

---

## 2. 现状诊断（基于源码）

对照实现：`agent-cli/src/repl/repl.ts`、`render/repl-renderer.ts`、`commands/chat.ts`、`local/approval.ts`、`util/ansi.ts`。

### 2.1 痛点地图

| ID | 痛点 | 用户体感 | 根因 | 严重度 |
|---|---|---|---|---|
| P1 | **执行中锁输入** | Agent 跑着只能干等或 `/cancel`，不能先写好下一条 | `inputLocked` + `rl.pause()`；无消息队列 | P0 |
| P2 | **状态栏经常消失** | 流式输出时底部进度没了，像卡住 | `setStatus` 要求 `atLineStart`；`content_delta` 一写就清状态 | P0 |
| P3 | **工具与正文平铺** | 长任务刷屏，结论难找 | `▸ tool` 与正文同级行式输出，无折叠/分组 | P0 |
| P4 | **提问打断 REPL** | `ask_user_questions` 新建第二个 `readline`，主循环状态脆弱 | `askQuestionsInTty` 独立 `createInterface` | P0 |
| P5 | **提问交互原始** | 只能手打序号；无高亮、无默认项、无 Esc 取消语义 | 纯文本 `question()` | P1 |
| P6 | **冷启动空白** | 只有 `› `，不知能 `/help`、不知当前会话 | 无 welcome banner / 无 slash 提示 | P1 |
| P7 | **历史回放过干** | resume 只有「首行+工具名」文本墙 | `summarizeMessages` + stderr 分隔线 | P1 |
| P8 | **登录密码可见** | `login` 的 `hidden` 参数未真正隐藏输入 | `cmdLogin` 里 `_hidden` 未接线；`promptHidden` 也未吞回显完善 | P1 |
| P9 | **斜杠面窄且无补全** | 无 `/clear`、`/compact` 提示、`/agent`、无 Tab | 硬编码少量命令 | P2 |
| P10 | **Todo 不可见** | 任务规划只在 `/todo` 才看 | 无 live Todo 条 | P2 |
| P11 | **审批文案偏运维** | 规则、deny-list、信任路径对人类不友好 | 技术错误直接 stderr | P1 |
| P12 | **Markdown 流式撕裂** | 半截 `**` / 代码围栏渲染错乱 | `renderMarkdownLite` 按 delta 片段处理 | P2 |
| P13 | **Ctrl+C 心智负担** | 「有任务取消 / 无任务再按一次退出」需学习 | 双击窗口 + 文案偏短 | P2 |
| P14 | **会话切换成本高** | 必须退出重开才能换会话 | 首版「一进程一会话」简化 | P2（可接受，但要降低摩擦） |

### 2.2 设计文档与实现的体验债

技术设计 §9 明确：**首版行式滚动、单行状态栏、不做 ink**——这对「协议优先」正确，但也直接把体验债留到了现在。Phase 1/3 能力已落地，**体验专项应视为独立 Phase U（UX）**，与协议 Phase 解耦。

### 2.3 用户旅程（当前）

```
安装 → login（密码可能明文）→ mao-agent
  → 一行「新建会话」→ 空白 ›
  → 打字 → 锁输入 → 工具刷屏 + 正文交织 → 状态栏时有时无
  → Agent 提问 → 第二个 readline 抢 stdin
  → 结束 → 一行 meta → ›
  → /exit
```

目标旅程见 §4。

---

## 3. 设计原则

1. **角色清晰**：每一屏时刻只突出一个「当前焦点」（输入 / 流式正文 / 工具块 / 模态提问）。
2. **输出分级**：
   - L0 正文（Assistant）——默认最大字号对比度
   - L1 工具轨迹 —— 次级、可折叠摘要
   - L2 系统/连接/压缩 —— 最弱 dim，一行够用
3. **模态优先于并行**：提问与审批用**显式模态**占住输入权，结束后干净交还 REPL；禁止叠两个 readline。
4. **TTY 增强、管道不变**：所有花活（spinner、颜色、队列预输入）仅 TTY + 非 print；`-p`/JSON 零装饰。
5. **渐进披露**：默认安静；需要细节时 `/verbose`、展开工具、`--thinking`、`--trace-file`。
6. **文案像人对人**：少堆协议字段名；错误给出「下一步做什么」。
7. **可撤销默认**：取消、拒绝审批、Esc 退出模态，比「强制完成」更重要。
8. **架构不绑死 UI**：继续坚持 `SessionRunner → CliEvent → Renderer`；UX 改动尽量落在 `repl/` + `render/` + 薄编排层。

---

## 4. 目标体验（叙事）

```
$ mao-agent
mao-agent  会话 #128 · 通用助手 · gpt-4o · CLOUD
输入消息开始；/help 查看命令。Ctrl+C 取消当前任务。

› 帮我看看 README 总结三句话

  💭 思考中…                                    3s · Context 12%
  ▸ read_file  README.md
    210 lines · 0.2s

这份 README 描述了……（三句话）……

  ✔ 完成 · 8s · Context 18% · 1 tool
› _
```

执行中用户可继续打字（灰色预览「已排队」），回车进入队列；Agent 结束后自动发送下一条。  
Agent 提问时进入模态面板，选完后回到同一 `›`。

---

## 5. 信息架构与视觉规范

### 5.1 屏幕分区（逻辑，非全屏 TUI）

| 区域 | 内容 | 行为 |
|---|---|---|
| Header（会话开始时一次） | 产品名、sessionId、Agent、Model、Mode、workspace（LOCAL） | 静态打印，不重绘 |
| Transcript | 用户回合分隔、正文、工具块、系统一行提示 | 只追加，进入 scrollback |
| Status（TTY） | spinner + 阶段文案 + 已用时 + Context% | **独立于正文行**：用 stderr 最后一行或「正文下方保留行」策略（§6.2） |
| Input | `› ` 或模态 `? ` | 单一 stdin 所有者 |

### 5.2 回合分隔

每轮用户消息前打印弱分隔（可选）：

```
── 你 ────────────────────────────────────────
› 帮我看看 README…
── Agent ─────────────────────────────────────
```

默认开启轻量版（仅在回合开始印一条 `──`）；`--compact-ui` 可关掉。

### 5.3 工具块（默认折叠）

```
⏺ shell  npm test
  ⎿  exit 0 · 12.4s
```

- 默认：Claude Code / Codex 式 `⏺` 标题 + `⎿` 一行摘要（截断）。
- `/verbose` 或环境 `MAO_AGENT_VERBOSE=1`：多行预览。
- `file_change` 归入回合末汇总，中途只 dim 一行路径。
- 用户回合整行深灰块回显（底栏输入框提交后写入 transcript，避免和 readline 双份）。

### 5.4 颜色与符号

- 保持现有 ANSI 色板（cyan 工具、dim 次要、red 错误、yellow 系统）。
- **减少 emoji 依赖**：工具用 `⏺`/`⎿`，输入用 `❯`；`--ascii` 退回 `*` / `|` / `>`。保留 `✔`/`✖`/`⚠`。
- 遵守 `NO_COLOR` / `--color` / 非 TTY 规则（已有）。

### 5.5 Markdown

- **流式阶段**：不对半截 markdown 做结构变换，原样输出或仅做安全转义。
- **回合结束**（可选 Phase U2）：对完整 assistant 缓冲做一次 lite 渲染（标题/粗体/行内代码）。
- 代码围栏：围栏行 dim；围栏内不着色（与现状一致）。语法高亮仍非目标。

---

## 6. 交互模型专项设计

### 6.1 输入所有权状态机（核心）

```
          ┌─────────────┐
          │   IDLE      │◄──────────────────────────────┐
          │  › 可输入    │                               │
          └──────┬──────┘                               │
                 │ submit prompt                        │
                 ▼                                      │
          ┌─────────────┐     ask/approval      ┌──────┴──────┐
          │  RUNNING    │──────────────────────►│   MODAL     │
          │ 可预输入排队 │◄──────────────────────│ 独占 stdin  │
          └──────┬──────┘     答完/取消          └─────────────┘
                 │ terminal phase
                 ▼
          ┌─────────────┐
          │ DRAIN_QUEUE │──有队列──► 自动 runPrompt ──► RUNNING
          └─────────────┘
                 │无队列
                 └──► IDLE
```

规则：

1. **全局唯一** `readline` / 输入驱动器；模态不得 `createInterface` 第二次。
2. `RUNNING` 时：键入进入 `queuedPrompt`（显示 `… 已排队（回车追加，Ctrl+C 清空队列）`）；不立刻 `send_message`。
3. `MODAL` 时：暂停队列写入；模态取消 = 按产品策略发 fail/空答（对齐 `--on-question`）。
4. 退出进程前若有队列：提示「有未发送草稿，确认退出？」

### 6.2 状态栏可见性修复（P0）

现状：状态写在「行首」且被 `content_delta` 清掉。

方案（二选一，推荐 A）：

**A. stderr 粘性状态行（推荐）**

- 正文继续走 stdout。
- 状态始终 `\r\x1b[K` 写在 stderr；每次 stdout 写入前清 stderr 状态，写入后**立刻重画**（不要求 `atLineStart`）。
- 多行 stdout 增量时：每个 chunk 后重画，80ms 节流。

**B. 保留底行（需轻微 ANSI 光标管理）**

- 打印正文前 `scroll` 上推，底行固定状态；复杂度更高，留作 U2。

验收：流式打字过程中，用户仍能看到 `思考中/运行 shell/等待 LLM` + 秒数。

### 6.3 取消与中断（P13）

| 输入 | RUNNING | IDLE | MODAL |
|---|---|---|---|
| Ctrl+C | 发 `cancel`；清空队列；提示「已取消」 | 第一次提示「再按一次退出」；2s 内第二次退出 | 关闭模态（等同拒绝/取消提问，按协议发结果） |
| `/cancel` | 同 Ctrl+C | 提示无任务 | — |
| Ctrl+D | — | 退出 | 取消模态 |

文案统一短句，避免「等待任务结束…」而无超时提示：若 cancel 后 8s 未终态，提示「仍在收尾，可再等或强制 Ctrl+C 退出进程」。

### 6.4 斜杠命令升级

| 命令 | 作用 | 优先级 |
|---|---|---|
| `/help` | 分组帮助（会话/模型/视图/危险） | 已有，改版 |
| `/session` | 会话信息表格化 | 改版 |
| `/model` | 切换模型；无参列出常用 | 增强 |
| `/todo` | Todo；RUNNING 时自动刷新提示 | 增强 |
| `/context` | context + 建议「接近上限可新开会话」 | 增强 |
| `/cancel` | 取消 | 已有 |
| `/clear` | 清屏（ANSI），不删服务端历史 | U1 |
| `/verbose` | 切换工具详情详细度（会话级） | U1 |
| `/queue` | 查看/清空预输入队列 | U1 |
| `/copy` | 复制上一回合 assistant 文本到剪贴板（有则用，无则打印路径） | U2 |
| `/agent` | 提示改用新进程 + `mao-agent --agent`，不假装热切换 | U1 文案 |

Tab 补全：仅斜杠命令名与 `/model` 候选（U2）；无参时列出前缀匹配。

### 6.5 `ask_user_questions` 模态（P4/P5）

对齐 desktop 能力的「终端缩小版」：

```
? Agent 想确认（1/2）
  用哪种部署方式？
  ❯ 1) 蓝绿发布 — 零停机
    2) 滚动发布
    3) 自定义…

  ↑↓ 选择  Enter 确认  数字快捷  Esc 跳过/取消（受 --on-question）
```

- 多选：Space 勾选，Enter 提交。
- 自定义：选「自定义」后进入一行输入。
- 实现：在同一输入驱动器上切换 keymap；**禁止**新建 readline。
- 超时：服务端 15min；本地每分钟 stderr 提醒一次剩余时间（可选）。

### 6.6 LOCAL 审批模态（P11）

```
⚠ 需要批准 · shell
  cd /opt/mao && npm test

  [y] 允许这次  [n] 拒绝  [a] 本会话允许同类
  工作区: /opt/mao · 已信任
```

- `a` = 会话内动态追加等价于临时 `--approve-rule`（内存，不写盘），降低重复打扰。
- 拒绝理由简短回传 Agent（已有 `tool_error` 路径）。
- deny-list / 未信任：不要只丢技术长句；模板：

```
✖ 已拦截：工作区未信任
  目录: /tmp/x
  下一步: 在本目录运行 mao-agent --local 并输入 y，或编辑 ~/.mao/agent-cli/config.json
```

### 6.7 冷启动与 resume（P6/P7）

**新会话 welcome（3 行封顶）**：

```
mao-agent  #128 · 通用助手 · gpt-4o · CLOUD
输入消息开始。常用: /help  /session  /model
```

**resume / `--continue`**：

```
恢复 #128 · 通用助手 · 上次更新 10 分钟前
── 最近对话 ──
你: 帮我改登录页…
Agent: 已改 TopNav… · 工具: edit_file×2
──────────────
›
```

- 默认最近 2～3 轮；`--replay-full` 仍拉更多。
- 每条用户/助手各最多 2 行摘要；工具只计次数。

### 6.8 登录（P8）

- `mao-agent login` 密码必须无回显（TTY 下 `stdin.setRawMode` 或等效）。
- 成功后提示：`之后可直接 mao-agent`；token 过期文案指向 `mao-agent login`。

### 6.9 会话切换摩擦（P14）

短期不实现多会话 attach，但降低成本：

- `mao-agent ls`：高亮最近会话、标注 `last`、显示相对时间（`10m ago`）。
- `mao-agent resume` 打印将恢复哪一条的标题/Agent 再连接。
- welcome 增加：`换会话: mao-agent resume | mao-agent ls`。

---

## 7. 文案与错误体验

### 7.1 语气

- 短、祈使、给下一步。
- 中文为主（与现网一致）；标志符/命令保持原文。

### 7.2 常见错误改写示例

| 现状倾向 | 目标文案 |
|---|---|
| `当前任务仍在执行，请等待结束或 /cancel。` | `上一条还在跑。已把你的输入放入队列；或 /cancel 后重说。`（配合队列后） |
| `未知斜杠命令` | `未知命令 /foo。输入 /help 查看列表。` |
| `没有可恢复的 ACTIVE 会话` | `没有可恢复的会话。直接运行 mao-agent 新建一个。` |
| WS 重连失败 N 次 | `连不上服务器（已重试 N 次）。检查网络，或 mao-agent login 后重试。` |

### 7.3 首次 LOCAL 信任

保留 y/N 默认拒绝；说明「允许后 Agent 可在该目录执行命令与写文件」，一句风险够用，不贴长协议。

---

## 8. 技术方案选型（UX 层）

### 8.1 推荐路径：自研「轻交互层」，不默认上 ink

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 继续纯 readline + 行式 | 零依赖、管道友好 | 难做模态/队列/粘性状态 | 仅维持 print 模式 |
| **自研 InputController + AnsiRenderer** | 可控、依赖少、契合现架构 | 需认真处理 raw mode / 测 TTY | **主路径** |
| ink / React TUI | 组件化快 | React 运行时、包体、与现有 CLI 风格冲突 | U3 可选 POC，不阻塞 U1/U2 |

### 8.2 模块划分（建议新增）

```
agent-cli/src/
  ui/
    input-controller.ts   # 唯一 stdin：IDLE/RUNNING预输入/MODAL keymap
    modal-ask.ts          # ask_user_questions UI
    modal-approval.ts     # LOCAL 审批 UI
    welcome.ts            # banner / resume 摘要格式化
  render/
    repl-renderer.ts      # 强化：工具折叠、粘性状态、回合分隔
    status-line.ts        # 从 renderer 抽出，便于测节流
  repl/
    repl.ts               # 变薄：委托 InputController + 队列
```

`SessionRunner` / WS **尽量不动**；若队列自动发送，只在 `repl` 层连续调用 `runPrompt`。

### 8.3 测试策略

- 单测：状态机转换、队列、状态行节流、markdown 流式不撕裂、文案快照。
- 集成：mock WS 下模拟 `ask_user_questions` 模态键序（可注入假 stdin）。
- 手工验收清单见 §10。
- 不强制 Playwright；TTY raw mode 以单测 + 脚本验收为主。

### 8.4 配置项（可选）

`~/.mao/agent-cli/config.json` 增补（均有默认）：

```json
{
  "ui": {
    "verboseTools": false,
    "showTurnDividers": true,
    "asciiOnly": false,
    "queuedInput": true
  }
}
```

CLI 覆盖：`--verbose-tools`、`--ascii`、`--no-queue`。

---

## 9. 分期落地（Phase U）

### U0 — 止血（0.5～1 天，强烈建议先做）

- 粘性状态栏（§6.2A）
- 登录密码隐藏
- welcome 三行 + `/help` 提示
- 取消后超时提示
- `ls` / resume 相对时间与标题可读性

**验收**：流式输出时仍能看到状态；新用户知道有 `/help`。

### U1 — 交互主路径（3～5 天）

- `InputController` + 消息队列（P1）
- 统一模态：ask + approval（P4/P5/P11）
- 工具默认折叠 + `/verbose`
- `/clear` `/queue`
- 错误文案改写

**验收**：执行中可排队；提问不再双 readline；长任务刷屏明显减轻。

### U2 — 润色（已落地）

- 回合结束 markdown 再渲染（流式阶段原样输出，块边界按可视行数一致才回写）
- 斜杠 Tab 补全（含 `/model` 模型名、`/queue clear`）
- Todo 在状态区一行 live 摘要（`Todo 2/5`）
- `/copy` 复制上一回合回复（无剪贴板命令时回落到打印）
- 底栏 Composer（备用屏 + 顶栏固定 + 滚动区 + 圆角输入框），对齐 Cursor Agent / Claude Code 的「对话在上、输入钉底」；高度不够时回退 readline。
- 用户回合整行深灰块回显（底栏输入框提交后写入 transcript，避免和 readline 双份）。
- 底行状态方案 B：半行流式时用光标保存/恢复把状态钉在最后一行；无 `rows` 时不在正文行 `\r`，避免擦掉回复（不再用换行把旧状态推进历史）。
- resume 摘要按角色对齐排版

### U3 — 可选评估（结论：不做）

- **不引入 ink / React。** 包体、运行时与现有零依赖 CLI 风格冲突；U1 的 `InputController` + 手写 ANSI 已覆盖边框输入框的核心诉求（队列、模态、Tab）。若未来强诉求全屏面板，再单独 POC，不作为默认路径。

---

## 10. 手工验收清单

- [ ] `mao-agent` 冷启动 ≤3 行引导 + 底栏 `❯` 输入框
- [ ] 发送长回复：状态秒数持续更新
- [ ] 执行中输入第二句并回车：显示已排队；结束后自动发送
- [ ] 执行中 Ctrl+C：取消且队列清空
- [ ] Agent `ask_user_questions`：方向键选择；Esc/取消行为符合 `--on-question`
- [ ] LOCAL 审批：`y`/`n`/`a`；deny-list 文案含下一步
- [ ] `mao-agent login` 密码无回显
- [ ] `mao-agent -p "…"` stdout 无装饰；退出码不变
- [ ] `NO_COLOR=1` 无颜色码
- [ ] resume 可见最近对话摘要

---

## 11. 风险与约束

| 风险 | 缓解 |
|---|---|
| raw mode 在某些 SSH/tmux 异常 | 检测失败则降级纯 readline，并提示 |
| 队列自动发送误触 | 回车才入队；Ctrl+C 清空；`/queue` 可编辑策略先只支持清空 |
| 状态行与用户滚动冲突 | 仅用 `\r` 单行；不抢 scrollback 历史 |
| 与技术设计「一进程一会话」冲突预期 | 文档/welcome 写清；用 `ls`/`resume` 降摩擦 |
| 范围膨胀到全屏 TUI | 严格按 U0→U1→U2；U3 单独决策 |

---

## 12. 与现有文档的关系

| 文档 | 关系 |
|---|---|
| `mao-agent-cli-technical-design.md` | 协议/架构 SSOT；本文不修改其 Phase 1～3 结论，只把 §9「体验后置」展开为可执行 UX 专项 |
| `ask-user-questions-design.md` | 后端/产品语义；本文定义 CLI 侧交互壳 |
| `center-panel-approval-design.md` | desktop 审批 UX 参考；CLI 模态对齐其决策语义，不抄 GUI 布局 |

建议在技术设计文首「关联文档」中增加本文链接；发版用户可见改动写入根 `CHANGELOG.md` → `### 终端 CLI（mao-agent）`。

---

## 13. 开放问题（评审时拍板）

1. **队列是否默认开启？** 建议默认开，提供 `--no-queue`。
2. **模态 Esc 对 `ask_user_questions`**：发空答 / 显式 cancel 事件 / 等同 `--on-question=fail`？需与后端现有 result schema 对齐后定一条。
3. **会话内 `a` 永久批准**：仅内存 vs 写入 config？建议 U1 仅内存。
4. **是否允许 U3 ink？** 默认否；U2 完成后维持该结论，不引入 React 运行时。

---

## 14. 附录：优先级与痛点回溯

| 痛点 | 归属阶段 |
|---|---|
| P2 状态栏消失 | U0 |
| P6 冷启动 | U0 |
| P8 密码可见 | U0 |
| P7 历史干 | U0 |
| P1 锁输入 | U1 |
| P3 工具刷屏 | U1 |
| P4/P5 提问 | U1 |
| P11 审批文案 | U1 |
| P9 斜杠 | U1/U2 |
| P10 Todo live | U2 |
| P12 Markdown | U2 |
| P13 Ctrl+C | U0/U1 |
| P14 换会话 | U0 降摩擦 |

---

**文档结束。** 评审通过后建议直接按 U0 → U1 拆任务实现；本文件只描述体验与交互合约，不替代具体 PR 中的实现说明。
