# 前端代码评审报告：desktop + admin（第 6 轮）

- 日期：2026-10-25
- 审查范围：
  - `admin/src/`：10 月新页面与近期高频改动（`views/agent/AgentExperienceLibraryDialog.vue`、`views/settings/components/EcpConfigPanel.vue`、`views/settings/SystemSettingsView.vue`、`api/index.ts`、`main.ts`、`views/feedback/FeedbackView.vue` 分页等）
  - `desktop/src/`：聊天链路（`useChat.ts` / `ChatPanel.vue` / `ChatInput.vue` / `MessageBubble.vue` / `useStreamWS.ts`）、任务与中心 Tab（`views/task/TaskView.vue` / `useCenterTabs.ts`）、收件箱（`components/inbox/InboxDrawer.vue`）、用量（`components/usage/`）、通道绑定与登录轮询、`api/index.ts`、`main.ts`、构建产物 `desktop/dist/assets/`
  - 交叉验证：`backend-ts/src/agent/agent-experience-library.routes.ts`（经验库 PUT 语义）、`desktop/dist/assets`（图标打包实证）
- 审查维度：功能模块缺陷、交互逻辑、UI 样式（含暗色主题）、性能（包体积）
- 方法：原计划 4 路并行子代理分区审查，因模型并发限制全部失败，改为主评审人单线程逐文件静态审查；对每条问题回读源码核实行号与证据，并对「图标全量打包」用当前 `desktop/dist` 产物 grep 实证。未运行 vue-tsc / 构建 / 单测 / Playwright，无运行时与视觉验证。
- 与前几轮的关系：与 `2026-09-21-frontend-review-01.md`、`2026-09-28-frontend-review-01.md`（第 4 轮）、`2026-09-28-frontend-review-02.md`、`2026-09-30-frontend-review-01.md`（第 5 轮）逐条去重；同型但位置不同（新文件 / 另一端复发）的条目在各条「与历史评审的关系」中说明。文末附本轮核实为「已修复」的历史条目清单。
- 总体观察：经过前 5 轮前端评审与多轮逻辑评审，本轮重点抽查的历史高严重度条目（WS 断线横幅、上传失败守卫、图片上限、isTouchDevice、搜索加载态、登出状态残留）均已确认修复，浅层缺陷已基本清空；本轮收录的问题以近期新增代码（10-24 经验库、InboxDrawer 等）和跨端不一致为主，无高严重度条目。
- 本轮共 **6 个问题**：中 1、中低 2、低中 1、低 2。
- 以下行号对应当前工作区文件。

---

## 严重度汇总

| # | 端 | 问题 | 类别 | 严重程度 | 位置 |
|---|:---:|------|------|:---:|------|
| 1 | admin | 经验库「新建经验」重名保存静默覆盖已有共享文档，无确认无提示 | 功能 | 中 | `views/agent/AgentExperienceLibraryDialog.vue:171-192` + `backend-ts/src/agent/agent-experience-library.routes.ts:85-103` |
| 2 | desktop | 聊天输入框粘贴「图文混排」内容时文字被静默丢弃，只落图片 | 交互 | 中低 | `components/chat/ChatInput.vue:543-571` |
| 3 | desktop | InboxDrawer 类型徽章整组硬编码亮色系配色，暗色主题无任何适配 | UI 样式 | 中低 | `components/inbox/InboxDrawer.vue:282-310,333-338` |
| 4 | admin | 经验库 load / startEdit 错误双重弹 toast，同文件两种错误处理口径并存 | 交互 | 低中 | `views/agent/AgentExperienceLibraryDialog.vue:126-138,159-169` + `api/index.ts:68-73,102-104` |
| 5 | desktop | 全量注册约 300 个 Element Plus 图标进主包；admin 已按需化，desktop 未跟进 | 性能 | 低中 | `desktop/src/main.ts:39-42` vs `admin/src/main.ts:15-20` |
| 6 | admin | 「新建经验」默认文件名是不完整占位 `YYYY-MM-DD-.md`，可直接保存；点「编辑」无 loading 反馈 | 交互 | 低 | `views/agent/AgentExperienceLibraryDialog.vue:154-157,159-169` |

---

## 一、功能模块缺陷

### 1. 经验库「新建经验」重名保存静默覆盖已有共享文档（admin，中）

- **位置**：`admin/src/views/agent/AgentExperienceLibraryDialog.vue:171-192`（`saveDoc`）；后端 `backend-ts/src/agent/agent-experience-library.routes.ts:85-103`（PUT 处理器）
- **证据**：
  ```ts
  // AgentExperienceLibraryDialog.vue:171-192 —— 新建（existing=false）与编辑（existing=true）
  // 共用同一 PUT，文件名校验只有格式规则，没有重名检查
  async function saveDoc() {
    if (!editing.value) return
    const fileName = editing.value.fileName.trim()
    if (!fileName.endsWith('.md') || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      ElMessage.warning('文件名必须是 .md 结尾且不含路径')
      return
    }
    ...
    await api.put(`/agents/${props.agentId}/experience-library/docs/content`, {
      fileName,
      content: editing.value.content,
    })
  ```
  ```ts
  // agent-experience-library.routes.ts:96-98 —— 后端无条件 writeDoc，不区分新建/覆盖
  let bytes: number;
  try {
    bytes = experienceIndexService.writeDoc(agentDir, fileName, body.content);
  ```
- **行为**：经验库是跨成员共享目录（对话框顶部说明「跨会话、跨成员」）。「新建经验」时输入一个已存在的文件名（或按默认占位名保存后再次新建同名），PUT 直接整文件覆盖，无二次确认、无提示；被覆盖的原文档内容不可恢复。对照组：同一对话框内「删除」有 `ElMessageBox.confirm`（`removeDoc`，:194-199），覆盖反而没有。
- **影响**：管理员 B 在新建时无意撞上管理员 A 沉淀的文档名（默认名就是日期前缀，同一天新建极易撞名），A 的经验文档被静默清空。共享库场景下属真实数据丢失风险。
- **修复建议**：前端 `saveDoc` 在 `existing === false` 且 `fileName` 命中当前 `docs` 列表时弹确认「文件已存在，覆盖将替换原文档」；更稳妥的做法是后端 PUT 支持 `overwrite` 参数，缺省时对已存在文件返回 409，由前端按确认结果重发。
- **与历史评审的关系**：新文件（2026-10-24 引入），历史评审未覆盖。

## 二、交互逻辑

### 2. 聊天输入框粘贴「图文混排」内容时文字被静默丢弃（desktop，中低）

- **位置**：`desktop/src/components/chat/ChatInput.vue:543-571`（`handlePaste`）
- **证据**：
  ```ts
  handlePaste: (_view, event) => {
    if (props.disabled) return true
    const items = event.clipboardData?.items
    if (items) {
      let handledFile = false
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          ...
          addPendingImage(file)
          handledFile = true
        } else if (item.kind === 'file') {
          ...
          addPendingFile(file)
          handledFile = true
        }
      }
      if (handledFile) return true   // ← 剪贴板含图片/文件时直接终止，text/plain 分支被跳过
    }
    // Handle text paste — ...
    const text = event.clipboardData?.getData('text/plain')
  ```
- **行为**：TipTap/ProseMirror 的 `handlePaste` 返回 `true` 表示「已处理」，默认粘贴行为（插入 text/plain）被跳过。从网页、Word、飞书文档等复制「一段文字 + 截图」的混排内容粘贴进聊天框时，只有图片进入待发列表，整段文字静默丢失，无任何提示。
- **影响**：用户以为贴了完整说明，实际发出的消息只有图片；Agent 拿不到文字上下文。复制纯截图（截图工具）不受影响，因此该路径在日常测试中不易暴露。
- **修复建议**：`handledFile` 为 true 时，若 `event.clipboardData?.getData('text/plain')` 非空，用 `editor.commands.insertContent(text)` 把纯文本一并插入编辑器后再 `return true`；或至少对「剪贴板同时含文字与图片」的场景弹提示。
- **与历史评审的关系**：第 4 轮 #3（图片上限绕过）同函数不同缺陷，彼条已修复（:553、:946、:968 三处上限均已强制），本条未被覆盖。

### 4. 经验库 load / startEdit 错误双重弹 toast，同文件两种错误处理口径并存（admin，低中）

- **位置**：`admin/src/views/agent/AgentExperienceLibraryDialog.vue:126-138`（`load`）、`:159-169`（`startEdit`）；对照 `:187-192`（`saveDoc`）、`:204-207`（`removeDoc`）；根因机制在 `admin/src/api/index.ts:68-73`（业务 code≠0 自动 toast）与 `:102-104`（HTTP 错误自动 toast）
- **证据**：
  ```ts
  // api/index.ts:68-73 —— 拦截器对失败请求统一弹 ElMessage.error（未置 skipErrorToast 时）
  if (data.code !== 0) {
    if (!response.config.skipErrorToast) {
      ElMessage.error(data.message || '请求失败')
    }
  ```
  ```ts
  // AgentExperienceLibraryDialog.vue:133-134 —— load 的 catch 又弹一次
  } catch {
    ElMessage.error('加载经验库失败')
  ```
  ```ts
  // 同文件 saveDoc 的 catch —— 依赖拦截器，注释自认口径
  } catch {
    // api 拦截器已弹错误提示
  }
  ```
- **行为**：打开经验库对话框或点「编辑」失败时，拦截器 toast（带服务端 message）与页面 catch 的本地 toast（固定文案）接连弹出，同一错误提示两遍；而保存 / 删除 / 重建索引走拦截器单次提示。同一文件两种口径并存。
- **影响**：双重 toast 干扰排查（两个文案不一致，用户不知道信哪个），也说明错误处理约定未收敛。
- **修复建议**：`load` / `startEdit` 的请求加 `skipErrorToast: true` 保留本地文案，或删掉本地 `ElMessage.error` 统一依赖拦截器；经验库是独立小模块，建议随手把口径统一掉。
- **与历史评审的关系**：与第 5 轮 #6（admin 登录双重提示，拦截器与页面 catch 各弹一次）完全同型，彼条已修复登录页；本条是 2026-10-24 新文件里的复发。

### 6. 「新建经验」默认文件名是不完整占位，可直接保存；点「编辑」无 loading 反馈（admin，低）

- **位置**：`admin/src/views/agent/AgentExperienceLibraryDialog.vue:154-157`（`startCreate`）、`:159-169`（`startEdit`）
- **证据**：
  ```ts
  // :154-157 —— 默认文件名是「日期 + 连字符 + 空」的不完整占位
  function startCreate() {
    const today = new Date().toISOString().slice(0, 10)
    editing.value = { fileName: `${today}-.md`, content: '', existing: false }
  }
  ```
  ```ts
  // :159-169 —— startEdit 拉取文档内容期间无任何 loading 态
  async function startEdit(row: ExperienceDoc) {
    try {
      const { data } = await api.get(...)
      editing.value = { ... }
    } catch { ... }
  }
  ```
- **行为**：
  1. 点「新建经验」预填 `2026-10-25-.md`，用户不改直接点「保存」能通过全部校验（.md 结尾、无路径分隔符），真的创建出这个破相文件名的文档；
  2. 点「编辑」到内容返回之间按钮与界面无变化（无 loading / 禁用），慢网络下像点击无效，容易连点。
- **影响**：破相文件名进入共享目录与自动生成的 INDEX.md；编辑入口体验粗糙。
- **修复建议**：默认名只填日期前缀并把焦点放到文件名输入框选中待改部分（或不预填、用 placeholder 提示格式）；保存校验加「文件名不得以 `-` 直接接 `.md`」或非空 slug 段校验；`startEdit` 加行内 loading（如按钮转 loading 或编辑区先渲染骨架）。
- **与历史评审的关系**：新文件，历史评审未覆盖。

---

## 三、UI 样式

### 3. InboxDrawer 类型徽章整组硬编码亮色系配色，暗色主题无任何适配（desktop，中低）

- **位置**：`desktop/src/components/inbox/InboxDrawer.vue:282-310`（`.kind-*` 六组）、`:333-338`（`.inbox-dot`）；主题机制见 `desktop/src/style.css:303,546`（`[data-theme="dark"]`）
- **证据**：
  ```css
  /* InboxDrawer.vue:282-310 —— 徽章文字全部是为亮底调的深色，背景为低透明度叠色 */
  .kind-task_completed { background: rgba(103, 194, 58, 0.14); color: #529b2e; }
  .kind-task_failed    { background: rgba(245, 108, 108, 0.14); color: #d64545; }
  .kind-question_pending { background: rgba(230, 162, 60, 0.16); color: #b9791a; }
  .kind-approval_pending { background: rgba(64, 158, 255, 0.14); color: #337ecc; }
  .kind-daily_digest  { background: rgba(103, 194, 58, 0.14); color: #529b2e; }
  /* :338 */
  .inbox-dot { ... background: #f56c6c; }
  ```
  全文件 grep `data-theme|dark` 无任何命中（无暗色 override）；同文件其余样式均使用 `var(--aw-*)` 变量体系。
- **行为**：desktop 支持 `[data-theme="dark"]` 暗色主题，且主题变量体系完备（`--aw-ink`、`--aw-divider-soft` 等）。InboxDrawer 的五类事件徽章（任务完成 / 失败 / 待问卷 / 待审批 / 日报）绕过变量硬编码，暗色下 14%-16% 透明底叠在暗背景上再压深色文字（#529b2e / #b9791a / #337ecc 等均为亮底口径的深色），对比度明显不足。
- **对照**：同库同类场景均已正确处理——`QuickCommandTag.vue:60-67` 为 `.tag-skill/.tag-command` 显式写了 `:root[data-theme="dark"]` override；`GitChangeTreeNode.vue:169-171` 已改用 `var(--aw-diff-add/mod/del)` 语义变量（第 4 轮 #15 修复成果）。InboxDrawer 是 10 月新增组件，属漏网。
- **影响**：暗色主题用户打开收件箱抽屉，事件类型徽章发暗发糊，弱视用户与低亮度环境下更难分辨「失败 / 待审批」等关键状态。
- **修复建议**：把五组徽章色收敛进 `style.css` 的 `--aw-*` 变量（每组成对定义「文字色 + 底色」，dark 块给出亮色口径的替代值），`.inbox-dot` 一并处理；或最小改动直接照 QuickCommandTag 的方式补 `[data-theme="dark"] .kind-*` override。
- **与历史评审的关系**：与第 4 轮 #15（Git 徽章硬编码色暗色对比度 2.9-3.9:1）同型；彼条已修复，本条在新组件上复发。

---

## 四、性能（包体积）

### 5. 全量注册约 300 个 Element Plus 图标进主包；admin 已按需化，desktop 未跟进（desktop，低中）

- **位置**：`desktop/src/main.ts:39-42`；对照 `admin/src/main.ts:15-20`
- **证据**：
  ```ts
  // desktop/src/main.ts:39-42 —— 全量注册
  // Register all Element Plus icons
  for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component)
  }
  ```
  ```ts
  // admin/src/main.ts:15-20 —— 已按需化，注释即历史结论
  // 仅全局注册「字符串解析（prefix-icon）或未局部导入的模板标签」用到的图标；
  // 其余图标由使用方自行按需 import，避免约 300 个图标全量进主包
  const globalIcons = { Close, Expand, Fold, Lock, Menu, Plus, User }
  ```
  构建产物实证（当前 `desktop/dist/assets/index-*.js`，未压缩 1.3MB）：从未在 desktop 模板中使用过的 `Trophy`、`Umbrella`、`Soccer`、`IceTea`、`MostlyCloudy`、`Watch` 等冷门图标组件全部可在主包中 grep 到。
- **行为**：`import *` + 全量 `app.component` 使 tree-shaking 完全失效，整套图标库进入首屏主包。desktop 模板中通过全局标签使用的图标实际约 20-30 种（Check 20 处、ArrowDown 19 处、Plus 16 处、Close 16 处等），其余数百个纯属陪跑。
- **影响**：主包白白多出整套图标库（gzip 后数十 KB 量级）；对生产单域名下「Electron / Web / 安卓 WebView」三端共用一份产物的 desktop 而言，安卓端弱网首开与月度 OTA 流量都为此买单。同时两端实现口径不一致，后续维护者难以判断哪种是推荐做法。
- **修复建议**：按 admin 的方案迁移——全局只注册模板标签方式高频使用的图标（可用脚本从 `.vue` 文件统计 `<IconName` 标签得出清单），其余组件内按需 `import`；或引入 `unplugin-icons` / `unplugin-vue-components` 在构建期自动按需化，一步到位并消除两端差异。
- **与历史评审的关系**：第 5 轮 #15 报过 admin 侧同型问题（「`main.ts` 全量注册约 300 个图标」），admin 已修复；desktop 侧当时被并入同一条目但未跟进，本轮单独定位于 desktop。

---

## 五、已核实为已修复的历史条目（抽样复核）

本轮对历史评审的重点条目做了回读核验，以下确认已修复，不计入本轮问题：

| 历史条目 | 修复证据 |
|---|---|
| 第 5 轮 #2：WS 断线全程无 UI 反馈 | `components/common/ConnectionBanner.vue:11-13` 已消费 `connected/everConnected`，断线显示「连接已断开，正在自动重连…」横幅 |
| 第 5 轮 #3：图片/附件上传失败静默降级可发出空消息 | `useChat.ts:341-347,422-432` 已接入 `guardUploadsBeforeSend` / 全失败中止发送 |
| 第 5 轮 #11：登出/换号模块级状态残留（中心 Tab / 待审批队列 / 关闭标记） | `stores/auth.ts:62-84` `clearLocalSession` 统一清理 centerTabs、pendingApprovals、sideTask 关闭标记、persistedActiveTabs 等 |
| 第 4 轮 #3：图片「最多 10 张」上限被异步入队绕过 | `ChatInput.vue:553`（粘贴）、`:946`（addPendingImage）、`:968`（addPendingFile）三处入口全部强制 |
| 第 4 轮 #12：`isTouchDevice` 用触摸能力判定 | `ChatInput.vue:237` 已改为 `matchMedia('(pointer: coarse)')` |
| 第 4 轮 #17：会话搜索无加载态 | `SessionSearchPopover.vue:65,69` 已有 `status === 'loading'` 的「搜索中…」提示 |

另：本轮审查过的 `useChat.ts`（审批发送失败回滚 `:96-106`、编辑重发失败回滚 `:733-741`、发送失败草稿回填 `ChatPanel.vue:697-708`）、`TaskView.vue` 子会话补拉防竞态（`:370-455`）、`FeishuBotPanel` 轮询超时与基线比对、admin `EcpConfigPanel` 的 `useServerSyncGuard` 服务端同步守卫等，均为历史评审驱动的修复，实现质量良好，无新问题。

---

## 六、复核记录

- 全部 6 条均在成文前回读当前工作区源码核对行号与代码证据；#1 含后端 PUT 语义交叉验证；#5 含 `desktop/dist/assets` 产物 grep 实证。
- 审查过程中排除的候选（记录备查，避免后续重复排查）：
  - `sendMessageWithQueue` 非活跃分支无论成败恒 `return true`（`useChat.ts:798-804`）——唯一调用方 `ChatPanel.vue:676-686` 已在外层用 `isActive` 分流，该分支实际不可达，不构成缺陷；
  - `UsageDetailTab.vue:61-65` resize 监听器未随组件卸载移除——`UsageDrawer` 的 el-drawer 未开 `destroy-on-close`，组件单实例常驻，泄漏不可累积，修复价值过低；
  - `fetchMessages` / `loadOlderMessages` 的空 catch（`useChat.ts:227-229,254-255`）——REST 失败仍有 api 拦截器全局 toast（`api/index.ts:125-141`），仅缺页内错误占位与重试入口，可作后续体验优化；
  - `imageUrlAnnotation` 剥离 `[图片 N] URL` 行可能误伤用户手写的同格式正文——格式特征足够特异，且有「与后端逐字节一致」的契约约束，不构成实际风险。
