# 代码审查：管理后台会话工作区文件浏览器（commit 625dcee3）— 1 个经测试验证的功能 BUG

- **日期**：2026-10-16
- **基线**：分支 `feat/admin-session-workspace-files` @ `625dcee3`（父提交 `aab16bbf`），工作区干净；本审查仅新增 1 个存在性证明测试文件（`*.bugcheck.spec.ts`），未改动任何产品代码
- **范围**：`625dcee3` 全部改动——后端 `backend-ts/src/session/admin-session-files.routes.ts`（6 个只读端点）+ `create-app.ts` 注册；admin `useWorkspaceFiles.ts`、`WorkspaceFileDialog.vue`、`file-format.ts`、`SessionDetailView.vue`、`FileChangePanel.vue`、`MessageGroup.vue`
- **方法**：逐文件通读 + 与桌面端同款实现（`desktop/src/composables/workspace-file-provider.ts`）逐条对照 + 与设计文档（`docs/plan/2026-10-15-admin-session-workspace-file-browser.md`）核对；每条候选必须满足「输入合法即可触发、输出确定错误、有可运行测试证明」，无法构造确定性失败测试的候选一律不列为 bug（排除清单见 §4）
- **测试证据**：`backend-ts/src/session/admin-session-files.bugcheck.spec.ts`（断言按「正确行为」书写，当前源码下 **failed**，即证明 bug 真实存在）；`cd admin && npm run build` 通过；`cd backend-ts && npm run build` 通过；`npx vitest run src/session src/file` → **34 passed + 1 failed**（唯一失败即本 bugcheck，存量 594 条无一回归）

---

## 1. 结论表

| 编号 | 严重度 | 位置 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 高 | `admin/src/views/session/composables/useWorkspaceFiles.ts` L108-121（`fetchBytes`） | 三个字节流端点（download / download-zip / preview）的业务错误被后端以 HTTP 200 + JSON 返回，`fetchBytes` 只判 `resp.ok`，把 JSON 错误体当文件 blob：下载落地的是内容为错误 JSON 的损坏文件、PDF 预览渲染一段 JSON，方案 §5.5 承诺的「目录过大」等明确错误完全不可见 |

---

## 2. BUG-1 详述

### 2.1 文件:行号

- **主缺陷**：`admin/src/views/session/composables/useWorkspaceFiles.ts` L108-121——`fetchBytes` 仅以 `if (!resp.ok)` 判定成败，成功分支直接 `resp.blob()`
- **受牵连的前端调用点**：同文件 L242-243（PDF 预览 `previewFile`）、L272-278（`downloadFile`）、L280-288（`downloadZip`）；`WorkspaceFileDialog.vue` L128/L208/L210/L220/L228（下载按钮与预览失败兜底下载）
- **后端错误语义来源**：`backend-ts/src/common/http-error.ts` L78-83——`handleError` 仅把 `1001/401` 映射为 401、`1002/403` 映射为 403，**其余错误码一律 HTTP 200 + JSON**；`backend-ts/src/common/error-code.ts` L10/L11/L14/L70——`PARAM_INVALID=2001`、`PARAM_MISSING=2002`、`SESSION_NOT_FOUND=3002`、`INTERNAL_ERROR=5001`
- **受影响端点**：`backend-ts/src/session/admin-session-files.routes.ts` L74-82（`/files/preview`）、L85-94（`/files/download`）、L97-116（`/files/download-zip`）——三者均以 `sendFileStream` / `reply.send(stream)` 直接下发字节流
- **正确写法对照**：`desktop/src/composables/workspace-file-provider.ts` L377-387——桌面端在 `resp.ok` 之外还校验「无 `Content-Disposition` 且 `content-type` 含 `application/json` → 解析 body，`code !== 0` → 返回 error」；admin 复刻时漏掉了这处守卫（`extractFetchError` 只在非 2xx 分支被调用，永远看不到 200-JSON 错误）

### 2.2 触发条件（任一合法输入即可触发）

1. 下载不存在 / 非普通文件（目录、符号链接）：后端 `PARAM_INVALID`「文件不存在：x」「不是普通文件：x」
2. zip 下载不存在目录：「目录不存在」；**zip 超过 1GB 上限（方案 §5.5 明确承诺「目录过大（x.x GB），请选择子目录下载」的场景）**
3. PDF 预览非 `.pdf` / 文件头损坏：「仅支持预览 .pdf 文件」「不是有效的 PDF 文件或文件已损坏：x」
4. 会话不存在（3002）、LOCAL 会话 / 无工作区会话（前端入口已禁用，直接构造 URL 或页面缓存未刷新时可触发）、服务内部错误（5001）

### 2.3 复现方式（测试用例）

- **文件**：`backend-ts/src/session/admin-session-files.bugcheck.spec.ts`（本次审查新增的存在性证明测试：真实 `app.listen` + Node `fetch`，`fetchBytes` / `extractFetchError` / `parseDownloadFileName` 三函数逐行复制自前端；含 FORBIDDEN-403 与正常下载两个对照组，证明失败不是测试写法问题）
- **命令**：

```bash
cd backend-ts && npx vitest run src/session/admin-session-files.bugcheck.spec.ts
```

- **当前结果**：`1 failed`。首条断言即失败：

```
FAIL  src/session/admin-session-files.bugcheck.spec.ts > ... 业务错误应 surfaced 为 error，而不是文件 blob
AssertionError: the given combination of arguments (undefined and string) is invalid for this assertion.
 ❯ admin-session-files.bugcheck.spec.ts:104:22
    104|     expect(dl.error).toContain('文件不存在');
```

（`dl.error` 为 `undefined`——错误响应被当成了成功 blob）

- **同代码路径实测输出**（用与 bugcheck 完全相同的 `fetchBytes` 逻辑 + 真实 HTTP 实测，仅把断言改为记录实际返回值后观测到）：

| 请求 | 实际得到 |
| --- | --- |
| `download?path=ghost.txt` | `blob` 非空，type `application/json;charset=utf-8`，内容 `{"code":2001,"message":"文件不存在：ghost.txt",...}`，`fileName` 回落为 `ghost.txt` |
| `download-zip`（把 `setMaxZipBytes(10)` 复现「目录过大」） | `blob` 内容 `{"code":2001,"message":"目录过大（50 B），请选择子目录下载"}`；响应无 `Content-Disposition`，前端回落名 `workspace.zip`——用户存到一个损坏 zip |
| `preview?path=not-a-pdf.pdf` | `blob` 内容 `{"code":2001,"message":"不是有效的 PDF 文件或文件已损坏：not-a-pdf.pdf"}`——iframe 渲染一段 JSON |
| 对照组 `download?path=../outside.txt` | 正确报错「路径访问被拒绝」（FORBIDDEN 1002 走真 403） |
| 对照组 `download?path=README.md` | 内容正确 `hello\nworld`，文件名 `README.md` |

### 2.4 预期行为 vs 实际行为

- **预期**（方案 §5.5 边界降级表、§11.3 补充完善第 1 条）：字节流端点失败时按 `extractDownloadError` 模式解析出后端 message；`downloadFile` / `downloadZip` 不落盘、抛错由 `ElMessage.error` 提示；PDF 预览区展示「暂不支持预览，请下载后查看」+ 下载按钮兜底；zip 超 1GB 给「目录过大」明确错误
- **实际**：HTTP 200 使 `resp.ok` 为真，`extractFetchError` 永不执行；`resp.blob()` 把 JSON 错误体当作文件流。`downloadFile` / `downloadZip` 经 `utils/download.ts` 的 `downloadBlob` 落盘一个内容为错误 JSON 的文件（zip 场景直接是打不开的损坏压缩包）；PDF 预览的 iframe 显示 JSON 文本而不是兜底面板

### 2.5 为什么是功能错误

下载取证是本需求的核心诉求（方案 §2.1.4）。「目录过大」「文件不存在」是最常见的失败路径：用户侧完全看不到失败原因，只会得到一个打不开的 zip 或内容莫名其妙的文件，且没有任何错误提示。JSON 端点（directory/search/read）走全局 `api` 实例，响应拦截器按 `data.code !== 0` 拒绝并抛出 message，因此只有这三个裸 `fetch` 端点受损——差异正是复刻桌面端实现时漏掉的一处守卫。

### 2.6 严重级别

**高**——核心功能路径（下载 / PDF 预览）在全部常见失败场景下输出确定错误（损坏文件、无提示），且与方案承诺的降级行为直接矛盾。

### 2.7 修复方向（仅供修复参考，本次未动手）

1. **前端（最小改动，推荐）**：`fetchBytes` 在 `resp.ok` 分支补桌面端同款守卫——无 `Content-Disposition` 且 `content-type` 含 `application/json` 时解析 body，`code !== 0` 返回 `{ error: body.message }`；`previewFile` 的 PDF 分支随之能走 `preview.error` 兜底面板。
2. **后端（更根治但影响面大）**：`handleError` 对业务错误一律 200 是平台既有约定，用户侧 `/v1/files/workspace-*` 同享此语义，单方面改动需评估全局影响，不建议在本需求内顺手改。

---

## 3. 已验证通过的关键点（防误伤，简要记录）

- **越界收口**：六个端点全部经 `WorkspaceBrowseService.resolvePath` → `StrictPathResolver`，相对穿越 / 越界绝对路径 / 符号链接逃逸均 `FORBIDDEN(1002)` → HTTP 403（既有 spec + bugcheck 对照组双重验证）
- **权限**：六端点均先 `requireRequestPermission(..., 'session:read')`；无权限 403（既有 spec 验证）；不做出属主校验符合 D1
- **LOCAL / 无工作区会话**：`requireBrowsableSession` 双保险 + 前端 `canBrowseFiles` 门禁，口径一致
- **审计（D7）**：全局 `onResponse` 钩子的 `AUDITED_PREFIXES` 含 `/v1/admin` 且不限方法；`objectType=admin.sessions`、`objectId` 取路径首个数字段（会话 id）推导正确，下载天然留痕，无需显式 `record()`
- **符号链接条目**：`listDirectory` 返回 `isDirectory=false, isSymlink=true`，前端禁用进入/预览并标注「链接」
- **目录优先排序 / 500 条截断 / 搜索 100 条上限 / `formatSize` / `formatTime`**：与桌面端逐行一致，既有 spec 覆盖
- **下载 zip 临时文件清理**：`close` / `error` 双钩子 `unlinkSync`，既有 spec 验证流后清理
- **D6 聊天记录联动**：`FileChangePanel` 的 `inWorkspace` 判定（`relativePath !== c.path || !isAbsoluteLike(...)`）对「路径在工作区内 / 前缀相似但不在（929 vs 9290）/ 绝对路径在工作区外 / 无 workspace」四种情形结论均正确；`toRelativeWorkspacePath` 对不存在情形原样返回绝对路径，不会误标可点
- **构建与存量测试**：`admin npm run build`（vue-tsc -b + vite build）通过；`backend-ts npm run build` 通过；`src/session src/file` 594 条存量测试通过

---

## 4. 已排查但未列为 bug 的候选（附排除理由）

| 候选 | 排除理由 |
| --- | --- |
| `pathId` 收到非数字 id（NaN） | `getSession(NaN)` → `SESSION_NOT_FOUND`，与既有 admin 路由同口径，非本次引入 |
| 搜索 / 目录加载的并发竞态（快速连续点击时 `entries` 与 `currentDir` 可能短暂不一致） | 瞬时且下一次导航即自恢复，无法构造确定性失败测试，按审查方法不采纳 |
| 裸 `fetch` 无 401 静默刷新 | 方案 §11.3 明知取舍（换取无 30s 掐断与可读错误体），失败时有明确错误提示 |
| `loadDirectory` 失败时 `state.currentDir` 仍指向失败目录、dialog 错误文案固定为「工作区目录不存在或已被清理」 | 与方案 §5.5 约定的空态文案一致。**2026-10-16 补充**：该文案会把「URL 拼错导致 404」误报成「目录不存在」（线上即此形态，见 CHANGELOG 0.0.298 管理后台小节的修复）。纯展示层的其他失败（权限 403、会话不存在）仍有各自的明确 toast，仅目录这一路的文案对失败原因不敏感——后续若要细化，宜把后端 message 一并透出 |
| PDF blob 为空（size 0）时 iframe 空白 | 服务端 PDF 头校验已拦截空文件，桌面端同款行为 |
| 关闭 Dialog 后 `searchInput` 残留上次关键词 | 纯展示层瞬时态，不影响功能正确性 |

---

## 5. 环境与验证备注

- 已知环境噪音（与本次改动无关，未当 bug）：worktree 路径超长导致 backend-ts 全量测试中 `runtime-agent.spec.ts` 等 2 个用例 EADDRINUSE 失败（macOS unix socket 104 字符限制），主工作区同代码通过
- 本次审查未修改任何产品代码（`git diff HEAD` 为空，仅新增 `backend-ts/src/session/admin-session-files.bugcheck.spec.ts` 一个未跟踪测试文件）；bugcheck 修复后应转绿，可参照 2026-10-14 评审的先例转为回归测试保留
