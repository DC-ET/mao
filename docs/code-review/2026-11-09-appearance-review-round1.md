# 外观个性化（强调色五款 + 字号三档）代码审查 · Round 1

- 日期：2026-11-09
- 审查范围：工作区未提交改动（desktop/src/style.css、utils/appearance.ts(.test.ts)、main.ts、ProfileView.vue、QuickCommandTag.vue、MessageBubble.vue、ServerSettingsView.vue）
- 规格依据：docs/plan/2026-11-08-appearance-personalization-technical-design.md（含 §3.1 色值总表 / 字号值表，均为定案值）
- 结论：**存在 2 个 bug**（均已用真实 Chromium + 仓库真实 style.css 做计算级联验证，非纯推理）。纯函数 / 预设级联主体 / 字号档 / 持久化 / ProfileView 接线均验证正确。

---

## Bug 1（中）：ServerSettingsView 收编 3 处在暗色主题下不等价，暗色默认观感发生变化

- 位置：
  - `desktop/src/views/settings/ServerSettingsView.vue:525`（`.history-row.current` background）
  - `desktop/src/views/settings/ServerSettingsView.vue:526`（`.history-row.current` border-color）
  - `desktop/src/views/settings/ServerSettingsView.vue:587`（`.current-badge` border）
- 描述：三处由字面量 `rgba(0, 102, 204, α)` 改写为 `rgba(var(--aw-accent-rgb), α)`。该组件内**没有任何 `[data-theme]` 暗色覆盖**（全文 grep 确认），这些规则在暗色下同样生效；而暗色块把 `--aw-accent-rgb` 重定义为 `41, 151, 255`（style.css:340）。因此在**不写任何偏好的默认档 + 暗色主题**下，这三处的渲染值从 `rgba(0,102,204,α)` 变为 `rgba(41,151,255,α)`——违反规格 §1 硬约束「默认观感零变化」、§2.1 第 6 条「改写前后渲染值逐字节相同」、§7 第 7 条「ServerSettings 提示条三处，默认档截图与主分支一致」，也与 CHANGELOG 0.0.493「不选择新偏好时全部取值与旧版逐字节相同」的承诺冲突。规格 §4 映射表给这三行的等价性注记「亮色三元组展开同值」只在亮色成立，暗色不等价（同表对 MessageBubble:991 特意标注了「该行处于暗色覆盖语境」，对这三行漏了语境判断）。
- 触发路径：设置 → 服务器 → 历史列表（暗色主题，默认蓝）→「当前」行的底色/描边与「当前」徽标描边均比旧版偏亮偏蓝（0.4 α 的徽标描边在深底上合成后 RGB 差约 15–20，肉眼可辨）。
- 验证（真实引擎，产物在 /tmp/appearance-review/verify.cjs）：用仓库真实 style.css + 组件三条声明（新旧各一套探针类）在 headless Chromium 中取 getComputedStyle：
  - light：三处 new=old 全部 SAME；
  - dark：bg `rgba(41, 151, 255, 0.08)` vs `rgba(0, 102, 204, 0.08)` DIFF；border `rgba(41, 151, 255, 0.25)` vs `rgba(0, 102, 204, 0.25)` DIFF；badge `rgba(41, 151, 255, 0.4)` vs `rgba(0, 102, 204, 0.4)` DIFF。
  - 对照组 MessageBubble.vue:991（`var(--aw-accent-bg)`）在 dark 下 new=old SAME，符合规格，不属于本 bug。
- 备注：新加的 `appearance.test.ts` 守卫锁的是 style.css 源文本计数（`rgba(0, 102, 204` 恰好 4 处等），覆盖不到「组件内改写 + 暗色重定义三元组」的合成结果，因此测试全绿仍漏过本问题。

## Bug 2（中）：暗色 + 非默认强调色时，EP 组件主色不跟随预设（且 EP 派生色跟随亮色变体，形成混色）

- 位置：
  - `desktop/src/style.css:383-394` 等 4 个预设亮色块（只覆写 `--el-color-primary-light-3/5/7/8/9`，不含 `--el-color-primary` / `--el-color-primary-dark-2`）
  - `desktop/src/style.css:396-405` 等 4 个预设暗色块（9 项均为 `--aw-*`，无 EP 变量）
  - 关联现状：`desktop/src/style.css:585` `--el-color-primary: var(--aw-primary)`、`:591` `--el-color-primary-dark-2: var(--aw-primary-focus)`（`:root`，特异性 (0,1,0)）
- 描述：规格 §3.1 决策表断言「EP 主色本值 / hover 不动：`--el-color-primary: var(--aw-primary)`、`dark-2: var(--aw-primary-focus)` 已是令牌引用，自动跟随预设」——这在**暗色下不成立**：`element-plus/theme-chalk/dark/css-vars.css`（main.ts:16 引入）的 `html.dark { --el-color-primary:#409eff; --el-color-primary-dark-2:#66b1ff; … }` 特异性 (0,1,1) 高于 `:root` (0,1,0)，暗色下 EP 主色/hover 一直是 EP 蓝，根本没在走 `--aw-primary`。预设块又未覆盖这两个变量，于是暗色 + 紫/绿/橙/石墨时：EP 按钮、开关、单选/分页选中态等主色面仍为 EP 蓝 `#409eff`，**不同步变色**（违反 §7 第 5 条「强调色矩阵点验（5 预设 × 亮暗）：…EP 组件（按钮、开关、单选、分页）同步变色」的暗色行）；而 EP 派生色 light-3/5/7/8/9 因预设亮色块与 `html.dark` 同为 (0,1,1)、style.css 引入顺序靠后（main.ts:25 > main.ts:16）而**跟随预设的亮色变体**（如暗色+紫 light-3=#8B78D9、light-9=rgba(110,86,207,0.05)，而默认档暗色下它们是 EP 暗色系不透明值 #3375b9/#18222b）——同一颗 EP 按钮本体蓝色、悬停底色（light-3）变紫，呈现混色状态。
- 触发路径：设置 → 个人信息 → 强调色选「紫」→ 主题切「深色」→ 观察外观卡自身的 el-radio-group 选中项、各设置页 EP 主按钮/开关：仍为 EP 蓝；悬停主按钮则出现紫色 hover 底。
- 验证（真实引擎，产物在 /tmp/appearance-review/verify-ep-dark.cjs / verify-preset.cjs）：按 main.ts 的真实引入顺序（EP dist/index.css → EP dark css-vars → style.css）+ `html` 同时带 `class="dark"` 与 `data-theme="dark"`（theme.ts applyResolvedDark 行为）取计算值：
  - dark+默认：elPrimary=#409eff、elL3=#3375b9、elDark2=#66b1ff（与改动前一致，非本 bug 部分）；
  - dark+violet：elPrimary=**#409eff**、elDark2=**#66b1ff**（不跟随），elL3=#8B78D9、elL9=rgba(110,86,207,0.05)（跟随紫）；
  - dark+graphite：elPrimary=#409eff，elL3=#6C7787（同上混色）；
  - light+violet：elPrimary=#6E56CF、elDark2=#7C66D6、elL3=#8B78D9 全部跟随（亮色矩阵正常）。
- 备注：暗色+默认档的 EP 表现（#409eff）是改动前既有行为，本次未引入回归；本 bug 是新功能在暗色半区未达成规格自己声明的「自动跟随预设 / EP 组件同步变色」。修复方向（供参考，不在本报告职责内）：预设亮/暗色块显式覆写 `--el-color-primary` / `--el-color-primary-dark-2`，或把 `:root` 的这两个引用提到能压过 `html.dark` 的特异性/位置。

---

## 已检查且排除的项（避免 round 2 重复上报）

1. **12 处 alpha 令牌改写**：真实引擎下亮/暗两主题计算值与 git HEAD 字面量逐字节一致（/tmp/appearance-review/verify-tokens.cjs，含 `--aw-primary-lighter/soft/hover/ring/line`、`--aw-accent-bg` 及三元组本身）。
2. **MessageBubble.vue:991 收编**：暗色语境，`var(--aw-accent-bg)` 与原字面量暗色下逐字节同值；随预设变色是既定功能。
3. **QuickCommandTag.vue:47 收编**：亮色 `var(--aw-primary)` 同值；暗色 `#5b9bd5` 覆盖保留属规格显式豁免。
4. **4 款预设色值/alpha/覆盖集合**：与 §3.1 色值总表逐项核对一致；亮块 10 项、暗块 9 项；特异性结论 (0,2,1)>(0,1,1)>(0,1,0) 经真实引擎证实（暗+紫下 `--aw-accent-rgb=167,139,250`、`--aw-primary` 维持亮值，均符合规格）。
5. **字号三档**：7 变量值与字号值表一致；`--aw-text-*` 定义于 `:root`（style.css:112-115），`html[data-font-scale]` (0,1,1) 可压过；组件内无局部重定义；marketing 尺寸三档不动（实测 hero=56px 不变）。
6. **appearance.ts / main.ts / ProfileView**：与 theme.ts 同构、幂等初始化、blue/std 归一 null → removeAttribute、损坏存储值读作默认、'blue' 落存储保 UI 选中态、aria-label/aria-pressed、`fontScaleMode` 本地 ref 与单例同步——均符合规格。初始化在 mount 后有首帧默认观感闪变，但与规格指定的 main.ts 接线方式（与 useTheme 并列）一致，属按规格既定行为，不计 bug。
7. **守卫测试范围**：components/+views/ 之外的蓝字面量仅 `useTerminal.ts`（终端语法配色）、`echarts.ts`（图表系列色）、`appearance.ts`（色板定义本身），均非 UI 强调色面，规格清单封闭；`AVATAR_PALETTE` 白名单字符串与源码逐字匹配。
8. **回归**：desktop vitest 1880/1880 通过（含新增 appearance.test.ts 10 例）；守护计数（12/4/0/1、预设块、字号块）与 style.css 实文一致。

## 验证产物与仓库洁净度

- 验证脚本与日志均在 `/tmp/appearance-review/`（verify.cjs、verify-tokens.cjs、verify-preset.cjs、verify-ep-dark.cjs、inspect-btn.cjs），未进入仓库；仓库除本报告外无其他新增/修改。
