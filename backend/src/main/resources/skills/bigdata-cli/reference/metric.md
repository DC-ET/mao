# 指标定义

本文档说明如何使用 `bigdata-cli` 通过 `big-dama` 的指标定义接口，完成指标检索、筛选和详情查看。

## 适用范围

当任务属于以下场景时，优先使用本组命令：

- 按指标名称、编号、负责人、描述关键词搜索指标
- 按指标类型、状态、数据域、指标分层、安全等级筛选指标
- 只看“我当前有权限”的指标
- 查看单个指标的完整定义，包括口径、公式、相关库表、维度、别名和关联指标
- 获取筛选所需的下拉选项，例如数据域、状态、类型、负责人

## 默认服务与鉴权

- 默认 `big-dama` 服务地址：`https://bd.acg.team/api/big-dama`
- 鉴权方式：沿用 `bigdata-cli auth login` 的 SSO token
- 如需覆盖地址，可传 `--big-dama-base-url`

## 命令总览

```bash
bigdata-cli metric page --metric-name "支付金额" --page 1 --limit 20
bigdata-cli metric detail --metric-abbr pay_amount
bigdata-cli metric detail --id 123
bigdata-cli metric apply --metric-abbr pay_amount --metric-abbr refund_amount --reason "执行数据分析 SQL 时缺少指标权限"
bigdata-cli metric data-domains
bigdata-cli metric levels
bigdata-cli metric types
bigdata-cli metric status
bigdata-cli metric users
```

## 命令选择规则

- 不确定指标编号时，先用 `metric page`
- 已知指标 ID 或指标编号时，用 `metric detail`
- 执行 SQL 遇到 `PERMISSION_DENIED`，且响应包含 `validation.missingMetricPermissions` 时，在用户明确同意后用 `metric apply` 申请缺失指标权限
- 需要复刻管理后台筛选项时，先取：
  - `metric data-domains`
  - `metric levels`
  - `metric types`
  - `metric status`
  - `metric users`

## 命令：`bigdata-cli metric page`

### 用途

分页检索指标定义，整体筛选逻辑与管理后台 `acg-dama-web/src/views/metric/index.vue` 对齐。

### 常用参数

- `--search-text`
  搜索编号/名称/描述/负责人等综合关键词。
- `--metric-abbr`
  指标编号，支持模糊匹配。
- `--metric-name`
  指标名称，支持模糊匹配，也会命中别名。
- `--metric-type`
  指标类型编码。
- `--status`
  指标状态编码。
- `--data-domain-id`
  数据域 ID。
- `--metric-level`
  指标分层。
- `--secret-level`
  安全等级编码。
- `--metric-definer`
  业务定义人，模糊匹配。
- `--metric-owner`
  分析负责人，模糊匹配。
- `--just-mine`
  只返回当前用户有权限的指标。
- `--page`
  页码，默认 `1`。
- `--limit`
  每页条数，默认 `20`。

### 示例

```bash
bigdata-cli metric page --search-text "GMV"
bigdata-cli metric page --metric-name "支付金额" --metric-type 0 --status 5
bigdata-cli metric page --data-domain-id 12 --metric-level "交易" --just-mine --json
```

## 命令：`bigdata-cli metric detail`

### 用途

查看单个指标的完整定义。

### 参数说明

- `--id`
  指标 ID。与 `--metric-abbr` 二选一。
- `--metric-abbr`
  指标编号。与 `--id` 二选一。

### 返回重点

- 基本信息：名称、英文名、类型、状态、分层、安全等级、负责人
- 业务定义：指标描述、口径描述、计算公式
- 数据定义：相关库表、统计时间字段、数据计算公式、权限点编码
- 维度与关系：可分析维度、别名、关联指标

### 示例

```bash
bigdata-cli metric detail --metric-abbr pay_amount
bigdata-cli metric detail --id 123 --json
```

## 命令：`bigdata-cli metric apply`

### 用途

提交指标权限申请。申请会发送飞书审批卡片给配置的审核人，当前默认审核人为“杨佳毅”。

### 参数说明

- `--metric-abbr`
  指标编号。支持传多次，用于同时申请多个指标权限。
- `--reason`
  申请原因。建议填写当前分析任务和受阻 SQL 的简要说明。

### 示例

```bash
bigdata-cli metric apply --metric-abbr adv_chnl_chrg --metric-abbr adv_abm_wdl_service_chrg --reason "执行 Agent 数据分析 SQL 时缺少指标权限"
bigdata-cli metric apply --metric-abbr pay_amount --json
```

### Agent 使用约束

- 不要在用户未确认时自动申请权限。
- 从 `sql run --json` 的 `validation.missingMetricPermissions[].metricAbbr` 提取指标编号，不要解析中文错误文案。
- 申请成功后提示用户联系“杨佳毅”审批。
- 用户后续说“好了”时，重新执行之前失败的 SQL。

## 选项类命令

- `bigdata-cli metric data-domains`
  获取所有数据域
- `bigdata-cli metric levels`
  获取所有指标分层
- `bigdata-cli metric types`
  获取所有指标类型
- `bigdata-cli metric status`
  获取所有指标状态
- `bigdata-cli metric users`
  获取所有出现在指标定义中的业务定义人和分析负责人

## 工作建议

- 当用户先给自然语言描述时，先用 `metric page` 缩小范围，再用 `metric detail` 拉详情
- 当要写 SQL 或找底表时，把 `metric detail` 的 `dbTable`、`statDateField`、`dataFormula` 和 `dimList` 一起看
- 当要解释口径时，优先引用接口返回的 `metricCaliber`、`metricFormula`，不要再依赖静态 Markdown 副本
