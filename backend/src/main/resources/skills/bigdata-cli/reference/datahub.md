# DataHub 模块

## 模块职责

使用 Ark 的 DataHub 接口补充做表搜索和表详情查询，适合在不知道准确库表名、想看上游脚本、描述或字段时使用。

## 命令选择规则

- 只想基于关键词快速浏览候选表时，用 `bigdata-cli datahub search`。
- 已知库表名，想看 DataHub 详情时，用 `bigdata-cli datahub detail`。

## 命令：bigdata-cli datahub search

### 用途

按关键词搜索 DataHub 中的候选表，结果会按数据库分组。

### 参数说明

- `--query`
  搜索词。字符串。必填。映射到后端 `searchText`。
- `--json`
  输出 JSON。布尔开关。可选。

### 参数约束

- `--query` 必填。

### 返回结果与状态判断

- 非 JSON 输出时先打印数据库名，再打印库下命中的表。
- JSON 输出时返回 `databases` 数组，每个元素包含：
  - `name`
  - `tables`

### 示例

```bash
bigdata-cli datahub search --query "会员积分"
bigdata-cli datahub search --query "订单履约" --json
```

## 命令：bigdata-cli datahub detail

### 用途

获取 DataHub 视角下的表详情。

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

- 返回内容通常包括：
  - `database`
  - `name`
  - `description`
  - `hasReadPermission`
  - `scriptName`
  - `lastModifiedTime`
  - `tableFields`
- 当需要补充“这张表最近谁改过、它对应什么脚本、字段大致长什么样”时，这个命令很有用。

### 示例

```bash
bigdata-cli datahub detail --database access_cdm --table dim_user_dd_f
bigdata-cli datahub detail --database access_cdm --table dim_user_dd_f --json
```
