# 提案：设置可达性 —— 条目级搜索定位，散落偏好一个卡收口

> 设置中心现在是 15 个子页的纯侧栏清单（`SettingsView.vue:10-56+` 全部为 `router-link`，全文件无任何搜索实现），配置面已经很厚：通知、审批规则、渠道绑定、MCP、环境变量、桌面偏好、定时任务、开放接口……批次 24 的命令面板解决了「跳到某个设置**页**」（`useCommandRegistry.ts` 设置导航 15 条），但跳不到**条目**——「开机自启在哪改」「哪里测系统通知」仍要靠逐页扫。另一面是**可调偏好的入口散落在使用现场**：代码块换行开关藏在消息代码块头部（`utils/codeBlockCollapse.ts`，localStorage `aw-code-word-wrap`）、Diff 内联开关藏在文件查看器里（`components/center/FileDiffViewer.vue`，`aw-diff-inline`）、主题在个人资料页（`ProfileView.vue:8-15`）、桌面偏好只有 Electron 可见。具体断点：
> 1. **条目级不可搜索**：15 页侧栏是页级索引，低频设置（改键、测试通知、Webhook 测试投递）的可达路径 = 「记得在哪个页」。
> 2. **散落偏好不可盘点**：`aw-*` 前缀的展示偏好（换行 / Diff 展示 / 主题模式）没有任何集中列表，用户不知道「这台设备上我能调什么」——换行开关用过一次后，下次想改回来找不着。
> 3. **范式全是现成的**：搜索浮窗（teleport + 键盘导航 + 焦点回归，0.0.471 打磨过）与设置项声明式注册（路由 meta、命令面板 buildCommands）在仓内都有成熟范本，本提案是纯聚合，不发明交互。

- 状态：已否决（2026-11-08。见 [README](README.md) 台账）
- 日期：2026-11-08
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：P1 约 1.5 人日（注册表 + 搜索浮层 + 定位高亮）；P2 约 0.5-1 人日（聚合卡）。**零数据库迁移、零后端改动**
- 关联：`desktop/src/views/settings/SettingsView.vue`、`desktop/src/views/settings/ProfileView.vue`（P2 落点）、`desktop/src/components/search/SessionSearchPopover.vue`（交互范本）、`desktop/src/utils/codeBlockCollapse.ts`、`desktop/src/components/center/FileDiffViewer.vue`、新增 `desktop/src/utils/settings-registry.ts`

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 设置页导航 | 15 个 `router-link` 侧栏，无搜索 | `SettingsView.vue:10-56+`；grep 搜索零命中 |
| 页级跳转 | 命令面板 15 条设置导航（路由表派生） | 批次 24 已落地，`useCommandRegistry.ts` |
| 条目级定位 | 无：进页后逐块扫 | 各设置页均为整页表单 |
| 代码块换行偏好 | 开关在消息代码块头部，localStorage `aw-code-word-wrap` | `utils/codeBlockCollapse.ts`（批次 26 落地） |
| Diff 展示偏好 | 开关在文件查看器内，`aw-diff-inline` | `components/center/FileDiffViewer.vue` |
| 主题模式 | 个人资料页「主题色」卡（含注释声明收口意图） | `ProfileView.vue:8-15,104` |
| 桌面偏好 | 仅 Electron 端可见 | `views/settings/DesktopSettingsView.vue` |
| 偏好读写口径 | localStorage 统一经 `utils/safe-storage.ts` 兜底 | 既有约定 |
| 搜索浮层范式 | SessionSearchPopover：teleport、↑↓、Enter、Esc、焦点回归 | `components/search/SessionSearchPopover.vue`、`composables/searchJumpFocus.ts` |

## 2. 目标 / 非目标

**目标**

1. **P1 设置条目注册表**：新增 `utils/settings-registry.ts`，集中声明每页条目 `{ page: '/settings/xxx', title, keywords, anchorId }`（title 与页面内既有区块标题逐字一致）。集中而非页内导出——单一事实源，漏注册用穷尽单测拦（见目标 4）。首批覆盖 15 页共约 40-60 条高频条目（每页 2-5 条），按「新用户第一次会找什么」取舍，不求穷举。
2. **P1 设置搜索浮层**：`SettingsView` 侧栏顶部搜索框，输入即滤（title + keywords 子串匹配，与既有会话搜索同口径，不做拼音）；↑↓ 选择、Enter 跳转、Esc 清空关闭；浮层结构与焦点语义照 `SessionSearchPopover` 抄。跳转 = `router.push` 到目标页 + `scrollIntoView` 定位锚点 + 3 秒高亮渐隐（anchorId 与页内区块 `id` 对应）。
3. **P1 键盘入口**：设置页内 `Ctrl/Cmd+F` 聚焦搜索框（仅当设置页为活动路由时注册，`isTypingTarget` 守卫）；不占全局快捷键、不进命令面板命令表（P1 保持两入口互不知晓）。
4. **P1 防漂移守卫**：单测穷尽断言——路由表 settings 每个子路由在注册表中有 ≥1 条目；每条目的 `page` 在路由表中存在；每个 `anchorId` 在对应页面组件源码中存在 `id="…"`（`open-api-doc.test.ts` 同款源码断言范式）。
5. **P2 散落偏好聚合卡**：个人资料页「主题色」卡下方新增「外观与偏好」卡（该页注释已自declare 收口意图，`ProfileView.vue:8`），首期两项：代码块自动换行、Diff 内联 / 并排——**调用既有开关的同一写入函数、同一 localStorage 键**，与消息区 / 文件查看器的就地开关双向同源（就地开关改了聚合卡跟随，反之亦然，经 storage 事件 + 既有读取时机天然同步）。不含任何业务设置。

**非目标**

- 不做设置项改名 / 重排 / 分组重构——注册表 title 取既有区块标题，页面零改动（仅 P1 需要给少数区块补 `id` 属性）。
- 不做偏好云同步 / 跨设备漫游（维持设备本地口径）；不动 admin 设置搜索。
- 不做修改型搜索语义（搜「通知」不改任何配置，只定位）。
- 不并入命令面板（P1）：面板是页级导航、设置搜索是条目级定位，先独立演进，合并留作 P2 评估。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 会话内查找 / Markdown 导出（2026-11-02 否决） | 那是对**会话内容**的检索；本提案是对**设置条目**的索引，数据源是静态注册表，无会话语义 |
| 命令面板（批次 24 已落地） | 互补不重叠：面板答「有哪些功能」，设置搜索答「某个设置在哪页哪块」；面板命令表零改动 |
| 任务模板 / Runbook（批次 8 否决） | 注册表是只读索引元数据，无资产、无存储、无组合语义 |
| 记忆就地可见（批次 18 否决） | 无关：不碰记忆链路 |

## 4. 方案设计

- **settings-registry.ts**：`readonly SettingsEntry[]`，按页分组导出 + `filterSettings(keyword)` 工具；每条目 `keywords` 手工精选（中文别名，如「快捷键」条目带 hotkey / 改键 / 录制）。15 页路由 title 既有中文标题直接复用，防两处漂移。
- **定位高亮**：`SettingsView` 跳转处理：push → `nextTick` → `document.getElementById(anchorId)` → `scrollIntoView({ block: 'center' })` → 临时 class（复用既有高亮色 token）3s 移除；找不到锚点（DOM 未渲染 / 懒加载页）降级为仅跳页不报错。
- **聚合卡同源机制**：新增 `utils/display-prefs.ts` 收口 `aw-code-word-wrap` / `aw-diff-inline` 的读写（读 = 现有消费方逻辑平移，写 = 触发既有开关同一函数并写穿 localStorage）；聚合卡与就地开关都走它。`codeBlockCollapse` 消费时机是每次 `enhanceCodeBlocks`（渲染后读），`FileDiffViewer` 是挂载 / 切换时读——写入方再派发一次既有自定义事件即可让已挂载视图即时刷新（若无既有事件则 `storage` 事件兜底）。
- **搜索框 a11y**：`aria-label="搜索设置"`，结果列表 `role="listbox"` / `option` 语义，与命令面板同口径（AGENTS.md 图标按钮规范照旧）。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | 新增 `utils/settings-registry.ts`、`utils/display-prefs.ts`（P2）；`SettingsView.vue`（搜索框 + 浮层 + 定位）、`ProfileView.vue`（聚合卡）、各设置页少量区块补 `id`、`codeBlockCollapse.ts` / `FileDiffViewer.vue` 读写收口平移（逻辑不变）；新增单测 |
| backend-ts / admin / android / agent-cli | **无**；安卓壳共用 UI：搜索浮层触屏点选可用（768px 断点照 SessionSearchPopover 既有窄屏表现） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| anchorId 与页面 DOM 漂移 | 穷尽单测断言组件源码含对应 `id`（目标 4）；运行期找不到锚点静默降级为仅跳页 |
| 注册表条目与页面实际文案漂移 | title 取自页面既有区块标题；P1 只索引不改动文案；后续页面改文案时单测的 keywords 子串断言兜底 |
| 聚合卡与就地开关双入口状态打架 | 单一写入函数 + 同一 localStorage 键 + 事件通知（§4 设计）；测试双向同步断言 |
| 搜索噪音（keywords 过泛） | keywords 手工精选 + 只匹配 title/keywords 不匹配正文；结果为空态引导「试试其它关键词」 |
| `Ctrl/Cmd+F` 与浏览器页内查找冲突 | 仅设置页活动路由时注册并 `preventDefault`；其余页面不注册（浏览器原生行为不变）；决策记录项 3 备选：不占 Ctrl+F，只留点击入口 |

## 7. 测试要点

1. 搜索「快捷键」命中桌面页全局快捷键条目，Enter 后落在 DesktopSettingsView 并滚动高亮对应区块；Esc 清空不残留高亮。
2. 穷尽守卫：路由表 settings 全部子路由在注册表有 ≥1 条目；全部条目 `page` / `anchorId` 断言通过；故意删一个条目测试变红。
3. P2 双向同步：聚合卡开「自动换行」→ 消息代码块头部开关显示为开（反之亦然）；`FileDiffViewer` 切内联 → 聚合卡跟随；刷新后取值持久。
4. 键盘：设置页 `Ctrl/Cmd+F` 聚焦搜索框；输入框聚焦时快捷键不误触（`isTypingTarget`）；↑↓/Enter/Esc 全链路；焦点回归与 0.0.471 口径一致。
5. 既有回归：15 页各功能零改动（仅加 `id`），跑一次 settings 相关 E2E（含 settings-cards 所需 `MAO_ADMIN_PASS=admin123` 口径不变）；安卓壳 768px 下浮层与聚合卡实机点验。

## 8. 决策记录

待评审确认：

1. **聚合卡落点**：个人资料页「外观与偏好」卡（倾向，页内注释已声明收口意图）vs 独立设置子页。倾向前者，避免再加侧栏项。
2. **注册表首批覆盖度**：每页 2-5 条、约 40-60 条（倾向，按新用户视角取舍）vs 全量穷举（维护成本高）。倾向首批精编，页面贡献条目随迭代补。
3. **`Ctrl/Cmd+F` 是否占用**：占用（倾向，设置页内浏览器查找价值低）vs 仅点击入口（零冲突但键盘路径缺失）。
4. **P2 是否并入命令面板**：P1 两入口独立（倾向），P2 视使用反馈评估面板「搜设置 → 跳页定位」委托。
