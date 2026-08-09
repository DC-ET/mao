# 偏好模块（pref）

## 模块职责

读写用户偏好：任务面板（task-panel）分组顺序/折叠分组、任务完成通知（task-notification）的启停/渠道/测试，以及微信语音回复（weixin）开关。

## 命令选择

| 场景 | 命令 |
|------|------|
| 读取偏好 | `pref task-panel get` |
| 保存偏好 | `pref task-panel set` |
| 读取任务通知 | `pref task-notification get` |
| 保存任务通知 | `pref task-notification set` |
| 发送测试通知 | `pref task-notification test` |
| 读取微信语音回复 | `pref weixin get` |
| 设置微信语音回复 | `pref weixin set` |

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

---

## 命令：mao-user pref task-notification get

### 用途

获取当前用户任务完成通知配置。服务端只返回脱敏 Webhook。

### 返回结果

| 字段 | 类型 | 含义 |
|------|------|------|
| `enabled` | 布尔 | 是否启用 |
| `channel` | 字符串/null | `DINGTALK` 或 `FEISHU` |
| `webhookConfigured` | 布尔 | 是否已保存 Webhook |
| `maskedWebhook` | 字符串/null | 脱敏后的 Webhook |

### 示例

```bash
mao-user pref task-notification get --json
```

---

## 命令：mao-user pref task-notification set

### 用途

保存任务完成通知配置。开启通知时必须已有或同时传入渠道与 Webhook；切换渠道时必须传入新的 Webhook。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--enabled` | 是 | 布尔 `true/false` | 是否启用 |
| `--channel` | 条件 | 字符串 | `DINGTALK` 或 `FEISHU` |
| `--webhook-url` | 条件 | 字符串 | 钉钉/飞书机器人 Webhook |

### 示例

```bash
mao-user pref task-notification set --enabled true --channel DINGTALK --webhook-url 'https://oapi.dingtalk.com/robot/send?access_token=...'
mao-user pref task-notification set --enabled false
```

---

## 命令：mao-user pref task-notification test

### 用途

发送一次任务通知测试。未传 `--webhook-url` 时，服务端使用已保存的当前渠道 Webhook。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--channel` | 是 | 字符串 | `DINGTALK` 或 `FEISHU` |
| `--webhook-url` | 否 | 字符串 | 临时测试用 Webhook |

### 示例

```bash
mao-user pref task-notification test --channel FEISHU
```

---

## 命令：mao-user pref weixin get

### 用途

获取当前用户微信语音回复偏好。返回的 `voiceReply` 为生效值：未单独配置时回退全局默认配置（即 `voiceReply` 可能来自服务端全局开关）。

### 参数说明

无。需要鉴权。

### 返回结果

| 字段 | 类型 | 含义 |
|------|------|------|
| `voiceReply` | 布尔 | 是否开启微信语音回复（生效值） |

### 示例

```bash
mao-user pref weixin get --json
```

---

## 命令：mao-user pref weixin set

### 用途

保存当前用户微信语音回复开关（用户级覆盖全局默认）。

### 参数说明

| 参数 | 必填 | 类型 | 含义 |
|------|------|------|------|
| `--enabled` | 是 | 布尔 `true/false` | 是否开启微信语音回复 |

### 示例

```bash
mao-user pref weixin set --enabled true
mao-user pref weixin set --enabled false
```
