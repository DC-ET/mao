# 偏好模块（pref）

## 模块职责

读写用户任务面板（task-panel）偏好：分组顺序与折叠分组。

## 命令选择

| 场景 | 命令 |
|------|------|
| 读取偏好 | `pref task-panel get` |
| 保存偏好 | `pref task-panel set` |

---

## 命令：mao-user pref task-panel get

### 用途

获取当前用户任务面板偏好。

### 参数说明

无。需要鉴权。

### 返回结果

| 字段 | 类型 | 含义 |
|------|------|------|
| `groupOrder` | 字符串数组 | 分组显示顺序 |
| `collapsedGroups` | 字符串数组 | 默认折叠的分组名 |

### 示例

```bash
mao-user pref task-panel get --json
```

---

## 命令：mao-user pref task-panel set

### 用途

覆盖保存任务面板偏好。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--group-order` | 是 | 逗号分隔字符串 | 分组顺序，如 `running,recent,archived` → `groupOrder` 数组 |
| `--collapsed-groups` | 否 | 逗号分隔字符串 | 折叠分组，缺省为空数组 → `collapsedGroups` |

### 参数约束

- `--group-order` 会按逗号拆分并去除空白；不要传空字符串
- 分组名需与桌面端任务面板实际分组标识一致

### 示例

```bash
mao-user pref task-panel set --group-order running,recent,archived --collapsed-groups archived
```
