# 文件管理多选下载（合并 zip）— 技术方案

> 状态：方案已确认（§八），待实施（2026-11-14 可行性复核通过，复核补充见 §九）
> 版本：0.2（2026-11-14）
> 关联前案：`docs/plan/2026-08/2026-08-05-cloud-workspace-file-download-design.md`（单文件 / 单目录下载，本方案在其基础上扩展）

## 一、需求背景

文件管理（`FileManagerPanel`）支持多选条目后点底部工具栏「下载」按钮，但**实际只下载下来第一个文件**，其余文件静默丢失，且界面无任何失败提示。

### 1.1 根因（已核实）

前端下载链路：`FileManagerPanel.vue` 的 `handleDownload`（`desktop/src/components/file-browser/FileManagerPanel.vue:604`）循环逐个调用 provider 的 `downloadFile`，每次都 fetch 成功，最终经 `workspace-file-provider.ts:631` 的 `triggerBrowserDownload` 用 `<a download>` + `a.click()` 触发浏览器式下载。循环本身没有问题，问题在下载触发方式与 Chromium 的下载限流：

1. 第一个 `a.click()` 继承自「下载」按钮点击的**用户激活（transient user activation）**，正常触发保存框；
2. **下载会消耗用户激活**（Chromium M68 起下载必须且会消耗手势），后续第 2、N 次 `a.click()` 已无手势，被 Chromium 判定为「automatic download」，走 `AUTOMATIC_DOWNLOADS` 内容设置检查；
3. 该设置默认 ASK——Chrome 里会弹「此网站尝试下载多个文件」的询问条，但 **Electron 未实现该询问 UI**，限流请求被**静默丢弃**（不弹框、不报错、不触发 `will-download`）；
4. `downloadFile` 在 `click()` 之后即返回 `{ ok: true }`（fetch 是成功的），`handleDownload` 的失败计数器恒为 0，`FileManagerPanel.vue:623` 的「N 个条目下载失败」永远不会触发。

结果：N 个 fetch 全部成功、只有第一个文件真正保存，无任何异常提示。

### 1.2 现状相关事实（已核实）

- 多选交互：`selectedEntries()`（`FileManagerPanel.vue:313`）只含**当前目录**的条目（文件 + 目录可混合），导航后选区清空。
- 下载入口共三处，全部汇到 provider 的两个可选方法：
  - 底部工具栏「下载」按钮（`FileManagerPanel.vue:173`）→ `handleDownload`（单文件走 `downloadFile`，目录走 `downloadDirectory`）；
  - 右键菜单多选「下载（N 项）」（`FileManagerContextMenu.vue:17`）→ 同 `handleDownload`；
  - 右键菜单单条目「下载此文件 / 下载此目录（zip）」→ `handleDownload`（单选）与 `handleDownloadZip`。
- Provider 矩阵（`desktop/src/composables/workspace-file-provider.ts`）：
  - `createCloudProvider`（会话 CLOUD）：实现 `downloadFile` → `GET /files/workspace-download`、`downloadDirectory` → `GET /files/workspace-download-zip`；
  - `createOwnedWorkspaceProvider`（工作区总览）：实现同上，对应 `GET /files/owned-download[-zip]`；
  - `createLocalProvider`（LOCAL）与 `createProjectProvider`（新建态只读）：**均不实现**这两个方法。
- 已知现状缺陷（顺带修复项）：LOCAL 模式下 provider 非 null 但无下载方法，`handleDownload` 的判空只挡 `provider === null`，循环里 `downloadFile?.()` 经可选链全部返回 `undefined`，**点了「下载」毫无反应、也无提示**。
- 次要隐患：`triggerBrowserDownload` 在 `click()` 后同步 `URL.revokeObjectURL`（`workspace-file-provider.ts:639`），存在「浏览器尚未开始读 blob 就注销 URL」的竞态，首次下载也可能偶发失败。
- 后端 zip 基建可直接复用：`WorkspaceBrowseService.zipDirectory`（`backend-ts/src/file/workspace-browse.service.ts:302`）—— `archiver`（level 5）打包到 `tmpdir()` 临时文件、打包前递归统计总字节、超 `maxZipBytes`（默认 1GB，`setMaxZipBytes` 可配）拒绝、遍历与打包均跳过符号链接、响应后 `close/error` 删除临时文件。
- 后端路径安全基建：`StrictPathResolver` 严格沙箱 + 「团队经验」挂载特例（`resolvePath`，`workspace-browse.service.ts:475`），`workspace-*` 家族额外传 `experienceDirOf(session)`。

## 二、需求描述

### 2.1 做

| # | 需求点 | 说明 |
|---|--------|------|
| 1 | 多选（≥2 项）点「下载」打包为一个 zip 一次下载 | 文件与目录可混合；一次保存框、一次 anchor click，从机制上绕开 Chromium 多下载限流 |
| 2 | zip 结构平铺 | 选中文件放 zip 根，选中目录保持目录名递归（与 macOS Finder「压缩 N 个项目」行为一致；同一父目录下条目必不同名，无重名冲突） |
| 3 | 建议文件名 | `<工作区根名>-YYYYMMDD-HHmm.zip`，如 `docs-20261114-1530.zip`（后端按**服务端本地时间**生成，随 `Content-Disposition` 下发；前端仅作兜底） |
| 4 | 大小上限 | 复用目录 zip 的 1GB 上限（`maxZipBytes`），超限拒绝并提示减少选中项或分批下载 |
| 5 | 条目数上限 | **不设上限**（评审确认 2026-11-14）：选区天然受当前目录列表 500 项约束，仅做去重与逐项合法性校验 |
| 6 | 覆盖两个 provider 家族 | 会话 CLOUD（`workspace-*`）与工作区总览（`owned-*`）各新增一个 POST 端点 |
| 7 | 顺带修复：LOCAL 模式点「下载」静默无反应 | provider 有实例但无下载方法时明确提示「当前模式不支持下载」 |
| 8 | 顺带修复：`revokeObjectURL` 时序 | 延迟 1s 注销 blob URL，消除首次下载的偶发竞态 |

### 2.2 不做

| # | 不做项 | 原因 |
|---|--------|------|
| 1 | LOCAL 模式批量下载 | 本地文件本就在用户磁盘上（与 2026-08-05 前案不做项 1 一致） |
| 2 | 新建态（project provider）批量下载 | 写与下载都依附会话，新建态只读（前案同源约束） |
| 3 | Electron 主进程 `showSaveDialog` IPC 保存 | 方案对比后不选（见 §3）；Web 端无法复用该实现 |
| 4 | 下载进度条 / 流式落盘 | 与单目录 zip 现状一致（blob 全量进内存，1GB 上限内可接受） |
| 5 | 安卓 WebView 特化 | 前案不做项 8 维持不变；本方案单次 anchor click 与现状行为面一致 |
| 6 | 跨目录选区 | 交互上选区只存在于当前目录，天然约束；后端不强制同目录（任意相对路径组合均可打包） |
| 7 | 限流 / 队列 | 与现有下载端点一致：鉴权后用户打包自己工作区，不做限流 |

## 三、技术选型

| 决策点 | 选型 | 理由 |
|--------|------|------|
| 多选下载方式 | 服务端打包 zip，一次下载（**方案 A**） | 一次 anchor click 携带用户手势，彻底绕开 Chromium 多下载限流；后端 zip 基建现成；单次下载对 Electron / Web / 安卓行为面一致；多选打包 zip 也是主流文件管理器的通用认知 |
| 备选：Electron 主进程 IPC 保存（方案 B） | 否 | 每文件弹一次保存框体验差；Web 端仍受 Chromium 限流且需双实现；为修一个下载 bug 引入一条新 IPC 面，收益不成比例 |
| 备选：纯前端规避限流（方案 C） | 否 | 用户激活无法伪造，`DownloadRequestLimiter` 行为随 Chromium 版本变化，任何 timing 手法都不可靠 |
| 端点方法 | `POST`，paths 放 JSON body | 多值路径不适合 query（转义 / 长度）；`file.routes.ts` 已有 POST 先例（`upload-incoming`、`workspace-git-refresh`）；下载走 `fetch` + Authorization header，不受「POST 不能导航」影响 |
| 端点数量 | 两个（workspace / owned 家族各一） | 与既有 `workspace-download-zip` / `owned-download-zip` 双家族一一对应，鉴权守卫各走现成函数，不混用语义 |
| 服务端打包 | 复用 `WorkspaceBrowseService`，新增 `zipEntries` | 与 `zipDirectory` 共用沙箱解析、大小上限、archiver 配置、临时文件生命周期；将 `writeZip` 泛化后两者共用一份遍历逻辑 |
| zip 内符号链接 | 选中项是 symlink → 拒绝；目录内部 symlink → 跳过 | 前者与 `downloadFile`「不是普通文件」行为一致；后者与 `zipDirectory` 一致（防逃逸与 zip 膨胀） |
| 前端触发 | 保留 `<a download>` + blob，单次点击 | 不新增 IPC、不引依赖；一次点击不触发限流 |

## 四、详细设计

### 4.1 后端 — Service 层

`backend-ts/src/file/workspace-browse.service.ts`：

**新增类型**

```ts
interface ZipSourceItem {
  /** 沙箱解析后的绝对路径（文件或目录） */
  absPath: string;
  /** zip 内的根 entry 名：文件 = 文件名；目录 = 目录名（其子树挂在该前缀下） */
  entryRoot: string;
}
```

**新增公开方法 `zipEntries`**

```ts
async zipEntries(
  sessionWorkspace: string,
  paths: string[],
  experienceDir?: string | null,
): Promise<ZipResult>
```

流程：

1. 入参校验：`paths` 为非空数组，逐项 trim 后非空；trim 后按出现顺序去重。违反 → `PARAM_MISSING` / `PARAM_INVALID`。条目数硬上限 **1000**（超限 → `PARAM_INVALID`「选中条目过多（n），请减少选中项或分批下载」）：UI 选区受当前目录列表 500 项约束远够用；无上限时恶意大 body（生产 bodyLimit 为 52MB，见 `main.ts`，**并非** Fastify 默认 1MB）叠加 O(n²) 的去重 / 包含校验可长时间阻塞事件循环（实现期 review 修正 §八.2 的原始前提，UI 行为不变）。
2. 逐项 `resolvePath(path, sessionWorkspace, experienceDir)` 复用现有严格沙箱（含「团队经验」挂载特例，越界 → `FORBIDDEN`）。
3. 逐项 `existsSync` + `lstatSync`：不存在 → `PARAM_INVALID`「文件不存在：xx」；是符号链接或既非文件又非目录 → `PARAM_INVALID`「不是普通文件：xx」（与 `downloadFile` 文案一致）。
   - 解析后按 `absPath` 二次去重（如 `a` 与 `./a` 解析为同一路径）；若某条目位于另一条目（目录）的子树内（如同时传 `docs` 与 `docs/x.txt`）→ 跳过内层条目（外层目录已包含它，避免 archiver 产出重复 entry 名）。UI 选区同目录内不可能触发，纯 API 直调防御。
   - 跨目录选中同名条目（如 `dir1/same.txt` 与 `dir2/same.txt`）无法平铺、重名 entry 语义不明 → `PARAM_INVALID`「选中项存在重名：xx，无法合并打包」（同上，UI 不会触发；实现期补充的防御）。
4. 统计总大小：文件 `statSync().size`；目录用现有 `walkFiles`（跳过 symlink）。合计 > `this.maxZipBytes` → `PARAM_INVALID`「所选内容过大（${formatSize(totalBytes)}），请减少选中项或分批下载」。
5. 临时文件 `join(tmpdir(), 'mao-workspace-<randomUUID>.zip')`，调用泛化后的 `writeZip`（见下），失败清理后抛 `INTERNAL_ERROR`「打包选中项失败」；成功返回 `{ zipPath, size, fileName: '<workspaceBasename>-YYYYMMDD-HHmm.zip' }`。
   - `workspaceBasename` 取 `pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace)` 的 `basename`（等价于 `resolveZipRootName` 在「dir === root」分支的行为）；
   - 时间戳为**服务端本地时间**，格式 `YYYYMMDD-HHmm`（如 `docs-20261114-1530.zip`）；用 `common/datetime.ts` 风格的手写 pad 格式化即可，不引新依赖。

**泛化 `writeZip`（既有函数重构，行为不变）**

现签名 `writeZip(dirPath: string, rootName: string, zipPath: string)` 改为：

```ts
async function writeZip(items: ZipSourceItem[], zipPath: string): Promise<void>
```

- 单文件 item → `archive.file(absPath, { name: entryRoot })`；
- 目录 item → 递归 `readdirSync` 遍历（跳过 symlink）收集子树 entry，entry 名 = `entryRoot + '/' + relative(absPath, p)`；目录自身的占位 entry（`${entryRoot}/`）与子树 entry **一并纳入统一集合**；
- entry 集合统一 `localeCompare` 排序后 append（占位参与排序，与现实现把根目录自身纳入同一排序集合一致，保证 `zipDirectory` 输出的确定性不变）；
- `zipDirectory` 改为构造单元素 `items` 调用（`entryRoot = rootName`），由既有用例 `zipIncludesNestedDirsAndSkipsSymlinks`、`workspaceZipRejectsOversizedDirectory` 守护回归。

### 4.2 后端 — 路由层

`backend-ts/src/file/file.routes.ts` 新增两个端点，响应样板复制现有 zip 端点（`file.routes.ts:237-256` / `:678-695`）：

```
POST /v1/files/workspace-download-multi-zip   body: { sessionId: number, paths: string[] }
POST /v1/files/owned-download-multi-zip       body: { root: string, paths: string[] }
```

- workspace 家族：`requireUserId` + `requireOwnedSession`（归属校验）+ `experienceDirOf(session)`；守卫层级与既有 `workspace-download-zip` 完全一致（该端点不拒绝 LOCAL 会话，本端点保持一致，LOCAL 拦截靠前端 provider 缺方法 + §4.3 的提示）。
- owned 家族：`requireUserId` + `resolveOwnedWorkspace(userId, body.root)`（受管目录校验）。
- 响应：`application/zip` + `contentDisposition('attachment', result.fileName)` + `Content-Length`，`createReadStream` 流式发送，`stream.on('close'/'error')` 后 `unlinkSync` 清理临时文件——与现有 zip 端点逐字一致。
- body 解析：`bodyOf(request)`（routes 内已有工具），`paths` 缺失或非数组 → `PARAM_MISSING`。
- 鉴权：与其他 `/v1/**` 一致走 Authorization header（前端 fetch 携带），审计 / 权限拦截器沿用现有排除规则，无新增。

### 4.3 前端 — Provider 层

`desktop/src/composables/workspace-file-provider.ts`：

**接口新增可选方法**（`WorkspaceFileProvider`）：

```ts
/** 打包下载多个选中条目（zip）到浏览器（仅 CLOUD 模式实现）。paths 为工作区相对路径。 */
downloadEntriesZip?(paths: string[], suggestedName: string): Promise<DownloadResult>
```

实现矩阵与 `downloadFile` / `downloadDirectory` 一致：`createCloudProvider` 与 `createOwnedWorkspaceProvider` 实现；`createLocalProvider` / `createProjectProvider` 不实现。
注意 `createCloudProvider` 的「会话未就绪」早退分支（sessionId 非法时返回的 fallback provider）也要实现 `downloadEntriesZip`（返回 `{ ok: false, error: '会话未就绪' }`，与该分支的 `downloadFile` / `downloadDirectory` 同款）——漏掉则未就绪会话多选下载会误报「当前模式不支持下载」，文案错误。

**新增内部函数 `downloadWorkspaceZip`**（与 `downloadWorkspaceResource` 平行的 POST 变体，尾部复用既有模块级 helper：`extractDownloadError`、JSON 错误体判断、`parseDownloadFileName`、`triggerBrowserDownload`）：

```ts
async function downloadWorkspaceZip(
  endpoint: string,
  body: Record<string, unknown>,
  suggestedName: string,
): Promise<DownloadResult> {
  // fetch(endpoint, { method: 'POST', headers: { Authorization }, body: JSON.stringify(body) })
  // resp.ok → blob → parseDownloadFileName(content-disposition) || suggestedName → triggerBrowserDownload
}
```

- `createCloudProvider.downloadEntriesZip(paths, name)` → `downloadWorkspaceZip('/files/workspace-download-multi-zip', { sessionId, paths }, name)`；
- `createOwnedWorkspaceProvider.downloadEntriesZip(paths, name)` → `downloadWorkspaceZip('/files/owned-download-multi-zip', { root, paths }, name)`。

**`triggerBrowserDownload` 时序修复**（同一改动内）：

```ts
function triggerBrowserDownload(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立即 revoke 存在「浏览器尚未开始读 blob 就注销 URL」的竞态；延后 1s 回收
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}
```

### 4.4 前端 — FileManagerPanel

`desktop/src/components/file-browser/FileManagerPanel.vue` 的 `handleDownload` 重构为两个分支：

```ts
async function handleDownload() {
  const targets = selectedEntries()
  if (targets.length === 0) return
  const files = targets.filter((e) => !e.isDirectory)
  const dirs = targets.filter((e) => e.isDirectory)
  let failures = 0
  if (targets.length === 1) {
    // 单选：走既有单文件 / 单目录下载（不变）
    const t = targets[0]!
    const res = t.isDirectory
      ? await props.provider?.downloadDirectory?.(t.path, t.name)
      : await props.provider?.downloadFile?.(t.path, t.name)
    if (res && !res.ok) ElMessage.error(res.error || '下载失败')
    return
  }
  // 多选：合并 zip 一次下载
  if (!props.provider?.downloadEntriesZip) {
    ElMessage.warning('当前模式不支持下载')
    return
  }
  const res = await props.provider.downloadEntriesZip(
    targets.map((t) => t.path), 'selected.zip',
  )
  if (res && !res.ok) ElMessage.error(res.error || '下载失败')
}
```

要点：

- 删除「将逐个下载 N 个文件」的 `ElMessage.info`（不再逐个下载）。
- 单选分支同时修复 §1.2 所述 LOCAL 静默缺陷吗？——单选分支里 `downloadFile?.()` 为 undefined 仍静默；统一处理：单选分支开头同样判 `!props.provider?.downloadFile` → `ElMessage.warning('当前模式不支持下载')`（目录走 `downloadDirectory` 同理）。两分支共用一个能力判断。
- 右键菜单「下载（N 项）」与单条目「下载此文件」复用 `handleDownload`，无需改 `FileManagerContextMenu`。
- `handleDownloadZip`（右键单目录 zip）：复核补充，**不再保留原「不动」结论**——右键菜单的下载项不受 `writesLocked` 抑制，LOCAL 模式同样会展示「下载此目录（zip）」，`downloadDirectory?.()` 为 undefined 时与 `handleDownload` 同属「provider 非空但无方法」静默无反应（§1.2 同类缺陷）。一并补同一能力判断（无 `downloadDirectory` → `ElMessage.warning('当前模式不支持下载')`），1 行改动，随本任务顺带修复。
- zip 的实际文件名优先取后端 `Content-Disposition`（`parseDownloadFileName`），`'selected.zip'` 仅是兜底，几乎不会生效。

### 4.5 影响面

| 端 | 是否改动 | 说明 |
|----|----------|------|
| backend-ts | 是 | 2 个新端点 + service 新方法 + `writeZip` 泛化；无 DB 迁移 |
| desktop（Electron / Web / 安卓共用 UI） | 是 | provider 接口与两个实现、`handleDownload`、`triggerBrowserDownload` |
| admin / agent-cli / mao-cli / 安卓原生 | 否 | 无涉及 |
| 既有端点 | 否 | `workspace-download[-zip]`、`owned-download[-zip]` 行为不变（`writeZip` 重构由既有用例守护） |

## 五、测试方案

### 5.1 后端（Vitest，`cd backend-ts && npm test`）

Service 层（`file.service.spec.ts` 的 `WorkspaceBrowseService` describe，与既有 zipDirectory 用例同处）：

| 用例 | 断言 |
|------|------|
| `zipEntriesPacksMixedFilesAndDirsFlat` | 文件 + 目录混合：zip 根直接出现选中文件名；目录子树挂在目录名下，内容可解出 |
| `zipEntriesRejectsSymlinkEntry` | 选中 symlink 条目 → 「不是普通文件」 |
| `zipEntriesSkipsSymlinksInsideDirs` | 选中目录内部 symlink 不进 zip |
| `zipEntriesRejectsEscapeAndMissing` | `../` 越界 → FORBIDDEN；不存在路径 → 「文件不存在」 |
| `zipEntriesDedupsAndRejectsInvalid` | 空数组 / 非数组 → PARAM_MISSING / PARAM_INVALID；重复路径去重只打包一份 |
| `zipEntriesSkipsNestedAndDedupsResolved` | `docs` + `docs/x.txt` → 内层跳过；`a` 与 `./a` → 解析后去重；zip 内无重复 entry 名 |
| `workspaceEntriesZipRejectsOversized` | `setMaxZipBytes` 后超限 → 「所选内容过大」 |
| `zipEntriesNamesAfterWorkspaceWithTimestamp` | `fileName` 匹配 `<workspaceRootBasename>-YYYYMMDD-HHmm.zip`（正则断言） |

路由层（`file.routes.spec.ts`）：

| 用例 | 断言 |
|------|------|
| workspace 家族归属 | 他人 sessionId → FORBIDDEN；`paths` 缺失 → PARAM_MISSING；正常请求返回 zip 字节 |
| owned 家族 | 非受管 `root` → PARAM_INVALID；正常请求返回 zip 字节 |

### 5.2 前端（Vitest，desktop）

`workspace-file-provider.test.ts`：

- cloud provider `downloadEntriesZip`：POST 到 `/files/workspace-download-multi-zip`、body 含 `sessionId` 与 `paths`、错误映射（HTTP 500 / JSON 错误体）→ `{ ok: false, error }`；
- owned provider 同理（body 含 `root`）；
- `createLocalProvider` / `createProjectProvider` 的 `downloadEntriesZip` `toBeUndefined()`（与既有 134-135 行断言同款）；
- 「会话未就绪」fallback：`createCloudProvider` 传非法 sessionId，`downloadEntriesZip` 返回 `{ ok: false, error: '会话未就绪' }`。

`FileManagerPanel` 不新增组件测试（`file-browser/` 目录无 panel 级测试惯例，`handleDownload` 分支逻辑简单，行为由 provider 层用例 + 手工回归覆盖）。

### 5.3 手工回归清单

- CLOUD 会话：单选文件 / 单选目录（走旧端点）；多选 2 文件、多选文件+目录混合、全选（含目录）→ 一次保存框、zip 解开结构与选中一致；超 1GB 提示。
- 工作区总览（owned）：同上。
- LOCAL 模式：单选 / 多选点「下载」、右键单目录「下载此目录（zip）」→ 「当前模式不支持下载」提示。
- Web 端（浏览器）：多选 zip 一次下载成功（不再出现「下载多个文件」询问场景）。

### 5.4 E2E

不新增 Playwright 用例：下载落盘是原生保存对话框，无法自动化断言；现有 E2E 亦不覆盖下载路径。构建验证：desktop `npm run build`（`vue-tsc -b`）+ backend `npm test`。

## 六、发布与文档同步

1. **部署顺序：先发后端，再部署 desktop dist**。
   - 旧前端 + 新后端：兼容（旧前端不发新请求）；
   - 新前端 + 旧后端：多选 zip 请求 404 → 提示「下载失败（HTTP 404）」，因此先发后端避免该窗口。
2. `changelog/unreleased/2026-11-14-multi-select-download-zip.md`：小节「前端（桌面 / Web / 安卓）」（多选下载合并 zip 一次保存 + LOCAL 提示修复）与「后端」（新增多选打包端点）。
3. README / DEPLOY / skills/mao-cli 不涉及（无部署形态与 CLI 行为变化）；admin 无改动。
4. 本设计文档随实现同任务提交。

## 七、风险与边界

| 风险 | 评估 | 缓解 |
|------|------|------|
| blob 全量进内存 | 与单目录 zip 现状一致；1GB 上限内可接受，Electron 64-bit 渲染进程无实际问题 | 维持 1GB 上限；不做流式落盘（不做项 4） |
| 大量小文件打包耗时无反馈 | 与单目录 zip 一致 | 选区受当前目录列表 500 项约束，总大小 1GB 兜底；如后续需要再引入进度事件 |
| `writeZip` 重构波及既有单目录 zip | 中低 | 重构保持 entry 排序 / 目录占位 / symlink 跳过语义不变；既有两条 zipDirectory 用例守护，另补「zipDirectory 行为不变」对照断言（可选） |
| 中文工作区名 / 文件名 | 已有 `contentDisposition` 的 `filename*=UTF-8''` 编码与 archiver UTF-8 处理，路径沙箱本就支持中文 | 无新增处理 |
| 选中项含「团队经验」挂载链接 | `resolvePath` 的 experience 特例逐项生效 | 与单文件下载同一套判断，无特殊逻辑 |

## 八、评审结论（2026-11-14 已确认）

1. zip 建议文件名：**带时间戳** `<工作区名>-YYYYMMDD-HHmm.zip`（服务端本地时间生成）。
2. 单次条目数上限：**不设上限**（选区受当前目录列表 500 项约束，仅做去重与逐项校验）。
3. 超 1GB 提示文案：「所选内容过大（xx），请减少选中项或分批下载」。

## 九、评审复核（2026-11-14，可行性通过）

对 §1.1 根因、§1.2 现状事实、§4 全部落点逐项对照源码核实，均属实；关键交叉验证：

- 前端：`handleDownload`（`FileManagerPanel.vue:604`）、`selectedEntries`（:313）、下载按钮（:173）、右键菜单 wiring（`@download` / `@download-zip`）、provider 矩阵与 `triggerBrowserDownload` 同步 revoke（`workspace-file-provider.ts:631,639`）与文档一致；`parseDownloadFileName` / `extractDownloadError` 等被复用 helper 均存在。
- 后端：`zipDirectory` / `writeZip` / `walkFiles` / `resolvePath` / `resolveZipRootName` / `getEffectiveWorkspaceRoot`、两个 zip 路由样板（`file.routes.ts:237-256` / `:678-695`）、`bodyOf` POST 先例（`upload-incoming:142`、`workspace-git-refresh:278`）、`requireOwnedSession` 确不拒绝 LOCAL 会话（只做归属 + workspace 非空校验）、既有用例名 `zipIncludesNestedDirsAndSkipsSymlinks` / `workspaceZipRejectsOversizedDirectory`，全部属实。
- 鉴权：`requireUserId` 仅读 Authorization header（`common/auth.ts:7-13`），现有下载 URL 的 `?token=` 参数后端并不读取；新 POST 端点只走 header 的设计正确。
- 修复思路（服务端合并 zip + 单次 anchor click）从机制上绕开 Chromium 多下载限流，不依赖对限流细节的精确复现；即使 Electron 各版本对 automatic downloads 的丢弃行为有差异，本方案行为面与既有单文件下载一致，需求与方案均可行。

相对 0.1 的补充（已并入正文）：

1. §4.3：「会话未就绪」fallback provider 补 `downloadEntriesZip`，否则未就绪会话多选下载误报「当前模式不支持下载」。
2. §4.1：`zipEntries` 解析后按 absPath 二次去重 + 跳过子树包含的内层条目（API 直调防御，避免 archiver 重复 entry 名）；明确目录占位 entry 参与统一排序，守护 `writeZip` 泛化对既有 zipDirectory 输出的确定性。
3. §4.4：`handleDownloadZip` 一并补能力判断（原「不动」在 LOCAL 下仍静默，与 §2.1 修复项 7 同类缺陷，自相矛盾）。
4. §5.1 / §5.2 / §5.3：补上述各项的回归用例与手工回归点。

实现完成后 review 子代理复核（2026-11-14）：

1. **P1 修复**：§八.2「不设条目数上限」的前提（Fastify 默认 1MB body 兜底）不成立——生产 `main.ts` 显式 `bodyLimit: 52MB`。改为条目数硬上限 1000 + trim 去重改用 `Set`（O(n)），子树包含检查在上限内 O(n²) 可接受；UI 选区 ≤500 项行为不变。§4.1-1 已同步更正。
2. P2 已顺手处理：路由层补「paths 非数组」拒绝断言；owned 前端用例用 fake timers 收尾避免遗留 1s 定时器。
3. P2 保持现状（记录理由）：错误文案回显 trim 后路径（比回显原始带空白入参更可读，与 `downloadFile` 的原始入参口径差异极小，不统一）；`downloadWorkspaceZip` 返回值不带 `url` 字段（`DownloadResult.url` 可选且调用方不消费）。
