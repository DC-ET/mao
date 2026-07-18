# 管理后台移动端适配技术方案

> 范围：`admin/`（Vue 3 + Element Plus 管理后台），不涉及 `desktop/` 客户端。
> 目标：在「不重写现有页面」的前提下，让管理后台在手机（≤768px）上**可用、可读、可操作**。
> 当前日期：2026-07-18

---

## 1. 现状与问题

### 1.1 已具备的基础
- `admin/index.html` 已有 `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`，无需补充。
- 技术栈为 Vue 3 + Element Plus 2.14 + Vite 8，支持媒体查询与 `:deep()` 穿透样式，适配改造成本低。

### 1.2 核心问题（按影响排序）

| # | 问题 | 现状 | 移动端后果 |
|---|------|------|-----------|
| M1 | 固定宽度侧边栏 + 100vh 布局 | `Layout.vue` 用 `<el-aside width="200px">` 与 `.layout-container { height: 100vh }` | 桌面侧边栏在手机上挤占 2/3 屏宽，主内容被压扁 |
| M2 | 表格列宽硬编码 | 各 `*ListView` 用 `width="80/120/170"`、`min-width="180/200"` | 列多于屏宽时出现横向滚动，操作列 `fixed="right"` 错位，体验差 |
| M3 | 顶部面包屑 + 标签栏横向溢出 | `Layout.vue` header 与 `TabBar.vue` 在窄屏挤压 | 标题/标签被截断，关闭按钮点不准 |
| M4 | Element Plus 弹窗/分页默认桌面尺寸 | `el-dialog width="480px"`、`el-pagination layout="total, sizes, prev, pager, next, jumper"` | 弹窗超出视口、分页一行放不下需折叠 |
| M5 | 描述列表固定 4 列 | `SessionDetailView` 的 `el-descriptions :column="4"` | 手机上 4 列文字相互挤压 |
| M6 | 表单/搜索区 inline 横排 | `search-form` 用 `:inline="true"`，`el-form-item` 固定宽度 | 横向排布在窄屏溢出或严重错乱 |
| M7 | 登录卡片固定 400px | `LoginView.vue` `.login-card { width: 400px }` | 小屏左右留白/溢出 |

### 1.3 设计原则
- **响应式而非重做**：用 CSS 媒体查询 + 少量组件化封装覆盖现有样式，不推翻业务组件。
- **断点统一**：以 `768px`（平板/手机分界）为主断点，必要时加 `480px`。
- **优先「可用」**：移动端允许表格降级为卡片列表、弹窗全屏、菜单抽屉化——不必与桌面像素级一致。
- **最小侵入**：优先改全局样式（`style.css` + Layout），业务页只补关键 media query。
- **不引入新依赖**：纯 CSS + Element Plus 已有能力（抽屉、对话框全屏 API）即可完成。

---

## 2. 整体方案

### 2.1 断点与布局策略

| 视口 | 侧边栏 | 内容区 | 表格 | 弹窗 |
|------|--------|--------|------|------|
| ≥1024px（桌面） | 固定 200px 侧边栏常驻 | 多列栅格 | 原表格不变 | 居中对话框 |
| 768–1023px（平板） | 可折叠抽屉 | 2 列栅格 | 表格横向滚动 / 精简列 | 居中对话框 |
| ≤768px（手机） | **抽屉式**（默认收起，汉堡按钮打开） | 单列栅格 | **卡片列表**（替代表格） | **全屏/近全屏**对话框 |

### 2.2 关键组件改造清单

#### A. 布局容器（Layout.vue）— 解决 M1/M3
- 新增 `isMobile` 计算属性（`window.innerWidth <= 768`），并监听 `resize`。
- 桌面：维持当前 `<el-aside>` 常驻。
- 移动：隐藏 `<el-aside>`，改为 `<el-drawer>`（direction="ltr"）承载原侧边菜单；header 左侧加汉堡按钮（`el-icon Menu`）触发 drawer；`App.vue`/`Layout` 监听 drawer 关闭。
- 菜单内容抽为 `<SideMenu />` 子组件（或 `v-if` 复用同一 `el-menu`），桌面放 aside、移动放 drawer，避免重复。
- header：移动端隐藏 `el-breadcrumb`（或仅留当前标题），右侧用户名可缩为头像。
- `.layout-container` 高度用 `100dvh`（动态视口高度，规避移动浏览器地址栏抖动），并保留 `100vh` 兜底。

#### B. 标签栏（TabBar.vue）— 解决 M3
- 已具备 `overflow-x: auto`，移动端补充 `flex-wrap: nowrap` 保证横向滚动；关闭图标点击区放大到 ≥28px。
- 移动端可隐藏标签栏（手机多页签价值低），由抽屉导航替代；建议保留但允许横向滑动。

#### C. 表格 → 卡片列表（各 ListView）— 解决 M2
- **封装通用 `<ResponsiveTable>` 或采用「列宽缩放 + 横向滚动」的轻量方案**：
  - 方案 1（推荐，低成本）：保留 `el-table`，移动端通过 `:deep(.el-table__body)` 允许横向滚动，并对操作列 `fixed="right"` 校验对齐；同时用媒体查询隐藏低优先级列（`display:none`）。
  - 方案 2（体验最佳，成本中）：移动端渲染为「卡片列表」——每行数据用 `el-card` 展示关键字段+操作按钮，用 `v-if="isMobile"` 切换模板。适合 `UserListView`、`SessionListView`、`AuditLogView` 等高频页。
- 建议：**先落地方案 1（隐藏次要列 + 横向滚动）覆盖全站，再对 3–4 个核心列表（User/Session/Audit）补充方案 2 卡片视图**。

#### D. 弹窗与分页（全局）— 解决 M4
- `el-dialog`：移动端加 `:fullscreen="isMobile"` 或 `width="92%"`；封装 `<ResponsiveDialog>` 包裹 `el-dialog`，统一移动端全屏行为。
- `el-pagination`：移动端 `layout` 改为 `"prev, pager, next"`（去掉 sizes/jumper/total），`page-size` 默认降到 10；或封装 `<ResponsivePagination>`。

#### E. 描述列表（SessionDetailView）— 解决 M5
- `el-descriptions :column` 改为 `:column="isMobile ? 1 : 4"`，并给长文本列 `:span="isMobile ? 1 : 2"`。

#### F. 搜索/筛选表单（各 ListView）— 解决 M6
- `:inline="true"` 在移动端通过媒体查询改为纵向堆叠：`.search-form { flex-direction: column }`，`el-form-item` 宽度 `100%`，`el-input/el-select` 去固定 `style="width"` 或改 `width:100%`。
- 表单项过多时，移动端可加「展开/收起」或折叠进 `el-collapse`。

#### G. 登录页（LoginView）— 解决 M7
- `.login-card { width: 400px }` 改为 `width: min(400px, 92vw)`；容器 `padding` 适配小屏。

#### H. Dashboard 栅格（DashboardView）— 联动 M2
- `el-col :span="6"` 在移动端通过媒体查询改为 `:span="12"`（2 列）或 `:span="24"`（1 列）；图表容器 `chart-container` 横向滚动或缩小柱宽。

---

## 3. 可复用的适配基础设施（建议新增）

为减少每个页面重复写媒体查询，建议在 `admin/src/` 新增：

1. **`composables/useBreakpoint.ts`**
   - 暴露 `isMobile`（≤768）、`isTablet`（769–1023）响应式 ref，内部监听 `resize` 并以 `matchMedia` 实现。
   - 用法：`const { isMobile } = useBreakpoint()`。

2. **全局断点样式（`style.css` 或新建 `admin/src/styles/responsive.css` 并在 `main.ts` 引入）**
   - 统一 `.responsive-hide-mobile { @media (max-width:768px){ display:none } }` 等工具类。
   - 统一 Element Plus 覆盖：`@media (max-width:768px){ .el-dialog{ width:92% !important } .el-pagination .el-pagination__sizes, .el-pagination__jump { display:none } }`。

3. **`components/ResponsiveDialog.vue` / `components/ResponsivePagination.vue`**
   - 薄封装，内部根据 `useBreakpoint` 设置 `fullscreen` / `layout`，业务页直接替换原组件。

4. **`components/SideMenu.vue`**
   - 抽出现有 `el-menu`（13 个菜单项），供桌面 `aside` 与移动 `drawer` 共用。

---

## 4. 落地步骤（建议排期）

> 优先级 P0（阻塞可用）→ P1（核心页体验）→ P2（全站收尾）。

- **P0-1** 新增 `useBreakpoint` + 全局响应式样式文件，接入 `main.ts`。
- **P0-2** 改造 `Layout.vue`：移动端抽屉菜单 + 汉堡按钮 + `100dvh`；抽 `SideMenu.vue`。
- **P0-3** 登录页 (`LoginView`) 卡片宽度自适应。
- **P1-1** 封装 `ResponsiveDialog` / `ResponsivePagination` 并替换核心页弹窗与分页。
- **P1-2** `UserListView` / `SessionListView` / `AuditLogView` 移动端卡片列表（方案 2）+ 搜索表单堆叠。
- **P1-3** `SessionDetailView` 描述列表单列；`DashboardView` 栅格降级。
- **P2-1** 其余列表页（Agent/Model/Skill/Role/Notification/Runtime/Analytics/Settings）用「隐藏次要列 + 横向滚动」统一适配（方案 1）。
- **P2-2** `TabBar` 移动端交互打磨、全局 Element Plus 尺寸微调（如 `el-button` 触摸区）。

---

## 5. 验证方式

- **构建校验**：`cd admin && npm run build`（含 `vue-tsc` 类型检查）确保无类型/编译错误。
- **真机/模拟器**：浏览器 DevTools 设备模拟（iPhone SE 375px、Pixel 412px）+ 真机扫码访问 `/admin`。
- **E2E 回归**：根目录 `npm run test:admin` 确认桌面端登录与关键路径未回归（注意现有用例断言优先 `toContainText`/`toBeVisible`，移动适配不应破坏这些断言）。
- **检查清单**：
  - [ ] 手机端侧边栏为抽屉且可开合，主内容占满宽度
  - [ ] 登录/卡片弹窗不溢出视口
  - [ ] 列表页在 375px 下无横向溢出或仅表格内部可控滚动
  - [ ] 分页在窄屏仅显示上下页
  - [ ] 会话详情描述列表单列可读

---

## 6. 风险与取舍

- **表格卡片化需逐页写模板**：方案 2 对每页有少量重复工作；优先覆盖高频页，其余用方案 1 兜底。
- **`keep-alive` + 抽屉状态**：`Layout` 抽屉开关状态需与路由联动，避免返回桌面尺寸时残留 `drawer` 打开态；用 `watch(isMobile)` 关闭抽屉。
- **Element Plus 组件内部样式穿透**：部分弹窗/popover 需 `:deep()` 覆盖，注意 `!important` 必要性，避免污染桌面端（务必包在媒体查询内）。
- **不追求「移动原生」体验**：本方案目标是「管理员用手机能应急查看/操作」，而非替代桌面端专业操作；复杂批量操作仍建议在桌面端完成。
