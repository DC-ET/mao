# 浏览器直播协作操作（用户输入注入）技术方案

- 日期：2026-11-27
- 状态：**方案已定稿**（2026-11-27 评审拍板，全部决策见下方记录与 §15 评审结论）；实施前置 POC（§13），排期见 §14（本文档只定方案，不含代码改动）
- 2026-11-27 二次评审：结论**可行**；补充 6 处修正——D10 鼠标 modifiers、D11 macOS Cmd→Ctrl、D12 限速预算口径（§3）、契约/映射带 modifiers（§4/§5.2）、目标页定向提帧率（§5.3）、meta 降级路径修正（§7.2）、键盘事件流与本地快捷键拦截（§7.1）。均系正确性缺陷，P0 必含
- 2026-11-27 实施评审（子代理代码评审）：P0 无；P1×3 已修——切会话退出协作（activeSessionId 漂移时 sender 仍指向旧会话，输入会注入"用户正在看的另一场直播"）、KeepAlive 停用退出（程序化切 Tab 不派发 blur 不卸载，setIgnoreMenuShortcuts 粘滞 + 远端卡键）、letterbox 黑边越界点击忽略（钳 0 等于向远端视口左上角注入真实点击）；P2×7 已采纳——control 随 subscribe 重放与 hub getState 快照下发（刷新后入口不消失）、mouseReleased 携带 press 的 clickCount（远端 dblclick 语义）、后端限速提为 (60,180)、属主缓存容量上限 + 未命中查库按用户限速、LOCAL /input 传输上限 256KB、403（token 失配）与 404（旧 sidecar）分口径、测试补齐
- 一句话：在现有浏览器直播链路（CDP screencast 看画面）之上增加一条**上行控制链路**，把客户端捕获的鼠标 / 滚轮 / 键盘事件经坐标映射后由 sidecar 注入 CDP `Input.*`，让用户在直播画面上直接操作 Agent 正在使用的浏览器，与 Agent **并发协作、互不阻塞**。
- 关联：
  - `docs/plan/2026-11/2026-11-20-browser-live-pip-technical-design.md`（直播/画中画基础；本方案复用其全部下行链路）
  - `docs/plan/2026-11/2026-11-22-browser-live-replay-technical-design.md`（录制；本方案不改录制，见 §9）
  - 现有控制通道先例：`browser_live_stop`（客户端 → 后端 → runner → `Browser.close`），本方案的输入通道与之同构
- 决策记录（2026-11-27 用户定案）：
  - **目标是“协作”，不做“接管/抢方向盘”**：用户输入与 Agent 并发自由交织，**不做会话相位门控、不做执行暂停**；由此带来的行为混乱按风险接受（见 §12 R2）。
  - 技术路线：CDP `Input.dispatch*` 注入（Chrome DevTools 的 Screencast 面板即此机制），不引 VNC / xvfb / 自建远控协议。
  - **前置 P-1：画中画手动化**——PiP 改为 Tab 内手动打开的只读监控，自动弹出与双击放大删除（定案讨论见 §1.3）；协作交互层只在 Tab 启用。
  - 「Agent 执行中」徽标：**做**——直播视图内的非阻断提示，随 P0 交付（§7.1）。
  - 协作开关**不记住状态**：每次显式开启/退出。交互层是注入真实输入的敏感态，粘滞开启容易“忘了自己在操作”（D7 口径的延伸）。
  - 命名与降级：UI 文案统一**「协作操作」**；LOCAL 旧 sidecar（无 `control` 能力协商）隐藏交互入口，tooltip 提示“采集端升级后支持操作”，不做全局公告式提示。
  - 操作权**仅会话属主**：共享会话观看者 / 回放观看者不获得操作能力（显式边界，非需求遗漏；“分享给别人看且可操作”若成需求另行立项）。
  - P-1 后**暂不补**「直播开始」桌面通知：先观察用户反馈（现有 `desktopNotify` 基建可随时加）。

## 0. 现状与前提（2026-11-27 核实）

| 环节 | 现状 | 代码位置 |
|---|---|---|
| 画面下行 | sidecar 每页 `Page.startScreencast`（jpeg q60 ≤1280×720），按页限速 `PAGE_MIN_INTERVAL_MS=250`（≈4fps）；CLOUD 经 runner WS → 后端 `browserFrameRateLimiter = WsRateLimiter(6,12)` → 属主客户端；LOCAL 经 SSE → Electron 主进程枢纽 → 画中画/Tab | `skills/bundled/browser-use/scripts/browser-live-host.mjs:46,192-205`、`backend-ts/src/session/ws/streaming-ws-handler.ts:396,853` |
| 已有下行控制 | `browser_live_stop`：客户端 WS 帧 → 后端属主校验 → 转发 runner → sidecar `doStop`（LOCAL 为主进程直 POST `/stop`） | `streaming-ws-handler.ts:871-883`、`browser-live-host.mjs:422-424`、`desktop/electron/browserLive.cjs:456-464` |
| CDP 会话 | sidecar 对每页持有扁平化 session（`Target.setAutoAttach flatten:true`），`cdpCall(entry, method, params, sessionId)` 现成 | `browser-live-host.mjs:118-131,132-176` |
| 帧元数据 | CDP `screencastFrame` 自带 `metadata`（deviceWidth/Height、pageScaleFactor、scrollOffsetX/Y、offsetLeft/Top），**当前未下发**；`BrowserFrameData` 只有 seq/ts/jpeg/width/height/pageUrl/cliSession | `browser-live-host.mjs:192-205`、`shared/contracts/src/ws.ts:336-346` |
| 前端画布 | `BrowserLiveView.vue` canvas 只读展示；PiP（双击放大）/ Tab 两形态——P-1 后 PiP 改为 Tab 内手动打开、只读（§1.3） | `desktop/src/components/browser/BrowserLiveView.vue` |
| 兼容容错 | sidecar cloud 客户端对未知消息类型静默忽略（只处理 connected/stop/error）→ 新旧并存不炸 | `browser-live-host.mjs:414-428` |

前置条件：直播可用（Agent 未自定义 `--config`、Node≥22）才有协作；`MAO_BROWSER_LIVE_RECORD` 与本方案无关。

## 1. 目标与非目标

### 1.1 目标

- 用户在直播 Tab 画面上直接鼠标点击、拖动、滚轮、键入文字（含中文 IME），操作作用到 Agent 正在用的那个浏览器（PiP 经 P-1 定为只读监控，不开交互层）。
- 输入与 Agent 并发：Agent 执行中用户随时可操作，无门控、无暂停、无仲裁。
- 只允许会话属主操作；输入内容零日志、零审计、零录制。
- 旧版 sidecar / 旧版客户端并存时优雅降级（入口隐藏或事件被忽略）。

### 1.2 非目标

- 不做接管/门控/执行暂停语义（用户定案；见 §12 R2 的已知后果）。
- 不做 VNC / 远程桌面 / 整机键鼠（沿用 2026-11-20 方案 D1 边界）。
- 不录输入事件（回放录制继续只录帧，见 §9）。
- 不做安卓触摸操作（P2，见 §14）。
- 不做文件选择框 / HTTP Basic 认证 / 原生右键菜单 / 系统弹窗的操作（CDP 注入的天然边界）。
- 不做标签页管理（新建/关闭页签无 UI；`target=_blank` 打开的新页会被现有 auto-attach 自然接流）。
- 不做多操作端仲裁（Tab + 多设备同时操作时事件按到达顺序应用；PiP 经 P-1 定为只读，不构成操作端）。
- 不砍画中画功能本体（评估过整体移除，定案为降级：见 §1.3）。

### 1.3 前置改动 P-1：画中画手动化（独立可发版）

**动机（2026-11-27 评审讨论）**：PiP 的“自动弹出”是近期体验问题的根源——弹出打扰工作、用户想关窗时误触「停止浏览器」把 Agent 的浏览器杀掉（该事故催生了收起按钮，已随 0.0.534 发布）；「双击放大」是为“被弹出的 PiP 逃回大画面”设计的**无可见入口的隐藏手势**，且与本方案交互层直接冲突（双击会被当成两次点击上发）。

**定案**：PiP 保留但降级为**纯手动、只读监控**：

```
直播开始 → 不再弹窗（会话内提醒由输入框上方「浏览器」状态条承担）
chip     → 打开直播 Tab（Electron 经主进程 expand：若 PiP 在看则一并收起）
Tab      → 「打开画中画」按钮（原「还原为画中画窗口」，isLive 时显示）
PiP      → 只读观看；关闭（×）/ 直播结束 2s 自动收起 / 点 chip 回 Tab
自动弹出、双击放大 → 删除
```

**改动清单**：

| 文件 | 改动 |
|---|---|
| `desktop/electron/browserLive.cjs` | 删除 `browser_live_started` 分支的 `pip?.show()`（连同刷新重放方案加的 `replayLive` 不重复弹窗守卫——自动弹出消失后无意义）；**保留**：停止后 2s 自动收起、`expandToTab`（chip 链路用）、`hidePip` IPC |
| `desktop/src/components/browser/BrowserLiveView.vue` | 删除 `onDblClick` / `@dblclick`；Tab 的「还原为画中画窗口」按钮改为「打开画中画」，并加 `state?.isLive` 门控（无直播时打开只见占位符，无意义） |
| 测试 `browserLive.test.cjs` | “started → pip show” 断言反转为「不再 show」；「hub 无态时重放仍弹出」断言随守卫删除；hide / expand / 停止后自动收起用例保留 |
| CHANGELOG / 文档 | 收起按钮等前置修复已随 0.0.534 发布（归档条目不可改）；P-1 自身新增一条 changelog 碎片，写明“画中画不再自动弹出（含应用重启）”；`DEPLOY.md` 的「以画中画窗口实时旁观」改为手动入口描述 |

**保留不动**：PiP 窗口机制本体（`pipWindow.cjs`、bounds 记忆、Windows 置顶语义）、`/pip` 路由与 preload、hide 按钮、主进程 hub 的 `getState` 快照（主窗刷新仍依赖）。后续若“跨应用盯屏”无人使用，再整体移除即零痛感（入口已收敛为 opt-in）。

**与本方案的关系**：交互层（§7）只在 Tab 形态启用，PiP 永远只读——§15 原待定项“PiP 是否允许操作”就此关闭；§7.1 中“控制开启时禁用双击放大”的补丁逻辑随双击删除而消失。P-1 不依赖本方案任何部分，可先行独立发版（纯桌面端改动，需重打桌面包；收起按钮的 hide IPC 已随 0.0.534 发布）。

工作量：**0.5 人日**（含测试与文档）。

## 2. 总体方案

```
【下行（现有，不动）】 CDP screencast 帧 + metadata ──→ sidecar ──→ CLOUD WS / LOCAL SSE ──→ 客户端 canvas
【上行（新增）】       客户端 overlay 捕获事件 ──→ 坐标映射（用最新帧 metadata）──→ 批量事件帧
                        CLOUD: WS /api/ws/stream 上行 browser_live_input（属主校验 + 限速）→ 转发 runner
                        LOCAL: renderer → IPC → Electron 主进程 → POST sidecar /input
                                     └──→ sidecar 校验/限速/路由到目标页 ──→ CDP Input.dispatch* 注入
```

要点：

- **通道与 `browser_live_stop` 完全同构**（客户端上行帧 → 后端属主校验 → runner 转发 / 主进程直连），没有新鉴权模型。
- **输入是视口坐标级**，不做 DOM 定位：iframe / shadow DOM / 跨域内容天然可用；坐标换算靠 screencast metadata。
- sidecar 是唯一注入点：它已持有每页 CDP 会话，且知道“最近活跃页”（最新出帧的 target），客户端无需理解页面结构。

## 3. 决策点

| # | 决策 | 结论 | 理由 / 备选 |
|---|---|---|---|
| D1 | 注入通道 | **CDP `Input.dispatchMouseEvent/dispatchKeyEvent/insertText`**，走现有 sidecar | DevTools Screencast 同机制、零新依赖；备选 VND/noVNC 被既有方案 D1 排除 |
| D2 | 协作语义 | **无门控并发**：不做“接管模式”、不暂停 Agent、不判会话相位 | 用户定案“协作、不考虑抢方向盘”；后果列 §12 R2 |
| D3 | 事件模型 | **批量原始事件**（`BrowserInputEvent[]`，一帧最多 32 个）：pointer→mouse、wheel→mouseWheel、IME 合成→`insertText` | 语义最小、状态无耦合；备选“高级指令”（click(selector)/type）会引入 DOM 定位与 Agent 命令竞争，放弃 |
| D4 | 文本输入 | 键盘 keydown 映射 rawKeyDown/keyUp + 可打印单字符 `char`；**中文 IME 用 compositionend → `Input.insertText` 整段提交** | IME 逐键会打碎拼音；insertText 等价粘贴到聚焦元素 |
| D5 | 帧率自适应 | 操作活跃（最近 5s 内有输入）时：sidecar 按页限速 250ms→100ms（≈10fps），后端下行限流 (6,12)→(12,24)；静止自动回落 | 交互需要反馈密度；带宽代价见 §10 |
| D6 | 能力协商 | `browser_live_started` 增加 `control: true`；LOCAL `live.json` 增加 `caps: ['input']` | 新客户端 + 旧 sidecar：入口隐藏；旧客户端 + 新 sidecar：上行帧被忽略（sidecar 现状即忽略未知类型） |
| D7 | 隐私纪律 | **输入 payload 不写日志、不进审计、不进录制**（三类都只允许记“事件条数/类型”级别的计数） | 按键可能含密码；REST 审计拦截器本就不覆盖 WS，需守住 sidecar/主进程日志 |
| D8 | 给 Agent 的“用户操作过”提示 | **默认不做**；列为可选增强（协作语义下由 Agent 自己读回页面状态） | 用户定案不做方向盘协调；若后续要，可在输入静默 60s 后向会话插入一条系统提示（非阻塞） |
| D9 | 后端属主校验频度 | 高频输入不能每批查库：**属主结果缓存 60s**（`Map<userId:sid, {ok, at}>`） | `browser_live_stop` 是低频单发可直查；输入是 10-25 批/s |
| D10 | 鼠标/滚轮组合键 | mouse 系事件**必须携带 `modifiers` 位掩码**（客户端由转发的 Shift/Ctrl/Alt/Meta keyDown/keyUp 维护，随每次鼠标/滚轮事件上送） | CDP 每次 dispatch 无状态、不自动跟随键盘会话；漏带则 Shift/Ctrl+点击（多选/范围选/新标签打开）、Ctrl+滚轮缩放全失效。DevTools ScreencastView 同做法（二次评审补充） |
| D11 | macOS Cmd 翻译 | 客户端把 Cmd（Meta）**翻译为远端 Ctrl** 上发，Option 保持 Alt；逆向不翻译 | 远端是 Chrome 页面语义，Meta 不触发复制/粘贴/切标签等快捷键，而 macOS 用户肌肉记忆全是 Cmd；VNC 惯例同（二次评审补充） |
| D12 | 事件预算口径 | **诚实发送者**：客户端自限总事件率 ≤50/s（留 sidecar 60/s 的余量），后端 (60,180)/sidecar 60/s 退化为纯滥用防护；mouseMoved 仅在按键按住（拖拽）时连续上发，悬停态降至 ~5/s | 原稿 40ms 节流 move=25/s + 打字 30/s ≈ 55/s 持续速率超后端 30/s 补充率，burst 耗尽后 happy path 静默丢事件；且 10fps 下悬停反馈本就跟不上，move 是信息价值最低的事件（二次评审补充；实施评审 P2-3 再把后端补 30/s 提到 60/s——低于客户端持续速率时合法输入持续 4.5s 后整批丢弃，丢到含 keyUp 的批会卡键，与"happy path 零丢弃"口径矛盾） |

## 4. 契约设计（`shared/contracts/src/ws.ts`）

```ts
/** 帧元数据（CDP screencastFrame.metadata 子集）：协作操作的坐标映射依据。 */
export interface BrowserFrameMeta {
  targetId: string;          // 出帧页面的 target（输入回带，跨 cliSession 消歧）
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;   // 桌面无缩放时恒 1
  scrollOffsetX: number;
  scrollOffsetY: number;
  offsetLeft: number;        // 滚动条留白
  offsetTop: number;
}
// BrowserFrameData 增加：meta?: BrowserFrameMeta（旧端忽略）
// BrowserLiveStartedData 增加：control?: boolean（sidecar 支持输入注入时置 true）

/** 协作输入事件（视口坐标，全部为必填有限数字 / 短文本）。 */
export type BrowserInputEvent =
  | { type: 'mouseMoved'; x: number; y: number }
  | { type: 'mousePressed' | 'mouseReleased'; x: number; y: number; button: 'left' | 'right' | 'middle'; clickCount: number; modifiers?: number }
  | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { type: 'keyDown' | 'keyUp'; key: string; code: string; windowsVirtualKeyCode: number; modifiers?: number }
  | { type: 'char'; text: string }                 // 单个可打印字符
  | { type: 'insertText'; text: string };          // IME 合成 / 粘贴段（≤1000 字符）

/** 桌面客户端 → 后端：协作输入（后端校验属主 + 限速后原样转发 runner）。 */
export interface WsBrowserLiveInputFrame {
  type: 'browser_live_input';
  sessionId: number;
  data: { targetId: string | null; events: BrowserInputEvent[] }; // ≤32 事件；LOCAL /input 传输体上限 256KB（覆盖 32×1000 字符的契约上限，实施评审 P2-5：原 16KB 与矩阵不一致）
}
```

约束（后端与 sidecar 双侧校验）：事件数 ≤32、`insertText/char` 文本长度上限、x/y 有限且 ∈ [-100, 100000]、`windowsVirtualKeyCode` ∈ [0, 0xFFFF]、`modifiers` 位掩码 ≤ 0xFF；非法批整批丢弃（不回错误，静默——洪泛防护优先于可观测性）。`modifiers` 取 CDP 常量（Alt=1/Ctrl=2/Meta=4/Shift=8），由客户端维护组合键状态随 mouse 系事件上送（D10；macOS Cmd 先经 D11 翻译为 Ctrl 再计入），mouseMoved 不带（纯移动无组合语义）。

## 5. sidecar 设计（`browser-live-host.mjs`）

### 5.1 入口

- LOCAL：HTTP server 增加 `POST /input?token=`（与 `/stop` 同鉴权），body 为 `{ targetId, events }`。
- CLOUD：ws.onmessage 增加 `msg.type === 'browser_live_input'` 分支（现有未知类型忽略逻辑天然兼容旧端）。
- `browser_live_started` data 增加 `control: true`；LOCAL `live.json` 增加 `caps: ['input']`。

### 5.2 注入流程 `applyInput(data)`

1. 校验（§4 约束）+ sidecar 侧限速：每 cliSession 60 事件/s，超出丢弃（无错误）。
2. 路由目标页：优先 `data.targetId` 在 `entry.pages` 命中的页；否则用 `entry.lastActiveTarget`（在 `Page.screencastFrame` 处理处记录最新出帧的 target）；无页可路由则忽略。
3. 逐事件 `cdpCall(entry, 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText', params, page.sessionId)`：
   - mouseMoved/mousePressed/mouseReleased → `Input.dispatchMouseEvent { type, x, y, button, clickCount }`（pressed/released 附带 `modifiers`，D10；release 携带 press 的同值 clickCount——不一致则远端无法合成 detail=2 的 dblclick，实施评审 P2-2）；
   - mouseWheel → `Input.dispatchMouseEvent { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers }`；
   - keyDown/keyUp → `Input.dispatchKeyEvent { type: 'rawKeyDown' | 'keyUp', key, code, windowsVirtualKeyCode, modifiers }`；
   - char → `Input.dispatchKeyEvent { type: 'char', text }`；
   - insertText → `Input.insertText { text }`。
4. 记录 `lastInputAt`（供帧率自适应，§5.3）；**日志只打事件计数**，绝不打坐标文本内容。

### 5.3 帧率自适应与 metadata 下发

- `emitFrame` 节流：**提帧率只对输入路由命中的目标页生效**（`lastInputAt` 记在输入路由处的 page 上，`interval = (Date.now() - page.lastInputAt < 5000) ? 100 : 250`），其余页维持 250ms。后端限速按会话不分页，全员提率在多页并发下必超 (12,24) 预算（2 页×10fps=20/s > 12/s 补充率，丢 40%）；定向提帧同时改善用户所见页的帧密度。既有参考：多页×4fps=8/s 今天就已超 6/s 补充率（后端 token 桶按会话扣，多页并发本就有帧丢弃）。
- `Page.screencastFrame` 处理处：从 `p.metadata` 提取 §4 字段 + `targetId`，随帧下发 `meta`；同时更新 `entry.lastActiveTarget`。

## 6. 后端设计（`streaming-ws-handler.ts`）

- 新增 case `browser_live_input` → `handleBrowserLiveInput(userId, root)`：
  1. `sessionId` 合法性；**属主缓存校验**（D9：`Map`，TTL 60s，未命中回落 `requireOwnedSession` 查库并回填；未属主直接丢弃，不回错）。
  2. 限速：`inputRateLimiter = new WsRateLimiter(60, 180)`（按会话，计数单位=事件条数；必须高于客户端自限 50/s——低于时合法速率会整批丢弃含 keyUp 的批造成卡键，实施评审 P2-3），超出丢弃。另：属主缓存未命中查库前置按用户限速 (5,15)（distinct sessionId 洪泛防打库，实施评审 P2-4），缓存容量上限 1024 超限整清。
  3. 转发：`registry.sendToConnection(runner, { type: 'browser_live_input', data })`；无 runner 忽略。
  4. 记录 `lastInputAt`（驱动 D5 的下行帧限速切换：`browserFrameRateLimiter` 在输入活跃窗口内放宽到 (12,24)）。
- 不写日志（或 debug 级只记条数）；不审计（WS 不在 REST 审计拦截器范围，见 §9）。
- 清理：`inputRateLimiter` 桶与 D9 属主缓存随 runner 断开 / 会话终态与 `browserFrameRateLimiter.clear()`（现有 runner 断开清理处）同处清理——两张 Map 惰性 TTL 不主动逐出，不清则条目无界慢积累。
- `handleBrowserLiveInput` 与 `handleBrowserLiveStop` 并排实现，同一 runner 转发范式。

## 7. 前端设计（desktop，Web/安卓同构）

### 7.1 `BrowserLiveView.vue` 交互层

- 头部新增图标开关「协作操作」（aria-label/title 一致，规范要求）：仅 `state.startedControl === true`（D6）且 `isLive` 时可开。开关**不记住状态**（决策记录）：每次显式开启，退出即失效。
- 头部/画布角落「Agent 执行中」徽标（决策记录：做，非阻断纯提示）：会话 phase 为 RUNNING 时显示，提示用户“Agent 的命令可能与你的输入交织”。
- 开启后：
  - canvas 上叠 pointer 捕获层：mousedown/up/move/wheel → 事件入本地队列（mouseMoved 按键按住时 40ms 节流合并取最后位置——拖拽语义；悬停态降至 ~5/s，10fps 下高频悬停反馈本就跟不上，D12）；队列按批 ≤32 上发，**客户端总事件率自限 ≤50/s**（D12 诚实发送者，happy path 零丢弃，上游限速退化为滥用防护）。
  - **本地 ghost cursor**：画布上即时绘制指针位置小点（帧率低时维持“跟手”感），真实光标隐藏。
  - 键盘：overlay `tabindex=0` 聚焦；**keydown → `rawKeyDown`、keypress → `char`**（对齐浏览器原生事件流，keypress 只在可打印键触发，免去从 keydown 判定可打印性的边界；`windowsVirtualKeyCode` 用 `e.keyCode` 兜底 + 内置 ~60 键 code 映射表，autoRepeat 可透传）；**macOS：Cmd 翻译为远端 Ctrl（D11）、Option 保持 Alt**；**IME**：`compositionstart` 暂停转发，`compositionend` 发 `insertText(整段)`。
  - 组合键状态与本地行为抑制：客户端由转发的 Shift/Ctrl/Alt/Meta keyDown/keyUp 维护 modifiers 掩码，随 mouse 系事件上送（D10）；overlay 的 keydown/keypress/wheel/contextmenu 全量 `preventDefault()`（不抑制右键会先弹本地菜单在画布上，空格/Tab 等本地行为一并抑制）；Electron 菜单加速键（Cmd+W/Q/T 等）在页面事件之前被菜单消费——协作态 overlay 聚焦时由主进程 `webContents.setIgnoreMenuShortcuts(true)` 屏蔽（实施修正：Electron 官方口径，只屏蔽菜单快捷键、页面 keydown 照常派发；`before-input-event` 的 preventDefault 会连页面派发一起拦掉，不适合本场景），否则用户想发给远端的 Cmd+W 先关掉本地窗口；**Esc = 退出协作**（键盘用户的显式逃逸口）。
  - 滚轮：wheel → mouseWheel（delta 透传，preventDefault 防页面滚动）。
  - 右键转发 `button:'right'`（页面内自定义菜单可见；**原生菜单不在 screencast 画面里**，属边界）。
  - PiP 形态（P-1 后为手动打开的只读监控）：不开交互层、无双击放大（P-1 已删），回 Tab 走 chip。
- 停止转发的**全部**路径（协作开关关闭、直播 stopped、组件卸载、**KeepAlive 停用**（程序化切走 center Tab：DOM 摘除不派发 blur 也不卸载，实施评审 P1-2）、**切会话**（直播 Tab 跨会话复用、activeSessionId 随帧漂移，实施评审 P1-1）、blur、`visibilitychange`）都要 flush 队列并补发 `keyUp` 全释放，避免远端按键卡死——缺一路即卡一键。
- 帧延迟提示：控制开启且最近帧龄 >1.5s 时在画面角落显示“画面延迟较高”。

### 7.2 坐标映射（用最新帧 `meta`，DevTools ScreencastView 公式）

```
dipX  = (canvasX / canvasRect.width)  * meta.deviceWidth      // 画布 → DIP
viewX = dipX / meta.pageScaleFactor + meta.scrollOffsetX       // → 视口 CSS 坐标（含缩放/滚动补偿）
viewX -= meta.offsetLeft（滚动条留白，命中滚动条区域时按 0 处理）
```
`meta` 三级策略：帧未带 meta（CDP metadata 是**可选**字段，逐帧可能缺失）时**沿用上一个已知 meta**；整场从未有过才降级 `deviceWidth←当前显示 JPEG 的 naturalWidth`、`pageScaleFactor=1`、offsets=0。不能用 `frame.width/height` 降级：sidecar 现读 `p.metadata?.width/height`（CDP 协议无此字段，应为 deviceWidth/deviceHeight），该二字段今天恒为 0（前端一直靠 `img.naturalWidth` 画布所以未暴露）；实施 §5.3 下发 meta 时顺带把二字段修正为 deviceWidth/deviceHeight。公式以 POC 实测校准（§13）。画布 letterbox 黑边（容器与帧宽高比不一致时 flex 居中留边）上的事件**直接忽略**——不能钳 0，钳 0 等于向远端视口左上角注入真实点击（实施评审 P1-3）。

### 7.3 数据通道

- CLOUD：`useStreamWS` 新增 `sendBrowserLiveInput(sessionId, data)`（普通 `send`，不排队不重试——输入丢了就丢了，交互语义容忍）。
- LOCAL（Electron）：`store.inputBrowser(sessionId, payload)` → `electronAPI.browserLive.input(...)` → 主进程。
- store（`browserLive.ts`）：`BrowserLiveSessionState` 增加 `frameMeta`（最新帧 meta）、`startedControl`（started 的 control 标记）；帧 ingest 同步更新。

## 8. LOCAL Electron 链路

- `browserLive.cjs`：新增 `inputBrowser(sessionId, payload)`：查 `live` 出口 → `POST /input?token=`（复用 `postStop` 的 http 形态）；**404（旧 sidecar 无 /input 路由）**→ 返回 `unsupported`，renderer 收到后关闭入口并提示“采集端版本过旧”；403 是 token 失配（sidecar 重启换 token，SSE 重连拿新 live.json），按丢批返回 `ok` 不误报（实施评审 P2-6）。
- `preload.cjs`：`browserLive.input(sessionId, payload)`；`electron.d.ts` 同步类型。
- LOCAL 无需后端参与（与 stop 同链路），天然无属主校验问题（本机进程即属主环境）。

## 9. 安全与隐私

| 项 | 措施 |
|---|---|
| 鉴权 | CLOUD 输入帧过属主校验（缓存 60s）；LOCAL 仅本机进程可达（token + 127.0.0.1） |
| 权限 | 与 `browser_live_stop` 同级（会话属主即可），无新增权限面 |
| 按键内容 | 三个落点全禁：sidecar 日志（只计数）、后端日志/审计（WS 不在 REST 审计范围，需评审确认不新增）、客户端 console（禁止 debug 打印 payload） |
| 录制 | 回放录制继续**只录帧**——用户输入的内容会出现在后续画面帧里（与 Agent 自己输入同等可见面），但事件本身不落盘 |
| 洪泛 | 客户端节流 + 后端 (60,180) + sidecar 60/s 三层；非法批静默丢弃 |
| 注入面 | 事件只能到达会话自己的浏览器（sidecar 只路由到本会话 runtime 的 CDP 连接） |

## 10. 性能与带宽

- 交互回路延迟 ≈ 输入上行（~1 RTT，小包）+ 帧下行（100ms 节流 + 编码 + 转发）。点击类操作预期 150-400ms 反馈，可接受；连续拖拽/打字跟手性弱（ghost cursor 缓解视觉）。
- 带宽（CLOUD，操作活跃期 10fps）：jpeg q60 1280×720 约 80-150KB/帧 → 0.8-1.5MB/s/观看端；仅输入活跃的 5s 窗口内生效，静止回落 4fps（≈0.3-0.6MB/s）。移动端（安卓 P2）上线前需再评估。
- 后端限速放宽 (12,24) 仅输入活跃会话生效；runner 上行带宽同量级增加。
- CPU：sidecar dispatch 与帧编码均为既有路径，注入命令本身开销可忽略。

## 11. 影响面（改动清单）

| 端 | 文件 | 内容 |
|---|---|---|
| **前置 P-1（独立可发版，详见 §1.3）** | `desktop/electron/browserLive.cjs`、`desktop/src/components/browser/BrowserLiveView.vue`、`browserLive.test.cjs` | 删自动弹出与双击放大；Tab「打开画中画」入口（isLive 门控）；PiP 定为只读 |
| 契约 | `shared/contracts/src/ws.ts` | `BrowserFrameMeta`、`BrowserFrameData.meta?`、`BrowserLiveStartedData.control?`、`BrowserInputEvent`、`WsBrowserLiveInputFrame` |
| 技能（sidecar） | `skills/bundled/browser-use/scripts/browser-live-host.mjs` | `/input` 出口、cloud 消息分支、`applyInput`（校验/限速/路由/注入）、metadata 下发、动态帧率、started.control、live.json caps、无内容日志 |
| 后端 | `backend-ts/src/session/ws/streaming-ws-handler.ts`（+ spec） | `handleBrowserLiveInput`、属主缓存、输入限速、帧限速动态放宽、runner 转发 |
| 桌面 Electron | `desktop/electron/browserLive.cjs`（+ test）、`preload.cjs`、`src/types/electron.d.ts` | `inputBrowser` IPC 链路、unsupported 降级 |
| 桌面共用 UI | `desktop/src/composables/useStreamWS.ts`、`src/stores/browserLive.ts`（+ tests）、`src/components/browser/BrowserLiveView.vue` | 上行发送、frameMeta/startedControl、交互 overlay（事件捕获/映射/ghost cursor/IME/键表/节流）、开关按钮与降级提示 |
| 安卓 | 无（P2：touch → `Input.dispatchTouchEvent`） | — |
| 文档（实施时） | `DEPLOY.md`、`skills/bundled/browser-use/SKILL.md`、`skills/mao-cli/reference/` | 能力说明、隐私说明（“你输入的内容不落日志/不录制事件”） |
| 发版 | 后端 restart；admin 不涉及；`desktop/dist` 发布覆盖 Web 端；**LOCAL 输入链路改了 main.cjs/preload.cjs，需重打桌面安装包** | — |

依赖注意：`BrowserLiveView` 的 PiP 相关改动由 P-1 承担（§1.3，与本方案无耦合）；`no-progress-notice`/工具摘要规范与本方案无交集（不是内置工具变更，不触发那两条同步义务）。

## 12. 风险清单

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **交互延迟感**（4→10fps + 双跳网络） | 流畅拖拽/打字体验不及本地；用户预期管理 | ghost cursor、操作期提帧率、按钮文案“协作操作（画面有延迟）”；POC 先实测延迟基线 |
| R2 | **与 Agent 并发交织**（已接受，无门控） | Agent 的 click/type 可能作用到被用户改过的页面 → 命令失败/结果偏差；用户按键混入 Agent 的输入序列 | 用户定案接受；Agent 侧现有“读回验证/重试”逻辑兜底；已定做非阻断「Agent 执行中」徽标（P0 交付，见 §7.1）；给 Agent 的会话内提示仍不做（D8） |
| R3 | **按键含密码等敏感内容** | 泄露面在日志/审计/录制三处 | §9 三点禁令 + 用例守卫（日志断言不含 text 字段）；文档明示 |
| R4 | **洪泛/滥用**（属主客户端被劫持或 Bug） | 打满 WS / sidecar / 浏览器 | 三层限速 + 批量上限 + 静默丢弃 |
| R5 | **坐标映射误差**（缩放、滚动条、devicePixelRatio） | 点不准、误点 | DevTools 公式 + POC 校准；meta 缺失降级；偏差超阈值时 UI 提示重试 |
| R6 | **按键卡死**（blur 后 keyUp 丢失） | 页面认为键一直按着 | blur/visibilitychange 时全量 keyUp 释放（§7.1） |
| R7 | **新旧版本并存** | 新客户端发输入、旧 sidecar 无 `/input`；或反之 | D6 能力协商隐藏入口；sidecar 未知类型忽略（现状兼容）；LOCAL unsupported 显式提示 |
| R8 | **带宽抬升**（10fps 窗口） | 云端流量、弱网卡顿 | 仅输入活跃 5s 窗口；帧率/质量可后续调参（env）；移动端暂不开放 |
| R9 | **多操作端并发**（Tab + 多设备；PiP 经 P-1 定为只读，不构成操作端） | 事件乱序交织 | 按到达顺序应用，不做仲裁（协作语义内可接受）；文档说明 |
| R10 | **原生弹窗不可操作**（文件选择、Basic 认证、原生右键菜单） | 用户卡住 | 产品边界说明：这类交互留给 Agent/CLI 处理；UI 提示“当前弹窗无法远程操作”难以检测，先文档化 |
| R11 | CDP Input 与 playwright-cli 并发多客户端写同一页面 | 极端情况下事件时序不确定 | CDP 多客户端是官方支持形态（DevTools + automation 并存）；风险=行为层面（R2），非协议层面 |
| R12 | 属主缓存 60s 内会话被转移/删除 | 短窗口内输入打到已移交会话 | TTL 取 60s 且删除会话走既有 runtime 级联（浏览器已关，sidecar 无页可路由→忽略）；可收紧为 30s |

## 13. 测试计划

**POC（先行，半天）**：真实 headless Chrome 上验证 ①`Input.dispatchMouseEvent` 坐标公式与 DevTools 一致（含滚动条）；②`insertText` 中文；③10fps 帧率与带宽实测；④与 playwright-cli 并发注入冒烟；⑤Shift/Ctrl+点击与 Ctrl+滚轮（验证 D10 modifiers 必要性）；⑥D12 客户端自限参数标定（打字+拖拽并发 60s 窗口零丢弃）。POC 通过才进入开发。

- 后端 spec：属主校验/缓存命中与过期、限速丢批、无 runner 忽略、转发帧形状、帧限速放宽窗口。
- sidecar 单测（`node:test` 直载模式，把 `applyInput` 抽成可注入 fake ws 的纯函数）：校验矩阵、路由（targetId 命中/回退 lastActive/无页）、限速、动态 interval、日志不含内容。
- 桌面：坐标映射纯函数单测（含 meta 缺失降级）；overlay 事件→事件序列（IME 合成、blur 全释放、节流合并）；`browserLive.test.cjs` 补 `/input` 转发与 404 降级。
- E2E（可选）：本地起 fake CDP 页面，断言点击坐标到达。

## 14. 分期与工作量

| 阶段 | 内容 | 预估 |
|---|---|---|
| **P-1（前置，可独立发版）** | 画中画手动化：删自动弹出 + 双击放大，Tab 加「打开画中画」入口，PiP 定为只读（§1.3） | 0.5 人日 |
| POC | §13 POC 四项 | 0.5 人日 |
| P0 | 契约 + sidecar 注入 + 后端转发/限速 + Electron IPC + 交互 overlay（鼠标/滚轮/键盘/IME、ghost cursor、能力协商、降级、D10 modifiers 状态维护、D11 Cmd 翻译、setIgnoreMenuShortcuts 屏蔽本地加速键、定向提帧率）+ 「Agent 执行中」徽标 + 测试 + 文档 | 5–7 人日（复审补充项均为小时级增量，不另计） |
| P1 | 体验优化：拖拽平滑、延迟自适应画质 | 1–2 人日 |
| P2 | 安卓触摸（`Input.dispatchTouchEvent`、双指滚动） | 1–2 人日 |

**实施顺序（2026-11-27 拍板，同日按实际进度修正）**：早期未发布修复（PiP 收起按钮 / 刷新重放 / host 录制注入）与回放历史两入口均已实施并随 **0.0.534** 发布（`79b714df`、`3c42c5e6`，含设计稿 P0+P1 的 LOCAL 扫描）。**当前剩余队列：P-1 单独作为首个发版单元 → POC → P0**。

P-1 建议先行独立发版（不依赖协作任何部分；纯桌面端改动 + 重打桌面包）。P0 起发布组合：后端 restart + `desktop/dist` + **桌包包重打**（main/preload 变更）；技能脚本随 skills 同步到会话（新会话生效，进行中会话的 sidecar 不热更新——见 R7 兼容路径）。

## 15. 评审结论（2026-11-27 拍板）

| 待定项 | 结论 |
|---|---|
| 帧率自适应参数（100ms/250ms、5s 窗口）与后端限速放宽值 (12,24) | POC 实测后定（数据项，不人工拍板） |
| 「Agent 执行中」徽标 | **做**，随 P0 交付（非阻断纯提示，§7.1） |
| LOCAL 旧 sidecar 降级粒度 | **隐藏交互入口** + tooltip“采集端升级后支持操作”，不做全局公告式提示 |
| PiP 是否允许操作 | 已由 P-1 关闭：PiP 只读，操作仅 Tab |
| 协作开关是否记住状态 | **不记住**，每次显式开启/退出 |
| P-1 后是否补「直播开始」桌面通知 | **暂不补**，观察反馈（`desktopNotify` 可随时加） |
| 操作权边界 | **仅会话属主**；共享会话 / 回放观看者不可操作 |
| 二次评审补充（同日，可行结论） | D10 mouse modifiers、D11 macOS Cmd→Ctrl、D12 限速预算"诚实发送者"、§5.3 提帧率定向到输入目标页、§6 限速桶/属主缓存随 runner 断开清理、§7.1 keypress→char 事件流 + `setIgnoreMenuShortcuts` 屏蔽本地加速键（实施修正：before-input-event 的 preventDefault 会连页面派发一起拦掉） + Esc 退出、§7.2 meta 三级降级（naturalWidth 兜底，`frame.width` 恒 0 不可用作降级源）、§13 POC ⑤⑥——均为正确性修正，无新增待定项 |