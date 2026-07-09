# analytics — 分析汇总

## 用途

获取管理端分析汇总指标（按天数窗口）。

## 命令选择

仅 `analytics summary`。

## 命令：analytics summary

| 参数 | 必填 | 类型 | 默认 | 含义 | 后端字段 |
|------|------|------|------|------|----------|
| `--days` | 否 | 整数 | 30 | 统计天数窗口；服务端通常限制在 1–90 | `days` |

`GET /admin/analytics/summary`

### 成功失败判断

- 成功：`code===0`，`data` 为汇总对象（字段随服务端实现）
- 失败：stderr `message`

### 示例

```bash
mao-admin analytics summary
mao-admin analytics summary --days 7 --raw
```
