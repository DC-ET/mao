# 代码审查报告：2026-09-27 未提交变更

审查范围：当前 git 工作区未提交的全部代码变更（17 个文件），覆盖后端 feedback / notification / preference / ws-registry 四个模块及前端 useMessageFeedback / useTaskPanelPrefs 两个 composable。

---

## Bug 1（高）：偏好冲突检测永远不会触发——`conflictCodeOf` 取不到错误码

**文件**：`desktop/src/composables/useTaskPanelPrefs.ts:84-87` + `desktop/src/api/index.ts:63-70`

**现象**：`mergeWithServerThenSave` 的冲突合并逻辑是死代码，永远不会被执行。多端并发保存时不会自动合并，而是反复冲突→重试→失败。

**根因**：

后端 `PREFERENCE_CONFLICT`（code 3032）经 `handleError` 映射为 HTTP 200 + `{ code: 3032, message: "..." }`（code 3032 不属于 1001/401 或 1002/403，走默认 200 分支）。

axios 收到 HTTP 200 后走**响应成功拦截器**：

```ts
// desktop/src/api/index.ts:65-70
(response) => {
    const { data } = response
    if (data.code !== 0) {
      ElMessage.error(data.message || '请求失败')
      const err = new Error(data.message || '请求失败') as Error & { toastShown?: boolean }
      err.toastShown = true
      return Promise.reject(err)   // ← 普通 Error，没有 .response 属性
    }
    return data
},
```

reject 的是一个 `new Error(...)`，**不携带 `response` 字段**。

而 `conflictCodeOf` 依赖 `error.response.data.code`：

```ts
// desktop/src/composables/useTaskPanelPrefs.ts:84-87
function conflictCodeOf(error: unknown): number | null {
  const code = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code
  return typeof code === 'number' ? code : null
}
```

`error.response` 为 `undefined`，`conflictCodeOf` 恒返回 `null`，`=== PREFERENCE_CONFLICT_CODE` 永远为 `false`。

**影响**：
- 冲突合并逻辑（`mergeWithServerThenSave`）永远不会被调用。
- 多端并发保存时，用户 A 的保存会在 4 次重试后报错「任务面板偏好保存失败，请检查网络后手动再试一次」，而不是自动合并。
- 每次冲突还会额外触发 `ElMessage.error('偏好设置已在其他端被修改，请刷新后重试')`（来自拦截器），造成重复提示。

**修复方向**：`conflictCodeOf` 需要同时处理两种错误形态：
1. axios error（HTTP 非 2xx，有 `error.response.data.code`）
2. 拦截器构造的 plain Error（HTTP 200 + code≠0，无 `response`）

可改为从拦截器 reject 时附带 code（如 `err.code = data.code`），或 `conflictCodeOf` 增加对 `error.message` 匹配的兜底。更推荐的做法是让拦截器在 reject 时保留原始 response data。

---

## Bug 2（低）：`listDislikedMessageIds` 改为抛异常后，回显失败会弹出用户可见的 ElMessage 错误提示

**文件**：`backend-ts/src/feedback/feedback.service.ts:84-99` + `desktop/src/composables/useMessageFeedback.ts:48-56`

**现象**：当用户打开一个已不存在或非本人会话的聊天历史时，会看到 `ElMessage.error` 弹出的错误提示（「会话不存在」或「无权访问该会话」），而原行为是静默返回空数组。

**根因**：

`listDislikedMessageIds` 从「返回 `[]`」改为「抛 `SESSION_NOT_FOUND` / `FORBIDDEN` 异常」。路由层 `feedback.routes.ts:68` 直接 `await` 不做 try-catch，异常冒泡到 `handleError`：

- `SESSION_NOT_FOUND`（code 3002）→ HTTP 200 + `{ code: 3002 }` → 响应拦截器走 `data.code !== 0` 分支 → `ElMessage.error('会话不存在')`
- `FORBIDDEN`（code 1002）→ HTTP 403 → 错误拦截器走 `status === 403` 分支 → `ElMessage.error('无权访问该会话')`

前端 `loadDislikedIds` 的 catch 块虽然会设置空集合并标记已加载（防止重复请求），但**拦截器已经先弹出了错误提示**，catch 块无法阻止。

**影响**：
- 正常场景（用户打开自己的会话）不受影响。
- 边界场景（会话被删除、跨用户误传 sessionId）下，用户会看到与聊天体验无关的错误弹窗。
- 注释写「不阻断聊天，仅缺失高亮态」，但实际行为与注释不符。

**修复方向**：
- 方案 A：路由层 catch 异常，对 `SESSION_NOT_FOUND` / `FORBIDDEN` 仍返回 `ok({ ids: [] })`，保持原有的静默回显语义。
- 方案 B：前端调用 `fetchDislikedMessageIds` 时传 `skipErrorToast` 标记，阻止拦截器弹提示。

---

## 已审查无问题的模块

以下变更经审查未发现功能性 bug：

- **`feedback.repository.ts` — `sumByDay` 口径统一**：改为复用 `buildDetailWhere`，与 `sumByReason` / `countTotal` / `listDetails` 同口径，逻辑正确。单侧日期缺省时按开区间处理，`getSummary` 不再对 `byDay` 静默返回空数组。

- **`delivery.service.ts` — `suppressPending` SENDING 兜底**：新增对 SENDING 状态的 CAS 兜底，与 `resolveWebSocket` 的兜底策略一致。`deliver()` 发送前会 `findById` 重查状态，确保 SUPPRESSED_WS 行不会被发出。无 CAS 支持（`updateIfStatus` 缺失）时回退 `updateById`，生产环境 `DeliveryDbStore` 始终有 `updateIfStatus`，回退路径仅用于测试。

- **`streaming-ws-registry.ts` — 关键帧分队列**：`criticalQueue` 不受 capacity 限制，`flushNow` 优先冲刷关键帧。`shutdown` 时 resolve 所有 pending `resultFuture`，避免等待方永久悬挂。`sendWithResult` 的 tracked 事件一律走 criticalQueue，不再被普通队列满丢弃。逻辑自洽。

- **`task-panel-preference.service.ts` — 乐观锁**：`save` 方法在 `expectedVersion` 不匹配或 `updateByUserId` 返回 false 时抛冲突异常，版本号递增逻辑正确。旧客户端不传 `expectedVersion` 时跳过前置检查但仍走 CAS UPDATE（`row.version` 来自 SELECT），并发安全。
