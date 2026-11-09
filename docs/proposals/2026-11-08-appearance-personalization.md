# 提案：外观个性化与视觉令牌收编 —— 强调色 / 字号档位，默认观感零变化

> Mao 的样式底子已经是「Apple Design Token System」：`style.css` 约 120 个 `--aw-*` 变量、`[data-theme="dark"]` 两处集中覆盖块（`style.css:303`、`:546`），主题三态（light / dark / auto）经 `utils/theme.ts` 落地。但**「主题」只有亮暗一个维度**——每个用户打开 Mao 看到的都是同一款 Apple 蓝（`--aw-primary: #0066cc`，`style.css:7`）、同一套字号（EP 基准 13px，`style.css:482-484`）、同一种密度。具体断点：
> 1. **令牌体系已就绪，个性化入口为零**：`--aw-accent / --aw-accent-rgb / --aw-accent-bg`（`style.css:56-58`）与 `--aw-primary-*` 一族（`style.css:7-14`，暗色块 `:332-335` 重定义）本来就是为「可替换强调色」预留的形状，但全仓没有任何一处让用户改它；`utils/theme.ts` 的全部状态只有一个 mode 三态。
> 2. **令牌与组件之间有 38 处硬编码断点**：`#0066cc / rgba(0, 102, 204, …)` 字面量散布在 ≥12 个组件里（`file-browser/` 5 个文件、`task/GitContextMenu.vue`、`task/TaskContextMenu.vue`、`task/SideTaskList.vue`、`task/TaskInspector.vue`、`chat/QuickCommandTag.vue`、`center/CenterTabBar.vue`、`task/ShareDialog.vue`），令牌换色的收益被这些字面量截断。
> 3. **暗色覆盖在组件里长野了**：`components/ + views/` 内零散 `[data-theme="dark"]` 共 148 处、涉及 35 个文件——与 `style.css` 两处集中块并存，每加一个语义色都要人肉扫全仓。

- 状态：已立项（2026-11-08，技术方案：[docs/plan/2026-11-08-appearance-personalization-technical-design.md](../plan/2026-11-08-appearance-personalization-technical-design.md)）
- 日期：2026-11-08
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：P1 约 2-3 人日（收编 0.5 + 强调色 1 + 字号 0.5-1）；P2/P3 另计。**零数据库迁移、零后端改动**，全部为纯前端偏好（localStorage）
- 关联：`desktop/src/style.css`、`desktop/src/utils/theme.ts`、`desktop/src/views/settings/ProfileView.vue`（外观卡收口页）、`desktop/src/components/auth/LoginView.vue`、`desktop/src/composables/useCommandRegistry.ts`（P2 可选命令）

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 强调色 | 固定 Apple 蓝，令牌已预留 accent 形状但取值写死 | `style.css:7-14`（primary 族）、`:56-58`（accent 族）、`:332-335`（暗色重定义） |
| 组件硬编码主题色 | 38 处字面量绕过令牌，换色时漏色 | grep `#0066cc / rgba(0, 102, 204` 在 components/+views/ 命中 38 处、≥12 文件 |
| 字号 | 全局一套：EP 基准 13px，正文 `--aw-text-*` 固定 | `style.css:105-114`（text 阶梯）、`:476-484`（EP 变量映射先例） |
| 密度 | `--aw-space-*` 固定，无紧凑选项 | `style.css:117-124` |
| 主题模式 | light / dark / auto 三态，localStorage `aw-theme-mode` | `utils/theme.ts`（`setTheme` :86）、`ProfileView.vue:104` |
| 外观入口 | 个人资料页「主题色」卡（radio 三态）+ 登录页循环按钮；命令面板外观组 3 条 | `ProfileView.vue:8-15`、`LoginView.vue:5-8`、批次 24 已落地 |
| 暗色覆盖治理 | 集中块 2 处 + 组件散布 148 处 / 35 文件并存 | grep `[data-theme="dark"]` components/+views/ |

## 2. 目标 / 非目标

**目标**

1. **P1 硬编码色值收编（前置步骤，纯等值替换）**：38 处 `#0066cc / rgba(0,102,204,*)` 字面量改写为对应 `var(--aw-primary*) / var(--aw-accent*)`。替换前后渲染结果逐字节相同（值相同），默认观感零变化；这是强调色可切换的完整性前提。
2. **P1 强调色预设**：新增 `utils/appearance.ts`（与 `theme.ts` 同构的模块级单例 composable）+ `html[data-accent]` 属性；预设 5 款（默认 Apple 蓝 / 紫 / 绿 / 橙 / 墨灰），每款覆写 light + dark 两块共约 10 个 token（`--aw-primary`、`--aw-primary-focus/on-dark/hover/soft/lighter/ring/line`、`--aw-accent`、`--aw-accent-rgb`、`--aw-accent-bg`）；持久化 localStorage `aw-accent`（缺省 = 现状蓝，不写属性）。入口：个人资料页「主题色」卡内加一行强调色选择（与既有 radio 同卡，收口页已声明为「这台设备上的展示偏好」）。
3. **P1 字号档位**：`html[data-font-scale]`，三档「小 / 标准（默认=现状）/ 大」，覆写 `--aw-text-body / caption / fine / micro` 与 EP `--el-font-size-base / -small / -extra-small`（沿用 `style.css:476-484` 的 EP 映射先例）。marketing 尺寸（`--aw-text-hero/display/lead/tagline`，仅登录页与空态使用）不动。
4. **P2 密度紧凑档（收窄范围，先评估再做）**：不做全局 `--aw-space-*` 缩放（组件硬编码 padding 多，全局缩放回归面大）；只做侧栏列表与消息列表的行高 / 气泡间距局部紧凑 token，验收后视反馈扩展。
5. **P3 暗色覆盖收编（单独立项评估）**：35 文件 148 处组件内 `[data-theme="dark"]` 逐步等值搬迁进 `style.css` 集中块，分批做、每批可回滚。本提案只登记，不绑定排期。

**非目标**

- **不做自定义取色器**：只提供预设集，避免任意色带来的对比度 / 可读性问题（每款预设的 rgba 派生值人工核准）。
- 不换字体族、不做界面国际化（产品边界）、不做 per-component 主题、不做主题云同步（沿用 `aw-theme-mode` 的设备本地口径）。
- 默认档 = 现状：不写 `aw-accent` / `data-font-scale` 时所有 token 取值与今天逐字节相同——**基线零回归**是硬约束。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 命令面板（批次 24 已落地） | 互补：面板外观组 3 条主题命令不动；P2 可选追加「强调色 → ×」几条命令，纯接线 |
| 消息上下文菜单 / 操作收敛（批次 25 否决） | 无关：不改任何消息区交互 |
| 界面国际化（产品边界） | 不做文案语言；字号档位是可读性偏好，不是语言 |
| 结构化回复卡片（批次 9 否决） | 不改消息渲染协议，只改颜色与字号 token 取值 |

## 4. 方案设计

- **收编先行**：以 grep 清单（38 处）为工单逐文件等值替换，每文件替换后 `npm run build` 过 vue-tsc；替换是机械操作，不引入新值。
- **appearance.ts 与 theme.ts 同构**：模块级 `ref` + `useAppearance()`；`setAccent(id)` 写 localStorage + 同步 `html.dataset.accent`（缺省移除属性）；`setFontScale(id)` 同理。暗色 / 亮色由既有 `data-theme` 承担，强调色只叠加 `data-accent` 维度，两轴正交。
- **色板定义在 CSS 而非 JS**：每款预设 = `style.css` 内 `[data-accent="violet"]` 等两个块（light + dark 下各一段，dark 借 `[data-theme="dark"][data-accent="…"]`），JS 只切属性——与现有暗色块组织方式一致，色值派生（`--aw-accent-rgb` 三元组）随色板手写核准。
- **字号档位同理**：`[data-font-scale="small"]` / `"large"` 两个块覆写 8 个变量（4 个 aw-text + 3 个 EP + 行高微调），正文 line-height 保持无量纲（`style.css:388` 的 1.47 系数继承）。
- **EP 组件取色**：EP 主色走 `--el-color-primary` 及其 light-3/5/7/9 派生（按 accent 色板一并覆写；`--el-font-size-*` 随字号档覆写）——EP 变量映射在 `style.css` 已有先例（`:476-484`），不是新模式。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | `style.css`（预设块 + 字号块）、新增 `utils/appearance.ts`、`ProfileView.vue`（主题卡加强调色与字号行）、38 处硬编码色值等值替换；P2 密度与命令面板命令另计 |
| backend-ts / admin / android / agent-cli | **无**；安卓壳共用 UI 自动获得（偏好存设备本地，与 `aw-theme-mode` 同口径） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 收编遗漏导致某组件换色后仍是旧蓝 | 收编以 grep 清单为准做完成断言（单测断言 components/+views/ 内 `#0066cc` 计数为 0，`open-api-doc.test.ts` 同款守卫范式）；EP 弹层挂在 body 下的取色经 `--el-color-primary` 覆写兜住 |
| 字号放大撑破布局 | 只放 13px 基准 ±1 级（小 12px / 大 14px），marketing 尺寸不动；E2E 跑 settings + chat 关键页截图点验 |
| 强调色对比度不足 | 每款预设的 rgba 派生（hover/soft/ring/line）人工核准一次；按钮文字色仍走白/黑不变量 |
| 密度缩放回归面大 | 已收窄为局部行高 token（目标 4），全局 `--aw-space-*` 不动；P2 先评估 |
| 默认档被意外改动 | 「缺省不写属性 = 原 token 值」写入单测：新装用户 localStorage 无键时 `data-accent` / `data-font-scale` 均不存在 |

## 7. 测试要点

1. 收编断言：components/+views/ 源码内 `#0066cc / rgba(0, 102, 204` 出现 0 次；`npm run build` 全绿（vue-tsc 严格检查，勿用 `npx vue-tsc --noEmit` 假通过口径）。
2. 切强调色后：主按钮 / 链接 / 焦点环 / 选中态 / 文件树选中 / 页签高亮取色一致，亮暗两态各点验一轮；刷新后持久；`aw-theme-mode` 与 `aw-accent` 两轴独立（切暗色不重置强调色）。
3. 字号档位：EP 输入框 / 下拉 / 按钮与正文同步缩放；「标准」档与主分支渲染无差异（DOM class/token 值断言）。
4. 缺省态：无 localStorage 键时 `html` 无 `data-accent` / `data-font-scale`，全部 token 与收编前逐字节一致。
5. 安卓壳：外观卡与主题切换实机点验（共用 UI，无平台分支）。

## 8. 决策记录

待评审确认：

1. **预设色板选型**：5 款（蓝[默认] / 紫 / 绿 / 橙 / 墨灰）是否合适，是否需要品牌色定制位。倾向 5 款封顶。
2. **字号实现选型**：token 覆写（本提案倾向）vs 根 `font-size` em 缩放（联动面更广但 EP 组件吃 px 值会漏）。倾向 token 覆写 + EP 三变量联动。
3. **P2 密度 / P3 收编是否绑定本批次**：倾向 P1 先落地验收，P2/P3 视反馈单独立项。
