# 管理后台定时任务：提示词可见 + 编辑能力 设计方案（2026-09-22）

> 状态：**已确认并实施**（0.0.181）。决策结论见下表；下文「待确认决策点」保留原始选项供回溯。

## 0. 决策结论（2026-09-22 确认）

| # | 决策点 | 结论 | 实施落点 |
| --- | --- | --- | --- |
| 1 | 提示词展示形态 | **只在详情弹窗展示**，列表/移动卡片不加提示词列 | `ScheduledTaskDetailDialog.vue`；列表操作列改「查看 / 编辑 / 删除」 |
| 2 | `once` 开关 | **暴露**给管理员，同时保留「改 Cron 时开关自动跟随形态」的兜底 | `ScheduledTaskFormDialog.vue`（`onceTouched` 标记 + 预览 `oneShot` 同步） |
| 3 | 编辑权限门槛 | **新增权限点 `scheduled-task:write`**（默认授予 ADMIN） | `V118__scheduled_task_write_permission.sql`；路由读写门槛拆分 |
| 4 | 审计 | **纳入**：`/v1/scheduled-tasks` 的变更方法写审计，读取与 cron 预览不写 | `audit.interceptor.ts`（`AUDITED_WRITE_PREFIXES` + 排除预览） |
| 5 | Cron 预览接口 | **本次一起做** | `POST /v1/scheduled-tasks/cron-preview` + 编辑弹窗防抖预览 |
| 6 | 发布流程 | 本服务走独立流程：**提交推送代码 → `/data` 目录执行部署脚本**（`bash /data/deploy-mao.sh`，脚本内 `git pull` + 构建三端 + 后端蓝绿重启）；不走 PMO/发布平台 | 见 `mao/AGENTS.md` 与 `/data/deploy-mao.sh` |

## 1. 需求

1. 管理后台「定时任务」页面看不到具体的**任务提示词（prompt）**。
2. 需要增加**编辑定时任务**的能力。

## 2. 代码现状（已核对，附定位）

| 事实 | 位置 |
| --- | --- |
| 列表接口已返回全字段（`SELECT *`，含 `prompt`） | `backend-ts/src/schedule/scheduled-task.store.ts:57`（`listAll`） |
| 前端 `ScheduledTask` 接口里已声明 `prompt`，但表格/卡片从未渲染 | `admin/src/views/scheduled-tasks/index.vue:238`、列定义 `:58-104`、移动卡片 `:135-186` |
| 更新接口已支持 `name / prompt / cronExpression / status / once`（部分更新） | `backend-ts/src/schedule/scheduled-task.routes.ts:64`、`scheduled-task.service.ts:194`（`updateTask`） |
| 改 cron 会重新解析并重算 `nextFireTime`；`next` 非空时把 `finished` 复位为 0 | `scheduled-task.service.ts:205-223` |
| 改 cron 且未显式传 `once` 时，按新 cron 形态重判一次性（与创建一致） | `scheduled-task.service.ts:208-210`、`isOneShotCron` `:94` |
| 鉴权门槛：他人任务读写 = 持 `session:read`（与列表同门槛），页面菜单也只要 `session:read` | `scheduled-task.routes.ts:20-23`、`admin/src/components/SideMenu.vue:121` |
| 操作列现状：仅「启停开关 / 查看会话 / 删除」 | `admin/src/views/scheduled-tasks/index.vue:104-131`（桌面）、`:165-186`（移动） |
| 字段约束：`name VARCHAR(200) NOT NULL`、`prompt TEXT NOT NULL`、`cron_expression VARCHAR(100)` | `backend-ts/db/migration/V061__scheduled_task.sql` |
| 服务端目前**没有** name/prompt 的长度与非空校验（空串、超长会直接落库或报 SQL 错） | `scheduled-task.service.ts:181`、`:194` |
| 定时任务接口**未纳入审计**（`AUDITED_PREFIXES` 不含 `/v1/scheduled-tasks`） | `backend-ts/src/audit/audit.interceptor.ts:5-13` |
| 现有可复用的同类实现（长文本列 + 查看详情 + 编辑弹窗） | `admin/src/views/system-commands/SystemCommandListView.vue:58-66`（clamp + tooltip）、`:216-230`（详情 `pre`）、`:187-214`（编辑表单） |
| 桌面端设置页已有提示词展示与 2 行截断的参考样式 | `desktop/src/components/ScheduledTaskPanel.vue:79` |

**结论**：`prompt` 只是前端没展示；编辑能力的**后端接口已就绪**（CLI/桌面端已在用同一 PUT）。
因此本需求的改动集中在 admin 前端，后端只补「入参校验」和一个可选的「Cron 预览」接口，不需要 DB 迁移。

## 3. 目标 / 非目标

目标
- 管理员在列表就能瞟到提示词，并能查看完整提示词与任务全貌。
- 管理员能编辑任务：任务名称、任务提示词、Cron 表达式；保存前能看到 Cron 的合法性判定与下次触发时间。

非目标（本次不做）
- 不提供「新建定时任务」（创建入口仍为 Agent 工具 `create_scheduled_task`，`admin` 不新增创建按钮）。
- 不允许改 `user_id / agent_id / session_id`（任务归属与执行上下文，改了语义就变了）。
- 不引入 cron 可视化编辑器（分钟/小时勾选式 UI）。
- 不改桌面端设置页与用户详情抽屉的既有行为（见 §9 可选项 C）。

## 4. 交互设计

### 4.1 列表：让提示词「看得见」

- 按决策 1，**列表不加提示词列**：桌面表格与移动卡片保持原字段，提示词只在详情弹窗展示。
- 操作列由「启停开关 / 查看会话 / 删除」改为 **启停开关 / 查看 / 编辑 / 删除**（宽度 `220 → 300`）：原「查看会话」并入详情弹窗的「所属会话」跳转。
- 写操作可见性由 `canModify(row)` 控制（本人任务 或 持 `scheduled-task:write`）；无权时开关置灰并给出 title 说明，编辑/删除不渲染。

### 4.2 详情弹窗（`ResponsiveDialog`，宽 720px）

- `el-descriptions`（2 列）：ID、任务名称、用户、Agent、所属会话（可点击跳 `/sessions/:id`）、Cron 表达式（含「一次性」标签）、状态、完结（含完结时间）、上次执行、触发次数、上次触发、下次触发、创建时间、更新时间。
- 「任务提示词」区块：`pre` 白底滚动（`max-height: 420px`、`pre-wrap`、可复制按钮），完整展示 `prompt` 原文。
- 一句灰色说明：*触发时系统会在提示词前自动附加「本次由定时任务 XX 触发」的说明，此处为任务本体原文。*
- 弹窗底部：关闭 / 编辑。

### 4.3 编辑弹窗（`ResponsiveDialog`，宽 720px）

表单字段（对齐服务端能力，只暴露可安全修改的部分）：

| 字段 | 控件 | 校验 |
| --- | --- | --- |
| 任务名称 | `el-input` | 必填、trim 后非空、≤ 200 字符 |
| Cron 表达式 | `el-input`（placeholder `0 0 9 * * ?`） | 必填、6 段（秒 分 时 日 月 周）、服务端校验通过 |
| 下次触发预览 | 只读文本 | 由 Cron 预览接口返回未来 3 次时间（北京时间） |
| 任务提示词 | `el-input` textarea，10 行 | 必填、trim 后非空、≤ 10000 字符 |

- **不含 `status`**：启停已由列表开关承担，一处修改入口避免两处状态打架。
- **含 `once` 开关**（决策 2）：默认取任务当前值；用户手动拨过后以手动为准，未拨动且 Cron 被改动时跟随预览返回的 `oneShot` 自动同步（避免「一次性 Cron + 关闭开关 → 任务每年重复」的坑）。开关与 Cron 形态不一致时给出黄色提示，说明保存后以开关为准。
- 提交体固定为 `{ name, prompt, cronExpression, once }`。
- 保存成功：`ElMessage.success('已保存，下次触发 ' + nextFireTime)`，刷新当前页列表。
- 保存失败：沿用拦截器的错误提示（后端 `无效的 cron 表达式: ...` / `PARAM_INVALID` 文案直接透出）。

### 4.4 Cron 预览（推荐项，见 §5.3）

- 弹窗打开时用当前 Cron 拉一次预览；用户编辑 Cron 后 400ms 防抖重拉。
- 结果三态：
  - 合法：展示「未来 3 次触发：…（北京时间）」，`once` 自动判定为一次性时追加标签「一次性任务」。
  - 非法：输入框下方红色提示后端返回的 message，**保存按钮置灰**。
  - 不足 6 段：不请求接口，直接本地提示（省一次往返）。
- 弹窗打开时若任务为已完结状态，顶部提示：*该任务已完结；修改 Cron 并保存后会自动重新激活（`finished` 复位为 0）。*（对应 `updateTask` 的既有行为）

## 5. 后端改动

### 5.1 入参校验（必做）

在 `ScheduledTaskService` 抽一个私有 `validateName/validatePrompt`（或统一 `validateTaskPayload`），`createTask` 与 `updateTask` 共用：

- `name`：`trim()` 后非空，长度 ≤ 200（对齐 `VARCHAR(200)`），否则 `PARAM_INVALID`「任务名称不能为空 / 不能超过 200 字符」。
- `prompt`：`trim()` 后非空，长度 ≤ 10000（`TEXT` 约 64KB，utf8mb4 下 10000 字符最坏 4 字节/字符仍有余量），否则 `PARAM_INVALID`。
- `cronExpression`：沿用现有 `parseCron`（`croner` 解析，兼容 Spring `?`），不动。
- 仅校验「传入且非 null」的字段，保持 `updateTask` 的部分更新语义。

影响面：REST 与 Agent 工具 `create_scheduled_task` 两条路径同时受益（空 prompt 的任务本体没有任何可执行内容，属于真问题）。

### 5.2 编辑能力：无需新增接口

`PUT /v1/scheduled-tasks/:id` 已具备全部所需能力（含 `allowNonOwner` 门槛），本次不新增、不改签名，只把非本人任务的门槛从 `session:read` 换成新的 `scheduled-task:write`。

### 5.3 Cron 预览接口（已实施）

```
POST /v1/scheduled-tasks/cron-preview
权限：session:read（与列表/详情同门槛）
请求：{ "expression": "0 0 9 * * ?", "count": 3 }   // count 1..10，默认 3
响应(ok)：
  合法 { valid: true,  oneShot: false, nextFireTimes: ["2026-09-23 09:00:00", ...], message: null }
  非法 { valid: false, oneShot: false, nextFireTimes: [], message: "无效的 cron 表达式: ..." }
```

- 非法表达式不抛 `BusinessException`，用 `ok` + `valid:false` 返回：预览时输错属预期中间态，不该弹全局错误 toast。
- 实现：`buildCronPreview()`（`scheduled-task.service.ts`）复用 `normalizeSpringCron` + `croner` 的 `nextRuns(count)` + `Asia/Shanghai`，与调度器**同一套解析与时区**；`oneShot` 直接复用 `isOneShotCron(expression)`。
- 用 `POST` 而非 `GET /cron-preview?expression=...`：避免与 `/v1/scheduled-tasks/:id` 同方法同层级的静态/参数路由歧义。
- 前端：弹窗打开即预览一次，手动编辑走 400ms 防抖；本地先卡「必须 6 段」，不合法则保存置灰。

### 5.4 审计覆盖（已实施）

`AUDITED_PREFIXES` 不含 `/v1/scheduled-tasks`，意味着跨用户改他人提示词此前**不留痕**。现新增 `AUDITED_WRITE_PREFIXES = ['/v1/scheduled-tasks']`：仅 `POST/PUT/PATCH/DELETE` 写审计，`GET` 列表/详情不写；读取型 `POST /cron-preview` 由 `AUDITED_WRITE_EXCLUDES` 排除，避免每次编辑击键都落一条日志。审计内容只有 path / objectId / 操作人，不含 prompt 正文，无敏感信息外泄风险。

## 6. 前端改动清单

| 文件 | 改动 |
| --- | --- |
| `admin/src/views/scheduled-tasks/index.vue` | 操作列加「查看/编辑」并按 `canModify` 控制写操作；弹窗接线；保存后刷新；类型改用 `ScheduledTaskRow` |
| `admin/src/views/scheduled-tasks/ScheduledTaskFormDialog.vue` | 新建：编辑表单（名称 / Cron + 预览 / 提示词 / 一次性开关） |
| `admin/src/views/scheduled-tasks/ScheduledTaskDetailDialog.vue` | 新建：任务全貌 + 完整提示词 |
| `admin/src/views/scheduled-tasks/types.ts` | 新建：`ScheduledTaskRow` / `CronPreviewResult` |
| `admin/src/views/scheduled-tasks/task-display.ts` | 新建：执行状态文案与标签色（列表与详情共用，取代原先只在 `index.vue` 里的一份） |

拆成独立组件而非单文件内联：`index.vue` 已 414 行，再叠加两个弹窗与预览逻辑会超过 700 行；`views/agent/AgentFormDialog.vue` 已是「列表页 + 独立弹窗组件」的既有先例。

## 7. 边界与风险

- **已完结任务**：改 Cron 保存后会 `finished=0` 重新激活（服务端既有行为），编辑弹窗顶部用 alert 显式说明。
- **一次性语义**：开关暴露（决策 2），并保留「Cron 被改动且用户未手动拨动开关时自动跟随形态」的兜底；两者不一致时在开关下方显式提示保存后以开关为准。
- **权限收口**：读（列表/详情/预览）仍是 `session:read`，写他人任务改为 `scheduled-task:write` 且默认只授予 ADMIN；此前靠 `session:read` 就能启停/删除他人任务的自定义角色需要显式补授权。
- **并发编辑**：`updateTask` 是「读-改-写」，两位管理员同时改同一任务时后者覆盖前者。当前量级可接受，不引入乐观锁。
- **超长提示词**：`TEXT` 上限约 64KB，服务端加 10000 字符上限并在表单同步提示；详情弹窗 `pre` 内滚动，不撑破布局。
- **含 `%` 等字符的提示词**：列表关键词搜索本身是 `LIKE`（既有实现），本次不改。

## 8. 测试与验证（已执行）

后端（Vitest）
- `scheduled-task.service.spec.ts` 增补：`name` 空/超长、`prompt` 空/超长 → `BusinessException(PARAM_INVALID)`；仅传部分字段时不影响其他字段；创建时对 name/prompt 做 trim。
- `previewCron`：合法表达式返回 `count` 条时间（Asia/Shanghai、格式 `YYYY-MM-DD HH:mm:ss`）、Spring `?` 兼容、一次性形态 `oneShot=true`、非法/空表达式 `valid=false` 且带 message、`count` 越界收敛到 1..10。
- `audit.interceptor.spec.ts`：定时任务 `GET` 不审计、`PUT/DELETE` 审计、`cron-preview` 不审计。

前端（Playwright，新增 `tests/admin-scheduled-tasks.spec.ts`，沿用 `page.route` mock 风格，5 例）
- 详情弹窗展示完整提示词与全字段；编辑弹窗打开即预览 Cron、保存请求体恰为 `{ name, prompt, cronExpression, once }`。
- 改成一次性 Cron 形态时开关自动跟随并提交 `once: true`；非法 Cron 提示错误并禁用保存；无 `scheduled-task:write` 时他人任务只读。
- 回归 `tests/admin-datetime.spec.ts`（定时任务表格/移动卡片时间展示）保持通过。

构建与回归
- `cd backend-ts && npm run build && npm test`
- `cd admin && npm run build`（vue-tsc 严格校验）

## 9. 未纳入本次（可后续做）

- **C（一致性）**：`admin/src/views/user/UserDetailDrawer.vue` 的「定时任务」Tab 加提示词列 + 查看详情（只读）。
- **D**：桌面端设置页是否也给用户开放「编辑」（当前仅启停/删除）。
- **E**：CLI `scheduled-task preview` 子命令（当前仅 REST + 管理后台）。

## 10. 决策点（已按 §0 结论实施）

原始备选：提示词只在详情弹窗展示（√）/列表加列；`once` 暴露（√）/不暴露；新增 `scheduled-task:write`（√）/沿用 `session:read`；审计纳入（√）/不动；Cron 预览本次做（√）/延后。

## 11. 实施顺序与产出

1. Phase 1（核心）：后端读写门槛拆分 + 校验补齐 → 前端详情弹窗 + 编辑弹窗 → 单测与 e2e。
2. Phase 2：`cron-preview` 接口 + 弹窗预览接入。
3. Phase 3：审计覆盖。
4. 交付同步：`CHANGELOG.md` 顶部 `0.0.181`（管理后台 + 后端小节）；`skills/mao-cli/reference/admin.md` 与 `scheduled-task.md` 更新门槛与新增能力；`skills/mao-cli/lib/commands/scheduled-task.js` HELP 补充写权限与长度约束。
5. 发布：走本服务独立流程（推送 `origin/main` 后 `bash /data/deploy-mao.sh`）。
