### 后端

- **修复新建默认 Agent 失败会把全库默认旗标清光**：创建 Agent 时「勾选设为默认」会先清旧默认旗标再校验默认模型，模型缺失/停用导致创建失败时全库零默认 Agent、所有新会话创建中断；已把模型校验前置到清旗标之前。
- **修复钉钉超长回复截断在 emoji 中间产生乱码**：回复截断与标题截断按 UTF-16 码元硬切，切点落在代理对中间时留下孤立代理，对端渲染 U+FFFD；已统一改用按码点计数的 `clipByCodePoints`。
- **修复无进展守护对定时任务/哨兵类工具永不触发**：`create_scheduled_task` / `create_signal_watcher` 返回的自增 id 未按工具归一化，模型同参数反复创建时每轮签名都不同，第 5/10 轮提醒与第 15 轮中止永不触发；已按 AGENTS.md 三处同步义务补齐按工具归一化。
- **修复 agent 级压缩覆盖的越界值导致 token 压缩静默关闭**：agent 级 `contextWindowTokens` / `maxSummaryTokens` 覆盖缺越界兜底，0/负数/NaN 放行后 token 维度自动压缩被静默关闭、NaN 还会写进压缩指令；已与同函数 `triggerRatio` 同口径补兜底。
- **修复微信降级推送超长截断在 emoji 中间产生乱码**：微信回复送不出去时唯一可见渠道的正文/卡片截断同样按码元硬切，已改用 `clipByCodePoints`。
- **管理后台反馈列表支持「无 Agent」筛选**：`agentIdNull=true` 显式标记可下达「agent_id IS NULL」三态约束，修复矩阵「无 Agent（飞书）」下钻实际返回全部 Agent 反馈的问题。

### 管理后台

- **修复反馈页取消选择后复选框残留、误删不可逆**：取消选择只清组件状态不清表格内部选区，再勾选时会复活已取消的行进批量忽略；已同时调用 el-table 的 `clearSelection()`。
- **修复反馈矩阵「无 Agent（飞书）」下钻不过滤**：点击无 Agent 行时 null 被折叠成 undefined，列表请求与「不筛选 Agent」完全同形、混入全部 Agent 的反馈；已下发显式空 Agent 标记。

### 终端 CLI（mao-agent）

- **修复 `--if-running=cancel` 期间 Ctrl+C 后消息仍被发出**：print 模式取消占用者后无条件重置轮次状态，把用户的 Ctrl+C 取消旗标清掉，被取消的消息照常发给服务端；已补上与等待分支相同的守卫。
