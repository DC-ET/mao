---
name: bigdata-cli
description: 使用 bigdata-cli 通过 bd.acg.team 网关调用大数据接口，并自动处理 SSO token，以完成 Hive 元数据检索、SQL 解析、Impala 查询执行和 gatekeeper 自助取数。
---

# bigdata-cli

当用户或 Agent 需要围绕内部大数据平台完成“找表 -> 查元数据 -> 解析 SQL -> 执行查询”“基于 gatekeeper 自助取数模型做查询/导出”或“查指标定义与口径详情”时，使用这个 Skill。

## 前置准备
使用此 Skill 前，需要先安装 bigdata-cli。安装方式如下：
```bash
# 进入 skills/bigdata-cli 目录
cd skills/bigdata-cli
# 安装 bigdata-cli
npm install . -g
```

## 触发条件

- 用户想根据业务需求找到相关 Hive 表。
- 用户需要查看某张表的字段、描述、更新时间、分区等信息。
- 用户已经有 SQL，希望先解析输入输出表。
- 用户需要执行一段 Impala SQL 做快速验证。
- 用户需要查看自助取数模型列表、详情、字段、参数或枚举。
- 用户需要基于自助取数模型执行查询或导出 Excel。
- 用户需要搜索指标定义、查看指标口径、公式、相关库表、维度或负责人。

## 不适用场景

- 需要由后端直接把自然语言生成 SQL。
  这里应由 AiAgent 基于元数据自行生成 SQL，`bigdata-cli` 只提供必要工具。
- 需要一次性导出超大结果集。
  `sql run` 依赖的后端接口会限制结果不超过 500 行。

## 全局命令选择规则

- 如果还不知道表名，先用 `meta search`；需要从 DataHub 侧补充查表时，再用 `datahub search`。
- 如果已经知道 `db.table` 或元数据 ID，优先用 `meta detail`、`meta columns`、`meta main-info`、`meta partitions`。
- 在执行 SQL 前，先用 `sql parse-tables` 解析输入输出表，做一次自检。
- 需要真正跑查询时，再用 `sql run`。
- 如果需求是自助取数，先判断是“我的可用模型”还是“全量模型检索”。
- 需要“我当前能直接使用哪些模型”时，用 `sr models`。
- 需要按名称筛选在线模型，再判断权限时，用 `sr page`。
- 需要构造自助取数查询时，先用 `sr detail`、`sr fields`、`sr params`、`sr enums` 补齐上下文，再用 `sr query` 或 `sr export`。
- 如果需求是指标定义检索，优先用 `metric page`。
- 已知指标 ID 或指标编号时，优先用 `metric detail` 查看完整定义。
- 需要构造指标筛选条件时，先用 `metric data-domains`、`metric levels`、`metric types`、`metric status`、`metric users` 获取可选值。
- 如果 `sql run` 返回指标权限不足，先向用户说明缺失指标；用户明确同意申请后，使用 `metric apply` 发起指标权限申请。

## ⚠️ SQL 生成前置检查清单（强制执行）

> **不执行以下步骤就直接生成 SQL，会导致查询扫描全部历史分区，返回严重失实的数据。**
> Agent 在生成任何 SQL 之前，必须逐项完成以下检查。

| 表后缀 | 含义 | 分区策略 |
|---------|------|----------|
| `_dd_f` | 天分区全量快照 | 每个分区包含截至该天的全部历史数据 |
| `_dh_f` | 天分区小时更新全量 | 同上，但每小时刷新 |
| `_hh_f` | 小时分区全量快照 | 每个分区包含截至该小时的全部历史数据 |
| `_dd_i` | 天分区增量 | 每个分区仅包含当天新增数据 |
| `_yh_i` | 年分区增量 | 每个分区仅包含当年新增数据 |

**禁止凭猜测写分区值。** 必须调用以下命令之一获取真实分区信息：

```bash
# 方式一：获取分区列表（推荐）
bigdata-cli meta partitions --database <db> --table <table> --limit 5

# 方式二：获取表主信息，含分区表属性
bigdata-cli meta main-info --database <db> --table <table>
```

- **全量表（`_f`）：WHERE 子句必须包含分区等值条件，不允许省略，不允许使用范围条件（`>=`、`<=`、`BETWEEN`）。**
- **增量表（`_i`）：也应指定明确的分区值，避免全表扫描。**
- 天分区全量表只查最新一天：`WHERE dt = '2025-12-09'`
- 小时分区全量表只查最新小时：`WHERE dt = '2025-12-10' AND hour = '15'`

---

## 大数据操作必读规则

- 在写 SQL 之前，先识别目标表是否为分区表、分区粒度是什么、后缀代表全量还是增量。
- 对 `_f` 结尾的全量表，查询时必须显式指定分区，并且通常应只查最新分区，否则会把历史全量分区重复累计。
- 不要在分区字段上写范围条件，应使用确定分区值的等值条件。
- ImpalaSQL 不支持 `DATE_FORMAT`，生成 SQL 时不要使用这个函数。
- 涉及表后缀、分区字段和值格式、查询约束时，先看 `reference/meta.md` 和 `reference/sql.md`。

## 全局环境与约束

- 默认服务地址：
  - `kangaroo-acg`: `https://bd.acg.team/api/kangaroo-acg`
  - `ark-acg`: `https://bd.acg.team/api/ark-acg`
  - `gatekeeper`: `https://bd.acg.team/api/gatekeeper`
  - `big-dama`: `https://bd.acg.team/api/big-dama`
- 所有命令都支持 `--json` 输出机器可读结果。
- 所有命令都支持：
  - `--timeout-ms`
  - `--kangaroo-base-url`
  - `--ark-base-url`
  - `--gatekeeper-base-url`
  - `--big-dama-base-url`
  - `--sso-login-url`

## 共享错误处理约定

- 如果接口返回业务错误，CLI 会直接退出并打印 `bigdata-cli error: ...`。
- 如果 `sql run` 返回“查询结果行数太多”，应缩小 SQL 范围或先加 `limit`。
- 如果 `sql run --json` 返回 `PERMISSION_DENIED` 且 `validation.missingMetricPermissions` 有值，应读取其中的 `metricAbbr`，不要解析中文错误文案；在用户确认后调用 `bigdata-cli metric apply --metric-abbr ...`。
- 指标权限申请成功后，提示用户联系“杨佳毅”审批；用户后续告知“好了”时，再重试之前失败的 SQL。
- 如果找表结果为空，应换关键词、改库名范围，或补充业务别名再试。

## 如何选择参考文档

- 如果需求是找表、看字段、看分区，先看 `reference/meta.md`。
- 如果需求是 DataHub 维度补充表说明、脚本、字段，先看 `reference/datahub.md`。
- 如果需求是解析 SQL 或执行 Impala SQL，先看 `reference/sql.md`。
- 如果需求是自助取数模型列表、模型详情、字段/参数枚举、查询或导出，先看 `reference/self-retrieval.md`。
- 如果需求涉及核心指标定义、指标口径、指标英文名、计算公式、关联库表、维度或负责人筛选，先看 `reference/metric.md`。
- 如果需求横跨多个阶段，按 `meta -> datahub -> sql` 或 `sr detail -> sr fields -> sr params -> sr query/export` 的顺序组合读取。
