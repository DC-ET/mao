# 终端 CLI（mao-agent）实现文件代理技术方案（CLI 绑定 LOCAL 会话的远程文件浏览）

- 状态：已实施（2026-11-18 落地；评审修订：投递档序修正（显式声明优先于 legacy 推断，修复「旧桌面 + 新 CLI」白等超时）、CLI 图片不缩放与桌面的行为差异如实标注、capabilities 解析边界与四 op DTO 字段细节补全、executor / file-ops 的收窄分工与行号校正）
- 日期：2026-11-18
- 关联方案：
  - [2026-11-17-local-file-tree-remote-proxy-technical-design.md](./2026-11-17-local-file-tree-remote-proxy-technical-design.md)（已落地：LOCAL 会话文件树远程代理主体。本方案是其 §9-5 开放问题的立项，补齐 CLI 执行端）
  - [2026-11-05-local-task-device-delegation-technical-design.md](./2026-11-05-local-task-device-delegation-technical-design.md)（已落地：设备身份 / 会话绑定执行端。CLI 与桌面共用 `~/.mao/agent-cli/device.json`）
  - [2026-11-09-mao-agent-local-daemon-technical-design.md](./2026-11-09-mao-agent-local-daemon-technical-design.md)（`mao-agent local --serve` 常驻执行端形态，本方案的执行宿主之一）
- 本方案定位：让 CLI（mao-agent）绑定的 LOCAL 会话也能被移动端 / 浏览器远程浏览文件。协议通道（`file_op_request / file_op_result`）、DTO 形状、超时档位、700KB 预检全部复用 11-17 已落地机制，主体是 **CLI 侧四个只读 op 的 Node fs 实现 + 服务端投递的 client-type / 能力感知分层**。

## 1. 需求背景

### 1.1 现状

文件代理的设备端执行器只存在于 Electron renderer（`desktop/src/composables/useStreamWS.ts` 的 `file_op_request` 分支 → `utils/local-file-op.ts`）。服务端投递器 `sendToFileCapableDevice`（D11）只投 electron 连接：CLI 创建 / 绑定的 LOCAL 会话（11-05 D13 正式产品流）在移动端打开文件 Tab 时，只能拿到「该任务由终端 CLI（mao-agent）执行，暂不支持远程浏览本地文件」的拒绝文案。`mao-agent local --serve` 常驻模式已经是本机全部 LOCAL 会话的执行端（替全部会话执行工具、技能、MCP 同步），唯独文件浏览缺席——能力不对称，且提示文案把「永久不支持」和「本期未实现」混在一起。

### 1.2 能力底座（全部已存在，本方案只组装）

| 设施 | 现状 | 证据 |
|---|---|---|
| CLI 设备事件路由（daemon） | `mao-agent local --serve` 全局接管 `DAEMON_ROUTED_EVENTS`（tool_execute / skill_sync_required / mcp_sync_required / tool_approval_resolved），不 subscribe、不过 acceptEvent，「凭设备身份拿执行连接，替本机全部 LOCAL 会话执行工具」 | `agent-cli/src/commands/local.ts:12-17`、`:67`、`:126-146`（非 tool_execute 分支 :133-135 静默接管；退出摘要 :170） |
| CLI 设备事件路由（REPL） | 交互模式按订阅会话路由：`acceptEvent`（sessionId 过滤）命中后 `tool_execute` 等四类事件交给 `localExecutor.handleEvent` | `agent-cli/src/session/session-runner.ts:450-460`（acceptEvent :452、路由 if 块 :454-460）、`agent-cli/src/ws/event-filter.ts:7-12` |
| CLI 执行器分发 | `LocalExecutor.handleEvent` 按事件类型分发（:181-191），错误统一收敛回包（tool_error / skill_sync_done 失败帧） | `agent-cli/src/local/executor.ts:176-206` |
| CLI 信任收窄 | `resolveWorkspace`：服务端下发的 workspace 必须等于本地信任根或位于其内部，否则拒绝（防服务端把 workspace 指到 `/` 绕过本地信任边界；`isWorkspaceWithin` 走 realpath 边界，`local/sandbox.ts:83-85`） | `agent-cli/src/local/executor.ts:218-227`（isOutsideTrust :233-236） |
| CLI 可靠回传 | `WsClient.sendReliable(payload)` 已有（skill_sync_done 走此通道） | `agent-cli/src/ws/ws-client.ts:174` |
| CLI 设备身份 | `device.json`（`~/.mao/agent-cli/device.json`）与桌面端共用同一 deviceId（桌面 `ensureDesktopDeviceId` 优先读共享文件）；auth 帧已带 `device: { id, name, platform }` | `agent-cli/src/local/device-identity.ts:13`（DEVICE_FILE）、`:18-24`（DeviceIdentity）、`desktop/electron/desktopPrefs.cjs:137`（ensureDesktopDeviceId）、`agent-cli/src/ws/ws-client.ts:242-246` |
| CLI 图片读取先例 | `local/tools/files.ts` 已有 `IMAGE_EXT` 五扩展名表、`mimeFromPath` / `detectMimeFromBytes`（魔数）与 `readImage`（5MB 上限、不缩放，注释明言「终端版不做缩放」）——file op 的 read 直接复用，勿再抄一份 | `agent-cli/src/local/tools/files.ts:8-52`、`:60-81` |
| 服务端 DTO 归一化 | `RemoteFileProxyService.normalizeResult` 对 list/search（mtime→mtimeMs + workspaceRoot）、files（包 `{ files }`）、read（透传）单点归一，不区分设备端形态 | `backend-ts/src/file/remote-file-proxy.service.ts:122-137` |
| 桌面端参照实现 | 四 op 的 DTO 与防护口径全在 main.cjs IPC handler 与 renderer 执行器里 | `desktop/electron/main.cjs:2267`（list-directory：containment + 500 条上限 + 目录优先排序）、`:2124`（local-read-file：图片 / PDF data_uri + 文本行窗口）、`:2638`（readLocalImage：5MB 上限 + 魔数校验 + promptImageResizer 缩放——CLI 无缩放，见 §4.2-2）、`:2215`（IGNORED_DIRS）、`:2217`（list-workspace-files：隐藏文件跳过 + mtime 排序去字段）、`desktop/src/composables/workspace-file-provider.ts:129-176`（searchLocalWorkspace：`.git` / `node_modules` 排除、500 目录 / 10 层、`min(limit, 200)`）、`desktop/src/utils/local-file-op.ts`（containment + 700KB UTF-8 字节预检） |

### 1.3 问题

1. **能力不对称**：同一台机器、同一个 deviceId，桌面客户端在就能远程浏览，只有 CLI 在就不能——但工具执行、技能同步 CLI 都能接管。
2. **文案误导**：拒绝文案是「暂不支持」，用户无法区分「永远不支持」与「升级即可」。
3. **投递语义缺口**：当前 `cliOnly` 三态是按「client 类型」一刀切，无法表达「这个 CLI 能不能干这件事」；未来桌面或 CLI 某版本若不支持某能力，服务端只能猜。

## 2. 需求描述

### 2.1 要做的

1. **P1 CLI 实现四个只读 op**（`list / read / search / files`）：新增 `agent-cli/src/local/file-ops.ts` 纯函数模块（fs/promises 实现，图片 mime / 魔数检测复用 `local/tools/files.ts` 既有代码），DTO 与桌面端逐字段同形（§4.2-2），服务端归一化零改动。
2. **P1 CLI 执行器接线**：`LocalExecutor.handleEvent` 新增 `file_op_request` 分支（含信任收窄 + containment + 700KB 预检 + 失败收敛回帧）；daemon 模式把 `file_op_request` 加入 `DAEMON_ROUTED_EVENTS`（全量接管）；REPL 模式跟随既有 `tool_execute` 的接受口径（仅当前订阅会话，§4.2-4）。
3. **P1 能力声明与分层投递**：auth 帧新增 `capabilities: string[]`（CLI 声明 `['file_op']`，桌面 Electron 同步声明）；服务端注册表按连接记录能力集，`sendToFileCapableDevice` 改为分层投递（§4.1-3），区分「旧 CLI 未声明」（升级提示文案）与「声明但不具备」（版本过旧文案）。
4. **P1 daemon 摘要**：`--serve` 退出摘要补文件代理计数（`文件代理 N 次`）。
5. **文档同步**：mao-cli 的 desktop.md / mao-agent.md LOCAL 段落更新（CLI 设备支持远程浏览 + 旧版升级提示）。

### 2.2 不做的（本期明确排除）

- **不做写操作**：CLI 只实现四个只读 op；写 / 预览 / 下载 / zip 仍按 11-17 的拒绝口径（bytes 传输 P2 未定），CLI 与桌面能力面保持一致。
- **不做 agent-cli 与 desktop 的 containment 代码共享**：桌面 renderer 无 node path 模块（词法实现），CLI 在 Node 侧用 `path.resolve`（镜像 main.cjs 口径），两端各自实现 + 互指注释 + 各自单测覆盖同形向量（D6）。
- **不改 file_op 协议载荷**：事件名、字段、超时档位、700KB 上限全部沿用；不进 `@mao/contracts`（延续 11-17 D3/D10 决策）。
- **不放宽 REPL 的会话过滤**：交互模式下非当前订阅会话的 `file_op_request` 与 `tool_execute` 同口径被丢弃（服务端最终超时报错）；常驻 daemon 是跨会话场景的正式答案，不为此扩大 REPL 语义（D7）。
- **不做 CLI 的图片 / PDF 例外放行，也不做图片缩放**：read op 镜像桌面实现（含 data_uri），700KB 预检把大文件挡在回帧层。注意一处与桌面的已知差异：桌面 `readLocalImage` 经 promptImageResizer 把超限图片缩放并转码（长边 ≤2048 / JPEG q85，`promptImageResizer.cjs`）再过预检，多数大图缩后可看；CLI 无 nativeImage 不缩放（与 CLI read_file 工具既有 readImage 同口径），原图 base64 超 700KB（约 >525KB）即回「文件过大」失败帧。不为此引入图片处理依赖，风险表与 mao-cli 文档如实注明。

## 3. 关键决策

| # | 决策点 | 结论 | 落选项与理由 |
|---|---|---|---|
| D1 | 协议复用 | 完全复用 `file_op_request / file_op_result` 通道、DTO、超时、预检规则 | 11-17 已把归一化收敛在服务端单点，设备端只要返回与桌面同形的 DTO 即零服务端改动；新开通道则归一化与超时要复制一套 |
| D2 | 能力信号 | auth 帧新增顶层 `capabilities: string[]`，服务端按连接存 `Set<string>` | 与 `pageEnabled`（11-06 能力协商）同款先例：客户端声明、服务端按连接消费；不塞进 `device`（设备身份是稳定信息，进 `WsConnectionSnapshot` 供管理后台展示，不混能力位） |
| D3 | 投递分层 | 档序：electron 显式声明 file_op → cli 显式声明 file_op → electron 未声明（legacy 回退）→ 其余（旧 CLI → cliOnly 升级提示 / 显式声明但缺能力 → noCapable 版本过旧提示）。**显式声明优先于 legacy 推断，声明端内部 electron 优先** | 见 §4.1-3 矩阵。声明是比 client-type 更强的能力信号：11-17 之前部署的旧桌面未声明也无 handler，若 legacy electron 先于声明的 cli 命中，同机「旧桌面 + 新 CLI」会白等 15s 超时（评审发现的朴素排序缺陷）。legacy 回退必须保留：已部署的 11-17 桌面端有 handler 但 auth 帧不带 capabilities，收窄成「必须声明」会让存量桌面立即不可用 |
| D4 | CLI 执行位置 | `LocalExecutor.handleEvent` 新分支 + 纯函数模块 `local/file-ops.ts` | 与 tool_execute 同一分发入口（错误收敛、信任收窄、日志口径一致）；纯函数便于对 tmp 目录单测，不拖 TUI |
| D5 | CLI 信任边界 | 双层：先 `resolveWorkspace` 收窄（session.workspace 必须在信任根内），再 `path.resolve` containment（镜像 main.cjs:2272） | 服务端下发的 workspace 不可信是 executor 既有安全不变量（tool_execute / skill sync 同款）；文件 op 沿用，防把 `/` 当工作区浏览全盘 |
| D6 | 跨端口径共享 | 不下沉共享包；CLI 侧 Node 原生实现（`path.resolve` + startsWith），桌面 renderer 词法实现，两端单测覆盖同一组向量并互指注释 | renderer 无 node path，共享包为一对常量 / 一个函数引入新包不值得；「防漂移」靠同一组测试向量锚定（.. 逃逸 / 绝对越界 / 盘符 / 根退化） |
| D7 | REPL 会话过滤 | `file_op_request` 加入 session-runner 的 tool_execute 同款路由（acceptEvent 之后），不放宽 | CLI 交互模式一次只坐一个会话，与其工具接管语义完全一致；daemon 才是跨会话执行端；放宽会造成「REPL 在 A 会话却替 B 会话读盘」的隐式行为 |
| D8 | 预检常量 | `FILE_OP_MAX_FRAME_BYTES = 700 * 1024` 在 CLI 本地重复定义，注释互指 | 不进 contracts（11-17 已定协议不进契约包）；两端 `Buffer.byteLength` / `TextEncoder.encode` 语义一致，测试锚定同一临界值 |

## 4. 详细设计

### 4.1 服务端（backend-ts）

1. **auth 帧解析能力**（`streaming-ws-handler.ts`）：在 auth 分支既有 `pageEnabled`（:598）与 `parseDevice`（:2900）旁边新增 `parseCapabilities(root)`——仅接受字符串数组（逐项 trim、去重、上限 16 项）；任一项非字符串 / trim 后为空 / 数组超 16 项 → **整体判非法 → 空集**（与 parseDevice 的整体拒绝口径一致，不做逐项丢弃），非法 / 缺省 → 空集（按旧客户端处理）。能力名区分大小写、不做归一化：声明未知名只是无效果，无害存储。透传给 `registry.register` 新参。桌面 / CLI / browser / embed 均可声明，消费方目前只有文件投递。
2. **注册表存能力**（`streaming-ws-registry.ts`）：新增 `connectionCapabilities: Map<string, Set<string>>`（socket.id → 能力集）；`register` 增第 7 可选参 `capabilities?: ReadonlySet<string>`（先清后写，向后兼容）；`unregister` 清理；新增 `hasCapability(socket, name): boolean`。
3. **分层投递**（`sendToFileCapableDevice` 改造，同设备全部存活 + 已鉴权连接内按档取首条命中）：

   | 档 | 连接条件 | 结果 |
   |---|---|---|
   | 1 | clientType=electron 且显式含 `file_op` | delivered |
   | 2 | clientType=cli 且显式含 `file_op` | delivered |
   | 3 | clientType=electron 且未声明任何 capabilities（legacy：11-17~now 桌面端有 handler） | delivered |
   | 4 | clientType=cli（旧版，未声明） | `cliOnly`（升级提示） |
   | 5 | 有连接但档 1-4 均未命中（全部显式声明且均无 `file_op`） | `noCapable`（版本过旧提示） |
   | — | 无连接 | `offline` |

   `FileCapableDelivery` 联合扩为四态（delivered / offline / cliOnly / noCapable，delivered 携带 socket 不变）。档序要点：
   - **显式声明优先于 legacy 推断**（档 1 / 2 先于档 3）：声明是更强的能力信号。若按 client-type 让 legacy electron 先命中，同机「旧桌面（<11-17，无 handler 且未声明）+ 新 CLI（声明 file_op）」会把请求投给旧桌面白等 15s 超时；新序投给声明过的 CLI 正常服务。11-17 桌面（legacy 但有 handler）+ 新 CLI 并存时改投 CLI——两端 DTO 与服务端归一化完全同形，UI 无感。
   - **声明端内部 electron 优先**（档 1 先于档 2）：延续 11-17 同机桌面优先的习惯，桌面 renderer 与 UI 同进程，后续 preview / download 等 UI 联动能力更强。
   - 档 3 legacy 回退必须保留（理由同 D3）；档 5 是面向未来的防护——「electron 显式声明但缺 file_op」在现实构建中无出现路径（§4.3 的声明与 handler 同源发布，声明存在即 handler 存在），只有未来桌面移除 handler 而忘删声明才会落入该档。发送失败仍按现状收敛为 offline（不做档内逐条重试）。
4. **拒绝文案**（`remote-file-proxy.service.ts`）：`cliOnly` → 「该任务由终端 CLI（mao-agent）执行，当前版本暂不支持远程浏览本地文件，请升级 mao-agent 后重试」；`noCapable` → 「执行端客户端不支持远程浏览本地文件，请升级桌面客户端或 mao-agent 后重试」。其余（未绑定 / offline / 超时）不变。

### 4.2 终端 CLI（agent-cli）

1. **新增 `src/local/file-ops.ts`**（纯函数，仅依赖 node fs/path）：

   ```ts
   export type LocalFileOp = 'list' | 'read' | 'search' | 'files';
   export interface FileOpRequest { requestId: string; op: LocalFileOp; params: Record<string, unknown>; workspace: string }
   export interface FileOpResultFrame { type: 'file_op_result'; sessionId: number; requestId: string; ok: boolean; data?: unknown; error?: string }
   export const FILE_OP_MAX_FRAME_BYTES = 700 * 1024; // 与 desktop/src/utils/local-file-op.ts 同值，互指注释

   export async function executeFileOp(sessionId: number, request: FileOpRequest): Promise<FileOpResultFrame>
   ```

   收窄分工：**信任收窄只在 executor 层做一次**（`resolveWorkspace`，复用 tool_execute 的错误文案「拒绝服务端下发的工作区 …」，见 §4.2-3）；`executeFileOp` 接到的 `request.workspace` 已收窄，模块内只做 **containment**——`path.resolve` 后须等于工作区或位于其内（镜像 main.cjs:2272 的 `startsWith(workspace + path.sep) || ===` 口径，越界回「路径越出工作区范围」），不重复信任收窄。

   执行序（与桌面执行器同构，永不抛错、全部收敛为回帧）：containment → op 分发 → 结果 `{ error }` 字段收敛为失败帧 → `Buffer.byteLength(JSON.stringify(frame), 'utf8') > 700KB` 预检 → 「文件过大，移动端暂不支持查看该文件」。fs 一律用 `node:fs/promises`：daemon 长驻进程与 tool_execute / WS 心跳共用事件循环，大目录 BFS 不能用同步 fs 长时间阻塞（桌面端逐目录 await 同构）。**实施豁免**：read op 图片分支复用 files.ts readImage（同步 fs、≤5MB，毫秒级阻塞已接受）——「复用 readImage」与「一律 fs/promises」内在冲突，实施选复用，评审确认。

2. **四个 op 的实现口径**（逐字段镜像桌面端，服务端归一化共用）：
   - `list`：`path.resolve` containment（防 `..`；镜像 main.cjs:2272）→ `readdir(withFileTypes)` + `lstat`（isDirectory && !isSymlink、size、mtimeMs、isSymlink）→ 目录优先、名称排序（localeCompare）→ 500 条上限 → `{ entries, truncated }`；`truncated` 按 readdir 原始条目数 > 500 判定（排序前计数，与桌面一致）。
   - `read`：三态镜像 main.cjs local-read-file（:2124）。图片：扩展名命中 `IMAGE_EXT` 五表 + `detectMimeFromBytes` 魔数校验（**复用 `local/tools/files.ts` 既有实现**），5MB 上限（`MAX_IMAGE_BYTES` 同值）→ 返回 `{ content, total_lines: 0, media_type: 'image', mime, path, size_bytes, data_uri }`；CLI 不缩放也不解码头信息，无 width / height 字段（桌面经 nativeImage 对可解码图片总是带这两个字段，服务端 read 透传、前端展示只用 data_uri，不影响）。PDF：`.pdf` 整文件字节 base64（桌面无独立大小上限，700KB 预检兜底）→ `{ content: 'PDF 文件：<path>', total_lines: 0, media_type: 'pdf', mime: 'application/pdf', data_uri }`。文本：utf8 读取、`content.split('\n')` 行切分、`offset / limit` 窗口（缺省 0 / 5000，与桌面 runner 层 `local-file-op.ts` 一致）、`total_lines` 为全文行数。`media_type` 值集合就三态：`'image'` / `'pdf'` / 文本分支无该字段。失败返回 `{ error: e.message }` 由统一收敛转失败帧。
   - `search`：BFS 队列逐层（与桌面 `searchLocalWorkspace` 同构），仅跳过 `.git` / `node_modules` 与符号链接（**勿混用 files op 的十二目录 IGNORED_DIRS**），上限 500 目录 / 深度 10；结果数 `Math.max(1, Math.min(limit, 200))`，limit 缺省 **100**（桌面 runner 层缺省值，非内部函数默认 50），触顶 / 扫满 → `truncated: true` → `{ entries, truncated }`，文件名大小写不敏感子串匹配。
   - `files`：`walkDir` 递归（跳过隐藏文件与 `IGNORED_DIRS` 十二目录集合，同 main.cjs:2215）→ `filter` 对文件名与相对路径子串匹配 → **收集上限在遍历中生效**（`results.length >= limit` 即早退，与桌面 walkDir 同款；默认 20）→ 对已收集集合按 mtime 降序 → 剥离 mtime → `[{ path, name, size }]`。不是「全量收集再全局排序」：mtime 排序只作用于遍历早退前收集到的文件，CLI 必须镜像这个顺序，否则同参数下与桌面返回不同集合。
3. **执行器分支**（`executor.ts`）：`handleEvent` 的分发链新增 `file_op_request` → `onFileOpRequest(sessionId, d)`：取 `d.requestId`（缺失直接忽略，与 onToolExecute 同款）、`resolveWorkspace(d.workspace)` 收窄（收窄后的 workspace 传入 executeFileOp，异常走统一 catch 回失败帧）、调 `executeFileOp`、`this.opts.ws.sendReliable(frame)`。`handleEvent` 的统一 catch 补 `file_op_request` 分支（带 requestId → 回 `ok:false` 失败帧），兜底帧与桌面 `useStreamWS` 分支同形。**无审批弹窗**（只读 op，与桌面一致）。`sendReliable` 返回 false（重连后仍发不出）不重试：服务端超时 / `failAllForSocket` 会把在途请求收敛为失败，与 tool_result `!sent` 的 console.error 口径一致。daemon 模式下 file_op 与 tool_execute 可并发（handleEvent 均 void 触发）：只读 fs 与 shell 并行无一致性风险、回帧互相独立，**无需互斥**。
4. **两条路由接线**：
   - daemon（`commands/local.ts`）：`DAEMON_ROUTED_EVENTS` 加 `'file_op_request'`；既有 `evt.type !== 'tool_execute'` 分支自动接管（回帧不打日志，:133-135），file_op 分支内累加计数，退出摘要补 `fileOpCount`（`文件代理 N 次`，:170 摘要行扩写）。
   - REPL（`session/session-runner.ts:455`）：路由条件加 `evt.type === 'file_op_request'`，与 tool_execute 同过 `acceptEvent`（当前订阅会话才接管，D7）。
5. **auth 帧声明**（`ws-client.ts:242-246`）：auth 帧追加 `capabilities: ['file_op']`（CLI 常量，与 file-ops 模块同文件导出）；旧后端忽略未知字段，无兼容风险。

### 4.3 桌面端（desktop，1 行级改动）

`useStreamWS.ts` 的 auth 首帧追加 `capabilities: isElectronClient() ? ['file_op'] : undefined`——从 legacy 回退（档 3）升入显式声明（档 1），行为不变；同时让「声明但不具备」的语义自洽（未来桌面若移除 handler，服务端可正确报版本过旧而非误投）。浏览器端 clientType 为 browser，本就不是投递候选，无需声明。

### 4.4 协议载荷（不变，仅备忘）

```
服务端→设备  file_op_request  { requestId, op: 'list'|'read'|'search'|'files', params: { dir? | path?, offset?, limit?, pattern?, filter? }, workspace: <session.workspace 绝对路径> }
设备→服务端  file_op_result   { sessionId, requestId, ok: true, data: <op 对应 DTO> } | { sessionId, requestId, ok: false, error: '<中文错误>' }
```

## 5. 落地清单

| 端 / 文档 | 项 |
|---|---|
| backend-ts | `streaming-ws-handler.ts`（auth 解析 capabilities）、`streaming-ws-registry.ts`（connectionCapabilities / hasCapability / 分层投递）、`remote-file-proxy.service.ts`（cliOnly 新文案 + noCapable 分支）+ 三个 spec 扩展 |
| agent-cli | 新增 `src/local/file-ops.ts`（四 op + containment + 预检，复用 `local/tools/files.ts` 的 IMAGE_EXT / detectMimeFromBytes / readImage）；`src/local/executor.ts`（handleEvent 分支 + onFileOpRequest + catch 兜底）；`src/commands/local.ts`（DAEMON_ROUTED_EVENTS + fileOpCount）；`src/session/session-runner.ts`（路由条件）；`src/ws/ws-client.ts`（auth capabilities）+ `test/local-file-ops.spec.ts`（新）+ 既有 spec 扩展 |
| desktop | `useStreamWS.ts` auth 帧加 `capabilities`（1 行级） |
| contracts / 迁移 | 无变更 / 无 DDL |
| 测试 | 见 §7 |
| 文档 | `changelog/unreleased/`（后端 + 终端 CLI（mao-agent）小节）；`skills/mao-cli/reference/desktop.md` LOCAL 段与 `mao-agent.md`（CLI 设备支持远程浏览 + 旧版升级提示 + CLI 大图不缩放差异）；11-17 方案 §9-5 已含「已立项」回链，无需再改 |

## 6. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| 旧 CLI 收到 file_op_request 静默忽略 → 白等超时，误导为设备故障 | 能力声明 + 档 4：未声明 CLI 一律 cliOnly 即时回升级提示，不投递（本方案主目标之一） |
| 已部署 11-17 桌面端（有 handler、未声明 capabilities）被「必须声明」误伤 | 档 3 legacy 回退：electron 未声明视为可投递；spec 覆盖该档 |
| 同机「旧桌面（<11-17，无 handler）+ 新 CLI」被 legacy 档误投旧桌面白等超时 | 档序修正：显式声明的 cli（档 2）先于 legacy electron（档 3）；registry spec 覆盖该组合 |
| CLI 无图片缩放：大图（原图 > ~525KB）被 700KB 预检拒绝，桌面缩放后可看 | 已知差异如实记录（§2.2-5），mao-cli 文档注明；错误文案沿用「文件过大，移动端暂不支持查看该文件」；不为此引入图片处理依赖 |
| 服务端把 workspace 指向 `/` 让 CLI 全盘浏览（信任边界绕过） | D5 双层防护：resolveWorkspace 收窄（信任根外拒）+ containment；与 tool_execute / skill sync 同款不变量，spec 覆盖 |
| CLI 与桌面 containment 口径漂移（renderer 词法 vs Node path.resolve） | D6：两端单测覆盖同一组向量（.. 逃逸 / 绝对越界 / 盘符 / 根退化 / 大小写 fail closed），文件互指注释 |
| 大文件 / 大图回帧超 WS maxPayload 断连（影响整个会话流） | 700KB UTF-8 字节预检（Buffer.byteLength，语义与桌面 TextEncoder 一致）；spec 覆盖中文长文本临界 |
| REPL 非当前会话的文件请求被丢弃 → 服务端超时报错 | 与 tool_execute 同口径（D7）：请求已送达 REPL 连接但被 acceptEvent 本地丢弃，服务端按已投递等待，15s / 30s 后回「执行端设备响应超时（X 秒），请稍后重试」；CHANGELOG / mao-cli 文档注明「交互模式仅当前会话可被远程浏览，跨会话请用 local --serve」 |
| daemon 长驻进程 fs 异常（权限 / 竞态删除） | executeFileOp 永不抛错、全部收敛失败帧；executor 统一 catch 兜底；fs 用 fs/promises，不阻塞事件循环（心跳 / tool_execute 同连接复用） |
| 旧后端 + 新 CLI | 旧后端忽略 auth 未知字段；旧后端无文件代理，不产生 file_op_request，无交互 |
| 新后端 + 旧 CLI | 档 4 cliOnly 升级提示（即时、准确） |
| 桌面 auth 加 capabilities 引入回归 | 行为不变（legacy 档 3 → 显式档 1，同为 delivered）；desktop auth spec 补断言；发布顺序 backend → desktop → mao-agent（11-17 §8 同约束） |

## 7. 测试要点

**后端（`cd backend-ts && npm test`）**

1. `streaming-ws-registry.spec.ts` 投递矩阵：electron 显式声明 / cli 显式声明 / electron legacy（未声明，视为可投递）/ cli legacy → cliOnly / 全部显式声明但均缺 `file_op` → noCapable / 无连接 → offline / 同机组合三例（新桌面 + 新 CLI → electron；11-17 桌面 legacy + 新 CLI → cli；旧桌面 + 新 CLI → cli，不投 legacy electron）/ 旧连接断开清理 capability。
2. `streaming-ws-auth.spec.ts`：auth 帧 `capabilities: ['file_op']` → register 收到能力集；非法形状（非数组 / 含非字符串项 / 含 trim 后空串 / 超 16 项）→ 空集且连接可用（整体判非法）；缺失 → 空集；重复项去重。
3. `remote-file-proxy.service.spec.ts`：cliOnly 新文案；noCapable 文案；既有用例（正常往返 / 离线 / 未绑定 / 超时 / failAllForSocket / 归一化）不回退。

**agent-cli（`cd agent-cli && npm run build && npm test`）**

4. `test/local-file-ops.spec.ts`（新）：四 op 对 tmp 目录逐字段断言（entries 排序 / 500 条与 truncated 原始计数口径 / read 三态：图片 data_uri + PDF + 文本行窗口 / total_lines / files 剥 mtime 与遍历早退收集语义 / search 仅排除 `.git`、`node_modules` 且默认 100 / IGNORED_DIRS / 隐藏文件）；containment 向量（`..` / 绝对越界）；图片超 700KB 回「文件过大」（CLI 不缩放差异锚定）；`{ error }` 收敛；700KB 预检（中文长文本超限回友好错误、错误帧远小于上限）；未知 op 回失败帧。
5. `local-executor.spec.ts` / `local-daemon.spec.ts` 扩展：handleEvent `file_op_request` 成功 / 失败 / 信任根外回帧（resolveWorkspace 拒绝文案，sendReliable 载荷形状）；缺 requestId 静默忽略；catch 兜底失败帧；daemon 路由含 file_op_request 且计入 fileOpCount。
6. `session-runner.spec.ts` 扩展：REPL 对当前订阅会话的 file_op_request 路由到 executor；非订阅会话被 acceptEvent 丢弃（同 tool_execute 口径回归）。
7. `ws-client.spec.ts` 扩展：auth 帧含 `capabilities: ['file_op']`（既有断言在 :50-71，扩展即可）。

**桌面（`cd desktop && npm run build` + `npm run test:unit`）**

8. auth 帧断言：Electron 带 `capabilities: ['file_op']`、浏览器不带（桌面测试文件为 `.test.ts` 命名，扩展既有 `useStreamWS.device-auth.test.ts` 的 FakeWebSocket 骨架）；`vue-tsc -b` 全量构建。

**手工联调（必须）**

9. `mao-agent local --serve` 常驻 + CLI 创建 LOCAL 会话：移动端打开文件 Tab → 树展示设备真实文件；展开 / 筛选 / 打开文本文件 / 小图预览（大图出「文件过大」，CLI 不缩放差异）/ `@` 引用面板全部可用。
10. REPL 坐在目标会话时同样可用；REPL 切到其它会话 → 服务端超时文案（语义按 D7 记录，不算 bug）。
11. 旧版 mao-agent（不升级）→ 移动端立即出升级提示（不白等）；升级后恢复。
12. 桌面端全链路回归：本机 / 双机互看 / 移动端浏览桌面绑定会话，行为与 11-17 版本一致。

`scripts/agent-cli-e2e.sh` 不新增 file op 场景（该链路依赖移动端 / 浏览器 UI 与真机 fs，手工联调覆盖即可）。

## 8. 发布与文档

1. **发布顺序**：先 backend-ts（能力解析 + 分层投递就绪，旧 CLI 走档 4 升级提示），再 deploy-desktop.sh（auth 声明，1 行），最后发 mao-agent（npm 发布；用户升级后才真正解锁）。
2. **CHANGELOG**（`changelog/unreleased/`）：后端——文件代理投递按客户端能力分层，旧版 CLI 即时返回升级提示；终端 CLI（mao-agent）——`local --serve` 与交互模式支持远程文件浏览（只读），旧版收到明确升级提示。桌面 auth 帧 1 行能力声明无用户可见行为变化，按 AGENTS.md 口径可不记。
3. **mao-cli 文档**：`reference/desktop.md` LOCAL 段（CLI 设备支持远程浏览）+ `reference/mao-agent.md`（daemon 能力面 + 版本要求）。
4. **回滚**：代码回滚即可；无 DDL、无契约变更；旧 CLI 在新后端下回到升级提示文案（不悬挂）。

## 9. 开放问题（不阻塞主链路）

1. **REPL 非当前会话的接管口径**：D7 跟随 tool_execute；若用户反馈「REPL 开着 A 会话、移动端浏览 B 会话报设备无响应」困惑，可评估 file op 放宽为「设备级接管」（REPL 内 executor 独立于会话订阅）——需先确认 REPL 多会话并存时 executor 实例与信任根的归属，另行小方案。
2. **IMAGE_EXTENSIONS / IGNORED_DIRS 双端漂移**：图片扩展名表 CLI 侧已有先例（`local/tools/files.ts:8-14` 的 `IMAGE_EXT`，file-ops 直接复用）；`IGNORED_DIRS` 十二目录 CLI 侧需新增（镜像 main.cjs:2215，仅 files op 用）。三端各自维护；若后续频繁增改，可评估下沉 `@mao/contracts` 或共享 cjs vendor（现有 `sync:shell` 脚本先例）。
3. **CLI 的 bytes op**（与桌面 P2 同批）：二进制远程传输方案（分块 / 设备 HTTP 直报）定案后，CLI 与桌面一起实现，CLI 侧无额外障碍。
4. **设备能力展示**：管理后台在线设备页可展示各连接能力集（file_op 等），便于排查「为什么浏览不了」；纯展示，P3。
5. **同机 REPL + daemon 并存的档 2 命中不确定**：分层投递按连接枚举序取首条命中，服务端无法区分 `--serve` 与交互 REPL 的声明；REPL 先连时档 2 可能命中 REPL，而 REPL 对非订阅会话按 D7 静默丢弃 → 服务端超时（daemon 存活本可服务）。候选方向：daemon auth 帧声明区分性能力（如 `file_op_daemon`）或档内优先 deviceExecutors 执行槽。实施评审（2026-11-18）记录，未在本期处理。
6. **CLI search 与桌面的两处口径差异**（评审记录）：CLI 无「每目录 500 条」上限（桌面经 listDirectory 间接继承并忽略其 truncated 标志）、结果 path 恒 `/` 分隔（桌面继承 path.relative，Windows 为反斜杠）——file-ops.ts 文件头已互指注释；CLI 结果更完整，显示层差异，可接受。
7. **>5MB 图片的回帧形态差异**：CLI 走 readImage 错误文案（含「请先本地压缩或裁剪」），桌面 readLocalImage 同分支也是文本错误帧——两端帧形态一致但文案不同，mao-cli 文档已按「大图提示文件过大」概括。
