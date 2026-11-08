# 提案：消息级上下文菜单与操作收敛 —— 右键直达，操作行不再一条排六个

> 消息操作全靠 `MessageBubble` footer 的一排平铺小按钮：用户消息是「编辑 / 添加到我的指令 / 复制」（`MessageBubble.vue:203`、`:206`、`:209`），助手消息加上「不满意 / Fork 到边路任务 / 分享会话」（`:264`、`:278`），六个 24px 图标钮挤一条线（`:1370` 注释自述「统一 24px 见方圆钮」）。两个断点：
> 1. **鼠标效率用户的路径绕**：右键是桌面端对「这个对象能做什么」的本能询问，但消息区右键弹的是浏览器原生菜单——全项目上下文菜单已有三处成熟先例（`CenterTabBar.vue:40-58` 页签菜单、`TaskContextMenu.vue` 会话菜单、`FileChangePanel.vue:19` diff 文件菜单），唯独使用频率最高的消息对象没有。
> 2. **低频动作占着高频位置**：Fork 与分享是低频操作，却与「复制」同排常驻；按钮越多，每个的视觉权重越低，新用户反而更找不到想要的那个。

- 状态：已否决（2026-11-08：footer 操作行已够用。见 [README](README.md) 台账）
- 日期：2026-11-08
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（P1 右键菜单约 1-1.5 人日；P2 溢出收敛约 0.5 人日；**零数据库迁移、零后端改动**，全部复用既有 emit/handler，不新增能力）
- 关联：`desktop/src/components/chat/MessageBubble.vue`、`desktop/src/components/center/CenterTabBar.vue`（菜单范式范本）、`desktop/src/components/task/TaskContextMenu.vue`、`desktop/src/utils/selection-quote.ts`

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 消息操作入口 | 仅 footer 平铺按钮：编辑 / 添加到我的指令 / 复制 / 不满意（popover）/ Fork / 分享 | `MessageBubble.vue:203,206,209,264,278` |
| 消息区右键 | 无自定义菜单，弹浏览器原生菜单 | chat 目录无 `@contextmenu`（仅 `FileChangePanel.vue:19` 有） |
| 上下文菜单范式 | teleport div 菜单已有三处成熟先例 | `CenterTabBar.vue:40-58`、`TaskContextMenu.vue`、`FileChangePanel.vue:19` |
| 划选引用 | 划选文字浮出「引用」按钮（既有，不动） | `utils/selection-quote.ts`（批次 18 落地） |
| 触屏命中区 | footer 按钮已达标（0.0.471 实体内扩 32px） | `@media (pointer: coarse)` 既有规则 |
| a11y 断言 | 既有测试只锁 `.copy-btn` 名称，不锁按钮集合 | `chat-a11y.test.ts` |

## 2. 目标 / 非目标

**目标**

1. **P1 消息右键菜单**：`MessageBubble` 消息体 `@contextmenu.prevent` 弹自定义菜单，菜单项 = 该消息当前**全部可用操作**（编辑 / 复制全文 / 添加到我的指令 / 不满意 / Fork / 分享 / 引用选区入口），逐项复用既有 `emit` 与 handler——菜单是既有动作的聚合器，不新增任何能力。可用性条件与 footer 按钮完全一致（`canEdit` / `showFork` / `showShare` / 角色判断同源）。
2. **P1 与划选共存**：有选区时右键**不拦截**，保留浏览器原生菜单（复制选中文字是刚需）；无选区才弹自定义菜单。
3. **P1 菜单可用性**：菜单项为 `button`（`role="menuitem"`）、Esc 关闭、点击外部关闭、teleport 到 body（照 `CenterTabBar` 范式）；焦点管理不抢编辑器。
4. **P2 操作行溢出收敛**：助手消息 footer 收敛为「复制 / 不满意 / 更多（⋯）」，Fork 与分享收进「更多」浮层（浮层内同样含全部动作，与右键菜单同源数据）；用户消息仅 2-3 个高频钮，保持平铺不动。`chat-a11y.test.ts` 无 footer 集合断言，收敛不破坏既有测试，收敛后补新断言。

**非目标**

- **不做触屏长按菜单**：触屏已有 footer 按钮（命中区达标），长按与划选引用手势存在冲突面，本期不做。
- 不新增消息能力（不做定时发送、不做消息内查找——后者 2026-11-02 已否决）。
- 不改任何既有 emit / handler 的行为，只改入口形态。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 记忆就地可见（批次 18 否决） | 菜单不含「记住这个」等记忆动作，是既有操作聚合。 |
| 会话内查找 / Markdown 导出（2026-11-02 否决） | 不新增检索 / 导出语义。 |
| 键盘焦点与命中区（批次 23 已落地） | 不重复触屏路线：footer 命中区已达标，本提案服务的是鼠标右键路径与视觉降噪。 |
| 结构化回复卡片（批次 9 否决） | 不改消息渲染协议。 |

## 4. 方案设计

- 新组件 `components/chat/MessageContextMenu.vue`：props（消息可用动作集 + 坐标）、teleport + div 菜单（`CenterTabBar.vue:40-58` 同构），边界防溢出（贴右/下边缘翻转）。
- `MessageBubble` 根容器 `@contextmenu.prevent="onContextMenu"`：先判选区（`window.getSelection()` 非空则直接 return 不拦截），再按消息角色与可用性条件组装菜单项（与 footer 按钮的 `v-if` 条件同一组 computed）。
- P2「更多」浮层：footer 加 `⋯` 按钮（带 `aria-label="更多操作"`），popover 内渲染同一份动作集；Fork / 分享按钮从平铺移除。
- 菜单项与浮层项由同一份数组驱动，杜绝两处文案 / 条件漂移。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | 新增 `components/chat/MessageContextMenu.vue`；`MessageBubble.vue`（contextmenu 接线 + P2 溢出按钮）；`chat-a11y.test.ts` 补收敛后断言 |
| backend-ts / admin / android / agent-cli | **无**；安卓壳触屏不触发右键路径，footer 不变（P2 仅桌面 pointer: fine 生效与否由实施定——**定案：P2 收敛全端生效**，触屏经「更多」两步可达且浮层项带 32px 命中区） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 右键拦截误伤原生能力（复制选区、拼写检查） | 有选区不拦截（目标 2）；无选区时原生菜单对消息体本无独占价值 |
| 菜单项与 footer 按钮条件漂移 | 同一组 computed 驱动两处（设计节末条约定） |
| P2 收敛改变肌肉记忆 | Fork / 分享仍两次点击内可达（⋯ → 项）；CHANGELOG 明示变化 |
| 菜单遮挡消息流 / z-index 冲突 | teleport body + 既有弹层 z-index 体系内取值（CenterTabBar 菜单同层） |
| 触屏 P2 浮层命中 | 浮层项沿用 0.0.471 命中区口径；安卓壳实机点验 |

## 7. 测试要点

1. 无选区右键助手消息：菜单含复制 / 不满意 / Fork / 分享，逐项执行与 footer 按钮效果一致；用户消息含编辑 / 复制 / 添加到我的指令。
2. 划选文字后右键：原生菜单出现（未拦截），划选「引用」浮层照常。
3. Esc / 点击外部 / 执行动作后菜单关闭；菜单打开不打断 WS 流式渲染。
4. P2：assistant 行仅剩复制 / 不满意 / 更多；「更多」浮层含 Fork / 分享且可达性 ≤2 次点击；user 行不变。
5. `chat-a11y.test.ts` 更新后全绿；安卓壳 footer / 浮层实机点验。

## 8. 决策记录

待评审确认：

1. **P2 收敛是否全端生效**（含触屏 footer 变化）还是仅桌面：倾向全端（一套形态，触屏「更多」可接受）。
2. **菜单是否含「引用选区」入口**：有选区时菜单不弹，该入口实际不可达——倾向不含，划选引用走既有浮层。
