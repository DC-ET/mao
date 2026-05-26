# SQL 模块

## 模块职责

提供 SQL 输入输出表解析和 Impala SQL 执行能力，供 AiAgent 在生成 SQL 后做校验与验证查询。

## ⚠️ SQL 生成强制工作流（必读）

> **跳过此流程直接写 SQL 是导致查询数据失真的根本原因。**
> 全量表（`_f`）不加分区条件，会把所有历史分区的数据叠加返回，结果严重膨胀。

### 流程图

```
拿到业务需求
    │
    ▼
① 找到目标表（meta search / datahub search）
    │
    ▼
② 判断表类型：看后缀 → _f = 全量表，_i = 增量表
    │
    ▼
③ 查询真实分区值（meta partitions / meta main-info）
   ⛔ 禁止凭猜测写分区值
    │
    ▼
④ 生成 SQL，WHERE 中必须包含分区等值条件
   ⛔ 全量表省略分区条件 = 数据失真
   ⛔ 分区字段使用范围条件 = 数据失真
    │
    ▼
⑤ 自检：每个 _f 表是否都有分区等值条件？
    │
    ├── 否 → 回到 ④ 补充
    └── 是 → 执行
```

### 正确 vs 错误示例

**示例 1：天分区全量表**

假设当前时间 `2025-12-10`，`meta partitions` 返回最新分区为 `2025-12-09`。

```sql
-- ✅ 正确：指定了具体分区值
SELECT goods_id, gmv
FROM access_cdm.dmd_index_managerial_report_goods_dd_f
WHERE dt = '2025-12-09'

-- ❌ 错误：没有分区条件，扫描全部历史分区，数据叠加膨胀
SELECT goods_id, gmv
FROM access_cdm.dmd_index_managerial_report_goods_dd_f

-- ❌ 错误：使用范围条件，扫描多个分区，数据叠加
SELECT goods_id, gmv
FROM access_cdm.dmd_index_managerial_report_goods_dd_f
WHERE dt >= '2025-12-01' AND dt <= '2025-12-09'
```

**示例 2：小时分区全量表**

假设当前时间 `2025-12-10 16:45`，`meta partitions` 返回最新分区为 `dt=2025-12-10, hour=15`。

```sql
-- ✅ 正确：指定了具体的 dt 和 hour
SELECT page_id, uv
FROM access_cdm.dws_flow_pf_visit_index_vtn_hh_f
WHERE dt = '2025-12-10' AND hour = '15'

-- ❌ 错误：只有 dt 没有 hour，仍然会扫描该天所有小时分区
SELECT page_id, uv
FROM access_cdm.dws_flow_pf_visit_index_vtn_hh_f
WHERE dt = '2025-12-10'
```

**示例 3：跨表 JOIN，每个全量表都必须加分区条件**

```sql
-- ✅ 正确：两张全量表都指定了分区
SELECT a.goods_id, a.gmv, b.brand_name
FROM access_cdm.dmd_index_managerial_report_goods_dd_f a
JOIN access_cdm.dim_goods_dd_f b ON a.goods_id = b.goods_id
WHERE a.dt = '2025-12-09' AND b.dt = '2025-12-09'

-- ❌ 错误：只有第一张表加了分区，第二张表全量扫描
SELECT a.goods_id, a.gmv, b.brand_name
FROM access_cdm.dmd_index_managerial_report_goods_dd_f a
JOIN access_cdm.dim_goods_dd_f b ON a.goods_id = b.goods_id
WHERE a.dt = '2025-12-09'
```

### 如果不确定分区值怎么办

```bash
# 先查分区，再写 SQL
bigdata-cli meta partitions --database access_cdm --table dmd_index_managerial_report_goods_dd_f --limit 5
# 从返回结果中取最新分区值，写入 WHERE 条件
```

---

## 查询规范

- 查询全量表时，`where` 中**必须**加分区等值条件，不允许省略。
- 对 `_f` 结尾的表，查询距离当前时间最近的分区：
  - 天分区：`dt = '最新日期'`（通过 `meta partitions` 获取）
  - 小时分区：`dt = '最新日期' AND hour = '最新小时'`（通过 `meta partitions` 获取）
- **禁止**在分区字段上使用 `>=`、`<=`、`BETWEEN`、`>`、`<` 等范围条件。
- ImpalaSQL 不支持 `DATE_FORMAT`。

## 分区查询示例规则

- 如果当前时间是 `2025-12-10 16:45:00`：
  - 天分区表应查 `dt = '2025-12-09'`（通过 meta partitions 确认）
  - 小时分区表应查 `dt = '2025-12-10' AND hour = '15'`（通过 meta partitions 确认）
- 生成 SQL 时，必须把”最近分区”展开成具体值，不要只写模糊时间描述。
- **一旦不确定最新分区值，必须先调用 `bigdata-cli meta partitions` 获取分区，再生成最终 SQL。**

## 生成 SQL 时的强约束

- 先判断目标表是全量表还是增量表。
- 对全量表：
  - **必须加分区等值条件。**
  - **不允许省略分区条件。**
  - **不允许对分区字段使用 `>=`、`<=`、`between` 这类范围过滤。**
- 对增量表：
  - 也优先使用明确分区值，避免扫过多分区。
- JOIN 场景中，**每张全量表**都必须独立指定分区条件。
- 如果 SQL 中出现 `DATE_FORMAT`，应直接改写为 Impala 可执行表达式。

## 命令选择规则

- 想先解析 SQL 依赖的源表和目标表时，用 `bigdata-cli sql parse-tables`。
- 确认 SQL 可执行后，再用 `bigdata-cli sql run`。

## 输入方式说明

这两个命令都支持两种 SQL 输入方式：

- `--sql`
  直接传 SQL 文本。
- `--file`
  传本地 SQL 文件路径。

二者互斥，不能同时传。

## 命令：bigdata-cli sql parse-tables

### 用途

解析 SQL 的输入表和输出表。

### 参数说明

- `--sql`
  SQL 文本。字符串。与 `--file` 二选一。
- `--file`
  SQL 文件路径。字符串。与 `--sql` 二选一。
- `--json`
  输出 JSON。布尔开关。可选。

### 参数约束

- 必须传 `--sql` 或 `--file` 之一。

### 返回结果与状态判断

- 返回：
  - `sourceTables`
  - `desTables`
- 非 JSON 输出时，会分别打印“输入表”和“输出表”。

### 示例

```bash
bigdata-cli sql parse-tables --sql "insert overwrite table a.b select * from c.d"
bigdata-cli sql parse-tables --file ./query.sql --json
```

## 命令：bigdata-cli sql run

### 用途

执行 Impala SQL 并返回格式化结果文本。

### 参数说明

- `--sql`
  SQL 文本。字符串。与 `--file` 二选一。
- `--file`
  SQL 文件路径。字符串。与 `--sql` 二选一。
- `--json`
  输出 JSON。布尔开关。可选。

### 参数约束

- 必须传 `--sql` 或 `--file` 之一。
- 后端接口会限制返回不超过 500 行，因此不适合大查询。

### 返回结果与状态判断

- 成功且有数据时，服务端返回格式化表格文本。
- 成功但无数据时，返回 `无数据`。
- 失败时，CLI 会直接打印错误并退出。
- `--json` 输出时，结果对象包含：
  - `sql`
  - `summary`
  - `resultText`

### 常见误用

- 不要把大范围明细查询直接丢给 `sql run`，很容易被 500 行限制拦住。
- 如果只想做依赖确认，不要直接执行，先用 `parse-tables`。

### 示例

```bash
bigdata-cli sql run --sql "select count(*) from access_cdm.dim_user_dd_f"
bigdata-cli sql run --file ./query.sql --json
```
