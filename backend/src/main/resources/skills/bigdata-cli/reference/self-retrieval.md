# 自助取数

本文档说明如何使用 `bigdata-cli` 调用 gatekeeper 的自助取数接口。

## 适用范围

当任务属于以下场景时，优先使用本组命令：

- 查看当前用户能直接查询哪些自助取数模型
- 在全部在线模型中按名称、负责人、属性筛选模型
- 查看模型详情、字段、参数、枚举
- 按模型提交自助查询
- 提交异步导出任务，并通过飞书接收文件或状态通知

## 默认服务与鉴权

- 默认 `gatekeeper` 服务地址：`https://bd.acg.team/api/gatekeeper`
- 鉴权方式：沿用 `bigdata-cli auth login` 的 SSO token
- 如需覆盖地址，可传 `--gatekeeper-base-url`

## 命令总览

```bash
bigdata-cli sr models
bigdata-cli sr page --model-name "会员" --page 1 --limit 20
bigdata-cli sr detail --model-id 123
bigdata-cli sr fields --model-id 123
bigdata-cli sr params --model-id 123
bigdata-cli sr enums
bigdata-cli sr query --model-id 123 --search-info-file ./search-info.json
bigdata-cli sr export --model-id 123 --search-info-file ./search-info.json
bigdata-cli sr export-tasks --page 1 --limit 10
bigdata-cli sr export-records --task-id 1001
bigdata-cli sr export-send-feishu --task-id 1001
bigdata-cli sr export-retry --task-id 1001
```

## 命令选择规则

- 只想看“我当前就有权限用哪些模型”，先用 `sr models`
- 想从全部在线模型里搜索，再判断是否有权限，用 `sr page`
- 已知模型 ID 时，按 `sr detail -> sr fields -> sr params -> sr enums` 补齐查询上下文
- 需要执行查询时，用 `sr query`
- 需要导出时，用 `sr export` 提交异步任务
- 需要跟踪异步任务状态时，用 `sr export-tasks`
- 需要查看文件发送/下载记录时，用 `sr export-records`

## 命令：`bigdata-cli sr models`

### 用途

获取当前登录用户可直接使用的模型列表。

### 参数说明

- 无业务参数
- 支持所有全局参数，例如 `--json`、`--timeout-ms`

### 返回结果与状态判断

- 成功时返回模型数组
- 重点关注字段：
  - `id`：模型 ID
  - `modelName`：模型名称
  - `modelOwner`：模型负责人账号
  - `modelType`：`0` 单表模型，`1` 组合模型
  - `modelAttribute`：模型属性
  - `authStatus`：当前用户是否有权限

### 示例

```bash
bigdata-cli sr models
bigdata-cli sr models --json
```

## 命令：`bigdata-cli sr page`

### 用途

分页检索全部在线模型，并带回当前用户的权限状态。

### 参数说明

- `--model-name`
  模型名称关键词。字符串。可选。对应后端字段 `modelName`。
- `--attribute`
  模型属性编码。整数。可重复传入。可选。对应后端字段 `modelAttributeList`。
- `--owner`
  模型负责人账号。字符串。可重复传入。可选。对应后端字段 `modelOwnerList`。
- `--auth-flag`
  是否按权限状态过滤。布尔值。可选。对应后端字段 `authFlag`。可传 `true`、`false`、`1`、`0`。
- `--page`
  页码。正整数。可选。默认 `1`。对应 `JsonBase.pageNum`。
- `--limit`
  每页条数。正整数。可选。默认 `20`。对应 `JsonBase.pageSize`。

### 参数约束

- `--attribute` 可以多次传入，例如 `--attribute 0 --attribute 1`
- `--owner` 可以多次传入
- `--auth-flag` 只接受明确布尔值，不要传中文

### 返回结果与状态判断

- 成功时返回分页对象
- 常见字段：
  - `records` 或 `list`：当前页记录
  - `authStatus`：当前用户是否有权限
  - `applyFlag`：申请状态编码
  - `applyFlagDesc`：申请状态说明

### 示例

```bash
bigdata-cli sr page --model-name "会员"
bigdata-cli sr page --owner alice --owner bob --attribute 1 --page 2 --limit 10 --json
```

## 命令：`bigdata-cli sr detail`

### 用途

查看单个模型详情。

### 参数说明

- `--model-id`
  模型 ID。正整数。必填。对应后端字段 `params.id`。

### 返回结果与状态判断

- 成功时返回模型详情对象
- 常看字段：
  - `modelSql`
  - `modelDesc`
  - `modelBaseName`
  - `modelTableName`
  - `modelType`
  - `modelStatus`
  - `authStatus`

### 示例

```bash
bigdata-cli sr detail --model-id 123
```

## 命令：`bigdata-cli sr fields`

### 用途

查看模型字段列表，用于确认哪些字段可以作为维度、指标或筛选条件。

### 参数说明

- `--model-id`
  模型 ID。正整数。必填。对应后端字段 `params.modelId`。

### 返回结果与状态判断

- 每个字段常见属性：
  - `modelFieldName`：字段英文名
  - `modelFieldComment`：字段中文说明
  - `modelFieldType`：字段类型编码
  - `modelFieldAttribute`：字段属性编码
  - `modelFieldDesc`：补充说明

### 字段属性编码

- `0`：指标
- `1`：维度

### 字段类型编码

- `0`：字符串
- `1`：URL
- `2`：日期
- `3`：数值

### 示例

```bash
bigdata-cli sr fields --model-id 123
bigdata-cli sr fields --model-id 123 --json
```

## 命令：`bigdata-cli sr params`

### 用途

查看模型参数定义，用于确定哪些参数必填、是否允许多值、默认值是什么。

### 参数说明

- `--model-id`
  模型 ID。正整数。必填。对应后端字段 `params.modelId`。

### 返回结果与状态判断

- 每个参数常见属性：
  - `paramName`：参数名
  - `paramAlias`：参数别名
  - `paramRequiredFlag`：是否必填
  - `paramMultivaluedFlag`：是否多值
  - `paramQuotationFlag`：拼接 SQL 时是否带引号
  - `paramDefaultValue`：默认值
  - `paramCandidateJson`：候选值 JSON

### 示例

```bash
bigdata-cli sr params --model-id 123
```

## 命令：`bigdata-cli sr enums`

### 用途

获取构造查询 JSON 时需要的全部枚举。

### 参数说明

- 无业务参数

### 返回结果与状态判断

- 常用枚举：
  - `functionTypeList`
  - `queryConditionTypeList`
  - `conditionTypeList`
  - `fieldTypeList`
  - `fieldAttributeList`

### 常用函数类型编码

- `0`：`SUM`
- `1`：`AVG`
- `2`：`MAX`
- `3`：`MIN`
- `4`：`COUNT`
- `5`：`DISTINCT`
- `6`：自定义计算

### 常用筛选条件编码

- `0`：`=`
- `1`：`!=`
- `2`：`>`
- `3`：`>=`
- `4`：`<`
- `5`：`<=`
- `6`：`IN`
- `7`：`NOT IN`
- `8`：`BETWEEN`
- `9`：`NOT BETWEEN`
- `10`：`IS NULL`
- `11`：`IS NOT NULL`
- `12`：`LIKE`
- `13`：`NOT LIKE`

### 示例

```bash
bigdata-cli sr enums
bigdata-cli sr enums --json
```

## 命令：`bigdata-cli sr query`

### 用途

按模型提交一次自助查询，并直接返回结果行。

### 参数说明

- `--model-id`
  模型 ID。正整数。条件必填。未使用 `--payload-file` 时必须传。
- `--search-info-file`
  查询主体 JSON 文件路径。条件必填。文件内容对应后端 `searchInfo`。
- `--payload-file`
  完整请求 JSON 文件路径。可选。传了以后，CLI 直接使用文件中的完整 payload，不再读取 `--model-id` 和 `--search-info-file`。
- `--query-id`
  自定义查询 ID。字符串。可选。默认自动生成 `sr-时间戳`。对应后端字段 `queryId`。
- `--search-name`
  查询名称。字符串。可选。对应后端字段 `searchName`。
- `--record-desc`
  备注。字符串。可选。对应后端字段 `recordDesc`。
- `--sequence-field`
  排序字段。字符串。可选。与 `--sequence-asc` 配对使用。
- `--sequence-asc`
  是否正序。布尔值。可选。`true` 表示正序，`false` 表示倒序。对应后端字段 `sequence.type`。
- `--page`
  `JsonBase.pageNum`。正整数。可选。默认 `1`。
- `--limit`
  `JsonBase.pageSize`。正整数。可选。默认 `20`。

### 参数约束

- `--payload-file` 与 `--search-info-file` 互斥
- `--payload-file` 与 `--model-id` 的优先级冲突时，以 `--payload-file` 为准
- 只传 `--sequence-field` 不传 `--sequence-asc` 时，不会生成排序对象
- 查询前必须先通过 `sr fields`、`sr params`、`sr enums` 明确字段和枚举，不要靠猜测写编码

### 查询 JSON 结构

如果使用 `--search-info-file`，文件内容应是 `searchInfo` 对象，例如：

```json
{
  "dimensionList": [
    {
      "alias": "日期",
      "field": "dt",
      "groupInfoList": []
    }
  ],
  "targetList": [
    {
      "alias": "用户数",
      "field": "user_id",
      "functionType": 5
    }
  ],
  "conditionList": [
    {
      "field": "dt",
      "queryConditionType": 0,
      "values": ["2026-05-01"]
    }
  ],
  "paramInfoList": [
    {
      "paramName": "start_date",
      "paramValues": ["2026-05-01"]
    }
  ]
}
```

如果使用 `--payload-file`，文件可写成完整 `JsonBase`：

```json
{
  "pageNum": 1,
  "pageSize": 20,
  "params": {
    "queryId": "demo-001",
    "searchModelId": 123,
    "searchInfo": {
      "dimensionList": [],
      "targetList": [],
      "conditionList": [],
      "paramInfoList": []
    }
  }
}
```

也可以省略外层，只写 `params` 的内容；CLI 会自动补默认的 `pageNum=1`、`pageSize=20`。

### 返回结果与状态判断

- 成功时返回：
  - `queryId`
  - `searchModelId`
  - `rows`
- `rows` 是对象数组
- 若结果很多，建议使用 `--json` 交给 Agent 继续处理

### 示例

```bash
bigdata-cli sr query --model-id 123 --search-info-file ./search-info.json
bigdata-cli sr query --payload-file ./query-payload.json --json
```

## 命令：`bigdata-cli sr export`

### 用途

按与查询相同的条件提交异步导出任务。导出文件由 gatekeeper 后台异步生成，并自动尝试发送到用户飞书；如果文件过大，会退化为发送下载链接。

### 参数说明

- `--model-id`
  模型 ID。正整数。条件必填。未使用 `--payload-file` 时必须传。
- `--search-info-file`
  查询主体 JSON 文件路径。条件必填。
- `--payload-file`
  完整请求 JSON 文件路径。可选。
- `--query-id`
  查询 ID。字符串。可选。默认自动生成。
- `--search-name`
  查询名称。字符串。可选。
- `--record-desc`
  备注。字符串。可选。
- `--sequence-field`
  排序字段。字符串。可选。
- `--sequence-asc`
  是否正序。布尔值。可选。
- `--page`
  `JsonBase.pageNum`。正整数。可选。默认 `1`。
- `--limit`
  `JsonBase.pageSize`。正整数。可选。默认 `20`。
- `--skip-search`
  是否跳过预查询。布尔值。可选。默认不跳过。
  因为 `manage/model/export/submit` 只接收 `queryId`，且要求该 `queryId` 已经被 `searchRecord` 写入 Redis，CLI 默认会先执行一次查询再提交导出任务。只有在你确认同一个 `queryId` 刚刚查询过且缓存仍有效时，才适合传 `--skip-search`。
- `--send-to-feishu`
  是否在提交任务后立即请求“发送到飞书”。布尔值。可选。默认 `true`。
  注意：任务刚提交时通常还未处理完成，因此这一步可能暂时失败；即便失败，任务本身仍会继续异步执行，后台最终也会自动发送结果。
- `--job-number`
  指定接收飞书文件或链接的工号。字符串。可选。默认由服务端使用当前登录人。

### 参数约束

- 查询和导出都应使用同一套 `searchInfo` 语义
- `manage/model/export/submit` 本身只吃 `queryId`，所以导出前必须先有一次 `searchRecord`
- CLI 默认会先执行查询，以确保 `queryId` 已注册到 Redis
- 导出是异步任务，不会立刻返回文件

### 返回结果与状态判断

- 成功时返回：
  - `taskId`
  - `queryId`
  - `searchModelId`
  - `status`
- 后续应使用 `sr export-tasks` 跟踪任务进展
- 状态编码：
  - `0`：初始化
  - `1`：数据收集完成
  - `2`：文件生成完成
  - `3`：文件上传完成
  - `4`：结果发送完成

### 示例

```bash
bigdata-cli sr export --model-id 123 --search-info-file ./search-info.json
bigdata-cli sr export --payload-file ./query-payload.json --send-to-feishu false
```

## 命令：`bigdata-cli sr export-tasks`

### 用途

分页查看导出任务状态。

### 参数说明

- `--page`
  页码。正整数。可选。默认 `1`。对应后端 `pageNo`。
- `--limit`
  每页条数。正整数。可选。默认 `10`。对应后端 `limit`。
- `--search-text`
  模糊查询。字符串。可选。服务端会匹配 `queryJson`，也支持按任务 ID 或模型 ID 查。
- `--job-number`
  操作人工号。字符串。可选。
- `--model-id`
  模型 ID。正整数。可选。对应后端 `searchModelId`。
- `--status`
  任务状态。整数。可选。

### 示例

```bash
bigdata-cli sr export-tasks --page 1 --limit 10
bigdata-cli sr export-tasks --model-id 123 --status 4 --json
```

## 命令：`bigdata-cli sr export-records`

### 用途

查看某个导出任务的发送/下载记录。

### 参数说明

- `--task-id`
  导出任务 ID。正整数。必填。

### 示例

```bash
bigdata-cli sr export-records --task-id 1001
```

## 命令：`bigdata-cli sr export-send-feishu`

### 用途

对已完成上传的导出任务，手动再次请求发送到飞书。

### 参数说明

- `--task-id`
  导出任务 ID。正整数。必填。
- `--job-number`
  接收人工号。字符串。可选。

### 示例

```bash
bigdata-cli sr export-send-feishu --task-id 1001
bigdata-cli sr export-send-feishu --task-id 1001 --job-number 123456
```

## 命令：`bigdata-cli sr export-retry`

### 用途

对失败或卡住的导出任务发起重试。

### 参数说明

- `--task-id`
  导出任务 ID。正整数。必填。

### 示例

```bash
bigdata-cli sr export-retry --task-id 1001
```

## 常见误用

- 误用：没有先看 `sr fields` 和 `sr enums`，直接猜 `functionType` 或 `queryConditionType`
  正确做法：先取枚举，再构造查询 JSON

- 误用：把 `--search-info-file` 写成完整 payload，又同时传 `--model-id`
  正确做法：完整 payload 用 `--payload-file`，只有 `searchInfo` 才用 `--search-info-file`

- 误用：只传 `--sequence-field`，忘了 `--sequence-asc`
  正确做法：两个参数一起传；否则 CLI 不会生成排序对象

- 误用：导出时假定返回 JSON
  正确做法：`sr export` 会把 Excel 二进制直接写入本地文件
