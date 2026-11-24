# 输入草稿刷新后保留技术方案

- 状态：待实现
- 日期：2026-11-24
- 一句话：会话输入框草稿继续只留在本机，刷新或重新打开页面后文字、回复引用和待发附件都还在。预览用恢复出来的文件字节重新生成。
- 关联代码（撰写时已核实，均为当前工作区）：
  - 内存草稿：`desktop/src/stores/draft.ts`（`DraftEntry` 含 `html` / `text` / `files` / `quotes`；`files` 持有 `File` 与 `previewUrl`，LOCAL 另有 `localPath`）
  - 保存时机只在切键、显式 `saveDraft` 和卸载：`desktop/src/components/chat/ChatInput.vue` 的 `buildCurrentDraft`（约 581 行）、`watch(draftKey)`（约 627 行）、`onBeforeUnmount`（约 1149 行）。`onUpdate`（约 573 行）不写草稿
  - 待发列表运行时还有 `originalFile`（再次标注用原图），类型 `DraftEntry` 未声明，靠对象展开留在内存里：`ChatInput.vue` 约 314、707、729、792 行
  - 草稿键：主会话 `s:{sessionId}`、新建任务 `new`（`ChatPanel.vue` 约 549 行）。边路当前把 `:draft-key` 设成 `tabId`（`SideChatPanel.vue`）。本页新建的边路 Tab 在会话转正后 **不改** `tab.id`（`useCenterTabs.ts` 的 `updateSideTaskTab`，占位 id 为 `side:0`）；刷新后 `restoreSideTaskTabs` 用 `side:{realSessionId}` 重建。两条键不是同一个。面板里已有 `realSessionId`（约 338 行；`props.sideSessionId` 的 watch 约 698 行在转正时赋值）
  - 清除：发送成功 `clearDraft`（`ChatPanel.vue` 约 815、828 行；`SideChatPanel.vue` 约 1002、1158 行，键是 `props.tabId`）；删除会话只清 `s:{id}`（`desktop/src/stores/session/list.ts` 约 819 行）；删除或升级边路任务只清 `tab.id`（`TaskView.vue` 约 1142、1169 行）；登出 `reset()`（`desktop/src/stores/auth.ts` 的 `clearLocalSession`，约 64–74 行，且先把 `user` 置空）
  - 用户身份在进主界面前可用：`desktop/src/router/index.ts` 约 222–229 行，`fetchUserInfo()` 返回后才 `next()`。`ProfileView` 也会再调 `fetchUserInfo()`。`User.id` 为 number（`auth.ts` 约 11–20 行）
  - 附件上限 10（`desktop/src/components/chat/pasted-text-file.ts` 的 `MAX_PENDING_ATTACHMENTS`）。单文件大小走 `getUploadConfig()`，失败时前端回落 1024MB（`desktop/src/utils/storageMode.ts` 约 28–30 行）
  - LOCAL 无 `localPath` 的文本附件发送时把内容交给主进程写入：`desktop/src/utils/chatLocalAttach.ts` 约 43–54 行。图片走 `File` 字节上传，非图片 LOCAL 走 `localPath` 拷贝
  - 生产桌面端主窗口加载的是配置的服务器地址（`desktop/electron/main.cjs` 的 `loadMainContent`），与 Web 同一 origin。`file://` 只用于未配置服务器时的本地选择页，那一页没有会话输入框。`auth-storage.ts` 里「file:// 下 localStorage 不可靠」不覆盖这条路径
  - 单测环境是 Node，没有 `indexedDB`：`desktop/vitest.config.ts` 的 `environment: 'node'`。仓库内尚无 IndexedDB
- 关联方案：[2026-08-21 会话输入框草稿绑定](../2026-08/2026-08-21-session-bound-draft-design.md)。该方案规定只做内存缓存，刷新丢失是当时的预期。本方案只改这一条：仍不上传服务端、仍不多端同步，改为本机 IndexedDB。切会话、发送清除、删除清除的语义保持不变；登出仍清内存，但本机库按用户留下，以便同一浏览器再登录恢复（见 D10）。

## 1. 现状与问题

切会话能留住草稿，是因为页面没卸载，Pinia 里的 `Map` 还在。刷新会重新加载前端，这块内存消失。

停在当前会话直接刷新，还有第二层丢失：正文不是每个按键都进 `Map`。`onUpdate` 只更新 `editorContent`。写入发生在草稿键变化、回复引用 / `@` 文件引用插入、以及 `onBeforeUnmount`。浏览器刷新不保证跑完 Vue 的卸载钩子，所以当前输入框里最新的字经常从未进过 store。

`blob:` 地址绑在当前文档上，刷新后必定失效。待发内容里真正要留下的是 `File` 字节。剪贴板图片、粘贴生成的文本文件、标注后的图片都没有本机路径，只存在 `File` 里。LOCAL 从磁盘选来的非图片文件已经把绝对路径抄进 `localPath`（`File.path` 与 `webUtils.getPathForFile`），发送时按这条路径拷贝。

`localStorage` 放不下这件事：只能存字符串，配额大约 5MB，也不能保存 `File`。草稿键是 `s:{sessionId}` / `side:{id}` / `new`，而 `sessionId` 是服务端自增数字。`auth.ts` 已写明同机换号会撞 ID。落盘若不按用户分开，后一个账号会看到前一个账号的草稿。

边路还有第三层：页内草稿键是占位 `tab.id`（`side:0`），刷新后重建出来的是 `side:{realSessionId}`。只把 `tab.id` 原样写入库，转正过的边路草稿刷新后对不上输入框。

## 2. 目标与非目标

### 2.1 目标

1. 刷新页面、重新打开标签、Electron 重启后，同一浏览器（同一 origin）上该用户的输入草稿还在：正文（含快捷指令、`@` 文件引用等 TipTap HTML）、回复引用、待发图片和文件。
2. 图片预览在恢复后可见。用恢复出来的字节重新 `URL.createObjectURL`。
3. 标注过的图片刷新后仍可基于原图再标一次（`originalFile` 一并留下）。
4. LOCAL 已记录的 `localPath` 刷新后仍在，发送继续按路径拷贝。没有路径的文本附件仍走现有的内容内联写入。CLOUD 上传继续使用 `File` 字节。
5. 切会话、发送成功清除、删除会话 / 边路任务清除，与现在一致，并且库里的记录一起删掉。登出、401 只清内存；该用户的库记录保留，同一浏览器再登录仍能恢复。换号看不到对方的草稿。
6. Web、Electron、安卓壳（Capacitor 远程加载同一套前端）同一条路径，无平台分支。

### 2.2 非目标

- 不上传草稿，不做多设备、多浏览器同步。
- 不把 `blob:` 字符串本身存下来。刷新后的预览是新的对象 URL。
- 不改发送、上传、`~/.mao/attachments` 拷贝。恢复出来的就是普通 `File` 加已有的 `localPath`。
- 不持久化光标位置，不加会话列表「有草稿」角标。这两条维持 2026-08-21 的决定。
- 不改后端、admin、安卓原生、mao-cli。
- 不引入运行时依赖。IndexedDB 用浏览器原生 API。
- 不在画中画、主窗口、多个浏览器标签之间做实时广播。两边同源时共用一个库，后写的覆盖先写的。
- 不保留「还没创建成功」的边路占位草稿。占位 Tab 刷新后不会重建，占位键只留在当页内存。
- 不加密本机草稿。与当前页面同源的脚本可以读到 IndexedDB，和这个 origin 上的其他本机数据同一暴露面。

## 3. 决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 存哪里 | 本机 IndexedDB，库名 `mao-drafts`，版本 1 | `File` / `Blob` 可以被结构化克隆。Chrome、Electron（服务器 origin）、安卓 WebView 读回后仍是带文件名、MIME、`lastModified` 的 `File`；读回成 `Blob` 或 `type` 为空时用 meta 包一层。按 origin 隔离，换服务器天然隔离。生产 Electron 不在 `file://` 上跑会话页 |
| D2 | 和内存的关系 | 内存 `Map` 仍是当前页的同步来源。切会话继续先读内存。IndexedDB 是刷新后的来源 | 切会话不能改成每次都等数据库。现有 `getDraft` 同步语义保留 |
| D3 | 记录怎么拆 | 两个对象仓库：`metas` 只放文本和附件描述，`blobs` 放字节 | 启动时把该用户全部 `metas` 读进内存。字节只在恢复某一条、或写入变化的附件时读写。避免打开应用就把所有会话的大文件读出来 |
| D4 | 键 | 主键 `[userId, draftKey]`。主会话 `s:{id}`，新建任务 `new`。边路一旦有正数 `sideSessionId`，库键和输入框键都是 `side:{sideSessionId}`，不再用占位 `tab.id` | `userId` 挡换号撞会话 ID。占位 `tab.id`（`side:0`）刷新后对不上重建 Tab。删除时两个可能的键都清 |
| D5 | 正文何时落库 | 进入内存后按键防抖 300ms 再写 `metas`。切键、卸载、引用插入、`visibilitychange`（变为 hidden）、`pagehide` 时立刻冲刷 | 停在当前会话刷新，也必须已经写过。卸载钩子在刷新时不可靠。`visibilitychange` 时页面还活着，安卓切到后台主要靠它。`pagehide` 只兜最后一瞬，且必须在已经打开的库上同步发起事务，前面不能再 `await`。`pagehide` 不清内存（往返缓存恢复时堆还在） |
| D6 | 附件何时落库 | 加入、删除、标注替换时立即写对应 `blobs` 并更新 `metas`。正文防抖重写时，附件指纹没变就不重写字节 | 大文件不能绑在按键上。加入动作本身已经是一次明确提交 |
| D7 | 预览 URL | 不入库。恢复时 `type` 以 `image/` 开头则 `createObjectURL(file)`，否则 `previewUrl` 为 `''` | `blob:` 跨文档无效。非图片今天就没有预览 |
| D8 | `originalFile` | 与当前 `file` 不是同一引用时单独存一条 blob。恢复后挂回 `originalFile`。没有原图 blob 时，`originalFile` 与 `file` 设为同一引用 | 现在只在内存展开里顺便存在。不存的话刷新后只能在标注结果上继续画。同一引用才能继续满足「只在标过之后才多存一份」 |
| D9 | `localPath` | 作为附件描述里的字符串入库。不依赖 `File.path` | Electron 的 `File.path` 不在结构化克隆里，刷新后一定丢。添加时已经抄进 `localPath` |
| D10 | 用户范围与登出 | 读写都带 `authStore.user.id`。登出和 401 先冲刷该用户内存里的草稿，再 `reset()` 只清内存，**不** `deleteUser` | 换号靠主键隔离，hydrate 只加载当前用户。手工预期是登出再登回，草稿还在。登出时删库会直接打掉这条。`deleteUser` 只留给适配层测试，不接到登出 |
| D11 | 容量 | 每用户最多 30 条草稿；全部 blob 合计上限 200MB。超出时按 `updatedAt` 从旧到新删整条（meta + 其 blobs），跳过正在编辑的键和 `filesLoading` 的键。只剩受保护的键时停止，即使它们自己超过 200MB。写入失败时删一条最旧的不受保护草稿并重试一次；仍失败则这条只留文字，附件不入库，并提示一次 | 单文件可以到上传配置的几十甚至上百 MB，继续删「其他条」会停不下来。正在恢复字节的键被删掉，恢复会读到空 |
| D12 | 灌入时机 | `fetchUserInfo` 成功并写入 `user` 之后 await `hydrate(user.id)`，再让路由 `next()`。失败不阻断进页。重复调用（个人资料页再拉一次 `/users/me`）不得覆盖当页已有内存，也不得重启进行中的附件恢复 | 路由守卫已经在等 `/users/me`。此时还没有 `ChatInput`，灌完后现有 `onMounted` → `restoreDraft` 仍能同步拿到文字。读的是不含字节的 meta |
| D13 | 竞态 | 每个键最多一个在飞的 `writeMeta`，写完再看这个键还要不要再写。代数只用来判断「这一次写完时，内存是不是已经变了」 | 见第 6 节。写完发现代数变了就「不再处理」，会把先发出的旧内容留在库里，盖住后发出的新内容，或在删除之后把草稿写回去 |
| D14 | 测试双端 | store 依赖一个窄接口 `DraftPersistence`。生产用 IndexedDB 实现；单测注入内存实现。不增加依赖。无持久化实现时 `setDraft` 不启动定时器 | Vitest 跑在 Node，没有 `indexedDB`。现有 `draft.test.ts` 不触碰持久化也必须继续通过，不能留下跨用例的定时器 |
| D15 | 边路占位键 | `side:` 后面不是正整数的键（当前是 `side:0`）只放内存，不写库。`realSessionId` 从非正数变成正数时，同步把内存条目搬到 `side:{id}`，下一拍再删掉占位键 | 占位 Tab 刷新后不存在，落库没有读者。转正后的键必须在子组件 `watch(draftKey)` 把编辑器写回占位键之前就位，否则恢复会把输入框清空 |

## 4. 行为契约

| 事件 | 内存 | 本机库 |
|---|---|---|
| 输入文字、改富文本 | 立即 `setDraft`（防抖只作用于库） | 300ms 后写 `metas`。附件指纹未变则不动 `blobs` |
| 插入或删除回复引用、插入 `@` 引用 | 沿用现有立即 `saveDraft` | 立即写 `metas` |
| 添加、删除、标注替换附件 | 立即 `setDraft` | 立即写变化的 blob，并更新 `metas`。`filesLoading` 期间输入框不接受新附件 |
| 切换会话 / 新建任务 / 边路 tab | 先存旧键，再恢复新键（现状） | 旧键立刻冲刷。新键若本页已加载过字节，同步恢复；否则先上文字，再读 blob |
| 边路占位转正 | 条目改挂到 `side:{realSessionId}`，随后删除占位键 | 只写 `side:{realSessionId}`。占位键从未入库 |
| 刷新、重新打开 | 进程内存为空 | 启动时灌入 `metas`；打开该输入框时读 blob，生成新的预览 URL |
| 切到后台、刷新前的 `pagehide` | 保持不动 | 冲刷所有已到期未写的文字。库必须事先打开 |
| 发送成功 | `clearDraft(目标键)`（现状） | 取消该键未发出的防抖，删除 meta 和 blobs。在飞的旧写返回后若内存已无此键，再删一次 |
| 发送失败 | 保留（现状） | 保留 |
| 删除会话 | `clearDraftAndMark('s:'+id)`，并同样清除 `side:{id}` | 两个键的库记录都删。晚到的卸载保存仍被 `clearedKeys` 挡住 |
| 删除或升级边路任务 | `clearDraftAndMark(tab.id)`，若 `sideSessionId > 0` 再清 `side:{sideSessionId}` | 同上。占位 id 与稳定 id 不一致时两个都清 |
| 关闭边路 tab 但不删任务 | 保留（现状） | 保留稳定键。再次打开 `side:{realSessionId}` 时恢复。占位阶段关掉再刷新：Tab 本身不会重建，草稿不保留 |
| 登出、401 清本地会话 | `reset()` | 先把当前内存冲刷进该用户的库，再清内存。不删库 |
| 草稿变为空（无文字、无引用、无附件） | 删除条目（现状） | 删除该键的 meta 和 blobs。`filesLoading` 期间编辑器里还没有附件，不算空 |
| 库写入失败 | 当前页内存草稿仍在 | 文字尽量留下。附件写失败时提示「草稿附件未能保存，刷新后将丢失」，同一次页面生命周期内只提示一次 |
| 附件字节读失败 | 文字先显示 | 缺的那一个附件从列表去掉，其余保留。提示「草稿附件未能恢复」，同一次页面生命周期内只提示一次 |
| 超过 30 条或 200MB | 当前键与正在恢复的键保留 | 删最旧的其他草稿。单条自身超过 200MB 时放弃该条的新字节，只留文字 |

恢复后的发送与今天相同：

- 图片：`file.type` 以 `image/` 开头，走现有上传。
- 非图片且 `localPath` 非空：LOCAL 按路径拷贝。源文件已被挪走时，失败提示与现在不刷新直接发送相同。
- 非图片且 `localPath` 为空、类型是文本：走 `writeInlineTextAttachment`。
- 非图片、无路径、又不是文本：仍是「无法获取文件路径」。刷新不把这类文件变成可发送。

工作区 `@` 引用只是编辑器 HTML 里的节点，不是待发 `File`。随 `html` 留下。引用的文件若在刷新前被删，表现与今天切会话再切回来相同。

## 5. 数据模型

库 `mao-drafts`，`version = 1`。应用启动、`hydrate` 之前就把库打开并缓存 `IDBDatabase`。`pagehide` 里不再 `open`。

### 5.1 `metas`

主键：`[userId: number, draftKey: string]`。索引：`byUser`，键为 `userId`。

```ts
interface DraftMeta {
  userId: number
  draftKey: string
  html: string
  text: string
  quotes: Array<{ id: string; text: string; truncated: boolean }>
  files: DraftFileMeta[]
  updatedAt: number
}

interface DraftFileMeta {
  blobId: string
  name: string
  type: string
  size: number
  lastModified: number
  localPath: string
  /** 有原图且与当前文件不是同一引用时才存在 */
  originalBlobId?: string
  originalName?: string
  originalType?: string
  originalSize?: number
  originalLastModified?: number
}
```

`blobId` 用 `crypto.randomUUID`（经现有 `generateUUID`，避免非安全上下文下 `crypto.randomUUID` 缺失）。不用「用户 + 草稿键 + 下标」当 blob 主键：删掉中间一个附件时，下标会错位，容易删错或留下孤儿。

### 5.2 `blobs`

主键：`blobId`。值：`Blob`（写入时直接放 `File`）。读回后若不是带非空 `type` 的 `File`，用 meta 里的 `name` / `type` / `lastModified` 再 `new File([blob], name, { type, lastModified })` 包一层。

另建索引 `byOwner`：`[userId, draftKey]`，删草稿时按属主删字节。blob 记录上冗余这两个字段，索引才能查。

某个 `blobId` 读不到：跳过这一份附件，其余照常恢复，并把 meta 更新成剩下的列表，避免每次刷新都读一个不存在的 id。

### 5.3 指纹与上一份 meta

附件未变化则跳过 blob 重写。比较对象是这个键 **上一份成功落库（或 hydrate 读到）的 `DraftFileMeta[]`**，不是一份刷新后就丢的指纹缓存。store 里按键记下这份列表。

某一槽位的指纹：

```text
name + '\0' + size + '\0' + lastModified + '\0' + localPath
  + '\0' + (original 的同样四段，没有原图则空)
```

槽位按顺序对齐。指纹相同则沿用该槽位的 `blobId`，不把 `File` 放进本次 `BlobPut`。指纹不同或这一槽是新的，分配新 `blobId` 并写入字节。上一份里没有被沿用的 `blobId`（含 `originalBlobId`）在同一次事务里删除。这样刷新后第一次按键不会把全部附件当成新文件重写，也不会把旧字节留成孤儿。

两份附件指纹完全相同（同名、同大小、同时刻）时仍按槽位各留各的 `blobId`，不合并成一条 blob。

### 5.4 空草稿

与 `draft.ts` 的 `isEmptyDraft` 同一口径：无有效文字、无引用、无附件，则删除 meta 与其 blobs，不留空记录。只剩 TipTap 空段落 `<p></p>` 也算空。`filesLoading` 期间判定空与否时，附件算 hydrate 到的那份 meta，不算编辑器里尚未填上的空数组。

## 6. 写入、删除与竞态

持久化不散落在各个调用点。`setDraft`、`clearDraft`、`clearDraftAndMark`、`rekey`、`reset` 在更新内存之后通知 store 内的调度器。`ChatInput` 仍只认识 store。调度状态（代数、定时器、在飞的写、上一份 meta）放在 store 实例里，随 `reset()` 清掉，不放模块单例。

```ts
interface DraftPersistence {
  loadMetas(userId: number): Promise<DraftMeta[]>
  /** 读一组 blob。缺失的 id 不在结果里，不抛 */
  loadBlobs(ids: string[]): Promise<Map<string, Blob>>
  writeMeta(meta: DraftMeta, blobs: BlobPut[], deleteBlobIds: string[]): Promise<void>
  deleteDraft(userId: number, draftKey: string): Promise<void>
  deleteUser(userId: number): Promise<void>
}

interface BlobPut {
  blobId: string
  userId: number
  draftKey: string
  blob: Blob
}
```

`setDraft(key, entry, mode)` 的 `mode`：`'debounce'`（按键）或 `'now'`（切键、卸载、引用、附件、冲刷）。缺省按调用点分：`onUpdate` 用 `'debounce'`，现有 `saveDraft` 用 `'now'`。

调度规则：

1. 内存更新是同步的，和现在一样。调用方不 `await` 数据库。占位边路键（`side:` 后不是正整数）到此为止，不排队写库。
2. 每个 `draftKey` 一个代数，从 0 起。每次 `setDraft`、`clearDraft`、`clearDraftAndMark`、`rekey` 都让该键 `++`。另有一个「在飞」标记，同一键不会有两个 `writeMeta` 同时进行。
3. 文字防抖：`'debounce'` 只重置 300ms 定时器。定时器触发或 `'now'` 时取当时内存和代数 `rev`。若已有在飞的写，只把「待再写」标上，不再开第二条事务。
4. 在飞的写 **返回之后** 看这个键：内存里已经没有它（清除、变空、rekey 走了）就再 `deleteDraft` 一次；还有，且代数不是这次的 `rev`，立刻用 **当前内存** 再写一次（这就是被盖住的新内容）。代数没变才把这次的 `DraftFileMeta[]` 记成上一份。不允许「代数变了就什么也不做」——旧事务已经提交，不补写就会留在库里。
5. 附件变化走 `'now'`，并只把指纹变了的槽位放进 `blobs`，被换掉的 `blobId` 放进 `deleteBlobIds`。与 meta 同一次读写事务。
6. `clearDraft` / `clearDraftAndMark`：取消定时器，内存删键，立刻 `deleteDraft`。在飞的旧写靠第 4 步再删一次，防止它晚于删除提交、把草稿写回去。`clearDraft` 不加 `clearedKeys`。
7. `rekey(from, to)`：把 `from` 的内存条目复制到 `to` 并 `++` 两边代数；`from` 若是占位键则没有库记录。`to` 安排一次 `'now'` 写。调用方在子组件处理完 `draftKey` 变化之后再 `clearDraft(from)`（见第 8 节）。
8. `flushAll()`：对当前用户内存里每一个可落库的键做一次 `'now'`，并等待已经发起的事务结束。`pagehide` / `visibilitychange` 不能依赖这个 await：事件回调里同步对已打开的库发起事务，然后返回。
9. 登出：在 `user` 和内存草稿都还在时 `await flushAll()`，然后现有的 `reset()` 只清内存和 `clearedKeys`。不调用 `deleteUser`。`user` 尚未拉到时没有可写的 `userId`，只清内存。
10. 写库失败则内存不变。带新字节的失败先按 D11 删一条最旧的不受保护草稿并重试一次；仍失败则用同一份文字重写 meta、文件列表为空，并提示一次。不限于 `QuotaExceededError`，事务中断同样走这条。
11. 容量裁剪放在成功写入之后：数 `byUser` 的条数，blob 字节用 meta 里的 `size`（含 original）相加，不读 blob。超限则删最旧且不是「正在编辑或 `filesLoading`」的记录。已经没有可删的键就停止。

`clearedKeys` 继续只防「删除之后卸载钩子又 `saveDraft`」。它不代替代数。

跨标签：不做版本比较。后提交的事务覆盖先提交的。隐藏标签里尚未冲刷的 300ms 也可能在切后台时写进去，从而盖住另一个标签刚写的内容。接受这个窗口，不在本方案里做跨标签锁。

## 7. 启动灌入与恢复

`fetchUserInfo` 成功、`user` 已赋值之后 `await draftStore.hydrate(user.id)`：

- 库已经打开。只 `loadMetas`。结果放进 store 内的 meta 表，不放进持有 `File` 的内存 `Map`。同时把每条 `files` 记成该键的「上一份 meta」。
- 同一键若内存 `Map` 已有条目，或该键正处于 `filesLoading`，保持内存和这次恢复，不用库覆盖。
- 并发的第二次 `hydrate` 等第一次，不并行读。
- 抛错或单条 meta 缺字段、类型不对：跳过坏条，记日志，进页继续。全部失败则这次访问退化为今天的纯内存草稿。
- `user.id` 不是 number 时不灌入，退化为纯内存，避免 `[1, key]` 与 `["1", key]` 分成两套。

`ChatInput.restoreDraft` 在现有逻辑上加一条库路径：

1. 内存 `Map` 有该键：完全走今天的同步恢复。
2. 只有 meta：立刻 `setContent(html)`、恢复 `text` 和 `quotes`。编辑器先不要放附件。store 把该键标成 `filesLoading`。这一步触发的 `onUpdate` 只更新文字和引用，写入时附件列表仍用 meta 里那份，不把空数组写回库，也不要因为编辑器暂时没有附件就把这条当成空草稿删掉。
3. 比较基准不要用「meta 里的 html 字符串是否等于 `getHTML()`」。`setContent` 会把 HTML 规范化，字符串经常对不上，用来判断会把附件丢掉。附件是否还该回填，只看：当前 `draftKey` 仍是这一键，且 store 里这次 `filesLoading` 没被取消。
4. 异步 `loadBlobs`。读完且第 3 步仍成立：写入 `pendingFiles`，按 D7 生成 `previewUrl`，按 D8 挂 `originalFile`，`localPath` 用 meta 里的字符串，然后把完整条目放进内存 `Map`，清掉 `filesLoading`。生成的 URL 归这条草稿所有，沿用现有「随草稿转移、有草稿则卸载不 revoke」的规则。
5. `filesLoading` 期间不接受新的附件（文件选择、粘贴文件、拖入文件直接返回）。文字、回复引用、`@` 引用照常。附件芯片等字节回来再出现。读库超过 1 秒时，附件区显示「正在恢复附件」，不阻塞文字。
6. 此期间切走或该键被清掉：取消回填，不为这批字节创建预览 URL。已输入的新文字按第 2 步写 meta。切回来时内存 `Map` 仍没有字节，再读一次库。
7. meta 和内存都没有：清空编辑器，与今天一样。

同一页里某键的字节一旦进了 `Map`，再切回来不再读库。

## 8. ChatInput 的保存时机与边路键

现有切键保存、卸载保存、`clearInput` 清草稿保留。切键和卸载走 `'now'`。

新增：

- `onUpdate` 里对当前 `draftKey` 调用 `setDraft(..., 'debounce')`。富文本节点的变化走 `getHTML()`，与现在 `buildCurrentDraft` 一致。`filesLoading` 时这次写入不带编辑器里的空附件列表。
- `addPendingImage`、`addPendingFile`、`removePendingFileAt`、`handleAnnotateConfirm` 在列表改完后立即 `saveDraft`（`'now'`）。大小校验失败把条目删掉时，删除路径会再存一次。`filesLoading` 期间这些入口直接返回。
- 冲刷监听挂在 draft store 上，只注册一次：`visibilitychange` 且 `document.hidden`，以及 `pagehide`。冲刷所有待写的键，而不是只冲当前这一个输入框。`pagehide` 里同步发起事务。不要在 `pagehide` 里清内存或 `revoke` 预览 URL。
- `buildCurrentDraft` 的 `files` 正式带上 `originalFile`。`DraftEntry` 补这个可选字段。

边路输入框的草稿键改为：

```ts
const draftKey = computed(() =>
  realSessionId.value > 0 ? `side:${realSessionId.value}` : props.tabId,
)
```

`SideChatPanel` 里发送成功的 `clearDraft` 使用这个 `draftKey`，不再用 `props.tabId`。占位阶段 `tabId` 与 `draftKey` 相同，行为与现在一致。

转正发生在已有的 `watch(() => props.sideSessionId)` 里，`realSessionId.value = newId` **之前**同步调用 `draftStore.rekey(props.tabId, 'side:' + newId)`。这样子组件跟着 `draftKey` 变化先存旧键、再恢复新键时，新键上已经有条目，编辑器不会被恢复成空。`rekey` 复制之后，子组件的 `saveDraft(占位键)` 会把占位键再写进内存；父组件在 `nextTick` 里 `clearDraft(占位键)`。占位键不入库，这次清除只打内存。创建成功这一下 `setContent` 会把光标移到文末，接受这一次。

`TaskView` 删除或升级边路任务时，除了现有的 `clearDraftAndMark(tab.id)`，在 `sideSessionId > 0` 时再 `clearDraftAndMark('side:' + sideSessionId)`。`deleteSession` 在清 `s:{id}` 之外同样清 `side:{id}`：边路草稿不在 `s:` 下面，只清一个键会在库里留下没有入口的附件。不递归清子会话；子会话还在，草稿就还在。

不改发送清除的时序（先确认保存成功，再按发送前捕获的键清除）。捕获的键改成上面的稳定 `draftKey`。

## 9. 容量、失败与换号

- 30 条、200MB 只在写入成功后的裁剪里执行，读路径不删数据。受保护集合是：这次写入的键，加上 store 里所有 `filesLoading` 的键。没有可删对象时停止，不空转。
- 单条草稿的字节超过 200MB：不要求把它裁进额度。这次写入改成只留文字，并走一次附件失败提示。
- 写入失败：删最旧的一条不受保护草稿，重试本次写入一次。仍失败则 meta 不带附件，内存里的 `File` 保留到本次页面关闭。提示文案固定为「草稿附件未能保存，刷新后将丢失」，模块级标记保证只出现一次。
- 读 blob 失败：提示「草稿附件未能恢复」，模块级标记只出现一次。文字照常恢复。
- 损坏的 meta（缺字段、类型不对）跳过该条，不抛到路由守卫外面。
- 登出不删当前用户的库记录，也不删其他 `userId`。同一浏览器下一个账号 hydrate 不到这些行。再登回原账号看得到。
- 无痕窗口里 IndexedDB 会随会话丢掉。不额外提示。安卓 WebView 在系统压力下也可能清掉该 origin 的存储，表现与库打开失败相同：这次变成纯内存，不额外做一套存储。
- 不迁移 2026-08-21 之前的数据：旧实现没有落盘，没有旧库可迁。

## 10. 实现步骤

1. 新增 `desktop/src/stores/draft-persist.ts`：打开并缓存 `mao-drafts`；`loadMetas`、`loadBlobs`、单事务 `writeMeta`、`deleteDraft`、`deleteUser`。`indexedDB` 不存在时导出空实现。
2. 改 `desktop/src/stores/draft.ts`：补 `originalFile`；防抖、代数、单键串行、hydrate、上一份 meta、`filesLoading`、`rekey`、`flushAll`、容量裁剪。占位边路键不写库。无持久化实现时不启动定时器。`reset()` 仍只清内存。
3. 改 `ChatInput.vue`：`onUpdate` 防抖通知；附件增删改立即保存；`filesLoading` 时不接受新附件、不把空附件写回；`restoreDraft` 走第 7 节。
4. 改 `SideChatPanel.vue`：`draft-key` 与发送清除改用稳定键；转正时 `rekey`，`nextTick` 清占位键。
5. 改 `TaskView.vue` 的删除 / 升级，以及 `session/list.ts` 的 `deleteSession`：稳定边路键一并 `clearDraftAndMark`。
6. 改 `auth.ts` 的 `clearLocalSession`：在把 `user` 置空之前 `await draftStore.flushAll()`，再走现有的内存 `reset()`。`fetchUserInfo` 成功后 `await hydrate`。路由守卫已经在等 `fetchUserInfo`，不必再改路由。
7. 单测：内存持久化假实现覆盖下面第 12 节。现有 `draft.test.ts` 保持绿。
8. `cd desktop && npm run test:unit` 中与草稿相关的用例，以及 `npm run build`。
9. 同任务新增 `changelog/unreleased/2026-11-24-draft-persist-refresh.md`，小节用「前端（桌面 / Web / 安卓）」。不改根 `CHANGELOG.md`，不改月份归档。

不改 `ChatPendingFileList.vue`、上传工具、`chatLocalAttach.ts`、后端与 admin。不改 `tab.id` 的生命周期（转正后仍不换 id，避免边路面板重挂载）。

## 11. 落地清单

| 文件 | 改动 |
|---|---|
| `desktop/src/stores/draft-persist.ts` | 新增。IndexedDB 适配与类型 |
| `desktop/src/stores/draft-persist.test.ts` | 新增。以假实现覆盖调度规则；「Blob 包回 File」用纯函数测 |
| `desktop/src/stores/draft.ts` | 持久化调度、hydrate、`originalFile`、`rekey`、`flushAll` |
| `desktop/src/stores/draft.test.ts` | 补晚到写入、hydrate 不覆盖内存、占位键不落库、转正搬键 |
| `desktop/src/components/chat/ChatInput.vue` | 防抖通知、附件立即保存、异步恢复附件、恢复中不接受新附件 |
| `desktop/src/components/chat/SideChatPanel.vue` | 稳定草稿键、转正 `rekey`、发送清除用同一键 |
| `desktop/src/views/task/TaskView.vue` | 删除 / 升级时同时清占位 id 与 `side:{sideSessionId}` |
| `desktop/src/stores/session/list.ts` | `deleteSession` 同时清 `s:{id}` 与 `side:{id}` |
| `desktop/src/stores/auth.ts` | 登出前冲刷；`fetchUserInfo` 后 hydrate。不删库 |
| `changelog/unreleased/2026-11-24-draft-persist-refresh.md` | 用户可见说明 |

## 12. 验证

单测要覆盖的行为：

- 文字防抖未到时 `flush` 会把最新 HTML 写入。
- 同一键上，旧的 `writeMeta` 后返回、新的内容已经进内存：最终库里是新内容，不是先发出的那份。
- `clearDraft` 发生在 `writeMeta` 已开始之后：旧写即使后提交，最终库里也没有该键。
- 用户 1 的 `s:1` 与用户 2 的 `s:1` 互不可见。`deleteUser` 只作为适配层能力测试，登出路径不调用它。
- 附件指纹不变的第二次文字写入不产生新的 `BlobPut`，并沿用上一份的 `blobId`。标注替换会换新 `blobId` 并删除旧的。刷新后只 hydrate 了 meta、还没有字节时，第一次文字写入同样不重写 blob。
- 第 31 条写入会删掉 `updatedAt` 最旧且不是当前键、也不是 `filesLoading` 的那条。只剩受保护键且字节仍超过 200MB 时停止，并改成只留文字。
- 空 HTML、空白文字、无引用、无文件：库里无记录。`filesLoading` 且 meta 里有文件时，编辑器附件仍为空也不删库。
- 只有引用、或只有文件：保留。
- `side:0` 的 `setDraft` 不调用 `writeMeta`。`rekey('side:0', 'side:42')` 之后库里只有 `side:42`。
- 恢复图片时 `previewUrl` 来自对新 `File` 的 `createObjectURL`。没有 `originalBlobId` 时 `originalFile === file`。
- hydrate 第二次调用不覆盖内存里已有的条目。

手工：

1. 会话 A 输入文字和一张粘贴的图片，不切会话，刷新：文字和缩略图都在，可以发出去。
2. 会话 A 有草稿，切到 B 再刷新，回到 A：A 的草稿在，B 为空。
3. 新建任务输入文字，刷新：仍在新建任务输入框。发出去之后再进新建任务：为空。
4. 从当前会话新建边路任务并发出第一条，使它拿到真实会话 id，再输入文字并添加文件。不删任务，关掉 tab，刷新后重新打开：恢复。删除该边路任务后刷新：不再出现。占位阶段（还没发出第一条）刷新：不要求保留。
5. 本地模式从磁盘选一个非图片文件，刷新后发送：仍按原路径拷贝。把源文件改名后再发送：提示与刷新前直接发送一致。
6. 粘贴一段超过阈值、变成文本附件的内容，刷新后发送：LOCAL 仍能内联落盘，CLOUD 仍能上传。
7. 图片标注后刷新，再打开标注：画布是原图，不是叠在上次笔迹上。
8. 含 `@` 引用和快捷指令的草稿，刷新后节点还在，能发送。
9. 发送成功后立刻刷新：输入框为空，库里该键已删。
10. 账号甲留下草稿，登出，账号乙登录：看不到甲的草稿。再登回甲：草稿还在。
11. 浏览器、Electron、安卓壳各做一次第 1 步。安卓额外把应用切到后台再划掉进程，再打开：文字还在。
12. 边路任务转正的那一下，输入框里已有的字还在，不闪成空。

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| 刷新时最后几百毫秒的文字还在防抖里 | 切后台用 `visibilitychange` 冲刷；`pagehide` 在已打开的库上同步补写 meta。附件不靠这个时机 |
| `pagehide` 里才 `indexedDB.open`，事务还没开始页面就被冻结 | 启动时打开并缓存连接 |
| 往返缓存把页面原样恢复 | `pagehide` 只写库，不清内存、不 revoke 预览 |
| 恢复附件完成前，切会话或 `onUpdate` 把空附件写回库 | `filesLoading` 的写库沿用 meta 里的附件列表；此期间不接受新附件 |
| 用 html 字符串判断「用户有没有改过」 | 不比较 html。只看草稿键和这次 `filesLoading` 是否还有效。`setContent` 会改写 HTML |
| 发送清除与在途 `put` 交错，草稿复活 | 同一键串行。写返回后若内存已无此键，再删一次 |
| 旧写后返回，盖住较新的内存 | 写返回后若代数已变且键还在，立刻按当前内存再写一次 |
| 登出时 `user` 已经是 null，最后几百毫秒没写入 | `clearLocalSession` 先 `flushAll`，再置空 `user` 并清内存 |
| 登出把库删掉，再登录草稿没了 | 登出不调用 `deleteUser` |
| 换号后会话 ID 相同 | 主键含 `userId`，hydrate 只加载当前用户 |
| 边路占位 `tab.id` 与刷新后的 `side:{realId}` 不一致 | 转正时 `rekey`。占位键不入库。删除时两个键都清 |
| 转正时子组件先按空的新键恢复，输入框被清空 | `rekey` 发生在改 `draftKey` 之前，新键上已有条目 |
| 结构化克隆丢掉 `File.path` | 发送只用已入库的 `localPath` 字符串 |
| 读回的是 `Blob`，或 `File.type` 为空 | 用 meta 的名字和类型包一层 `File` |
| 大附件占满配额，或单条就超过 200MB | 裁剪有停止条件；失败则只留文字并提示一次 |
| 裁剪把正在读的 blob 删掉 | 不裁 `filesLoading` 的键 |
| 路由在 `fetchUserInfo` 失败时仍进页 | 不 hydrate。本次退回纯内存 |
| 个人资料页再次 `fetchUserInfo` | hydrate 可重入，不覆盖已有内存，不等待中的附件恢复不重来 |
| 主窗口、画中画、另一个标签同时写同一键 | 后写覆盖先写。画中画没有会话输入框。两个标签同时编辑同一会话会互相覆盖，接受 |
| 删主会话时子边路草稿还在 | 子会话还在则草稿保留。删到某个会话 id 时同时清 `s:` 与 `side:`，避免只删掉一半 |
