# 用量预算（budget）

## 模块职责

管理用量预算：按**全局 / 用户 / Agent** 三个维度设**月度**预算，口径可选**金额（成本单位）**或 **token 数**，超额动作为**提醒（WARN）**或**拦截（BLOCK）**。对应管理后台「用量预算」页（`budget:read` 查看 / `budget:write` 增改删）。

预算不是计费：账来自模型价格（每百万 token 成本单位，见 [model.md](model.md)）与 `llm_call` 的成本快照，预算只是拿这个账去比对上限。

## 关键口径

| 项 | 说明 |
|----|------|
| 周期 | 自然月，按**服务器本地时区**每月 1 日 00:00 起算；跨月自动翻篇，不做手工结转 |
| 维度 | `GLOBAL` 整站（无视 `scope-id`，且全局只允许一条）；`USER` 按用户；`AGENT` 按 Agent |
| 口径 | `COST` 金额；`TOKENS` token 数（输入 + 输出，缓存命中按 5 折计的那套口径） |
| 检查顺序 | 同一时刻可能命中多条预算，按 `GLOBAL → USER → AGENT` 依次比对，先命中先生效 |
| 价格缺失 | 模型未填价格时该次调用成本为 NULL，`COST` 口径不计入（不按 0 计），因此不可能因"没配价格"误触发 |
| 停用 / 删除 | `enabled=0` 或被删除的预算行直接跳过，不参与判定；已删除的目标在列表里仍显示为「已删除」 |

### WARN 与 BLOCK 的区别

| 动作 | 触发时机 | 效果 |
|------|----------|------|
| `WARN` | 任务**跑完后**结算（终态时比对当期累计） | 给属主写一条 `BUDGET_WARN` 站内信；同一预算同一自然月只提醒一次，不会每轮任务刷屏 |
| `BLOCK` | 任务**发起前**准入判定 | 直接拒绝发起新任务：返回明确错误、不写入用户消息；同时给属主写一条 `BUDGET_WARN` 说明原因（同预算同月只写一次）。BLOCK 与 WARN 互不干扰，可同时存在 |

BLOCK 的准入点有 5 个：WebSocket 手动发送、消息编辑重发、排队消息自动消费、定时任务直接执行、开放 API / 入站 Webhook 触发。子代理与边路任务跟随主会话的判定结果（不单独判）。被拦截的排队消息会重新入队并通知一次；被拦截的定时任务标记为失败，但不影响下一档期照常执行。

## 命令选择

| 场景 | 命令 |
|------|------|
| 查看全部预算与当期消耗 | `budget list` |
| 新建预算 | `budget create` |
| 改口径 / 上限 / 动作 / 启停 | `budget update` |
| 删除预算 | `budget delete` |

---

## 命令：mao budget list

### 用途

列出全部预算行，含当期已用与上限。需 `budget:read`。

返回字段：`id`、`scope`（GLOBAL / USER / AGENT）、`scopeId`、`period`（固定 `MONTHLY`）、`limitType`（COST / TOKENS）、`limitValue`（微单位整数：COST = 成本×1e6，TOKENS = token 原值）、`action`（WARN / BLOCK）、`enabled`、`targetName`（目标名，已删除的目标为 null）、`periodSpend`（当期累计；查询失败时为 null，`COST` 为成本单位、`TOKENS` 为 token 原值）。

注意展示时的两套单位：`COST` 的 `limitValue` 是微单位（除以 1e6 才是成本单位），而 `periodSpend` 已经是成本单位，直接相除会把进度算小 100 万倍。

### 示例

```bash
mao budget list --json
```

---

## 命令：mao budget create

### 用途

新建月度预算。需 `budget:write`。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--scope` | 是 | `GLOBAL` / `USER` / `AGENT` |
| `--scope-id` | USER / AGENT 必填 | 目标用户 / Agent id；`GLOBAL` 忽略该值 |
| `--limit-type` | 是 | `COST` / `TOKENS` |
| `--limit-value` | 是 | 上限。`COST` 填**成本单位**（如 `100` 表示 100），CLI 换算成微单位整数；`TOKENS` 填 token 原值。上限 999999.999999（成本单位）/ 9007199254740991（token），小数位最多 6 位，超范围 CLI 直接报错而非提交 |
| `--action` | 是 | `WARN` / `BLOCK` |
| `--enabled` | 否 | `0` / `1`，默认 1 |

约束：`GLOBAL` 全局仅允许一条（重复创建被拒）；`USER` / `AGENT` 必须带正整数 `scope-id`；`limit-value` 必须换算后为正整数。

### 示例

```bash
# 全站每月 500 成本单位，超额直接拦截新任务
mao budget create --scope GLOBAL --limit-type COST --limit-value 500 --action BLOCK

# 用户 7 每月 2000 万 token，超额只提醒
mao budget create --scope USER --scope-id 7 --limit-type TOKENS --limit-value 20000000 --action WARN
```

---

## 命令：mao budget update

### 用途

按 id 修改预算。需 `budget:write`。**部分更新**：未传的字段沿用该预算当前值，CLI 会先拉取当前行再合并提交（后端 PUT 是全量替换语义，所以必须整行发）。

| 参数 | 必填 | 说明 |
|------|------|------|
| `--id` | 是 | 预算 id |
| `--scope` / `--scope-id` / `--limit-type` / `--action` | 否 | 同 create |
| `--limit-value` | 否 | 同 create；换算口径跟随**改后**的 `limit-type`，未显式改 `--limit-type` 时沿用该预算当前口径 |
| `--enabled` | 否 | `0` / `1` |

只改上限时不带 `--limit-type` 也能安全工作：CLI 按该行当前的 `COST` / `TOKENS` 口径换算，不会把成本单位误当成 token。

### 示例

```bash
mao budget update --id 1 --action WARN --enabled 0
mao budget update --id 1 --limit-type COST --limit-value 800
```

---

## 命令：mao budget delete

### 用途

删除预算行。需 `budget:write`。删除后立即不参与判定，无法恢复（需重建）。

### 示例

```bash
mao budget delete --id 1
```

---

## 使用问答

**为什么当月没到上限就被拦了？**
先看 `budget list` 的 `scope` 与 `scopeId`，很可能命中的是 GLOBAL 或 Agent 维度那条，而不是你以为的用户维度那条。命中多条时按 GLOBAL → USER → AGENT 依次生效，任一 BLOCK 命中即拒。

**刚把上限调高，为什么还拦着？**
当期累计消耗已经越过新上限时依旧拦截——预算比对的是当期累计，不是"从这一刻起再算"。

**改了模型价格，成本会变吗？**
价格在每次 LLM 调用写入时快照，改价只影响之后的调用，历史 `llm_call` 的成本不回填。因此当期消耗里可能同时存在新旧两种价格算出来的数。

**提示词压缩用的模型能单独配便宜模型省钱吗？**
能，系统设置里的「压缩模型」（`compaction.modelId`）就是干这个的，缺省用会话主模型。压缩是长任务里 token 量最大的辅助调用，配便宜模型收益最直接。详见 [settings.md](settings.md)。
