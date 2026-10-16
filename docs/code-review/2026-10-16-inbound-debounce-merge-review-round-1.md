# 代码审查：IM 入站消息防抖合并（飞书/钉钉/微信 1 秒窗口，commit 930c7196）— 2 个经测试验证的功能 BUG

- **日期**：2026-10-16
- **基线**：分支 `feat/inbound-debounce-merge` @ `930c7196`（父提交 `196c0263`），工作区干净；本审查仅新增 2 个临时存在性证明测试文件（`*.tmp.spec.ts`，验证后已删除），未改动任何产品代码与既有测试
- **范围**：`git diff 196c0263..HEAD` 全部 18 个文件中的代码部分（`backend-ts/src/common/inbound-merge-window.ts` 新增；`feishu/inbound-processor.ts`、`dingtalk/{inbound-processor,message.service,runtime}.ts`、`weixin/inbound-processor.ts`、`weixin/types.ts`、`config/app-config.ts`、`create-app.ts` 改动；其余为 spec / CHANGELOG / skills 文档，按审查要求不评）
- **方法**：通读设计方案 `docs/plan/2026-10-16-inbound-debounce-merge-technical-design.md` + 逐文件通读改动 + 对提示的风险点（flush 幂等/并发、arrivalSeq 排序、先批后豁免、正文合并边界、absorbed keys 心跳与成败标记、停机 flushAll 时序、windowMs=0 回退、配置默认值）逐条构造对抗用例；每条候选必须满足「合法输入即可触发、输出确定错误、有可运行测试证明」，无法构造确定性失败测试的候选一律不列为 bug（排除清单见 §5）
- **测试证据**：
  - 指定命令 `cd backend-ts && npx vitest run src/common/inbound-merge-window.spec.ts src/feishu/inbound-processor.spec.ts src/dingtalk src/weixin/inbound-processor-window.spec.ts` → **12 files / 126 tests 全 passed**（无存量回归）
  - 全量 `cd backend-ts && npm test` → **336 passed + 1 skipped files，4135 passed + 13 skipped tests**；`npm run build`（tsc）通过
  - 本审查新增的 2 个 bugcheck 文件（`src/feishu/review-probe.tmp.spec.ts`、`src/config/review-probe.tmp.spec.ts`）→ **4 failed + 3 passed**：4 条失败即下述 2 个 bug 的存在性证明，3 条通过为对照组（证明失败不是测试写法问题）

---

## 1. 结论表

| 编号 | 严重度 | 位置 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 中 | `backend-ts/src/create-app.ts` L546-552（ECP 绑定完成重放）、L3071（启动恢复重放） | 两条飞书「待绑定消息补投」路径漏传 `{ bypassWindow: true }`：补投消息进合并窗口，被拖延至多一个窗口期（默认 1s），并会与绑定成功后同一发送者的追问合并成一次触发；同任务的另外两条补投路径（L515 飞书 OAuth、钉钉 `runtime.ts` L474）都已显式绕开窗口并在注释里写明原因 |
| BUG-2 | 低 | `backend-ts/src/config/app-config.ts`（`coerceTypes` 无微信分支）；文档见 `skills/mao-cli/reference/config.md` L153、方案 §6.5 | 本次新增并文档化的微信窗口环境变量 `WEIXIN_BOT_MERGE_WINDOW_MS`（方案里写作 `WEIXIN_MERGE_WINDOW_MS`）没有任何接线：`coerceTypes` 只接了飞书/钉钉两个变量，YAML 也无占位符，运维按文档设环境变量关闭微信合并完全无效 |

---

## 2. BUG-1 详述：飞书待绑定消息重放未绕开合并窗口

### 2.1 文件:行号

- **主缺陷 1（用户可感知）**：`backend-ts/src/create-app.ts` L546-552——`completeFeishuPendingAfterEcp` 的 `replay` 回调调用 `pendingBindingProcessor.process(String(pending.appId), { ...pending.event, progressCardMessageId: pending.cardMessageId }, true)`，**未传第 4 个参数 `{ bypassWindow: true }`**。该回调是 ECP 登录成功后的绑定完成入口（`EcpAuthService` 构造参数，L528-560），即用户在飞书点「点我绑定」卡片、完成 ECP 登录后原消息的重放路径
- **主缺陷 2（同类遗漏，影响较轻）**：`backend-ts/src/create-app.ts` L3071——启动时 `pendingBindingMessages.listRecoverable()` 恢复扫描的补投，同样未传 `{ bypassWindow: true }`
- **已修对照**：`backend-ts/src/create-app.ts` L515（飞书 OAuth 绑定完成）与 `backend-ts/src/dingtalk/runtime.ts` L474（钉钉 OAuth 绑定完成）都在本次提交中补上了 `{ bypassWindow: true }`，且 L514/L473 留有注释：「绑定后补投绕开合并窗口：用户等的是这条消息的即时响应，不能被窗口期拖延。」——ECP 路径与启动恢复路径是被漏掉的同款调用点
- **窗口开启处**：`backend-ts/src/create-app.ts` L2473-2475（`feishuInboundProcessor` 注入 `mergeWindowMs: cfg.feishu.bot.mergeWindowMs`，默认 1000）；`pendingBindingProcessor = feishuInboundProcessor`（L2597，同一实例），因此补投与正常入站共用同一个窗口
- **被拖延的实现位置**：`backend-ts/src/feishu/inbound-processor.ts` L125-137（`process` 无 `bypassWindow` 时走 `window.submit`）、`backend-ts/src/common/inbound-merge-window.ts` L47-68（joinable 消息入缓冲 + 首条启动定时器，flush 要等 `windowMs`）

### 2.2 触发条件（默认配置即可触发，无需特殊输入）

1. 飞书通道开启 ECP 鉴权（`feishuUnauthorizedGuide` 在 ecpEnabled 时一律返回 ECP 引导卡片，是本配置下的主绑定流程）
2. 未绑定用户给机器人发一条会触发的消息（如 p2p 文本「帮我看下这份报告」）→ 落入待绑定表，用户收到绑定卡片
3. 用户点卡片完成 ECP 登录 → `completeFeishuPendingAfterEcp` → `replay` → `process(..., true)` → 消息进入合并窗口缓冲
4. **结果 A（必然）**：`handler.onMessage` 不在 `replay` 返回前调用，而是被挂起至多 `mergeWindowMs`（默认 1000ms）后才触发——用户刚完成绑定、正在等响应，进度卡/回复整体晚 1s
5. **结果 B（高概率）**：这 1s 内用户自然跟进一句（绑定成功后马上追问，或重复原问题），两条消息同键同发送者 → 合并为**一次** `onMessage`，追问被并进原消息的正文，且 `messageId`/进度卡归属取重放的首条；重启恢复路径（L3071）更会把同一用户多条待恢复消息合并成一条任务

### 2.3 复现方式（测试用例）

- **文件**：`backend-ts/src/feishu/review-probe.tmp.spec.ts`（本次审查新增，验证后删除）。用真实 `FeishuInboundProcessor`（`mergeWindowMs: 50`，仅缩短用例时长）+ 真实 `completeFeishuPendingAfterEcp`，`replay` 回调逐行复刻 `create-app.ts` L546-552 的装配；另设一条逐行复刻 L515（带 `bypassWindow`）的对照组
- **命令**：

```bash
cd backend-ts && npx vitest run src/feishu/review-probe.tmp.spec.ts src/config/review-probe.tmp.spec.ts
```

- **当前结果**：`Test Files 2 failed (2)` / `Tests 4 failed | 3 passed (7)`。与 BUG-1 相关的 3 条：

```
FAIL  src/feishu/review-probe.tmp.spec.ts > ... ECP 重放（create-app.ts:547）绑定完成即触发，不被窗口拖延
AssertionError: expected "spy" to be called 1 times, but got 0 times
 ❯ review-probe.tmp.spec.ts:76:23
     76|     expect(onMessage).toHaveBeenCalledTimes(1);

FAIL  src/feishu/review-probe.tmp.spec.ts > ... ECP 重放不与绑定后同一发送者的追问合并（各触发一次）
AssertionError: expected "spy" to be called 2 times, but got 1 times
 ❯ review-probe.tmp.spec.ts:96:23
     96|     expect(onMessage).toHaveBeenCalledTimes(2);
```

（`completeFeishuPendingAfterEcp` 已返回 `'replayed'`、`complete(state)` 已执行，但 `onMessage` 0 次——补投被挂在窗口里；追问后仅 1 次触发——两条被合并。对照组「飞书 OAuth 重放（create-app.ts:515）绑定完成即触发」**passed**，证明测试写法无误、差异只在漏传的 `bypassWindow`。）

- **合并行为的实测绘观测**（同文件「观察」用例，**passed**，记录实际输出）：ECP 重放「帮我看下这份报告」+ 绑定后追问「对了，还有第二份」→ `onMessage` 仅 1 次，`text === '帮我看下这份报告\n\n对了，还有第二份'`，`messageId === 'om_pending'`（重放的首条）

- **测试代码**（关键两段，完整文件见审查记录）：

```ts
/** 复刻 create-app.ts:546-552 的 ECP 绑定完成重放装配（未传 bypassWindow）。 */
function ecpReplayWiring(processor: FeishuInboundProcessor) {
  return async (p: { appId: number; event: FeishuNormalizedMessage; cardMessageId?: string | null }) => {
    await processor.process(String(p.appId), { ...p.event, progressCardMessageId: p.cardMessageId }, true);
  };
}

it('ECP 重放（create-app.ts:547）绑定完成即触发，不被窗口拖延', async () => {
  const onMessage = vi.fn(async () => ({ text: 'r' }));
  const processor = new FeishuInboundProcessor(makeHandler(onMessage), { mergeWindowMs: 50 });
  const result = await completeFeishuPendingAfterEcp({
    state: 'st-1', ecpUserId: 7,
    claim: async () => pending(),                       // { appId: 1, event: p2p 文本「帮我看下这份报告」, cardMessageId: 'card-1' }
    findUserIdByUnionId: async () => null,
    bind: async () => undefined,
    replay: ecpReplayWiring(processor),
    complete: async () => undefined,
    release: async () => undefined,
    failClaimed: async () => undefined,
  });
  expect(result).toBe('replayed');
  expect(onMessage).toHaveBeenCalledTimes(1);           // ← 实际 0 次
  expect(onMessage.mock.calls[0][0].text).toBe('帮我看下这份报告');
});

it('ECP 重放不与绑定后同一发送者的追问合并（各触发一次）', async () => {
  /* 同上装配；replay 后立即： */
  await processor.process('1', makeEvent({ messageId: 'om_follow', text: '对了，还有第二份' }));
  await wait(200);
  expect(onMessage).toHaveBeenCalledTimes(2);           // ← 实际 1 次（已合并）
  expect(onMessage.mock.calls[0][0].text).toBe('帮我看下这份报告');
  expect(onMessage.mock.calls[1][0].text).toBe('对了，还有第二份');
});
```

### 2.4 预期行为 vs 实际行为

- **预期**（本提交自己在 L514/L473 注释里写下的契约）：绑定后补投绕开合并窗口，`replay` 返回即已触发；补投消息不与窗口内的其它消息合并；启动恢复扫描同样即时逐条补投
- **实际**：ECP 绑定完成路径与启动恢复路径的补投进窗——触发被拖延至多一个窗口期；窗口期内同一发送者的追问/其它待恢复消息与补投合并为一次触发（合并正文、`messageId` 取首条）；`pendingBindingMessages.complete(state)` 已在补投「提交」后即执行，若此期间进程退出，该消息既不在窗口 flush 计划内也不再处于 PENDING/SENT 可恢复态（`listRecoverable` 只收特定状态），相比绕窗路径更容易丢失

### 2.5 为什么是功能错误

1. **直接违背本次提交自己确立的契约**：同一提交给另外两条补投路径加了 `bypassWindow` 并注明原因，ECP 路径是 ECP 开启时的主绑定流程（`feishuUnauthorizedGuide` 对 ecpEnabled 一律走 ECP 卡片），漏改使「飞书 OAuth 用户无感、ECP 用户每次绑定都晚 1s」——同类用户行为不一致
2. **合并补投会改变任务语义**：补投消息携带 `progressCardMessageId`（未绑定时下发的卡片），设计意图是「原消息即时重放、进度回写到原卡」；与追问合并后追问内容并进原消息正文、进度卡归属重放首条，用户在会话历史里看到一条把两个问题粘在一起的 USER 消息
3. **与「先批后豁免」的保序目标叠加后更混乱**：补投若落在别人（同键）的在途批次之后，还会再等一个窗口期

### 2.6 严重级别

**中**——默认配置（1000ms）下 ECP 绑定完成这一主路径必然被拖延 ~1s 且高概率发生合并；不丢数据（最坏情况内容并成一条）、可自行恢复，但属确定性的用户可感知错误，且与同提交内已修路径明显不一致。

### 2.7 修复方向（仅供修复参考，本次未动手）

- `create-app.ts` L547-551 的 `process(...)` 调用补第 4 参 `{ bypassWindow: true }`（与 L515 对齐）；L3071 启动恢复同样补齐
- 建议同时排查是否还有第三方形如「重放/补投」语义的 `process` 调用点（本次审查已穷尽 `grep`：飞书仅 L515/L547/L3071 三处，钉钉仅 `runtime.ts` L474 一处）

---

## 3. BUG-2 详述：微信合并窗口环境变量未接线

### 3.1 文件:行号

- **主缺陷**：`backend-ts/src/config/app-config.ts` `coerceTypes()`（L397 起）只新增了两行环境变量接线——L450 `cfg.dingtalk.mergeWindowMs = n(process.env.DINGTALK_BOT_MERGE_WINDOW_MS ?? ...)`、L462 `cfg.feishu.bot.mergeWindowMs = n(process.env.FEISHU_BOT_MERGE_WINDOW_MS ?? ...)`；**微信无对应行**，`cfg.weixin.bot.mergeWindowMs` 只来自 `DEFAULTS`（L297，1000）与 YAML 合并
- **文档承诺（本次提交新增）**：`skills/mao-cli/reference/config.md` L153 写明「`WEIXIN_BOT_MERGE_WINDOW_MS`（默认 1000）……设为 0 关闭合并，重启后端生效」；设计方案 `docs/plan/2026-10-16-inbound-debounce-merge-technical-design.md` §6.5 配置表列的是 `WEIXIN_MERGE_WINDOW_MS`
- **YAML 也无占位符**：`backend-ts/config/application.yml` L98-100 微信段只有 `enabled: ${WEIXIN_BOT_ENABLED:true}` 等，无 `merge-window-ms` 键（微信现有配置项全部靠 YAML 占位符接环境变量，`app-config.ts` 从不接 `WEIXIN_*`）
- **消费处**：`backend-ts/src/create-app.ts` L859 `mergeWindowMs: cfg.weixin.bot.mergeWindowMs` → `weixin/types.ts` L35 默认 1000

### 3.2 触发条件

运维按本次提交的文档（或方案）设置 `WEIXIN_BOT_MERGE_WINDOW_MS=0`（或 `WEIXIN_MERGE_WINDOW_MS=0`）期望关闭微信合并并重启后端 → 配置值仍是 1000，合并行为不变。两个变量名都不生效。

### 3.3 复现方式（测试用例）

- **文件**：`backend-ts/src/config/review-probe.tmp.spec.ts`（本次审查新增，验证后删除）。`vi.resetModules()` + 动态 `import('./app-config.js')` 绕过 `loadConfig` 模块级缓存；设环境变量后断言 `cfg.*.mergeWindowMs`
- **命令**：同上（与 BUG-1 的探针一起跑）
- **当前结果**（对照组 passed，两条微信用例 failed）：

```
✓ review probe：入站合并窗口环境变量接线 > 对照组：FEISHU_BOT_MERGE_WINDOW_MS / DINGTALK_BOT_MERGE_WINDOW_MS 生效
× review probe：入站合并窗口环境变量接线 > WEIXIN_BOT_MERGE_WINDOW_MS 生效（skills/mao-cli/reference/config.md 已文档化该变量）
× review probe：入站合并窗口环境变量接线 > WEIXIN_MERGE_WINDOW_MS 生效（技术方案 §6.5 配置表中的变量名）

FAIL  src/config/review-probe.tmp.spec.ts > ... WEIXIN_BOT_MERGE_WINDOW_MS 生效
AssertionError: expected 1000 to be +0 // Object.is equality
 ❯ review-probe.tmp.spec.ts:19:42
     19|     expect(cfg.weixin.bot.mergeWindowMs).toBe(0);

FAIL  src/config/review-probe.tmp.spec.ts > ... WEIXIN_MERGE_WINDOW_MS 生效
AssertionError: expected 1000 to be +0 // Object.is equality
 ❯ review-probe.tmp.spec.ts:27:42
     27|     expect(cfg.weixin.bot.mergeWindowMs).toBe(0);
```

- **测试代码**：

```ts
it('WEIXIN_BOT_MERGE_WINDOW_MS 生效（skills/mao-cli/reference/config.md 已文档化该变量）', async () => {
  vi.resetModules();
  process.env.WEIXIN_BOT_MERGE_WINDOW_MS = '0';
  const { loadConfig } = await import('./app-config.js');
  const cfg = loadConfig();
  expect(cfg.weixin.bot.mergeWindowMs).toBe(0);   // ← 实际 1000
});

it('WEIXIN_MERGE_WINDOW_MS 生效（技术方案 §6.5 配置表中的变量名）', async () => {
  vi.resetModules();
  process.env.WEIXIN_MERGE_WINDOW_MS = '0';
  const { loadConfig } = await import('./app-config.js');
  const cfg = loadConfig();
  expect(cfg.weixin.bot.mergeWindowMs).toBe(0);   // ← 实际 1000
});
```

### 3.4 预期行为 vs 实际行为

- **预期**：与飞书/钉钉对称——文档声明的环境变量可关闭微信合并窗口（回滚开关，方案 D7「开关即配置」对三端一致）
- **实际**：变量被静默忽略；关闭微信合并只能改 `backend-ts/config/application.yml` 增补 `merge-window-ms` 键（该键目前也不存在，同样要新增）。运维按文档操作会得到「配了却没效果」的静默失败

### 3.5 为什么是功能错误

合并窗口给三端都引入了「所有触发消息统一 +1s」这一用户可见行为变化（方案 §10.1 自认的代价），因此「可一键关窗」是本次需求明确的回滚诉求（D7、方案 §6.5 配置表、文档三处）。飞书/钉钉的开关可用，微信的开关不存在——不是文档笔误单方面问题，而是代码接线缺失导致文档承诺落空。

### 3.6 严重级别

**低**——不产生错误输出、不丢消息，仅回滚/调参能力缺失；但直接违反方案 D7 与本次提交自己写入的文档。

### 3.7 修复方向（仅供修复参考，本次未动手）

- 任选其一并保证文档变量名与代码一致：在 `app-config.ts` `coerceTypes` 增加 `cfg.weixin.bot.mergeWindowMs = n(process.env.WEIXIN_BOT_MERGE_WINDOW_MS ?? cfg.weixin.bot.mergeWindowMs, 1000)`；或在 `backend-ts/config/application.yml` 微信段增加 `merge-window-ms: ${WEIXIN_BOT_MERGE_WINDOW_MS:1000}`（与既有微信配置项风格一致）。若保留方案里的 `WEIXIN_MERGE_WINDOW_MS` 名称，需同步修正 `config.md` L153

---

## 4. 测试与构建证据汇总

| 命令 | 结果 |
| --- | --- |
| `cd backend-ts && npx vitest run src/common/inbound-merge-window.spec.ts src/feishu/inbound-processor.spec.ts src/dingtalk src/weixin/inbound-processor-window.spec.ts` | `Test Files 12 passed (12)` / `Tests 126 passed (126)` |
| `cd backend-ts && npm test`（全量） | `Test Files 336 passed \| 1 skipped (337)` / `Tests 4135 passed \| 13 skipped (4148)` |
| `cd backend-ts && npm run build`（tsc） | exit=0 |
| `cd backend-ts && npx vitest run src/feishu/review-probe.tmp.spec.ts src/config/review-probe.tmp.spec.ts`（本审查临时探针，已删除） | `Tests 4 failed \| 3 passed (7)`——4 条失败即 BUG-1×2 / BUG-2×2 的存在性证明，3 条通过为对照组 |

---

## 5. 已审查、有测试或推理支撑、但未列为 bug 的候选（排除清单）

1. **共享窗口 flush 幂等/并发**（`inbound-merge-window.ts` L80-110）：`takeBatch` 在同步段取走缓冲并清空，定时器回调与豁免冲刷竞争只可能执行一次；`lastStarted` 使空缓冲时的豁免路径等到刚启动的 flush；`inFlight`/`maybeCleanup` 不会误删有新条目的状态。既有 spec 13 条全覆盖，未构造出失败用例
2. **arrivalSeq 排序**：飞书/钉钉在 `process()` 入口同步分配（`inbound-processor.ts` L129 / L70），批内 `takeBatch` 按 seq 排序；微信在 monitor 路径（`knownKey` 恒非空）同样无 await 前置，`monitor.service.ts` L139-142 的 for 循环同步 submit。未构造出乱序用例
3. **豁免消息与批次「先批后豁免」**：豁免路径 `await flushKey` 等到批次 `onFlush` 启动（组件 L104 `resolveStarted()`）后才触发自己，既有 spec 对飞书/钉钉/微信均有「慢批次不阻塞豁免」用例。注意：该契约按设计只保证「启动」有序（组件 L6-8 注释明示），群聊路径内部 `onMessage` 的最终先后受 `flushPendingEnrichments` DB 竞态影响，属方案已接受的取舍，未列为 bug
4. **钉钉/微信正文合并边界**：空正文过滤 + `|| first.event.text` 回落、微信单条原样返回（`mergeMessages` L151）、空批合并后被 `processClaimed` 忽略并整批 markDone，均有既有用例且行为与加窗前一致
5. **微信 absorbed keys 心跳与成败整批标记**：`flushEntries` 对批内全部 key 起停心跳（L126/L139），成功整批 `markDone`、失败整批 `markFailed`（L130/L136，且 `markFailed` SQL 带 `status='CLAIMED'` 守卫，不会把已 DONE 行打回造成重放双跑）；既有 spec 含「慢任务期间两 key 均心跳」「失败整批 markFailed」用例
6. **停机 flushAll 时序与微信不 flush**：`create-app.ts` L3213-3221 先停三端 monitor/handler 再 `flushAll`（飞书/钉钉）后 `settleInFlightExecutions`；微信按方案 §6.6/D8 留在认领表由重放器兜底，注释与实现一致
7. **windowMs=0 恒等回退**：三端 spec 均有「0 时立即单条触发、无合并」用例；`n()` 对非有限值回落默认 1000，负值等价关闭（`windowMs > 0` 判断）
8. **`dingtalk/message.service.ts` `buildGroupContext` 签名扩展**（单 messageId → 数组）：唯一调用方已同改；`row.messageId == null` 分支与原 `!==` 语义等价；`message.service.spec.ts` 两条用例（含新的「排除批内全部」）通过

---

## 6. 复现测试清理说明

本审查使用的 `backend-ts/src/feishu/review-probe.tmp.spec.ts` 与 `backend-ts/src/config/review-probe.tmp.spec.ts` 为临时存在性证明文件，已在报告完成后删除；未提交、未遗留。修复 BUG-1/BUG-2 时可按 §2.3 / §3.3 的代码重建（建议作为回归用例并入各自 spec，断言按「正确行为」书写）。
