### 后端

- **用量分析 Token 口径统一为 llm_call**：总览「Token 消耗」卡片、其 spark 折线、环比窗口的 `totalTokens` 与模型明细的 `totalTokens` 全部改取 `SUM(llm_call.total_tokens)`（原为 `message.token_count` + `llm_usage.total_tokens`），同窗口同「含自检调用」开关下，三处数字与调用流水、成本口径严格相等；`GET /v1/admin/analytics/overview` 新增透传 `excludeConnectivity`，总览页的「含自检调用」复选框此前只影响趋势 / 模型 / 用户 Tab，对成本、缓存命中率无效。
- **用户维度聚合归并无主调用**：`llm_call` 按用户聚合由 `user_id IS NOT NULL` 改为 `COALESCE(user_id, 0)`，无用户上下文的系统 / 后台调用（Git 提交信息、定时任务等）计入 `userId=0`「未关联用户」，使「用户 Token 占比」中心数不再比模型侧少算一块；用户 Tab 明细遍历用户列表，不会出现假用户行。

### 管理后台

- **三处 Token 数字对得上**：总览卡片、模型占比环、用户占比环改用同一 `llm_call` 口径并各自标注口径来源；模型占比环新增「未关联用户」分桶（与既有「未关联模型」对称）。两个环图中心同读 `periodTotals.totalTokens`（窗口全量），不再各自对排行数据求和——用户排行按 100 行截断，超限时求和会少算，现在截断只影响「其他」扇区。
- **模型用量明细表删「Token 合计」列**：该列改口径后与「调用 Token」逐行相同，占比列与 CSV 导出同步改用「调用 Token」；「窗口构成」里的对话 / 后台 Token 补上口径后缀，避免与头部卡片混为一谈。
