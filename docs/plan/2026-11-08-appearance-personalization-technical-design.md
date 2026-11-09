# 外观个性化与视觉令牌收编技术方案：强调色五款 + 字号三档，默认观感零变化

- 状态：待实施（2026-11-08 定稿）
- 日期：2026-11-08
- 需求来源：`docs/proposals/2026-11-08-appearance-personalization.md`（已立项，含逐项代码证据；本文在其基础上完成定案与五处勘误，见 §3.2）
- 规模：小（style.css 约 130 行新增 + 12 行等值改写、新建 1 个工具模块约 90 行、ProfileView 约 60 行、组件收编 5 行、测试 1 个文件约 130 行；**零数据库迁移、零后端改动、零新依赖**）
- 关联：`desktop/src/style.css`、`desktop/src/utils/theme.ts`（同构范式）、`desktop/src/main.ts`、`desktop/src/views/settings/ProfileView.vue`、`desktop/src/components/chat/{QuickCommandTag,MessageBubble}.vue`、`desktop/src/views/settings/ServerSettingsView.vue`、`USER_GUIDE.md`、`skills/mao-cli/reference/desktop.md`

## 1. 需求背景

Mao 的样式底座是「Apple Design Token System」：`style.css` 约 120 个 `--aw-*` 变量，`[data-theme="dark"]` 集中覆盖块切换亮暗（`style.css:332-340` 暗色重定义强调色家族）。但外观只有一个维度——每个用户打开都是同一款 Apple 蓝（`--aw-primary: #0066cc`，`style.css:7`）、同一套字号（body `--aw-text-body: 17px` 经 `body` 选择器全局生效，`style.css:385-387`；Element Plus 控件基准 13px，`style.css:482-484`）。令牌体系已经为「可替换强调色」预留了形状（`--aw-accent / --aw-accent-rgb / --aw-accent-bg`，`style.css:56-58`），缺的是三件事：

1. **强调色的预设块不存在**：全仓没有任何机制改写这组令牌；`utils/theme.ts` 的全部状态只有亮暗 mode 三态。
2. **令牌与组件之间有一层字面量断点**：普查结果（§3.2 勘误后的准确数字）——组件里 30 处是 `var(--aw-primary, #0066cc)` 回退形态（令牌恒定义、回退值永不生效，换色时自动跟随，**无需改动**）；真硬编码仅 5 处（`QuickCommandTag.vue:47`、`MessageBubble.vue:991`、`ServerSettingsView.vue:525,526,587`）；`style.css` 内 16 处派生字面量（12 处 alpha 值 + Element Plus 主色派生 `--el-color-primary-light-3/5/7/8/9`，`style.css:451-455`）——后者在预设切换时会漏色。
3. **字号无档位**：字号令牌消费面广（`--aw-text-fine` 79 个文件、`--aw-text-caption` 63 个、`--aw-text-body` 12 个、`--aw-text-micro` 17 个），具备一份覆写全端生效的条件，但没有任何档位机制。

硬约束：**默认观感零变化**——不写偏好时所有 token 取值与今天逐字节相同；所有个性化都是显式 opt-in。

## 2. 需求描述

### 2.1 目标（全部要做）

1. **style.css 令牌改写**：12 处 alpha 定义从 `rgba(0, 102, 204, α)` / `rgba(41, 151, 255, α)` 改写为 `rgba(var(--aw-accent-rgb), α)`——默认展开值逐字节相同（`--aw-accent-rgb` 亮色 `0, 102, 204`、暗色 `41, 151, 255`，与原字面量同值），这是预设切换的传导机制。
2. **强调色预设 5 款**：经典蓝（默认）、紫、绿、橙、石墨。非默认 4 款各两个 CSS 块（`html[data-accent='<id>']` 亮色 10 项 + `html[data-theme='dark'][data-accent='<id>']` 暗色 9 项），色值定案见 §3.1 色值总表。
3. **字号三档**：小 / 标准（默认）/ 大。非默认 2 档各一个 CSS 块，覆写 4 个 `--aw-text-*` 令牌 + 3 个 Element Plus 字号变量，值定案见 §3.1 字号值表。
4. **`utils/appearance.ts` 新建**：与 `theme.ts` 完全同构的模块级单例（registry + 读写 + `html` dataset 应用 + 幂等初始化），`main.ts:75` 在 `useTheme()` 旁接线 `useAppearance()`。
5. **ProfileView 外观卡两行**：现有「主题色」卡（`ProfileView.vue:8-19`）内新增「强调色」行（五枚色板按钮）与「界面字号」行（小 / 标准 / 大三选一）。
6. **组件真硬编码收编 5 处**：按 §4 步骤 4 的映射规则逐处改写，改写前后渲染值逐字节相同。
7. **测试与文档**：新建 `utils/appearance.test.ts`（纯函数 + style.css 源码守卫断言 + 组件硬编码守卫）；同步 `USER_GUIDE.md:190`、`skills/mao-cli/reference/desktop.md:190`、`CHANGELOG.md` 0.0.480 前端节。

### 2.2 非目标（明确不做）

1. **密度紧凑档不做**（提案 P2 整体取消，不做「局部行高」方案——见 §3.2 勘误 2；将来要做须新提案）。
2. **暗色覆盖收编不做**（35 个文件 148 处组件内 `[data-theme="dark"]` 保持现状，提案 P3 不绑定本批次；将来要做须新提案）。
3. 不做自定义取色器（只提供 5 款预设，色值人工核准，见 §3.1）。
4. 不做命令面板的强调色 / 字号命令（面板命令表零改动；主题三条既有命令不动）。
5. 不做偏好云同步 / 跨设备漫游（设备本地口径，与 `aw-theme-mode` 完全一致）。
6. 不做登录页外观入口（登录页循环主题按钮不动；外观设置仅在个人信息页）。
7. 不换字体族、不做界面国际化（产品边界）。
8. 不收编头像色板（`ServerSettingsView.vue:135` `AVATAR_PALETTE` 是用户头像身份色，与 UI 强调色无关，显式豁免）。
9. 不改 30 处 `var(--aw-primary, #0066cc)` 回退形态（回退值永不生效且自动跟随令牌，改动是纯美化无收益，反增回归面）。
10. 零后端、零迁移、零新依赖（LRU 等 CCS 侧无 JS 计算，无需额外库）。

## 3. 技术选型与决策

### 3.1 决策表（全部定案）

| 决策点 | 定案 | 理由 / 证据 |
|---|---|---|
| 强调色切换机制 | `html[data-accent='<id>']` 属性 + CSS 预设块；JS 只切属性不注内联样式 | 与 `data-theme` 暗色机制同构（`theme.ts` `setAttribute('data-theme', …)`），级联天然处理亮暗组合 |
| 预设传导方式 | 派生 alpha 统一引用 `--aw-accent-rgb` 三元组，预设块只改 5 个根值 | 默认 `--aw-accent-rgb: 0, 102, 204`（`:57`）展开后与原字面量逐字节同值；预设改三元组即全族跟随 |
| EP 主色派生 `--el-color-primary-light-3/5/7/8/9`（`:451-455`） | **默认值保留字面量不改**；每款预设亮色块显式覆写这 5 项 | 若默认改 `var(--aw-accent-rgb)` 引用，暗色下 EP 派生色会从亮蓝 `rgba(0,102,204,α)` 变为 `rgba(41,151,255,α)`——现状是字面量不随主题变，改写违反零变化约束 |
| EP 主色本值 / hover | 不动：`--el-color-primary: var(--aw-primary)`、`dark-2: var(--aw-primary-focus)`（`:450,456`） | 已是令牌引用，自动跟随预设 |
| 预设暗色块覆盖集合 | 9 项，与默认暗色块（`:332-340`）现有集合逐项对应 | `--aw-primary` / `--aw-primary-focus` 在暗色下维持亮色值（现状如此），预设复刻同一模式 |
| 字号档位机制 | token 覆写 7 变量，否决根 `font-size` em 缩放 | EP 组件吃 px 值，em 缩放会漏；`style.css:476-484` 已有 EP 变量覆写先例 |
| 字号档位值 | 见下方字号值表（标准档 = 现状） | 小档 `--aw-text-micro` 触底 10px 不再缩 |
| 存储 | localStorage `aw-accent` / `aw-font-scale`；读 `localStorage.getItem`、写 `safeSetItem`（`utils/safe-storage.ts:6`） | 与 `aw-theme-mode` 完全同口径（`theme.ts:65` 读、`:88` 写），设备本地 |
| 初始化 | `appearance.ts` 模块级 `initialized` 幂等守卫 + `main.ts:75` `useAppearance()` 与 `useTheme()` 并列 | `theme.ts:24,63-65` 同构模式 |
| 默认档实现 | `blue` / `std` 归一为 null → `removeAttribute`；损坏存储值归一为 null → 默认档 | 属性缺省 = `:root` 现值，零变化基线由「不写属性」结构性保证 |
| UI 落点 | ProfileView 现有 `theme-card` 内加两行（强调色 / 界面字号） | 该卡注释已自declare「这台设备上的展示偏好收口」（`ProfileView.vue:8`）；不加侧栏项 |
| 色板值 | 见下方色值总表 | 白字对四款亮色主色对比度 5.0–7.6（≥4.5 AA）；暗色变体对深底 6.2–7.4（≥4.5） |

**色值总表**（定案；`light-3` = 主色掺 20% 白，与默认 `#3385d9` 同口径推导）：

| id | label | 亮色主色 L | rgb(L) | focus F | EP light-3 | 暗色主色 D（on-dark / accent） | rgb(D) |
|---|---|---|---|---|---|---|---|
| blue | 经典蓝 | `#0066cc` | 0, 102, 204 | `#0071e3` | `#3385d9` | `#2997ff` | 41, 151, 255 |
| violet | 紫 | `#6E56CF` | 110, 86, 207 | `#7C66D6` | `#8B78D9` | `#A78BFA` | 167, 139, 250 |
| green | 绿 | `#15803D` | 21, 128, 61 | `#1A9247` | `#449964` | `#46A758` | 70, 167, 88 |
| orange | 橙 | `#C2410C` | 194, 65, 12 | `#D64B14` | `#CE673D` | `#F97316` | 249, 115, 22 |
| graphite | 石墨 | `#475569` | 71, 85, 105 | `#5A6B85` | `#6C7787` | `#94A3B8` | 148, 163, 184 |

blue 为默认：**不生成 CSS 块**（属性缺省即 `:root` 现值）；表内列出仅为对照。

**字号值表**（定案）：

| 变量 | 小 | 标准（现状，不写属性） | 大 |
|---|---|---|---|
| `--aw-text-body` | 15px | 17px | 19px |
| `--aw-text-caption` | 13px | 14px | 15px |
| `--aw-text-fine` | 11px | 12px | 13px |
| `--aw-text-micro` | 10px | 10px | 11px |
| `--el-font-size-base` | 12px | 13px | 14px |
| `--el-font-size-small` | 11px | 12px | 13px |
| `--el-font-size-extra-small` | 11px | 12px | 13px |

marketing 尺寸（`--aw-text-hero/display/lead/tagline`，仅登录页与空态使用）三档一律不动。

### 3.2 对提案的五处勘误（随本方案落定）

1. **收编范围**：提案称「38 处硬编码断点」——实查 30 处为 `var(--aw-primary, #0066cc)` 回退形态（自动跟随，不改）；真硬编码 5 处 + `style.css` 派生 16 处（12 处等值改写、EP 5 项保留默认进预设覆写、light-3 本就需预设覆写）。
2. **密度**：提案 P2「收窄范围先评估」→ 本批次不做（局部行高 token 也涉及几十个组件的 padding 语义，收益不足以覆盖回归面）。
3. **命令面板命令**：提案 P2「可选追加」→ 不做。
4. **色板与字号值**：提案留白 → 定案为 §3.1 两张表。
5. **豁免项**：头像色板 `AVATAR_PALETTE`（提案未识别）显式排除。

## 4. 实现步骤

### 步骤 1：`desktop/src/style.css`——令牌改写 + 预设块 + 字号块

**(a) 12 处 alpha 定义等值改写**（行号为现值）：

```css
/* :10-14（亮色 primary 家族，α 不变） */
--aw-primary-lighter: rgba(var(--aw-accent-rgb), 0.10);   /* 原 rgba(0, 102, 204, 0.10) */
--aw-primary-soft:    rgba(var(--aw-accent-rgb), 0.05);
--aw-primary-hover:   rgba(var(--aw-accent-rgb), 0.08);
--aw-primary-ring:    rgba(var(--aw-accent-rgb), 0.12);
--aw-primary-line:    rgba(var(--aw-accent-rgb), 0.20);
/* :58 */
--aw-accent-bg: rgba(var(--aw-accent-rgb), 0.08);
/* :333-337, :340（暗色块，α 不变；--aw-accent-rgb 暗色已重定义为 41, 151, 255，:339） */
--aw-primary-lighter: rgba(var(--aw-accent-rgb), 0.18);   /* 原 rgba(41, 151, 255, 0.18)，余四项同理 */
--aw-accent-bg: rgba(var(--aw-accent-rgb), 0.12);
```

**(b) 保留的字面量**（默认档零变化的锚点，预设块按色值表覆写）：`:451` `--el-color-primary-light-3: #3385d9`、`:452-455` 四行 EP alpha。

**(c) 预设块**（4 款 × 2 块，追加在暗色块之后；以下为 violet 全量，其余 3 款按色值表逐项替换）：

```css
/* ===== 强调色预设（提案批次 27）：html[data-accent] 切换，blue 默认不写属性 ===== */
html[data-accent='violet'] {
  --aw-primary: #6E56CF;
  --aw-primary-focus: #7C66D6;
  --aw-primary-on-dark: #A78BFA;
  --aw-accent: #6E56CF;
  --aw-accent-rgb: 110, 86, 207;
  --el-color-primary-light-3: #8B78D9;
  --el-color-primary-light-5: rgba(110, 86, 207, 0.15);
  --el-color-primary-light-7: rgba(110, 86, 207, 0.10);
  --el-color-primary-light-8: rgba(110, 86, 207, 0.08);
  --el-color-primary-light-9: rgba(110, 86, 207, 0.05);
}
html[data-theme='dark'][data-accent='violet'] {
  --aw-primary-on-dark: #A78BFA;
  --aw-primary-lighter: rgba(167, 139, 250, 0.18);
  --aw-primary-soft: rgba(167, 139, 250, 0.08);
  --aw-primary-hover: rgba(167, 139, 250, 0.14);
  --aw-primary-ring: rgba(167, 139, 250, 0.22);
  --aw-primary-line: rgba(167, 139, 250, 0.32);
  --aw-accent: #A78BFA;
  --aw-accent-rgb: 167, 139, 250;
  --aw-accent-bg: rgba(167, 139, 250, 0.12);
}
```

alpha 值与默认块逐项同值（亮 `0.10/0.05/0.08/0.12/0.20/0.08`，暗 `0.18/0.08/0.14/0.22/0.32/0.12`）；`--aw-accent-bg` / primary 家族因步骤 (a) 已改引用，预设块无需重复定义。

**(d) 字号块**（2 块，按字号值表）：

```css
html[data-font-scale='small'] {
  --aw-text-body: 15px; --aw-text-caption: 13px; --aw-text-fine: 11px; --aw-text-micro: 10px;
  --el-font-size-base: 12px; --el-font-size-small: 11px; --el-font-size-extra-small: 11px;
}
html[data-font-scale='large'] {
  --aw-text-body: 19px; --aw-text-caption: 15px; --aw-text-fine: 13px; --aw-text-micro: 11px;
  --el-font-size-base: 14px; --el-font-size-small: 13px; --el-font-size-extra-small: 13px;
}
```

### 步骤 2：`desktop/src/utils/appearance.ts`（新建，约 90 行）+ `main.ts` 接线

与 `theme.ts` 完全同构：模块级 ref + `initialized` 幂等守卫 + `useAppearance()` composable。

```ts
export type AccentId = 'blue' | 'violet' | 'green' | 'orange' | 'graphite'
export type FontScaleId = 'small' | 'std' | 'large'

export const ACCENT_PRESETS: ReadonlyArray<{ id: AccentId; label: string; swatch: string }> = [
  { id: 'blue', label: '经典蓝', swatch: '#0066cc' },
  { id: 'violet', label: '紫', swatch: '#6E56CF' },
  { id: 'green', label: '绿', swatch: '#15803D' },
  { id: 'orange', label: '橙', swatch: '#C2410C' },
  { id: 'graphite', label: '石墨', swatch: '#475569' },
]
export const FONT_SCALE_OPTIONS: ReadonlyArray<{ id: FontScaleId; label: string }> = [
  { id: 'small', label: '小' }, { id: 'std', label: '标准' }, { id: 'large', label: '大' },
]
```

- `normalizeAccent(v: string | null): AccentId | null`：合法非默认 id 原样返回；`'blue'` / null / 非法值 → null。`normalizeFontScale` 同理（`'std'` → null）。**导出供单测**（vitest node 环境可测的纯函数部分）。
- `applyAccent(id: AccentId)`：`normalizeAccent` 为 null → `document.documentElement.removeAttribute('data-accent')`，否则 `setAttribute('data-accent', id)`。`applyFontScale` 同理（`data-font-scale`）。
- 存储：`getAccent()` 读 `localStorage.getItem('aw-accent')` 经 normalize（非法值读作默认，不主动清除）；`setAccent(id)` 写 `safeSetItem('aw-accent', id)` + `applyAccent` + 同步 ref。字号同构（`aw-font-scale`）。
- `initAppearance()`：`initialized` 守卫 → 读两键 → apply 两属性 → `watch` 不需要（属性只在 set 时写，无系统级事件源）。
- `useAppearance()`：调 `initAppearance()`，返回 `{ accent, fontScale, setAccent, setFontScale, ACCENT_PRESETS, FONT_SCALE_OPTIONS }`。
- `main.ts:75`：`useTheme()` 之后加 `useAppearance()`。

### 步骤 3：`desktop/src/views/settings/ProfileView.vue`——外观卡两行

在现有 `theme-card`（`:9-19`）内、主题色 `theme-row` 之后新增两个 `theme-row`（结构完全照抄现有行：左 label+hint，右控件）：

1. **强调色行**：label「强调色」+ hint「应用于按钮、链接与选中态，亮暗主题各自适配。」；控件为 5 枚 20px 圆形色板按钮（`:style="{ background: p.swatch }"`，选中态描边 `2px solid var(--aw-primary)`），每枚 `type="button"` + `:aria-label="'强调色：' + p.label"`（AGENTS.md 图标按钮规范）+ `:aria-pressed="accent === p.id"`，点击 `setAccent(p.id)`。
2. **界面字号行**：label「界面字号」+ hint「三档影响界面与正文字号，立即生效。」；控件 `el-radio-group`（小 / 标准 / 大，复用既有 `theme-radio-group` 样式类），`@change="setFontScale($event)"`。

script 区：`import { useAppearance } from '../../utils/appearance'`，`const { accent, fontScale, setAccent, setFontScale } = useAppearance()`。

### 步骤 4：组件真硬编码收编（5 处，逐处映射定案）

| 位置 | 现值 | 改为 | 等价性 |
|---|---|---|---|
| `QuickCommandTag.vue:47` | `background: #0066cc;` | `background: var(--aw-primary);` | 令牌现值即 `#0066cc` |
| `MessageBubble.vue:991` | `background: rgba(41, 151, 255, 0.12);` | `background: var(--aw-accent-bg);` | 与暗色 `--aw-accent-bg`（`:340`）逐字节同值（该行处于暗色覆盖语境） |
| `ServerSettingsView.vue:525` | `background: rgba(0, 102, 204, 0.08);` | `rgba(var(--aw-accent-rgb), 0.08);` | 亮色三元组展开同值 |
| `ServerSettingsView.vue:526` | `border-color: rgba(0, 102, 204, 0.25);` | `rgba(var(--aw-accent-rgb), 0.25);` | 同上 |
| `ServerSettingsView.vue:587` | `border: 1px solid rgba(0, 102, 204, 0.4);` | `1px solid rgba(var(--aw-accent-rgb), 0.4);` | 同上 |

`ServerSettingsView.vue:135` `AVATAR_PALETTE` 不动（§2.2 第 8 条）；30 处回退形态不动（§2.2 第 9 条）。

### 步骤 5：测试 + 文档同步 + 验证 + 提交

1. **新建 `desktop/src/utils/appearance.test.ts`**（vitest node 环境）：
   - registry 断言：`ACCENT_PRESETS` 5 项 id 唯一且含 `blue`、每项有 label/swatch；`FONT_SCALE_OPTIONS` 3 项含 `std`。
   - normalize 断言：`'blue'`/null/undefined/`'red'` → null；`'violet'` → `'violet'`；`'std'` → null；`'large'` → `'large'`；非法 → null。
   - **style.css 源码守卫**（`readFileSync` 断言源文本）：`rgba(var(--aw-accent-rgb)` 恰好 12 处；`rgba(41, 151, 255` 恰好 0 处；`rgba(0, 102, 204` 恰好 4 处（仅 EP light-5/7/8/9）；`#3385d9` 恰好 1 处；4 款非默认预设的 `html[data-accent='<id>']` 与 `html[data-theme='dark'][data-accent='<id>']` 各 1 处；`html[data-font-scale='small']` 与 `'large'` 各 1 处。
   - **组件硬编码守卫**：扫描 `components/ + views/` 的 `.vue` 源码，剥离全部 `var(--aw-primary…)` / `var(--aw-accent…)` 回退表达式后，断言 `#0066cc / #0071e3 / #2997ff / rgba(0, 102, 204 / rgba(41, 151, 255` 命中 0 处（`AVATAR_PALETTE` 行按精确字符串加入白名单）。
2. **文档同步**：`USER_GUIDE.md:190`「主题色（浅色 / 深色 / 跟随系统）在『设置 → 个人信息』顶部切换」句扩写为含强调色五款与字号三档；`skills/mao-cli/reference/desktop.md:190` 同句同步；`CHANGELOG.md` 顶部新增 `## 0.0.480 (发布日)` → `### 前端（桌面 / Web）` 节（含强调色 / 字号 / 默认观感不变三句）。
3. **验证命令**（AGENTS.md 口径，禁 `npx vue-tsc --noEmit` 假通过）：`cd desktop && npm run build > /tmp/appearance-build.log 2>&1; echo exit=$?`、`cd desktop && npm test > /tmp/appearance-test.log 2>&1; echo exit=$?` 后 grep 摘要；根目录 `npm test` Playwright desktop spec（未初始化先 `bash scripts/e2e-setup.sh`）。
4. 提交：`feat(desktop): 外观个性化——强调色五款与字号三档，默认观感零变化（0.0.480）`。

## 5. 落地清单

| 文件 | 改动 | 类型 |
|---|---|---|
| `desktop/src/style.css` | 12 行 alpha 改写 + 预设块 8 个（~90 行）+ 字号块 2 个（~16 行） | 修改 |
| `desktop/src/utils/appearance.ts` | registry + normalize/apply/存取 + `useAppearance()` | **新建** |
| `desktop/src/main.ts` | `useTheme()` 旁加 `useAppearance()`（1 行） | 修改 |
| `desktop/src/views/settings/ProfileView.vue` | 外观卡两行 + script 引入（~60 行） | 修改 |
| `desktop/src/components/chat/QuickCommandTag.vue` | `:47` 一行收编 | 修改 |
| `desktop/src/components/chat/MessageBubble.vue` | `:991` 一行收编 | 修改 |
| `desktop/src/views/settings/ServerSettingsView.vue` | `:525,526,587` 三行收编 | 修改 |
| `desktop/src/utils/appearance.test.ts` | 纯函数 + style.css 守卫 + 组件守卫 | **新建** |
| `USER_GUIDE.md` | `:190` 外观设置句扩写 | 修改 |
| `skills/mao-cli/reference/desktop.md` | `:190` 外观设置句同步 | 修改 |
| `CHANGELOG.md` | 0.0.480 前端节 | 修改 |
| `backend-ts/`、`admin/`、`android/`、`agent-cli/`、数据库迁移 | **零改动** | — |
| 30 处回退形态、`AVATAR_PALETTE`、EP `:450,456` 引用、`theme.ts` | **零改动** | — |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 12 处等值改写引入视觉差异 | 等价性由「`--aw-accent-rgb` 默认值与原字面量同 rgb 三元组」结构性保证；单测锁定 `rgba(var(--aw-accent-rgb)` 12 处 + EP 残留 4 处 + `#3385d9` 1 处的精确计数，任何多改少改直接红 |
| 预设切换漏色（某组件仍写死蓝） | 组件守卫测试剥离回退形态后 0 命中（步骤 5.1 第 4 条）；收编仅 5 处，清单封闭 |
| 预设对比度不足 | 色值按 WCAG AA 选型并附实测值（白字 5.0–7.6、深底 6.2–7.4，§3.1）；改色必须过色值总表评审 |
| 字号放大撑破布局 | 三档幅度 ±2px 内、EP 三变量联动；Playwright desktop spec + 手动矩阵（§7.6）兜底 |
| localStorage 损坏值 | normalize 非法值归一默认档（读不清洗、写时覆盖），UI 永远有合法选中态 |
| `html[data-accent]` 与 `[data-theme='dark']` 级联冲突 | 预设暗色块选择器 `html[data-theme='dark'][data-accent='<id>']` 特异性 (0,2,1) 高于暗色默认块 (0,1,0)，与书写顺序无关；亮色块 `html[data-accent]` (0,1,1) 高于 `:root` (0,1,0) |
| EP 弹层（teleport 到 body）不跟随 | 变量挂在 `html`，body 弹层继承；EP 主色已走 `var(--aw-primary)`（`:450`） |
| JS 侧读色依赖 | 全仓无 JS 读取 `--aw-primary/--aw-accent`（grep 仅 `useMonacoQuote.ts:38` 读 position），无联动面；Monaco 主题是语法配色，与强调色无关 |

## 7. 测试要点

1. `appearance.test.ts` 全绿：registry / normalize / style.css 守卫 / 组件守卫四组断言（步骤 5.1 全部子项）。
2. `cd desktop && npm run build`（`vue-tsc -b && vite build`）通过；`npm test` 既有用例零回归。
3. 默认零变化基线：清空 `aw-accent` / `aw-font-scale` 后 `documentElement` 无 `data-accent` / `data-font-scale` 属性；选回「经典蓝 / 标准」后属性被移除。
4. 持久化与账号隔离：设置紫 + 大字号后刷新保留；键为设备本地（不随登出清除，与主题一致）。
5. 强调色矩阵点验（5 预设 × 亮暗）：主按钮 / 链接 / 焦点环 / 输入框 focus / 下拉选中 / 文件树选中 / 页签高亮 / 消息引用条 / 表格工具条取色一致；EP 组件（按钮、开关、单选、分页）同步变色。
6. 字号矩阵点验（3 档）：聊天正文、侧栏列表行、设置表单、EP 输入框 / 下拉整体缩放；登录页与空态 hero 文案不变；切档后 `useChatScroll` 滚动定位正常。
7. 收编 5 处回归：QuickCommand 标签底色、MessageBubble 暗色引用块底色、ServerSettings 提示条三处，默认档截图与主分支一致。
8. 安卓壳实机：外观卡操作与切色生效（共用 UI、无平台分支、无原生变更，不发 apk）。

## 8. 决策记录（原提案 §8 三项 → 定案）

| 原待评审项 | 定案 |
|---|---|
| 1. 预设色板选型 | 5 款封顶（蓝 / 紫 / 绿 / 橙 / 石墨），色值见 §3.1；不做品牌色定制位 |
| 2. 字号实现选型 | token 覆写 + EP 三变量联动（§3.1 字号值表）；否决根 em 缩放 |
| 3. P2 密度 / P3 收编是否绑定本批次 | 均不绑定：密度取消、暗色收编须新提案（§2.2 第 1、2 条） |

## 9. 明确不做的（汇总）

1. 密度紧凑档（含任何局部行高 / 间距缩放）
2. 暗色覆盖收编（35 文件 148 处维持现状）
3. 自定义取色器、品牌色定制位
4. 命令面板强调色 / 字号命令
5. 偏好云同步 / 跨设备漫游 / 按账号隔离
6. 登录页外观入口、字体族更换、界面国际化
7. `AVATAR_PALETTE` 头像色板收编
8. 30 处 `var(--aw-primary, #0066cc)` 回退形态改写
9. 后端、admin、安卓原生、数据库迁移的任何改动
