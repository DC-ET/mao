# 回复引用溯源（answer-citations）未提交改动代码审查 — Round 1

- **日期**：2026-10-12
- **工作区**：`/Users/yangjiayi/AiProjects/mao/.worktrees/answer-citations`（分支 `feat/answer-citations`），审查对象为 `git status` 中的全部已修改文件与未跟踪新文件（不含文档类改动：CHANGELOG / README / skills 文档按审查要求忽略）。
- **方法**：对照 `docs/plan/2026-10-12-answer-citations-technical-design.md` §2/§5/§7/§8 逐条核对实现；每个候选 bug 均补临时探针测试实跑复现，探针断言写「当前行为」以证明 bug 真实存在（非假想）。探针已全部删除，工作区恢复为原始改动集（`git status` 与审查前一致）。
- **基线健康度**：审查前 `backend-ts` 4 个相关 spec（`message-citations` / `citation-markers` / `task-terminal.service` / `prompt-engine`）82 个用例全绿；`desktop` 3 个相关 spec 25 个用例全绿；`backend-ts npm run build`（tsc）与 `desktop npm run build`（vue-tsc -b && vite build）均通过。**即：现有测试全绿，但下述 5 个 bug 全部逃过现有测试**（根因见「测试覆盖缺口」）。
- **结论**：确认 **5 个 bug**（1 严重 / 1 高 / 2 中 / 1 低），其中 BUG-1 会导致最常见的 markdown 结构（列表）在桌面端整条消息渲染空白，属阻塞级回归。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 严重 | desktop/useMarkdown | `text` renderer 覆写调用 `marked.parser.parseInline`，marked v18 的 `Marked` 实例无该方法 → 含紧凑列表（无序/有序/任务/嵌套）的消息整体渲染抛错，正文空白 |
| BUG-2 | 高 | desktop/useMarkdown | `text` renderer 用自研 `escapeHtml` 全量转义 `&`，取代 marked 默认的实体感知 escape → 消息里的 HTML 实体（`&amp;`/`&lt;`/`&copy;` 等）被双重转义，用户看到 `&amp;` 字样 |
| BUG-3 | 中 | desktop/MessageBubble | 来源条目点击用裸 `window.open`，未走项目统一的 `openExternalUrl` → 安卓 Capacitor 壳（WebView 无多窗口支持）点击来源毫无反应 |
| BUG-4 | 中 | backend/task-terminal + desktop/useChat | `session_status(COMPLETED)` WS 事件先于 citations 落库发出，桌面端 `fetchMessages()` 与异步 citations 写入竞态 → 来源区/上标首屏可能缺失，需手动刷新才出现 |
| BUG-5 | 低 | desktop/useMarkdown | 链接文本内的 `[^n^]` 不被转换、原样泄漏（链接 renderer 对原始 text 直接 escape，嵌套标记走不到 text renderer） |

---

## BUG-1【严重】`marked.parser.parseInline` 在 marked v18 不存在，含列表的消息整体渲染失败

### 位置

`desktop/src/composables/useMarkdown.ts:52-58`（本次新增的 `text` renderer 覆写，关键行 :54）

```ts
text(token: { text?: string; tokens?: unknown[]; escaped?: boolean }) {
  if (token.tokens && token.tokens.length > 0) {
    return (marked as unknown as { parser: { parseInline: (tokens: unknown[]) => string } }).parser.parseInline(token.tokens)
  }
  const raw = token.escaped ? (token.text ?? '') : escapeHtml(token.text ?? '')
  return renderCitationMarkers(raw, citeMap)
},
```

### 代码事实

marked v18（`desktop/package.json` 锁定 `marked@^18.0.4`，实测安装 18.0.4）的 `Marked` 实例暴露的是 `options / renderer / textRenderer`，**没有带 `parseInline` 的 `parser`**；默认 renderer 方法内部用的 `this.parser` 是 `Renderer` 实例上的 parser。探针实测（jsdom 环境）：

```
C9 => parser = [Function: parser] | renderer.parser = undefined
```

即 `marked.parser` 存在但不是带 `parseInline` 的对象，`marked.parser.parseInline` 恒为 `undefined`，调用即 `TypeError`。

marked 对**紧凑列表**（tight list：`- a\n- b`、`1. a\n2. b`、`- [ ] x`、嵌套列表）的 tokenize 结果是：listitem 的 `tokens` 里是一个**带子 tokens 的 `text` token**。因此只要消息含紧凑列表，就必然走进上面第一个分支并抛错；松散列表 / 引用 / 表格 / 标题的正文走 `paragraph`/`blockquote`/`table` renderer，其叶子 text token 无子 tokens，走第二个分支，不受影响。

`MarkdownContent.vue:25-39` 的 watcher **没有 try/catch**：`await renderMarkdown(...)` 抛错 → 异步 watcher 回调 reject（unhandled rejection）→ `html.value` 保持 `''` → 该条消息 `v-html=""` **正文整体空白**，且 `mao:markdown-rendered` 事件不再派发。

### 触发场景（已核实）

模型回复只要包含紧凑列表即触发，与是否带 `[^n^]` 标记、是否带 citations **完全无关**（无 citeMap 也抛）。实测崩溃面：

| 输入 | 结果 |
| --- | --- |
| `- 项目一\n- 项目二`（无序紧凑列表，无标记） | THROWN |
| `1. 第一步\n2. 第二步`（有序列表） | THROWN |
| `- [ ] 待办\n- [x] 完成`（任务列表） | THROWN |
| `- 一级\n  - 二级`（嵌套列表） | THROWN |
| `- 项目一\n\n- 项目二`（松散列表） | 正常 |
| `> 引用一句` / 表格 / `## 标题` / 普通段落 | 正常 |

这是模型输出里最高频的 markdown 结构之一（"结论如下：1. … 2. …"），桌面/Web/安卓三端所有助手消息全部受影响。

### 预期 vs 实际

- **预期**（设计 §5.5 / §8）：`[^n^]` → 上标；无标记消息渲染与改动前一致；行内代码/代码块内标记不转换。
- **实际**：带子 tokens 的 text token（紧凑列表项）直接抛 `TypeError: marked.parser.parseInline is not a function`，整条消息渲染空白。

### 影响

- 桌面 / Web / 安卓三端：任何含列表的助手回复显示为空白气泡（仅剩复制按钮等外围 UI），分享页（ShareView → ChatRoundList → MessageBubble）同样中招。
- 属于本次改动引入的**纯回归**：改动前默认 `text` renderer 用 `this.parser.parseInline` 正常渲染列表（A/B 实测见下）。

### 验证测试与运行输出

探针 A（当前行为，必然失败——证明 bug 存在），`desktop/src/composables/zz-cite-probe3.test.ts`（jsdom 环境，已删除）：

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Marked } from 'marked'
import { renderMarkdown } from './useMarkdown'

describe('probe: A/B against default marked (pre-change behavior)', () => {
  it('C13 默认 marked 渲染紧凑列表（覆写前的行为）', async () => {
    const m = new Marked()
    const out = await m.parse('- 项目一\n- 项目二')
    expect(String(out)).toContain('<li>项目一</li>')   // 通过：改动前行为正常
  })
  it('C15 renderMarkdown 对紧凑列表抛错（覆写后的行为）', async () => {
    await expect(renderMarkdown('- 项目一\n- 项目二', false)).rejects.toThrow()  // 通过：当前代码必抛
  })
  it('C16 renderMarkdown 对任务列表抛错（覆写后的行为）', async () => {
    await expect(renderMarkdown('- [ ] 待办\n- [x] 完成', false)).rejects.toThrow()  // 通过
  })
  it('C18 混合内容：段落 + 列表（典型模型回复）', async () => {
    // '结论如下：\n\n- 要点一\n- 要点二[^1^]' → THROWN: marked.parser.parseInline is not a function
  })
})
```

实测输出（`npx vitest run src/composables/zz-cite-probe3.test.ts`，6 passed）：

```
C13 => <ul>
C14 => <ul>
C17 => <p>普通段落，无列表无标记。</p>
C18 => THROWN: marked.parser.parseInline is not a function
```

探针 B（崩溃面刻画），`zz-cite-probe2.test.ts`（12 passed）：

```
C1 => THROWN: marked.parser.parseInline is not a function   （无序紧凑列表）
C2 => THROWN: marked.parser.parseInline is not a function   （有序列表）
C3 => <ul>                                                   （松散列表，正常）
C4 => <blockquote>                                           （正常）
C5 => <table>                                                （正常）
C6 => THROWN: marked.parser.parseInline is not a function   （嵌套列表）
C7 => THROWN: marked.parser.parseInline is not a function   （任务列表）
C8 => <p>普通段落</p>                                        （正常）
C9 => parser = [Function: parser] | renderer.parser = undefined
```

> 说明：探针通过 `ln -s ../../backend-ts/node_modules/jsdom desktop/node_modules/jsdom` 临时提供 jsdom（desktop 自身未装 jsdom，且 `vitest.config.ts` 为 `environment: 'node'`），探针删除后 symlink 已一并移除，`git status` 干净。

### 修复方向（仅建议，未改动代码）

`text` renderer 的 tokens 分支改用 renderer 自身的 parser（marked v18 renderer 方法内 `this` 即 Renderer 实例）：`(this as unknown as { parser: { parseInline(t: unknown[]): string } }).parser.parseInline(token.tokens)`；或直接不覆写无子 token 之外的逻辑、把 `renderCitationMarkers` 只应用于叶子分支并用默认行为处理 tokens 分支。

---

## BUG-2【高】自研 `escapeHtml` 全量转义 `&`，HTML 实体被双重转义

### 位置

`desktop/src/composables/useMarkdown.ts:10-17`（`escapeHtml`，既有函数）与 `:56`（本次新增的 `text` renderer 叶子分支调用它）：

```ts
const raw = token.escaped ? (token.text ?? '') : escapeHtml(token.text ?? '')
return renderCitationMarkers(raw, citeMap)
```

### 代码事实

marked 默认 `text` renderer 是 `"escaped" in e && e.escaped ? e.text : escape(e.text)`，其 `escape` 使用 `escapeReplaceNoEncode`（`/&(?!#?\w+;)|<|>|"|'/g`）——**只转义尚未构成实体的 `&`**。而本文件的 `escapeHtml` 是无条件 `.replace(/&/g, '&amp;')`。覆写后，凡是输入里已存在的实体都会被再转义一次。

### 触发场景

助手消息 / 用户消息正文中出现 HTML 实体即触发，例如：模型输出 `&amp;`、`&lt;div&gt;`、`&copy;`、`&#39;`、`&nbsp;`（粘贴的 HTML 片段、URL 查询参数写成实体、模型转义 HTML 标签时非常常见）。实测 A/B（同一输入，默认 marked vs 覆写后 `renderMarkdown`）：

```
C10 => <p>A &amp; B &lt;tag&gt; 5 &gt; 3 &copy;</p>        （默认 marked：正确）
C11 => <p>A &amp;amp; B &amp;lt;tag&amp;gt; 5 &gt; 3 &amp;copy;</p>  （覆写后：双重转义）
```

页面渲染后用户直接看到字面量 `&amp;`、`&lt;`、`&amp;copy;`。裸 `&`/`<`/`>`（非实体）不受影响（`C12 => <p>A &amp; B &lt;tag&gt; 5 &gt; 3</p>` 正常），因此是「只坏一半」的隐蔽回归，普通纯文本消息完全看不出问题。

### 预期 vs 实际

- **预期**：非标记相关文本的渲染与改动前完全一致（设计 §5.5 只要求把 `[^n^]` 变成 sup）。
- **实际**：所有历史消息 / 新消息里的 HTML 实体显示为双重转义文本。

### 影响

全量历史消息 + 新消息的桌面/Web/安卓渲染与分享页；JSONL 导出不受影响（导出走原始 content）。严重度评为「高」：可见文本错误、影响面 = 全部含实体的消息，且无测试覆盖导致必然漏到合并后。

### 验证测试与运行输出

探针 `zz-cite-probe2.test.ts`（已删除，12 passed），关键两例：

```ts
it('C10 默认 marked（无 text 覆写）对实体的输出', async () => {
  const m = new Marked()
  console.log('C10 =>', await m.parse('A &amp; B &lt;tag&gt; 5 > 3 &copy;'))
})
it('C11 覆写后 renderMarkdown 对实体的输出', async () => {
  console.log('C11 =>', await renderMarkdown('A &amp; B &lt;tag&gt; 5 > 3 &copy;', false))
})
```

以及 `zz-cite-probe.test.ts` 的 P8（4 failed 之一）：

```
P8 => <p>A &amp;amp; B &amp;lt;tag&amp;gt; "q" 's' 5 &gt; 3</p>
AssertionError: expected '<p>A &amp;amp; B …' to contain 'A &amp; B &lt;tag&gt;'
```

### 修复方向（仅建议）

叶子分支不要自绘转义：无标记可替换时原样返回 `token.text`（交由末尾统一的 `DOMPurify.sanitize` 兜底转义），或复用 marked 的实体感知 escape 语义（`&` 仅在不是实体一部分时转义）。

---

## BUG-3【中】来源条目点击用裸 `window.open`，安卓壳下点击无响应

### 位置

`desktop/src/components/chat/MessageBubble.vue:497-500`（本次新增的 `openCitation`）：

```ts
function openCitation(c: Citation): void {
  window.open(c.url, '_blank', 'noopener,noreferrer')
}
```

### 代码事实

项目有统一的三端外跳能力 `desktop/src/utils/capacitor.ts` 的 `openExternalUrl(url)`：Electron 走 IPC、安卓 Capacitor 走自研 `OpenUrl` 插件（`@capacitor/app` / `Browser` 兜底）、Web 才 `window.open`。`desktop/src/utils/externalLink.ts` 的文件头注释明确记录了原因：

> 安卓 Capacitor 壳的 WebView 没有开启多窗口支持，`window.open` 直接失败，点击链接毫无反应。

`openCitation` 绕过了该能力。设计 §2.1.7 明确要求「点击经 `openExternal` 外跳（复用 `isSafeHref` 仅 http/https）」——实现与设计不符。安全性无虞（`extractCitationsFromMetadata` 已过滤非 http(s)），问题纯粹是安卓端点了没反应。

### 触发场景

安卓壳（`android/` Capacitor 远程加载）打开任意带 citations 的回复，点击「来源 N」区的条目 → 无任何反应（WebView 拦截 `window.open` 且无 native 兜底）。桌面/Web 正常（Electron 的 `setWindowOpenHandler` 会接住 `target=_blank`）。

### 预期 vs 实际

- **预期**：三端（桌面/Web/安卓）点击来源均系统浏览器打开；安卓走 OpenUrl 插件。
- **实际**：安卓端点击无响应。

### 验证测试与运行输出

探针 `desktop/src/utils/zz-cite-android-probe.test.ts`（jsdom 环境，已删除，3 passed）：

```ts
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { openExternalUrl } from '../utils/capacitor'

describe('probe: citation click external jump on Android', () => {
  it('A1 源码事实：openCitation 用 window.open，而非项目统一的 openExternalUrl', () => {
    const src = readFileSync('<worktree>/desktop/src/components/chat/MessageBubble.vue', 'utf8')
    const fn = src.slice(src.indexOf('function openCitation'), src.indexOf('function openCitation') + 300)
    expect(fn).toContain('window.open(')
    expect(fn).not.toContain('openExternalUrl')   // 通过：确认未走统一外跳
  })
  it('A2 安卓环境下 openExternalUrl 走 OpenUrl 插件（项目统一外跳能力）', async () => {
    const openUrl = vi.fn(async () => undefined)
    ;(window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true, getPlatform: () => 'android',
      Plugins: { OpenUrl: { openUrl } },
    }
    expect(await openExternalUrl('https://a.example.com')).toBe(true)
    expect(openUrl).toHaveBeenCalledWith({ url: 'https://a.example.com' })  // 通过
  })
  it('A3 安卓环境下 window.open 不触达任何原生插件（点击无响应的成因）', () => {
    const openUrl = vi.fn(async () => undefined)
    ;(window as unknown as { Capacitor: unknown }).Capacitor = { /* 同上 */ }
    window.open('https://a.example.com', '_blank', 'noopener,noreferrer')
    expect(openUrl).not.toHaveBeenCalled()   // 通过：window.open 到不了插件
  })
})
```

实测输出：

```
A1 openCitation => function openCitation(c: Citation): void {
 ✓ A2 安卓环境下 openExternalUrl 走 OpenUrl 插件（项目统一外跳能力）
 ✓ A3 安卓环境下 window.open 不触达任何原生插件（点击无响应的成因）
```

### 修复方向（仅建议）

`openCitation` 改为 `void openExternalUrl(c.url)`（url 已在 extract 阶段过滤为 http(s)，无需再叠 `isSafeHref`）。

---

## BUG-4【中】`session_status(COMPLETED)` 先于 citations 落库，桌面首屏刷新与 citations 写入竞态

### 位置

- 后端：`backend-ts/src/session/task-terminal.service.ts:131`（`sendWithResult(ownerId, wsEvent('session_status', { phase, ... }))`）vs `:158-159`（`dispatchMemoryExtraction` → `dispatchCitationRegistry`，后者经 `agentExecutor` fire-and-forget 执行 `MessageCitationService.buildForSession`）。
- 前端：`desktop/src/composables/useStreamWS.ts:663-733`（收到 `session_status` 终态）→ `desktop/src/composables/useChat.ts:813-835`（phase watcher 在 `COMPLETED` 时 `fetchMessages()` 全量重拉消息）。

### 代码事实

`finishExecution` 内 WS 事件（触发桌面 `fetchMessages`）在 citations job **提交之前**就已发出；citations 的 3 次 DB 往返（`selectLastAssistantMessage` → `listBySession` → `updateById`）发生在这之后。探针实测时序（R1）：

```
R1 finishExecution 返回后 order = ["ws:session_list_update","ws:session_status"]
R1 job 执行后 order = ["ws:session_list_update","ws:session_status","citation:build"]
```

即桌面端收到 COMPLETED 并发起 `fetchMessages()` 的时刻，citations  job 连提交都尚未发生（`finishExecution` 返回时 `buildForSession` 一次都没被调用）。

### 触发场景

任务完成瞬间桌面端的那一次全量重拉，与 citations 的 `UPDATE message SET metadata` 是两条并发的时间线。DB 空闲时 citations 写入（事件后约几 ms）通常能赢；但在 DB 慢查询 / 事件循环拥塞 / `agentExecutor` 核心线程被占满（默认 core=20，记忆抽取等 job 同池，见 `create-app.ts:1057-1061`、`settings.service.ts:132`）时，前端 REST 查询先落地 → 拉到的最终消息 `metadata` 为 null → **来源区与上标首屏不渲染**，且此后没有任何事件再触发重拉（`session_status` 只发一次），用户必须手动刷新 / 切换会话再切回才能看到。

### 预期 vs 实际

- **预期**（设计 §8「COMPLETED 触发构建并写库」+ 桌面渲染）：任务完成后来源区随最终回复呈现。
- **实际**：非确定性竞态，失败时来源区静默缺失（无报错、无重试），功能表现为「时好时坏」。

### 影响

桌面/Web/安卓三端首屏；分享快照不受影响（按消息水位冻结，之后生成快照自然含 citations）。因无确定性复现路径（竞态），严重度评为「中」：功能最终一致（刷新即恢复），但首次完成时可能静默丢失，且用户无从感知。

### 验证测试与运行输出

探针 `backend-ts/src/session/zz-cite-race-probe.spec.ts`（已删除，1 passed）：记录 `registry.send/sendWithResult` 与 `citationRegistry.buildForSession` 的相对顺序，断言 `finishExecution` 返回时 `session_status` 已发出而 `buildForSession` 尚未执行，且事件顺序上 `session_status` 严格早于 `citation:build`（输出见上）。

### 修复方向（仅建议）

任选其一：① `dispatchCitationRegistry` 移到 `finishExecution` 内 WS 事件发送之前（仍在 COMPLETED 分支内、保持 void + try-catch）；② 前端在终态重拉时对最终消息做一次延迟补拉（如 300ms 后若 metadata 仍无 citations 且正文含 `[^n^]` 再拉一次）；③ citations 写库后经 WS 补发一次 `message_updated` 事件。

---

## BUG-5【低】链接文本内的 `[^n^]` 不被转换，原样泄漏

### 位置

`desktop/src/composables/useMarkdown.ts:59-67`（`link` renderer，既有代码）与 `:52-58`（本次 `text` renderer）的交互：

```ts
link({ href, text }) {
  ...
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`
}
```

marked v18 传给 `link` renderer 的 `text` 是链接的**原始文本**（子 tokens 在 `tokens` 字段），此处直接 escape 输出，链接内部的嵌套内容（加粗、行内代码、以及本次的 `[^n^]`）永远走不到 `text` renderer。

### 触发场景

模型把标记写进链接文本：`详见[政策页面[^1^]](https://a.example.com)`。实测：

```
D7 => <p>详见<a href="https://a.example.com" target="_blank" rel="noopener noreferrer">政策[^1^]</a>。</p>
```

标记在链接外（`...详见[政策](url)[^1^]。`）则完全正常（`D6` 输出含 `<sup class="cite-ref" data-cite="1">[1]</sup>`）。

注意：链接内嵌套 markdown 失效是**改动前既有行为**（实测 `D8`：`见[**粗体**](url)` → `<a>**粗体**</a>`），本 bug 的「新」仅在于泄漏物变成了 `[^n^]` 这种模板变量式字样——正是设计想消除的观感。按契约「标记插在被支撑句末」，模型更常写在链接后（正常路径），故严重度评为「低」。

### 验证测试与运行输出

探针 `zz-cite-probe4.test.ts`（已删除）：`D7` 输出见上（raw `[^1^]` 在 `<a>` 内）；`D6` 为对照（链接外标记正常转上标）。

### 修复方向（仅建议）

`link` renderer 对 `tokens` 存在时走 `parseInline`（或直接沿用 BUG-1 修复后的正确 parser 调用），使链接内嵌套内容（含标记）正常渲染。

---

## 次要观察（不构成功能 bug，记录备查）

1. **`markedCache` 缓存键无上限增长**（`useMarkdown.ts:79-95`）：缓存键从「主题」扩展为「主题 + citeMap」，每条 citations 组合各建一个 `Marked` 实例，长会话下缓存条目数随不同引用集线性增长（每个实例仅数 KB，非泄漏级，但可考虑改为「主题 + 是否有 citeMap」两层、citeMap 通过 parse 时参数注入而非闭包）。
2. **来源标题截断靠 CSS ellipsis**（`MessageBubble.vue` `citationDisplayTitle`）：设计 §2.1.7 写「超 60 字截断」，实现未做字符截断、由 `text-overflow: ellipsis` 视觉截断。功能等价，仅记录与设计文字的偏差。
3. **`mergeCitationsMetadata` 遇非对象 JSON 会丢既有 metadata**（`message-citations.ts:104-112`）：`existing` 为 `"[]"` / `"null"` / 数字时 `parseJson` 返回 null，root 重置为 `{}`，既有键丢失。当前最终 ASSISTANT 消息的 metadata 恒为 null 或对象，实际不可达，属防御性缺口。
4. **`selectLastAssistantMessage` 取不到当轮回复时的挂错风险**（设计 §9 风险 6 已接受）：最终回复 content 为空串时（`content <> ''` 过滤）会挂到更早的 ASSISTANT 行，表现为来源区出现在折叠的工具消息上。属设计已接受项，仅确认实现与设计一致。

---

## 测试覆盖缺口（两个桌面 bug 逃过现有测试的根因）

1. **`renderMarkdown` 全链路零自动化覆盖**：`desktop/vitest.config.ts` 为 `environment: 'node'` 且未安装 jsdom，而 `renderMarkdown` 依赖 `document`（`ensureCodeCopyDelegation` / `ensureExternalLinkDelegation`）与 DOMPurify（需 window）——现有测试根本跑不了这条链路；本次新增的 `citationMarkers.test.ts` / `MessageBubble.citations.test.ts` 只覆盖了纯函数与 SFC 源码 AST，marked + DOMPurify 的集成行为无任何用例。BUG-1 / BUG-2 / BUG-5 均出于此。建议补一个 jsdom 环境的 `useMarkdown` 集成用例（段落 / 加粗 / 紧凑列表 / 任务列表 / 实体 / 代码块 / 链接各一），并以「无 citeMap 时输出与改动前一致」为回归锚点。
2. **渠道剥离无 spec 锚点**：设计 §7 要求三渠道「各自的既有 spec 补输出无 `[^n^]`」，实际 `weixin/agent-inbound-handler.spec.ts`、`feishu/agent-inbound-handler.spec.ts`、`dingtalk/agent-inbound-handler.spec.ts` 均未改动。剥离逻辑本身（一行 `stripCitationMarkers`）经单元测试覆盖，但「渠道出口真的调到了」无测试保护，后续重构易丢。

---

## 附录：排查后确认不构成 bug 的候选（供后续审查去重）

- registry 范围圈定（最后一条 USER id 之后的 TOOL 消息）：与消息队列（排队消息落 `message_queue` 表、终态后才消费）、子代理 followup（每轮新 USER 消息）、定时/开放 API（无新 USER 消息时上界为旧 USER id）均兼容，实测 spec 覆盖；无越界。
- `buildToolNameIndex` 的 tool_calls JSON 结构与 `harness-service.ts:137`（`JSON.stringify(toolCalls)`，`{id, function:{name, arguments}}`）一致，映射可靠。
- `web_search` / `open_web_page` 工具结果形态与 registry 解析（`results[]` / 字符串 `content`）逐字段核对一致；TOOL 消息落库为完整 JSON（截断只写 `resultTruncated` 元数据），不会出现解析失败。
- DOMPurify 默认放行 `data-*`（`ALLOW_DATA_ATTR` 默认 true）与 `sup`/`class`，上标 `data-cite` 属性可存活（实测 P1 输出含完整 `<sup class="cite-ref" data-cite="1">[1]</sup>`），点击委托链路不断。
- 流式半截标记（`[^1^` 未闭合）不渲染上标、完整后正常（P9 实测）。
- `FileChangePanel` 从两个分支 hoist 到公共位置：仅 assistant 消息携带 fileChanges，视觉顺序不变（AST 测试已锁死），无行为变化。
- `markedCache` 键碰撞：整数键在 JS 对象中恒升序，`{2:1,1:2}` 与 `{1:2,2:1}` 键相同且映射一致，无串味（P10 实测不同 citeMap 互不干扰）。
- `extractCitationsFromMetadata` 的排序/去重/非法条目过滤、`buildCiteMap` 映射、后端 `strip/extractCitationMarkers` 边界（`[^0^]`、`[^a^]`、`[^1]` 脚注、lastIndex 复用）：均有 spec 且逻辑正确。
- `dispatchCitationRegistry` 的容错（executor 同步抛错 / 异步 reject 均不穿出 `finishExecution`）与 `create-app.ts` 构造参数位置（12 参，citationRegistry 落在第 12 位）：spec 与源码核对一致。
- `create-app.ts` / `dingtalk/runtime.ts` / `weixin/agent-inbound-handler.ts` / `feishu/card-progress-listener.ts` 四处剥离点覆盖了飞书/钉钉/微信的最终文本与流式卡片出口（`complete(finalContent)` 的来源 `getLatestAssistantReply` 均已剥）；出站事件 payload 不含正文，无需处理。
- `backend-ts npm run build`（tsc）与 `desktop npm run build`（vue-tsc -b && vite build）均通过，无类型/构建回归。
