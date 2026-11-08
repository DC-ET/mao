# 技术方案：飞书进度卡片工具调用执行中显示耗时

- 状态：已实施（2026-11-08，§11 决策按建议项全部确认，落地版本 0.0.477）
- 日期：2026-11-08
- 需求来源：飞书对话 2026-11-08（杨佳毅）——「飞书卡片目前只会显示"执行中"，是否也可以把耗时信息显示出来？评估一下」；确认刷新粒度为「30s 能改成 3s 吗？」
- 影响范围：`backend-ts`（`feishu/card-progress-listener.ts` 主改、`config/app-config.ts` 加旋钮、5 处装配点中的 3 处传参——飞书 2 + 崩溃恢复 1，钉钉 2 处用默认间隔）、`CHANGELOG.md`；**钉钉卡片行为同源变化**（与飞书共用同一监听器，见 §7.3）
- 不涉及：数据库（零迁移）、WS 协议、桌面端 / admin / agent-cli / 安卓、工具执行链路本身、已完成调用与历史回放的耗时展示
- 规模：小（后端 ≈ 0.5 人日，含单测与自测）

## 1. 背景

### 1.1 问题现象

飞书渠道执行任务时，进度卡的「本轮工具」列表对在途工具只标注 `（执行中）`，没有任何时间信息。长耗时工具（轮询登录态、`sleep` 等待、大范围检索）执行期间卡片完全静止，用户无法判断「卡了多久、还要等多久」：

```
状态：正在处理 · 第 38 轮
查一下其他会话对经验库的处理方式作为参考…
本轮工具
• shell：`echo … timeout 25 grep -rls "团队经验索引|agent-experience" … 等待 90s
  后复查 INDEX == …`（执行中）      ← 已执行 1m45s，但卡片上看不出来
```

### 1.2 桌面端已先行落地同一能力

桌面端在 0.0.463 / 0.0.464 / 0.0.465 三个版本已落地「工具调用执行中实时耗时」，并沉淀出口径，本方案对齐它：

| 口径 | 桌面端（已上线） | 本方案 |
|---|---|---|
| 起表时机 | WS 事件到达客户端（订阅重放用服务端 `elapsed_ms` 修正） | harness 事件到达服务端监听器（进程内 `Date.now()`） |
| 刷新粒度 | 1s | **3s**（见 §4.5 频率测算） |
| 亚秒调用 | 不显示（0.0.465：避免一闪而过的 ms 噪音） | 同样不显示 |
| 已完成调用 | 不显示耗时 | 不显示（摘要行保持纯净） |
| 多调用 | 组头取最早开始的 running 调用，组内各行各自计时 | 列表内各行各自计时 |

两套实现相互独立（一个在 WS 事件层、一个在 harness 事件层），无共享代码、无协议耦合；仅口径保持一致。

### 1.3 为什么现在做不了「加个字段」那么简单

进度卡的更新是**事件驱动**的：`onToolCallStart` / `onToolCallArgsDelta` / `onRoundEnd` / 终态各推一次，**单个长耗时工具执行期间一次推送都没有**。而卡片侧的耗时基建其实早已就绪——`patched-progress.ts` 持有执行级 `startedAtMs`，`buildCard` 接受 `elapsedMs`，终态卡一直在展示「耗时 8 分 26 秒」。唯独 RUNNING 态被**刻意**不展示耗时，`progress-card.ts:105` 的注释写明了原因：「执行中传 undefined 避免节流下展示过期读数」——没有周期刷新时，任何执行中耗时都是冻结的旧数字，比不显示更糟。

**因此本方案的核心不是渲染，而是补一个受控的周期刷新机制。**

## 2. 需求定义

### 2.1 要做的

1. 飞书进度卡「本轮工具」列表中，在途工具行追加执行中耗时，如 `shell：\`npm test\`（执行中 · 3 秒）`，随执行推进刷新（`1 分 30 秒` 量级）。
2. 周期刷新：有工具在跑期间每 **3 秒**重推一次卡（间隔可配置，见 §4.6）；无工具运行（模型思考阶段）、终态均不推。
3. 亚秒（< 1s）不显示耗时；并行工具各自计时；工具结束后照常变为摘要行（不带耗时）。
4. 刷新间隔做成环境变量可调（`FEISHU_CARD_TOOL_TICK_MS`，默认 3000），运维可降频无需发版。

### 2.2 明确不做的

- **不做执行级总耗时**（状态行「第 N 轮 · 已运行 X」）：需要 `patched-progress.send()` 放行 RUNNING 态 `elapsedMs` 并改 `statusLineOf`，牵动另外两个文件与「过期读数」守卫的语义，本期不做（列为后续项，见 §11 决策 4）。
- **不在已完成工具的摘要行带耗时**：与桌面端口径一致，摘要行保持结果语义纯净。
- **不改 `onToolCallResult` 的推送时机**：工具结束本身不推卡（现有设计，结果在下一次事件边界或轮末可见），本期不增加该推送（否则每工具多一次 PATCH）。
- **不改钉钉间隔**：钉钉复用同一监听器与默认间隔；构造参数已支持后续分离（§7.3）。
- **不做崩溃恢复期的历史耗时追认**：恢复后 listener 重建，在途工具按恢复后收到的 `onToolCallStart` 重新起表（§7.4）。
- **不动数据库 / WS 协议 / 桌面端 / admin / agent-cli**。

## 3. 现状盘点：可直接复用的能力

### 3.1 监听器事件模型（`feishu/card-progress-listener.ts`）

`FeishuCardProgressListener implements AgentEventListener`，经 `CompositeAgentEventListener.of(listener, cardListener)` 与 WS 监听器并联挂到 AgentLoop。所有卡片推送经 `queue()` 串行链（`this.pending`）发出：

| 事件 | 现有行为 | 代码位置 |
|---|---|---|
| `onToolCallStart` | 登记工具 + **立即推一次** RUNNING | `:54-61` |
| `onToolCallArgsDelta` | 渲染行变化时推一次 | `:63-72` |
| `onToolCallResult` | 只写 summary，**不推卡** | `:74-82` |
| `onRoundEnd` | 推一次（含本轮摘要行）并清空 tools | `:86-93` |
| `onError` | 推 FAILED | `:95-98` |
| `complete` / `cancel` / `fail` | flush 后推终态 | `:100-116` |

工具行渲染 `formatToolLine`（`:196-200`）：有 summary 用摘要，否则 `name：detail（执行中）`（shell 优先展示命令原文）或 `name：执行中…`。

### 3.2 卡片侧已就绪的基建（`feishu/patched-progress.ts`）

| 能力 | 位置 | 说明 |
|---|---|---|
| 执行级 `startedAtMs` | `:48` | 卡创建时确定，正是计时需要的基准 |
| `buildCard` 接受 `elapsedMs` | `:38` | 模板已支持耗时入参 |
| 250ms 节流 + 串行队列 | `:23`、`:86-95` | 高频刷新不会打爆接口，也不会并发 |
| `refresh()` 重推最近快照 | `:135-138` | 现供「会话详情」按钮用（`active-progress.ts:38`） |
| 终态耗时固化 | `:104-107` | 终态那一刻取定 elapsedMs，挂再久不涨 |
| 失败自愈 | `safeUpdate` catch + warn（listener `:132-140`） | 单次 PATCH 失败只丢一拍，下一拍恢复 |

### 3.3 耗时文案格式化（`feishu/progress-card.ts`）

`formatFeishuDuration`（`:316-324`）：`45 秒` / `8 分 26 秒` / `1 小时 2 分`（整分整时省略零头）——秒级粒度，直接复用，不新造格式。

## 4. 总体设计

### 4.1 端到端时序

```
LLM 产出工具调用
  └─ AgentLoop 分发 AgentEvent（CompositeAgentEventListener）
       ├─ WsStreamingEventListener（既有，桌面端事件流）
       └─ FeishuCardProgressListener（本方案）
            ├─ onToolCallStart: tools.set(id, {name, args, startedAtMs: now})
            │     → queue(RUNNING 推送)（既有行为，elapsed≈0 不带耗时后缀）
            │     → ensureTicker()  ← 新增：挂 3s 定时器
            ├─ tick（每 3s，仅当有工具在跑）:  ← 新增
            │     toolValues(now) 重算各行（running 行拼耗时）
            │     → queue(RUNNING 推送) → handle.enqueue（250ms 节流）→ PATCH
            ├─ onToolCallResult: 写 summary；无在途工具 → stopTicker()
            ├─ onRoundEnd: 推一次（摘要行）→ stopTicker()
            └─ complete/cancel/fail: finished=true → stopTicker() → 终态推送
```

### 4.2 数据结构变更

```ts
type ToolProgress = {
  name: string;
  argumentsJson: string | null;
  summary: string | null;
  /** 执行中起表时刻（epoch ms）；onToolCallStart 时打表，参数增量重复到达不重置 */
  startedAtMs: number | null;
};
```

「在跑」判定：`summary == null && startedAtMs != null`（无需额外 Map）。乱序先到结果的 entry（`:75-78` 兜底分支）`startedAtMs` 为 null，不参与计时也不阻塞 ticker 停止判定。

### 4.3 工具行格式

| 场景 | 现有 | 改后 |
|---|---|---|
| shell 在跑，elapsed ≥ 1s | ``shell：`npm test`（执行中）`` | ``shell：`npm test`（执行中 · 3 秒）`` |
| 无 detail 工具在跑，elapsed ≥ 1s | `read_file：执行中…` | `read_file：执行中…（1 分 30 秒）` |
| elapsed < 1s（含工具刚开始的事件推送） | 同上 | **不变**（亚秒门控，与桌面 0.0.465 一致） |
| `startedAtMs == null`（乱序/恢复） | 同上 | 不变（不带耗时，不显示 0） |
| 已有 summary（已结束） | `name：摘要` | 不变 |

### 4.4 定时器生命周期

```
ensureTicker()  finished==true 或 ticker!=null → 直接返回
                否则 setInterval(tick, tickMs).unref()
tick()          if (finished || !hasRunningTool()) return
                this.queue('RUNNING', this.displayContent(), this.toolValues(now), this.round)
stopTicker()    clearInterval + ticker=null
```

挂载/卸载点：

| 时机 | 动作 |
|---|---|
| `onToolCallStart` | `ensureTicker()` |
| `onToolCallResult`（之后无在途工具） | `stopTicker()` |
| `onRoundEnd`（tools 清空后） | `stopTicker()` |
| `complete` / `cancel` / `fail` | `finished = true` + `stopTicker()` |
| `onError` | `finished = true` + `stopTicker()`（错误即终局，不再有在途工具） |

防泄漏双保险：`finished` 标志在 tick 回调里二次判断；`.unref()` 保证极端路径下不拖住 Node 进程退出。`finished` **只门控定时器，不门控 `update`**——`onError` 之后 handler 仍会走 `fail()` 推终态卡（`agent-inbound-handler.ts:369`），该路径必须畅通。

`now` 抽象为私有可注入函数（`private readonly now: () => number`，默认 `Date.now`），供 spec 用假定时器确定性地驱动 tick。

### 4.5 刷新粒度：为什么是 3s

飞书开放平台消息更新接口（`im.v1.message.patch`，`feishu-cards.ts:114`）限额约 5 QPS（以官方文档为准）。3s 一拍的负载测算：

| 同时在跑工具的会话数 | PATCH 频率 | 占限额 |
|---|---|---|
| 1 | 20 次/分 ≈ 0.33 QPS | 7% |
| 5（本部署典型上限） | 100 次/分 ≈ 1.7 QPS | 33% |
| 10 | 200 次/分 ≈ 3.3 QPS | 66%（接近，偶发限流可自愈） |
| 15+ | > 5 QPS | **超出，需降频** |

结论：3s 在本部署量级下安全；真正的上限是聚合 QPS，超出时限流表现为单拍 PATCH 失败（`safeUpdate` warn，下一拍自愈），不丢状态、不用户可见。故必须提供降频旋钮（§4.6）。若评审希望更保守，5s（0.2 QPS/会话）亦可，默认值一个常量的事。

### 4.6 配置旋钮

- `config/app-config.ts` 的 `feishu` 段新增 `bot.cardToolTickMs`，env `FEISHU_CARD_TOOL_TICK_MS`，默认 3000（与该段现有 `FEISHU_BOT_RECONCILE_INTERVAL_MS` 等同级风格）。
- 监听器构造参数 `tickMs?: number`（默认 3000）；**飞书两个构造点**（`agent-inbound-handler.ts:324`、`:750`）与**崩溃恢复装配点**（`app-lifecycle.ts:170-172`）传入配置值；钉钉两个构造点（`dingtalk/agent-inbound-handler.ts:304`、`:361`）用默认 3000。
- 测试注入小值（如 20ms）驱动 tick，无需真实等待。
- 降频操作：调大 env 即可（如 60000）；注意调大只能基本关闭实时刷新（事件驱动的推送在 elapsed ≥ 1s 时仍可能带一次耗时后缀），完全关闭需回滚代码。

## 5. 详细改动点（文件级）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `backend-ts/src/feishu/card-progress-listener.ts` | `ToolProgress` 加 `startedAtMs`；`onToolCallStart` 打表（保留 previous，参数增量不重置）；`formatToolLine` 加耗时后缀（≥1s 门控）；`toolValues(now)` 参数化；`ensureTicker/stopTicker/tick/hasRunningTool`；`finished` 标志；`now` 可注入；构造参数 `tickMs` | +90 / −10 |
| `backend-ts/src/config/app-config.ts` | `feishu.bot.cardToolTickMs` 字段 + env 解析（默认 3000，非法值回落默认） | +4 |
| `backend-ts/src/feishu/agent-inbound-handler.ts` | 两处 `new FeishuCardProgressListener(progress, roundOffset, tickMs)` | ±2 |
| `backend-ts/src/app-lifecycle.ts` | 崩溃恢复装配点传 `tickMs` | ±1 |
| `backend-ts/src/feishu/card-progress-listener.spec.ts` | 见 §8 | +70 |
| `CHANGELOG.md` | 新版本小节（前端无关，归「渠道」口径按仓库惯例） | +4 |

**明确不改**：`patched-progress.ts`（不碰 RUNNING 态 elapsedMs）、`progress-card.ts`（不改状态行）、`onToolCallResult` 推送时机、钉钉构造点。

## 6. 数据契约

- **数据库**：零变更（无表 / 列 / 索引）。
- **接口**：零变更（无 REST / WS 协议改动；卡片是同一张 `interactive` 消息的 PATCH，载荷结构不变，仅 `tools` 数组元素文案变长）。
- **卡片文案契约**（用户可见面）：

  ```
  改前：shell：`npm test`（执行中）
  改后：shell：`npm test`（执行中 · 3 秒）   → 每 3s 刷新 → （执行中 · 1 分 30 秒）
  ```

## 7. 边界与风险

### 7.1 聚合 QPS 与限流自愈

见 §4.5。超出时限流表现为单拍失败 + warn 日志，下一拍自愈；观测项：`飞书进度卡片更新失败` warn 是否增多（发布后观测 §9）。

### 7.2 定时器泄漏

所有正常出口（cancel/complete/fail/onError）都 `stopTicker()` + `finished` 门控 + `.unref()` 双保险。handler 对 cardListener 的三终态调用已覆盖所有正常路径（`agent-inbound-handler.ts:352/359/369` 与 `:774/781/789`）；即使出现未覆盖的异常路径，tick 回调自身也会在无在途工具时静默返回，最坏情况是一个空转 interval（unref，不拖进程），不会产生错误推送。

### 7.3 钉钉卡片同源变化

`FeishuCardProgressListener` 是飞书与钉钉**共用**的类（`dingtalk/agent-inbound-handler.ts:2` 引用），本改动使钉钉进度卡的「执行中」同样带耗时并按 3s 刷新（钉钉 `update` 走自己的卡 API）。这是附带收益，但属于行为变化，需评审确认；若钉钉侧限额更严格，构造参数已支持给钉钉传更大间隔，无需改类。

### 7.4 崩溃恢复期计时丢失

恢复路径（`app-lifecycle.ts:170-172`）重建 listener，内存态 tools 丢失；在途工具按恢复后重新收到的 `onToolCallStart` 起表，恢复前已执行的耗时不计入。与 WS registry `started_at` 同为内存态口径（重启即丢），且 RESUMING 期间卡片展示的是「任务正在恢复执行」，用户可理解。**接受，不补追认。**

### 7.5 与既有事件推送的叠加

`onToolCallArgsDelta` 的推送若发生在 elapsed ≥ 1s 时会天然带上耗时后缀——这是正确行为（读数是新鲜的），无需特殊处理。3s tick 与事件推送经同一 `queue()` 链串行，经同一 250ms 节流，无排队堆积（3s ≫ 250ms）。

### 7.6 卡片刷新观感

PATCH 为原地更新，不产生新消息、不触发用户通知（与现有每次工具开始即刷新的行为一致，只是频率高一些）。

## 8. 测试计划

单元测试全部落在 `card-progress-listener.spec.ts`（沿用现有模式：收集 `updates`、假定时器、`await sleep(0)` 排空队列）：

| # | 用例 | 断言 |
|---|---|---|
| 1 | 工具在跑，跨过 tick 间隔 | tools 行出现 `（执行中 · 3 秒）`，再跨一拍变 `6 秒` |
| 2 | 工具结束后（result 到达） | 继续推进时间不再产生 RUNNING 推送（ticker 已停） |
| 3 | 无工具运行（仅 round/content 事件） | 不挂 ticker，推进时间无额外推送 |
| 4 | `complete` / `cancel` / `fail` 后 | 推进时间无 RUNNING 推送（ticker 清除、finished 门控） |
| 5 | 并行两个工具 | 两行各自计时（不同 startedAtMs → 不同耗时文案） |
| 6 | elapsed < 1s 的事件推送（工具刚开始） | 工具行不带耗时后缀（亚秒门控） |
| 7 | 结果先于开始到达（乱序 entry，`startedAtMs=null`） | 工具行不带耗时，且不阻塞 ticker 停止 |
| 8 | tickMs 可注入 | 传 20ms 快速驱动，验证频率与间隔参数一致 |
| 9 | 更新失败不影响 ticker | `update` 抛错时后续 tick 继续（safeUpdate 已吞，补一条防回归） |
| 10 | 回归 | 现有 20+ 用例全绿（含乱序结果、carriedContent、恢复轮次偏移） |

**回归命令**：`cd backend-ts && npm run build && npm test`。

## 9. 发布与回滚

- 纯后端改动，走常规后端部署（`/opt/mao` pull + 重启）；零 DB 变更、无数据修复。
- **回滚**：回退后端镜像即可；或先调大 `FEISHU_CARD_TICK_MS`（如 60000）基本关闭实时刷新（残留：事件推送在 ≥1s 时可能带一次耗时后缀），完全回到改前需回滚代码。
- 发布后观测：
  - `飞书进度卡片更新失败` warn 量（判断是否触碰限额）；
  - 飞书消息 PATCH 调用量（预期：仅在有工具在跑的会话期间 ~20 次/分/会话）；
  - 卡片终态与轮次推进是否正常（回归验证）；
  - 钉钉群卡片同样带耗时刷新的用户反馈。

## 10. 工作量拆解与实施顺序

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0-1 | listener 改动（打表 + 文案 + ticker + finished + now 注入） | 0.2 人日 |
| P0-2 | spec 十个用例 + 全量回归 | 0.2 人日 |
| P0-3 | app-config 旋钮 + 三处装配点传参 + 联调自测（真实飞书群跑一个 90s 工具验证刷新） | 0.1 人日 |
| **合计** | | **≈0.5 人日** |

实施顺序：P0-1 → P0-2 → P0-3。P0-3 的联调必须覆盖：并行工具、90s+ 长工具跨多拍、工具结束后停 tick、终态卡不带执行中耗时。

## 11. 决策记录（2026-11-08 已全部确认，按建议项实施）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 刷新间隔 | **默认 3000ms**，`FEISHU_CARD_TOOL_TICK_MS` 可调（需求方确认 3s；§4.5 有测算） |
| 2 | 亚秒门控 | **与桌面端一致，< 1s 不显示** |
| 3 | 已完成工具摘要行带耗时？ | **不做**（与桌面端口径一致，摘要保持结果语义） |
| 4 | 状态行执行级总耗时（「第 N 轮 · 已运行 X」）？ | **本期不做**；需放行 RUNNING 态 `elapsedMs` 并重写「过期读数」守卫，牵动 `patched-progress.ts` + `progress-card.ts`，且与轮次信息竞争。列为后续独立项 |
| 5 | 钉钉间隔 | **共用默认 3000**；构造参数已支持后续分离，不做配置分离 |
| 6 | 崩溃恢复期追认历史耗时？ | **不做**（§7.4，内存态口径，RESUMING 有专门文案） |
| 7 | env 落点 | **app-config `feishu` 段**（`FEISHU_CARD_TOOL_TICK_MS`），不在监听器里裸读 env |
