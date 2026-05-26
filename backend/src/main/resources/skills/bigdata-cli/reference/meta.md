# 元数据模块

## 模块职责

使用 Kangaroo 的元数据接口完成 Hive 表发现、字段查询、主信息查询和分区查询。

## 表名规范

- 离线数仓表名一般带有后缀，用于表达分区粒度、更新周期和数据组织方式。
- 常见后缀：
  - `_dd_f`
    按天分区、每天更新一次、每个分区都是历史全量数据。
  - `_dh_f`
    按天分区、每小时更新一次、每个分区都是历史全量数据。
  - `_hh_f`
    按小时分区、每小时更新一次、每个分区都是历史全量数据。
  - `_dd_i`
    按天分区、每天更新一次、每个分区只有当天增量数据。
  - `_yh_i`
    按年分区、每小时更新一次、每个分区只有当年增量数据。
  - 其他后缀按同样规则类推。
- 对 `_f` 后缀的全量表，查询时必须指定分区，并且应始终查询最新分区，否则数据会重复。

## 分区字段规范

- 分区表通常都会有一个分区字段，常见是 `year`、`dt`、`dt + hour`。
- 常见格式：
  - 天分区：
    `PARTITIONED BY (dt string comment 'yyyy-MM-dd')`
  - 小时分区：
    `PARTITIONED BY (dt string comment 'yyyy-MM-dd', hour string comment 'HH')`
  - 年分区：
    `PARTITIONED BY (dt string comment 'yyyy')`
- 看到表后缀后，不要只凭名字猜字段，一旦要执行查询，仍然应通过 `meta columns`、`meta main-info`、`meta partitions` 进一步确认。

## 命令选择规则

- 还不知道表名时，用 `bigdata-cli meta search`。
- 已知元数据 ID 或 `db.table` 时，用 `bigdata-cli meta detail`。
- 只想拿字段时，用 `bigdata-cli meta columns`。
- 只想拿表主信息时，用 `bigdata-cli meta main-info`。
- 只想拿分区分页结果时，用 `bigdata-cli meta partitions`。

## 命令：bigdata-cli meta search

### 用途

按语义检索 Hive 元数据，默认优先返回核心表。

### 参数说明

- `--keyword`
  语义搜索词。字符串。必填。用于传给后端的 `semanticSearch`。
- `--database`
  库名前缀。字符串。可选。用于收窄 `dbName` 范围。
- `--limit`
  返回条数。整数。可选。默认 `10`。
- `--page`
  页码。整数。可选。默认 `1`。
- `--core-only`
  是否只查核心表。布尔开关。可选。传入后只请求 `isCoreTable=1`。
- `--diy-tag`
  自定义标签。字符串。可重复。可选。映射到后端 `diyTagList`。
- `--json`
  输出 JSON。布尔开关。可选。

### 参数约束

- `--keyword` 不能为空。
- `--limit` 和 `--page` 必须是正整数。
- 默认不是“只查核心表”，而是“核心表优先 + 普通表补充”。

### 返回结果与状态判断

- JSON 输出下会返回 `results` 数组。
- 每个结果包含：
  - `id`
  - `metaName`
  - `owner`
  - `description`
  - `isCoreTable`
  - `objectId`
  - `source`

### 示例

```bash
bigdata-cli meta search --keyword "会员积分"
bigdata-cli meta search --keyword "履约时效" --database access_cdm --limit 5 --json
bigdata-cli meta search --keyword "订单" --core-only
```

## 命令：bigdata-cli meta detail

### 用途

根据元数据 ID 或 `db.table` 获取元数据详情和字段列表。

### 参数说明

- `--id`
  元数据 ID。整数。与 `--meta-name` 二选一。
- `--meta-name`
  库表名，格式一般为 `db.table`。字符串。与 `--id` 二选一。
- `--json`
  输出 JSON。布尔开关。可选。

### 参数约束

- 必须传 `--id` 或 `--meta-name` 中的一个。
- `--id` 必须是正整数。

### 返回结果与状态判断

- 返回 `meta`、`hiveTable`、`columns` 三部分。
- `columns` 来自 `metaHiveTable.tableParams`。

### 示例

```bash
bigdata-cli meta detail --meta-name access_cdm.dim_user_dd_f
bigdata-cli meta detail --id 12345 --json
```

## 命令：bigdata-cli meta columns

### 用途

按库表名直接查询字段列表。

### 参数说明

- `--database`
  库名。字符串。必填。映射到后端 `dbName`。
- `--table`
  表名。字符串。必填。映射到后端 `tbName`。
- `--refresh`
  是否刷新字段缓存。布尔开关。可选。映射到后端 `refresh=true`。
- `--json`
  输出 JSON。布尔开关。可选。

### 参数约束

- `--database` 和 `--table` 必填。

### 返回结果与状态判断

- 非 JSON 输出时逐行展示字段名、字段类型和注释。
- JSON 输出时返回 `columns` 数组原始结果，便于 Agent 继续处理。

### 示例

```bash
bigdata-cli meta columns --database access_cdm --table dim_user_dd_f
bigdata-cli meta columns --database access_cdm --table dim_user_dd_f --refresh --json
```

## 命令：bigdata-cli meta main-info

### 用途

按库表名获取表主信息。

### 参数说明

- `--database`
  库名。字符串。必填。
- `--table`
  表名。字符串。必填。
- `--json`
  输出 JSON。布尔开关。可选。

### 参数约束

- `--database` 和 `--table` 必填。

### 返回结果与状态判断

- 非 JSON 输出时直接展示主信息对象。
- 适合让 Agent 获取更新时间、分区表属性、DDL 相关主信息。

### 示例

```bash
bigdata-cli meta main-info --database access_cdm --table dim_user_dd_f --json
```

## 命令：bigdata-cli meta partitions

### 用途

分页获取表分区信息。

### 参数说明

- `--database`
  库名。字符串。必填。
- `--table`
  表名。字符串。必填。
- `--page`
  页码。整数。可选。默认 `1`，映射到后端 `pageNum`。
- `--limit`
  每页条数。整数。可选。默认 `20`。
- `--json`
  输出 JSON。布尔开关。可选。

### 参数约束

- `--database` 和 `--table` 必填。
- `--page`、`--limit` 必须是正整数。

### 返回结果与状态判断

- 非 JSON 输出时每行打印一个分区对象。
- JSON 输出时返回完整分页对象，通常包含 `records/list`、`total` 等字段。

### 示例

```bash
bigdata-cli meta partitions --database access_cdm --table dwd_order_dd_f --page 1 --limit 10
bigdata-cli meta partitions --database access_cdm --table dwd_order_dd_f --json
```
