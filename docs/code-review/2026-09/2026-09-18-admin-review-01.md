# 管理后台首页（用量分析 /analytics）前端代码审查

- 审查日期：2026-09-18
- 审查范围：仅管理后台首页（登录后管理员默认落地的用量分析页），即
  `admin/src/views/analytics/**`、`admin/src/components/BaseChart.vue`、
  `admin/src/components/Layout.vue`（keep-alive 容器）及关联工具
  （`chart-options.ts`、`metrics.ts`、`useScopeQuery.ts`、`useAnalyticsPeriod.ts`）。
- 严重程度：🔴 高（功能/正确性）｜🟡 中（交互/性能/安全）｜🟢 低（UI/一致性/维护性）

---

## 1. 🔴 keep-alive 与 `:key="fullPath"` 组合，query 一变就重建组件，缓存形同虚设

位置：`admin/src/components/Layout.vue:73`（`<component :is="Component" :key="viewRoute.fullPath" />`）
关联：`admin/src/views/analytics/AnalyticsView.vue`（tab/period/modelId 全部写入 query）

问题：
- 首页的 tab、统计周期、modelId 都同步到 URL query。任何一次切换 tab 或周期，
  `fullPath` 变化 → key 变化 → Vue 视为"不同组件"，直接销毁重建实例。
- 后果：
  1. `TrendsTab` 内部"流量/Token/调用/质量"视图选择等本地状态全部丢失；
  2. `useScopeQuery` 的模块级缓存虽然能命中数据，但整棵组件树（含 6 个 Tab 的
     ECharts 实例）反复创建销毁，图表重新 init，白屏闪烁；
  3. keep-alive `:max="8"` 会被 analytics 的 query 组合（6 tab × 6 period × …）
     快速挤占，把其他页面（用户管理、会话管理等）的缓存逐出，keep-alive 失去意义。

建议：key 改用 `viewRoute.path`（或 `viewRoute.name`），query 状态已由组件内部
watch + `router.replace` 管理，不需要靠 key 重建。

## 2. 🔴 页面初始化存在并发重复请求（onMounted 与 route watch 竞态）

位置：`admin/src/views/analytics/AnalyticsView.vue` 末尾 `onMounted` 与 `watch(() => [route.query...])`

问题：
- `onMounted` 里先 `syncUrl()` 再 `loadActive(false)`。若 URL 缺参数（例如直接访问
  `/analytics`），`syncUrl()` 的 `router.replace({ query })` 会触发 route.query 的
  watch，watch 内又 `loadActive(true)`，与 `onMounted` 的 `loadActive(false)` 并发执行。
- `useScopeQuery` 的 `seq` 守卫能保证最终状态不错乱，但同一份数据会发出两次
  HTTP 请求（key 相同时 inflight 去重可部分掩盖；force=true 的那次绕过去重，
  必然双发）。

建议：初始化只留一条路径——要么 watch `{ immediate: true }`，要么 onMounted 判断
query 已同步才请求。

## 3. 🔴 "含自检调用"开关状态不进 URL，分享/刷新后丢失

位置：`admin/src/views/analytics/AnalyticsView.vue` `syncUrl()`（只同步 tab/period/modelId）
关联：`ModelTab.vue` 顶部 `el-checkbox`（含自检调用）

问题：
- `excludeConnectivity` 参与请求与缓存 key（`useAnalyticsPeriod.ts` 的 `periodKey`），
  但 `syncUrl()` 不把它写进 query。用户取消勾选后刷新页面或把链接发给别人，
  状态回到默认"含自检"，数据口径悄悄变化，且 UI 与数据可能不一致。
- 对比：`modelId`（同为模型 Tab 的场景筛选）已同步 URL，两个开关行为不一致。

建议：`syncUrl()` 补充 `excludeConnectivity`（仅 models tab 写入），watch 中同步回填。

## 4. 🔴 手动刷新只失效当前 Tab，跨 Tab 数据时间口径不一致

位置：`admin/src/views/analytics/AnalyticsView.vue` `handleRefresh()`（`invalidateAnalytics(activeTab.value)`）

问题：
- 顶部的刷新按钮语义是"刷新当前数据"，但缓存 key 含周期不含时间戳：在"今日"窗口
  下刷新总览后切到"趋势"，`!force && slot.data != null` 直接命中 5 分钟前拉取的旧缓存，
  两个 Tab 展示的是不同时刻的数据快照，无任何提示。
- 反过来 `handlePeriodChange` 却 `invalidateAnalytics()` 全清，两个入口语义不统一。

建议：至少在缓存命中时显示数据拉取时间（`period` meta 里有窗口，但无拉取时刻）；
或给缓存加 TTL；或刷新按钮提供"刷新全部"选项。

## 5. 🔴 ECharts tooltip 直接拼接 HTML，模型/用户/Agent 名称未转义（存储型注入风险）

位置：`admin/src/views/analytics/chart-options.ts` `tooltipRows()` 与 `donutOption()` 的 tooltip formatter

问题：
- ECharts tooltip formatter 的返回值默认按 HTML 渲染。`donutOption` 中
  `${param.marker}${param.name}<br/>...` 的 `name` 来自 `modelStats[].modelName`、
  用户 displayName、Agent 名称——这些是数据库字段，管理员/用户可写。
- 名称形如 `<img src=x onerror=...>` 时，在模型占比图悬停即可触发脚本执行。
  虽然入口需要一定权限，但这是典型存储型 XSS 面 SSC 没有覆盖的盲区。

建议：对 `name`/`seriesName` 做 HTML 转义（封装 `escapeHtml`），legend formatter
的截断逻辑同理。`TrendsTab.vue` 内手写的两个 option 也检查了一遍：它们只用常量
seriesName 与数字，暂不受影响，但应统一走带转义的公共 formatter。

## 6. 🟡 "最后登录"列直接输出原始字符串，未走统一时间格式化

位置：`admin/src/views/analytics/tabs/UserTab.vue:67`
`<el-table-column prop="lastLoginAt" label="最后登录" width="170" class-name="hide-on-mobile" />`

问题：
- 全项目其他表格均使用 `formatDateTimeColumn`（`admin/src/utils/datetime.ts`，
  统一解释为北京时间、校验合法性、无效值显示"-"）。此处直接 `prop` 输出，
  会显示后端原始 ISO 字符串（含可能的 `T`/时区），与其他页面格式不一致，
  且空值显示为空而不是 `-`。

建议：加 `:formatter="formatDateTimeColumn"`。

## 7. 🟡 Tab 切换视图状态（流量/Token/调用/质量）不进 URL，无法直达与分享

位置：`admin/src/views/analytics/tabs/TrendsTab.vue`（`view = ref('traffic')` 局部状态）

问题：
- 总览页的指标卡点击跳 `/analytics?tab=trends`，但只能落到默认"流量"视图；
  想直达"质量"图没有入口。结合问题 1（key=fullPath 重建），即使本地记住也
  经常被重置。
- 顶部工具栏的周期、tab 均已 URL 化，唯独这一层视图选择没有，交互模型不完整。

建议：视图写入 query（如 `view=quality`），或至少在 keep-alive 修复后确认
状态保留符合预期。

## 8. 🟡 所有 Tab 声明的 `error` prop 从未使用（死代码 + 误导）

位置：`OverviewTab/TrendsTab/ModelTab/UserTab/AgentTab/SessionTab.vue` 的
`defineProps<{ ...; error?: boolean }>`；`AnalyticsView.vue` 逐个传入 `:error="activeError"`。

问题：
- 错误态实际由父级 `TabError` 全量接管（`v-if="activeError"` 时 Tab 组件根本不渲染），
  Tab 内部的 `error` prop 没有任何消费点。这是接口噪音：后来者会误以为 Tab 需要
  自行处理错误态，或怀疑父级漏传了展示逻辑。
- `useScopeQuery` 返回的 `refresh`/`reset` 同样无人调用。

建议：删除未使用的 prop 与返回值，或在 Tab 内真正利用（如局部错误横幅）。

## 9. 🟡 环比 delta 在"从 0 增长"场景直接不显示，信息丢失且语义易混淆

位置：`admin/src/views/analytics/composables/metrics.ts:2-4`

```ts
if (previous == null || previous === 0) return current > 0 ? null : 0
```

问题：
- 上期 0、本期 100 → `delta=null` → 不展示任何环比。对运营来说"从 0 到 100"
  恰恰是最值得关注的信号（新功能上线、新用户导入），现在却被静默吞掉。
- `null`（不渲染）与 `0`（"持平"）共用 `deltaText`/`deltaClass` 的 flat 分支，
  调用方（OverviewTab 的 `tokenDelta !== null` 判断）到处要判空，逻辑分散。

建议：previous=0 且 current>0 时显示"新增"或 `∞`/`--` 样式标记，而不是留空。

## 10. 🟡 BaseChart 对大 option 对象做 deep watch，性能反模式

位置：`admin/src/components/BaseChart.vue:59` `watch(() => props.option, render, { deep: true })`

问题：
- option 内含 tooltip formatter 函数、dataZoom、大量 series 数组，deep watch 每次
  payload 更新都要全量深比较；首页一屏最多 2~4 个图（TrendsTab 流量视图 2 个），
  切周期时全部重比较后 `setOption(option, true)` 全量替换——深比较本身没有收益，
  因为渲染策略就是 notMerge 全量替换。
- 更好的做法：`watch(() => props.option, render)`（引用替换）+ 由调用方保证
  computed 返回新对象（现状已满足，所有 option 都是 computed 生成的新引用）。

## 11. 🟢 可点击指标卡的可访问性不完整

位置：`admin/src/views/analytics/tabs/OverviewTab.vue`（`role="button" tabindex="0"` + `@keydown.enter`）

问题：
- 只处理 Enter，未处理 Space（button 语义的标准行为），键盘用户 Space 会滚动页面；
- `.metric.clickable:hover .value` 有 hover 反馈但没有 `:focus-visible` 样式，
  Tab 聚焦时无可见焦点环；
- `.linkish`/`.insight-link`（多 Tab 中大量使用）同样没有 focus 样式。

建议：统一补 `@keydown.space.prevent` 与 `:focus-visible { outline: ... }`。

## 12. 🟢 空态文案与空态判定存在永远不可达的分支

位置：`admin/src/views/analytics/AnalyticsView.vue`

问题：
- `TabEmpty` 渲染条件是 `isEmpty && activeTab !== 'overview'`，但 `emptyCopy` 的
  `default` 分支（"当前时间窗内没有数据…"）实际上只可能命中 overview（其余 tab
  都有专属文案），而 overview 永远不会显示 TabEmpty——该分支是死文案。
- 另外 overview 空数据时直接渲染全 0 卡片，与"其他 Tab 显示引导性空态"的策略
  不一致，管理员首次部署看到的首页是一排 0 而不是引导（例如"去创建 Agent/模型"）。

建议：删除死分支；overview 空态给出 onboarding 引导。

## 13. 🟢 图表颜色硬编码，不随 CSS 变量/主题走

位置：`chart-options.ts`（`borderColor: '#fff'`、`v: { color: '#1d1d1f' }`）、
`TrendsTab.vue`（`axisLabel: '#86868b'`、`splitLine: 'rgba(0,0,0,0.06)'`）、
`SessionTab.vue`/`chart-options.ts` 中 `PHASE_COLORS` 双份硬编码。

问题：
- 项目 UI 已用 `--mao-ink/--mao-muted/--mao-border/--mao-canvas` 变量体系，
  但 ECharts 侧全部硬编码浅色值；将来接入暗色主题（或用户系统强制深色）时，
  图表会整体破相。
- `PHASE_COLORS` 在 `SessionTab.vue` 与 `chart-options.ts` 各维护一份，
  `OverviewTab.vue` 又自己定义了一个与 `chart-options.ts` 完全相同的 `formatNumber`；
  `TrendsTab.vue` 手写的 `callTrendOption`/`qualityTrendOption` 重复了
  `chart-options.ts` 里未导出的 `categoryAxis/valueAxis/trendLegend` 样式常量。
  同一视觉规格散落多处，改一处漏一处。

建议：以 `getComputedStyle` 读取 CSS 变量注入 ECharts 主题，或集中到
`utils/echarts.ts` 注册自定义主题；`PHASE_COLORS`/`formatNumber`/轴样式统一导出复用。

## 14. 🟢 死代码与口径不一致的小问题

- `chart-options.ts` 的 `trafficTrendOption`、`tokenTrendOption`（双轴版）已无调用方
  （TrendsTab 改用 `seriesTrendOption`/`buildTokenTrendOption`），属于死导出，且
  `trafficTrendOption` 还带着"双轴误读"的旧设计，留着容易误导复用。
- `UserTab.vue` 卡片头写"按窗口内消息数 Top 10"，明细表头却是 `Top {{ userRows.length }}`
  （后端 limit=20），图表只展示 10 条、表格展示 20 条，两处口径不同但都叫"排行"，
  建议统一或注明。
- `AnalyticsView.vue` 的 `periodText`/`previousText` 兜底逻辑与
  `useAnalyticsPeriod.ts` 的 `usePeriodMeta` 重复（后者无调用方，也是死代码）。

---

## 修复优先级建议

1. 先修 1、2、3（行为正确性，改动小收益大）：Layout key、初始化双请求、
   excludeConnectivity 进 URL。
2. 再修 5（安全）与 6（数据展示正确性）。
3. 4、7、9 属于交互打磨，可与 8、10、11~14 的清理合并为一次重构。
