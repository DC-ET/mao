# 代码审查报告：信号哨兵 Shell 脚本探针（V189 / 0.0.494）第一轮

- 日期：2026-11-10
- 审查范围：git 工作区未提交代码（V189 迁移、backend-ts/src/signal/、harness 内置工具与装配、desktop 表单/视图/选择器、admin 列表、E2E；文档变更按约定未审）
- 规格依据：`docs/plan/2026-11-10-shell-script-signal-watcher-technical-design.md`（§3.1 决策表、§3.3 值表、§2.2 非目标）
- 验证产物：`/tmp/mao-review/verify3.mts`（未入仓库）

## 结论

**有 bug：2 个功能缺陷（均在管理后台列表链路）+ 1 个低危规格偏差。** 核心执行链路（script-probe 执行器、service 分流/校验/基线重置、内置工具、desktop 表单互斥出参与脚本选择器、判定/退避/触发复用）未发现功能性 bug。

| # | 位置 | 严重度 | 一句话描述 |
|---|---|---|---|
| 1 | `backend-ts/src/signal/signal-admin.routes.ts:57-76` | 高 | `/v1/admin/signal-watchers` 列表响应漏带 `probeType`/`scriptPath`/`scriptTimeoutSeconds`，admin 新增「类型」列对**所有行**（含 HTTP 哨兵）恒渲染为空白 |
| 2 | `admin/src/views/signal/SignalWatcherListView.vue:41-44` | 中 | 列表「探测地址」「方法」两列未按 §3.1 定案对 SCRIPT 行渲染「脚本：`<path>`」与「—」，脚本哨兵在管理后台列表看不到探测对象 |
| 3 | `backend-ts/src/signal/watcher.service.ts:482` | 低 | 「立即测试」SCRIPT 的 stdout 样例取 200 字，规格 §4 步骤 4.2 定案为「stdout 头 500 字」 |

## Bug 1（高）：admin 列表接口漏带 V189 三字段，「类型」列恒为空白

**位置**：`backend-ts/src/signal/signal-admin.routes.ts:57-76`

`GET /v1/admin/signal-watchers` 的 `records` 是逐字段显式映射的（id/name/userId/username/url/method/intervalMinutes/compareMode/jsonPath/triggerMode/status/...），本次改动只扩了 admin 前端视图（`SignalWatcherListView.vue` 新增「类型」列读 `row.probeType`，本地 `WatcherRow` 接口也声明了 `probeType`/`scriptPath`/`scriptTimeoutSeconds`），**但没有同步扩这个后端映射**。结果是三个字段在运行时永远是 `undefined`：

- `probeTypeLabel(row.probeType)` → `PROBE_TYPE_LABELS[undefined] ?? undefined` → **类型列每行都空白（HTTP 哨兵也空白）**；
- TS 编译期发现不了（本地 `WatcherRow` 接口自声明有这些字段，admin 无 tsc 穷尽校验可依赖）；本次新增的 admin E2E 只断言表头存在，也拦不住。

技术方案 §4 步骤 8 明确要求「admin API 类型同步（admin 侧哨兵接口类型定义文件加三字段）」，§3.1「admin 展示」行整个建立在这三字段随列表下发之上。

**验证（已实际执行）**：`/tmp/mao-review/verify3.mts` 用假 fastify 捕获 `registerSignalAdminRoutes` 的 GET handler，注入含 `probeType='SCRIPT'`、`scriptPath='ops/sentinels/disk.sh'`、`scriptTimeoutSeconds=60` 的仓库行后调用 handler，解析响应信封：

```
SCRIPT 哨兵行入参含 probeType = SCRIPT , scriptPath = ops/sentinels/disk.sh
响应 record 键: id, name, userId, username, url, method, intervalMinutes, compareMode, jsonPath, triggerMode, status, consecutiveFailures
BUG1 证实：响应缺 probeType, scriptPath, scriptTimeoutSeconds
```

**修复方向**：在 `signal-admin.routes.ts` 的 `records` 映射里补 `probeType: row.probeType`、`scriptPath: row.scriptPath ?? null`、`scriptTimeoutSeconds: row.scriptTimeoutSeconds ?? null` 三键（存量行迁移默认 `'HTTP'`，无需回落）。

## Bug 2（中）：admin 列表「探测地址」「方法」列未按定案渲染脚本哨兵

**位置**：`admin/src/views/signal/SignalWatcherListView.vue:41-44`

```vue
<el-table-column label="探测地址" min-width="220" show-overflow-tooltip>
  <template #default="{ row }">{{ row.method }} {{ row.url }}</template>
</el-table-column>
<el-table-column prop="method" label="方法" width="70" />
```

技术方案 §3.1「admin 展示」定案：「探测地址」列 SCRIPT 显示「脚本：`<path>`」，「方法」列 SCRIPT 显示「—」；§2.1 目标 7 同义。实现只改了**详情抽屉**（`probeTargetText`，第 117 行），列表两列未动。而 SCRIPT 哨兵落库时 `url=''`、`method='GET'`（`normalizeInput` 单侧归空，新增 service 用例已断言 `view.url === ''`），所以管理后台列表里每条脚本哨兵：

- 「探测地址」列渲染为孤零零的「GET」，管理员完全看不到该哨兵在跑哪个脚本；
- 「方法」列显示「GET」而非定案的「—」。

与 Bug 1 相互独立：即使后端把三字段补进列表响应，这两个列模板不读 `row.probeType`/`row.scriptPath`，显示依旧错误。两处需同修。

**验证**：静态证据链——(a) 列表列模板未引用 scriptPath/probeType（全文件 grep，`probeTargetText` 仅第 117 行详情抽屉使用）；(b) SCRIPT 行 `url=''` 已由 `watcher.service.spec.ts` SCRIPT 组「HTTP 侧字段归空」用例证实；(c) 规格原文引用如上（`docs/plan/2026-11-10-shell-script-signal-watcher-technical-design.md:63`、`:182`）。

## Bug 3（低）：「立即测试」SCRIPT 样例 200 字，规格定案 500 字

**位置**：`backend-ts/src/signal/watcher.service.ts:482`（`sample: (result.body ?? '').slice(0, WATCHER_TEST_SAMPLE_CHARS)`，常量 200 见 `:38`）

技术方案 §4 步骤 4.2（`:144`）定案「`sample` 语义对 SCRIPT = stdout 头 500 字」。实现沿用 HTTP 的 200 字口径（desktop 测试弹窗文案「（前 200 字）」与实现一致，但与方案不符）。功能影响轻微（仅样例展示截得更短），按定案表属于规格偏差：二选一对齐——代码改 500（SCRIPT 分支单独切片），或修订方案文档。

## 已核对、确认「按规格既定行为 / 非目标」而非 bug 的点

为免复看时重复提报，以下疑似点均判定为不是 bug：

- 脚本在后端宿主执行、不随 docker 运行模式分流；无凭据 env 注入（env 仅 `PATH`/`HOME`/`TZ`/`MAO_WATCHER_ID`/`MAO_WATCHER_NAME`）；无静态审查/白名单（§2.2 非目标 1/2/3）。
- SCRIPT 仅 HASH/JSON_FIELD、exit code 只作成败语义、`signal_watcher_check.exit_code` 超时/超限击杀记 null（§3.2/决策 2）。
- `watcher_id` 不进 `VOLATILE_RESULT_KEYS`、`no-progress-notice.ts` 零改动（§3.1「工具结果 id 处理」行）。
- 仅 list/create 两个内置工具，无 update/delete（§2.2 非目标 4）；`list_signal_watchers` 返回全部本人哨兵（规格「列自己名下哨兵」）。
- 间隔下限 5 分钟仅对 SCRIPT、`scriptTimeoutSeconds` 不进 `AFFECTS_BASELINE`（§3.1 两行）。
- 编辑 SCRIPT 哨兵时即使只改名也会重验脚本文件存在——service 注释与 R8 一致，属既定行为。
- 管理后台「轮询记录」详情 tab 状态码列对脚本行显示「-」（admin 本批次规格只要求类型/地址/方法三处展示）。
- 复制（copyFrom）继承、掩码请求头还原、复用指针维护等既有链路在本分支下行为逐字不变（SCRIPT 侧字段互斥归空由 `normalizeInput` + desktop `buildWatcherPayload` 双侧覆盖，desktop 单测已锁）。

## 回归门禁（审查期间实跑）

- `backend-ts`：`npm run build` ✓；`npm test` 469 文件 / 5825 用例全绿（含新增 `script-probe.spec.ts`、`watcher.service.spec.ts` SCRIPT 组、`signal-watcher-tools.spec.ts`）。
- `desktop`：`npm run build`（vue-tsc -b + vite）✓；`signal-watcher-form.test.ts` 37 用例全绿。
- `admin`：`npm run build` ✓。
