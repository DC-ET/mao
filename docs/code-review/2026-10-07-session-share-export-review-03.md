# 会话只读分享与 Markdown 导出 — 代码审查（第三轮）

- 日期：2026-10-07
- 范围：当前 git 工作区未提交改动中的功能逻辑（文档 diff 未审）
- 对照：`docs/plan/2026-10-06-session-share-export-technical-design.md` 的预期行为
- 审查方式：只读核对 + 临时探针实测。探针（后端 Vitest、前端页内评测 + headless Chrome 实测渲染尺寸 / 真实 XHR 报文）跑完即删，未改产品代码，也未改原有测试。

## 结论

发现 3 个功能缺陷，均可复现。分享的创建幂等、并发锁、水位截断与回落、撤销、属主停用、匿名开关与过期判定、审计脱敏、导出四节内容、`getMessagesByRounds` 新增参数的分页语义，在现有实现和单测覆盖的路径上没有看到问题。

`docs/code-review/2026-10-07-session-share-export-review-01.md` 与 `-02.md` 报告的问题在当前代码中均已修复，本轮不复述、不复验。

---

## BUG-1 会话标题切在 astral 字符中间时，导出端点直接 500

`sanitizeExportFileName` 用 `String.prototype.slice(0, 80)` 截断，这是按 UTF-16 码元切的。emoji（及所有 astral plane 字符）占两个码元，标题长度恰好落在第 80 位时尾部留下孤立高代理项，接着 `contentDisposition` 里的 `encodeURIComponent` 对孤立代理项抛 `URIError: URI malformed`。`handleError` 只识别 `BusinessException`，`URIError` 落到 500 分支。

```31:36:backend-ts/src/session/session-export.service.ts
export function sanitizeExportFileName(title: string | null | undefined, now = new Date()): string {
  const raw = (title ?? '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const base = (raw.length > 0 ? raw : '会话').slice(0, 80);
  const day = shanghaiYmd(now).replace(/-/g, '');
  return `${base}-${day}.md`;
}
```

```320:324:backend-ts/src/file/file.routes.ts
export function contentDisposition(kind: 'attachment' | 'inline', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"');
  const encoded = encodeURIComponent(fileName);
```

调用链：`GET /v1/sessions/:id/export/markdown` → `SessionExportService.render` → `sanitizeExportFileName` → `sendMarkdown` → `contentDisposition`。

影响：属主点「导出 Markdown」拿到 HTTP 500 + `INTERNAL_ERROR`，功能对该类标题不可用，也没有可理解的提示。触发条件是「标题第 80 个码元落在代理对中间」，含 emoji 的标题很容易命中。

复现：探针挂真实 `registerSessionShareRoutes`，`exportService.render` 返回 `sanitizeExportFileName('A'.repeat(79) + '😀')` 的文件名，`GET /v1/sessions/11/export/markdown`。

```text
AssertionError: expected 500 to be 200
- Expected
+ Received
- 200
+ 500
```

命令（探针 `backend-ts/src/session/session-share-review-probe.spec.ts`，跑完已删）：

```bash
cd backend-ts && npx vitest run src/session/session-share-review-probe.spec.ts
# Tests  2 failed (2)
```

---

## BUG-2 匿名分享端点把非业务异常抛成 500，而非统一 404 不暴露

公开端点的 try/catch 只把 `SHARE_NOT_FOUND` 一种业务码映射成 404，其余异常穿透到全局 `handleError`。匿名端点是免登录暴露面，500（带 `INTERNAL_ERROR` 信封）与开关关闭 / 链接失效的 404 形成可区分信号，且内部错误信息直接回到未认证调用方，与 §5.4「校验链任一不满足统一返回，不泄露存在性差异」、决策 7「404 不暴露语义」相悖。

```86:103:backend-ts/src/session/session-share.routes.ts
    try {
      const token = pathToken(request);
      const payload = await shareService.readView(
        token,
        queryOptInt(request, 'roundLimit') ?? 5,
        queryOptInt(request, 'beforeMessageId') ?? null,
        null,
        `/v1/share/public/${token}`,
        true,
      );
      return sendOk(reply, payload);
    } catch (e) {
      if (e instanceof BusinessException && e.code === ErrorCode.SHARE_NOT_FOUND.code) {
        return reply.status(404).send({ error: 'not found' });
      }
      throw e;
    }
```

可触发路径：`readView` → `requireLiveSession` → `users.findById` / `getMaxMessageId` / `getMessagesByRounds` 任一非业务异常（连接池耗尽、`messageWatermark` 脏数据等）。仓库里已有闭合更严的先例可对照：`agent-bundle.routes.ts:86-93` 对未知异常也归一为固定状态码（409），而不是 `throw e`。

复现：探针用真实 `registerSessionShareRoutes`，`readView` 抛普通 `Error`，`GET /v1/share/public/<64hex>`。

```text
AssertionError: expected 500 to be 404
- Expected
+ Received
- 404
+ 500
```

命令同 BUG-1（同一探针文件第 2 个用例）。

---

## BUG-3 ShareDialog 的 `publicLink` / `expiresInDays` 在两次打开之间残留

`ShareDialog` 的两个宿主（`TaskIndexPanel.vue`、`SideTaskList.vue`）各持有一个常驻实例，靠 `v-model` 切换显隐，切换时只改 `sessionId`。`publicLink`、`expiresInDays` 是组件级 `ref`，既不在 `load()` 里复位，也没有 `@closed` 复位。

```70:77:desktop/src/components/task/ShareDialog.vue
async function load() {
  if (!props.sessionId) return
  loading.value = true
  try {
    share.value = await getSessionShare(props.sessionId)
  } catch {
    share.value = null
  } finally {
    loading.value = false
  }
}
```

```65:66:desktop/src/components/task/ShareDialog.vue
const publicLink = ref(false)
const expiresInDays = ref(7)
```

影响链条：

1. 属主对会话 A 勾了「匿名链接」（即便 POST 因开关关闭而失败，勾选态仍在）；
2. 关闭对话框，对会话 B 右键「分享…」——复用的同一个实例，勾选态和天数原样带过来；
3. 属主点「生成链接」，POST 出去的载荷带着 `publicLink: true`。若开关是开的，会话 B 静默变成**免登录可读**的匿名链接（7 天有效），与属主以为的「登录用户可读」相反——这是治理方向的偏差，不是纯文案问题；
4. 若开关是关的，POST 400 且 `catch` 里只有注释、无任何提示，属主看到的是「点了没反应」。

另外 `share-hint` 的判定条件 `{{ share?.expiresAt || publicLink ? '匿名链接…' : '任何登录用户…' }}`（`ShareDialog.vue:10`）在已存在分享的分支里根本拿不到 `publicLink` 的真实含义，与 `link` 计算（只按 `expiresAt`，`sessionShare.ts:8`）口径不一致。

复现：headless Chrome 加载真实 `ShareDialog.vue`（由 Vite dev server 即时编译），单个实例挂 `modelValue`/`sessionId`，先对会话 11 勾选匿名链接，关闭后对会话 12 打开，并点击「生成链接」。

```json
{
  "o1":       { "publicLinkChecked": false, "days": null, "showsDaysInput": false, "hintStartsWith": "任何登录用户持链接可读。" },
  "o1t":      { "publicLinkChecked": true,  "days": "7",   "showsDaysInput": true,  "hintStartsWith": "匿名链接无需登录，任何持" },
  "o2":       { "publicLinkChecked": true,  "days": "7",   "showsDaysInput": true,  "hintStartsWith": "匿名链接无需登录，任何持" },
  "calls": [
    { "method": "POST",
      "url": "http://localhost:9080/api/v1/sessions/12/share",
      "body": "{\"publicLink\":true,\"expiresInDays\":7}" }
  ]
}
```

对会话 12 发出的就是匿名链接请求。探针跑完已删。

---

## BUG-4 边路任务右键菜单的哨兵值未随新增两项更新，贴底唤出时菜单被裁切

`SideTaskList` 的右键菜单本轮从 3 项变 5 项（新增「分享…」「导出 Markdown」），但 `openContextMenu` 里的宽高哨兵仍是旧值。

```163:167:desktop/src/components/task/SideTaskList.vue
  const menuWidth = 150
  const menuHeight = 112
  const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8)
  const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8)
```

headless Chrome 按 `style.css` 的真实变量实测：`.side-task-context-menu` 5 项渲染为 **156 × 168 px**（`--aw-text-caption: 14px`、`line-height: 1.2`、`padding: 7px 10px`、容器 `padding: 6px`）。哨兵高度少了 56 px。

实测裁剪量（`sentinelY + 168` 超出视口底部）：

| 视口 | 右键位置 | sentinelY | 菜单底部 | 底部溢出 |
|---|---|---|---|---|
| 1280×900 | (1240, 860) | 780 | 948 | 48 px |
| 1000×600 | (990, 590) | 480 | 648 | 48 px |
| 600×400 | (590, 390) | 280 | 448 | 48 px |

影响：在任务列表接近视口底部的位置右键，「分享…」「导出 Markdown」两项正好落在溢出区，用户看不见也点不到；触屏长按（`onTouchStart` 走同一个 `openContextMenu`）在矮屏安卓 WebView 上同样命中。`menuWidth=150` 也比实测 156 小 6 px，贴右时菜单右边界略微出界。

对照：`TaskIndexPanel.vue:321-322` 本次已同步改成 `160 × 200`，实测菜单 142 × 170 px，留有余量，没问题。仓库里 `GitContextMenu.vue:70-81` 与 `FileTreeContextMenu.vue` 用 `nextTick` + `getBoundingClientRect()` 实测校正，是可复用的更稳模式。

---

## 验证命令

```bash
# 基线（改动前）：全绿
cd backend-ts && npm test
# Test Files  251 passed | 1 skipped (252)
#      Tests  2819 passed | 14 skipped (2833)

# 本轮四个缺陷的复现探针：
# - BUG-1 / BUG-2：backend-ts/src/session/session-share-review-probe.spec.ts（2 failed）
# - BUG-3 / BUG-4：页内评测 + headless Chrome 实测（见各条 JSON / 表格）
# 探针均已删除；产品代码与审查开始时的测试文件保持原状。
```

## 未运行

本轮未跑 `desktop` 全量单测（该包无组件测试基建，`@vue/test-utils` / jsdom 均未安装）；也未跑根目录 Playwright。前端三条结论均以静态核对 + 真实浏览器实测为依据。
