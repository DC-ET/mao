# 2026-10-22 逻辑 BUG 审查报告（一）

> 审查范围：`backend-ts`（后端）、`desktop`（前端共用 UI / 桌面 Electron）核心业务链路。
> 审查方式：通读源码 + 逐条构造可复现场景 + **补充回归用例实跑验证**。
> 结论：**确认 11 个逻辑 BUG**，每个 BUG 都有对应的失败用例证明其真实存在（见「验证用例」一节）。
> 本次审查未修改任何产品代码，只新增验证用例与本报告。
>
> **复核记录（同日二次复核）**：逐条对照源码 + 重跑全部验证用例与默认测试套件后更新本文——
> - 12 条初查结论中 11 条确认存在并实跑复现（后端 12 失败 / 2 通过，前端 7 失败，见 3.3）；
> - **BUG-C1** 的影响链按生产实际布局修正：父目录防护会先于挂载拒绝（实跑证实），「后端工作树被 rw 挂进用户容器」在默认布局下不成立，严重度 P1 → P2；
> - **BUG-S3** 的受影响范围修正：仅滚动条拖拽路径命中，且为 `53fb6dab` 重构前既有的问题；
> - **BUG-C3** 经复核价值不高（触发条件双重苛刻，且默认布局下危害被既有防护拦截），连同对应用例一并移除；
> - 初查未核实到的两处环境事实本次已核实：线上域名 `mao.etarch.cn` 解析到 `120.26.109.221`（阿里云 ECS 段，BUG-E3 的「部署在阿里云」属实）；systemd 单元与 boot 脚本均不设置 `HOME`。

---

## 一、结论摘要

| # | 位置 | 严重度 | 一句话描述 | 回归用例 |
|---|------|--------|-----------|---------|
| BUG-E3 | 后端 `ssrf.ts` / `http-api-executor.ts` | **P0 安全** | SSRF 硬拒名单漏掉阿里云元数据地址 `100.100.100.200`，且该地址被当公网主机放行；URL 模板主机占位符使这条路径**模型可达** | `http-api-executor.review-bugcheck.spec.ts` |
| BUG-E2 | 后端 `http-api-executor.ts` | **P0 安全** | 重定向到不同主机时，解密后的 `Authorization` / `X-Api-Key` 等凭据照旧发出 | 同上 |
| BUG-H2 | 后端 `http-tool.service.ts` | **P1** | 敏感头改名为非敏感键后，掩码哨兵 `******` 被当真实凭据落库，旧密文被销毁 | `http-tool-headers.review-bugcheck.spec.ts` |
| BUG-H1 | 后端 `http-tool.service.ts` | **P1** | 请求头解码按「值以 `enc:` 开头」而非「键是否敏感」判断解密 → 非敏感头值以 `enc:` 开头时工具永久不可用（触发罕见，但失败不可逆且提示误导） | 同上 |
| BUG-S4 | 前端 `useChat.ts` | **P1** | 发送失败回滚用 `sessionId.value`（当前会话）而非入口 `sid` → 回滚打到期间切换过去的会话 | `useChat.rollback.review-bugcheck.test.ts` |
| BUG-S1 | 前端 `useChatScroll.ts` | **P1** | 自动贴底的「距底超过两屏」阈值把「内容单帧暴涨」误判成「用户已离开底部」→ 自动跟随不再恢复（可点「回到最新」显式恢复） | `useChatScroll.review-bugcheck.test.ts` |
| BUG-E1 | 后端 `http-api-executor.ts` | P2 | 「必填 + 默认值」并存的参数永远走不到默认值分支 → 工具无法调用 | `http-api-executor.review-bugcheck.spec.ts` |
| BUG-C1 | 后端 `app-config.ts` | P2 | 空串环境变量顶掉 `${VAR:default}` → 路径类配置为空 → 默认布局下 docker 模式容器创建被父目录防护拒绝（可用性故障）、host 模式技能扫描/工作区落进后端树 | `app-config.review-bugcheck.spec.ts` |
| BUG-C2 | 后端 `app-config.ts` | P2 | 数字型环境变量为空串时被解析成 `0` → `MAO_TS_PORT=` 得到随机端口，服务起来但不可达 | 同上 |
| BUG-S2 | 前端 `useChatScroll.ts` | P2 | 手势窗口只有滚轮/触摸/指针来源，键盘滚动既停不了跟随也触发不了分页 | `useChatScroll.review-bugcheck.test.ts` |
| BUG-S3 | 前端 `useChatScroll.ts` | P2 | 「内容高度变化」分支先于「位置上移」分支命中 → 流式输出期间滚动条拖拽上滑被判成布局变化（重构前既有问题；滚轮/触摸不受影响） | 同上 |

严重度口径：**P0** = 可造成凭据外泄 / 云账号失陷；**P1** = 用户可感知的功能失效或数据被误改；**P2** = 特定配置或操作路径下的功能失效（含误配置触发的可用性故障）。

---

## 二、逐条详述

### BUG-E3（后端 / P0 安全）SSRF 硬拒名单漏掉阿里云元数据地址，模型可直达

**位置**

- `backend-ts/src/common/ssrf.ts` — `isCloudMetadataIp()` / `isCloudMetadataHost()`
- `backend-ts/src/harness/tool/impl/http-api-executor.ts:152-164` — `guardUrl()`

**代码现状**

```ts
// ssrf.ts
/** 云元数据端点 IP（169.254.169.254）——任何形态下永拒，不放行。 */
export function isCloudMetadataIp(ip: string): boolean {
  return ip.trim() === '169.254.169.254';
}

/** 云元数据端点主机名（含常见云厂商别名；字面量 IP 由 isCloudMetadataIp 覆盖）。 */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === '169.254.169.254'
    || host === 'metadata.google.internal'
    || host === 'metadata.goog';
}
```

```ts
// http-api-executor.ts:152-164
if (isCloudMetadataHost(hostname)) {
  return { error: SSRF_DENY_MESSAGE };
}
const ips = await this.resolveIps(hostname);
for (const ip of ips) {
  if (isLoopbackIp(ip) || isCloudMetadataIp(ip)) {
    return { error: SSRF_DENY_MESSAGE };
  }
}
const needsAllowlist = isPrivateOrReservedHostname(hostname) || ips.some(isPrivateOrReservedIp);
if (!needsAllowlist) {
  return { ok: true };          // ← 100.100.100.200 走到这里，直接放行
}
```

**复现**

1. 本项目部署在阿里云（复核确认：线上域名 `mao.etarch.cn` 解析到 `120.26.109.221`，属阿里云 ECS 段；本地 `.env` 的 `MYSQL_URL` 亦指向该地址），实例元数据服务地址是 `100.100.100.200`（`latest/meta-data/ram/security-credentials/` 返回 RAM 角色的 `AccessKeyId` / `AccessKeySecret` / `SecurityToken`）。
2. `isPrivateOrReservedIpv4(100, 100, 100, 200)` 返回 **false**——`100.64.0.0/10` 不在 `ssrf.ts:22-31` 的私网/环回/链路本地/组播保留段列表里。
3. 于是 `100.100.100.200` 既没被硬拒，也没被判定为「需要放行名单」→ **直接按公网主机放行**。
4. **模型可达**：工具 URL 可以写成 `http://{{host}}/latest/meta-data/...`。保存期 `new URL(url)` 能解析出 hostname `{{host}}` 且 protocol 为 `http:`（复核实测：`new URL('http://{{host}}/latest/meta-data/').hostname === '{{host}}'`），通过 `http-tool.service.ts:293-302` 的校验；运行期占位符值由模型给出，`renderUrlTemplate` 用的 `encodeURIComponent` 不转义 `.`，故模型传 `host=100.100.100.200` 即拼出真实元数据地址。
5. 实测（用例中 fetch 被真实调用 1 次，返回体即伪造的 AK 内容）。

**影响**：模型可把云账号凭据读进上下文；配合 BUG-E2 的跨主机凭据转发，等于一条完整的云账号失陷链。

**修复方向**

- `isCloudMetadataIp()` / `isCloudMetadataHost()` 补齐实际部署平台：`100.100.100.200`（阿里云）、`169.254.0.23`（腾讯云）、`metadata.tencentyun.com`、`169.254.169.253`（AWS EC2 IMDSv1）等。
- `isPrivateOrReservedIpv4()` 把 `100.64.0.0/10` 纳入保留段（该段是 CGNAT / Alibaba 内部段）。
- 元数据判定必须对**解析出的 IP** 同样生效，不能只判字面量主机名。
- `guardUrl()` 解析出的 IP 应与实际 fetch 的地址绑定（IP pinning），消除 DNS rebinding 的 TOCTOU。

---

### BUG-E2（后端 / P0 安全）重定向跨主机仍携带解密后的凭据头

**位置**：`backend-ts/src/harness/tool/impl/http-api-executor.ts:83, 97-134`

**代码现状**

```ts
const headers = buildHeaders(tool, body != null);      // 只构建一次，含解密后的凭据
...
for (;;) {
  const guard = await this.guardUrl(currentUrl);        // 只判私网/放行名单，不比对主机
  ...
  res = await this.fetchImpl(currentUrl.toString(), {
    method: currentMethod,
    headers,                                              // ← 每跳原样复用
    ...
  });
  ...
  if (status >= 300 && status < 400 && location) {
    ...
    currentUrl = next;
    continue;                                            // ← 主机换了，凭据照发
  }
}
```

**复现**：工具配置 `Authorization: Bearer super-secret`、`X-Api-Key: kkk`，上游返回 `302 → https://evil.example.net/collect`。实测第二次请求的 headers 与第一次完全相同，`Authorization` 原样出现在 evil.example.net 上。

**影响**：管理员在管理后台配置的凭据被发往攻击者可控主机。触发条件很宽：上游 API 自身的开放重定向参数、或 URL 模板里的主机占位符（见 BUG-E3）。

**修复方向**：重定向到**不同主机**时剥离 `Authorization` / `Cookie` / `Proxy-Authorization` 以及管理员自定义的密钥类请求头（判定可复用 `isSensitiveHeaderKey`）；同主机（仅协议/端口变化）可保留。

---

### BUG-H2（后端 / P1）掩码哨兵被当成真实凭据落库，旧密文被销毁

**位置**：`backend-ts/src/http-tool/http-tool.service.ts:428-449`（`encodeHeaders`）

**代码现状**

```ts
function encodeHeaders(headers, previousStored, cipher) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isSensitiveHeaderKey(key)) {
      if (value === HEADER_VALUE_MASK) {        // ← 掩码只在敏感键分支被识别
        const previous = previousStored?.[key];
        if (previous != null && previous !== '') result[key] = previous;
        continue;
      }
      result[key] = ENC_PREFIX + cipher.encrypt(value);
    } else {
      result[key] = value;                      // ← 非敏感键：掩码原样写入
    }
  }
  return result;
}
```

**复现**

1. 建工具 `{ Authorization: 'Bearer real-secret' }` → 库中 `{"Authorization":"enc:5PphpuaW0Qp35EyV:..."}`。
2. 管理后台编辑表单回显为掩码；管理员把键名从 `Authorization` 改成 `X-Auth`（非敏感键，`SENSITIVE_HEADER_RE` 不命中）后保存 → 库中变成 `{"X-Auth":"******"}`。
3. 实测：运行时 `tool.headers = { 'X-Auth': '******' }`，**旧密文被彻底销毁**，每次调用都带着字面量 `******` 这个无效凭据；而管理后台仍显示 `******`（非敏感键按明文回显，形似掩码），破坏不可见。

**影响**：仅管理员编辑路径可触发（改名场景），但一旦发生即静默销毁凭据且表面无异常。

**修复方向**：掩码是**值**语义而非键语义——`value === HEADER_VALUE_MASK` 必须在 `isSensitiveHeaderKey` 判断**之前**处理；且当掩码无法在 `previousStored` 中解析到对应旧值时（改名场景），应直接拒绝保存并提示「请重新填写该请求头的真实值」，而不是把掩码当凭据。

---

### BUG-H1（后端 / P1）请求头解码按值前缀解密，非敏感头值以 `enc:` 开头时工具永久不可用

**位置**：`backend-ts/src/http-tool/http-tool.service.ts:451-463`（`decodeHeaders`）

**代码现状**

```ts
function decodeHeaders(headersJson, cipher) {
  const stored = parseStoredHeaders(headersJson);
  const result = {};
  for (const [key, value] of Object.entries(stored)) {
    if (value.startsWith(ENC_PREFIX)) {         // ← 按「值」判断，不按「键」
      result[key] = cipher.decrypt(value.slice(ENC_PREFIX.length));
    } else {
      result[key] = value;
    }
  }
  return result;
}
```

**问题**：`enc:` 是**敏感值的存储编码**，编码时用的是 `isSensitiveHeaderKey(key)`（第 436 行），解码时却改用「值是否以 `enc:` 开头」。非敏感头是原样明文落库的，一旦它的值恰好以 `enc:` 开头，执行期就会被送进 `cipher.decrypt()`。

**复现**：建工具 `{ 'X-Trace': 'enc:not-a-cipher' }` → 存储形态 `{"X-Trace":"enc:not-a-cipher"}`（非敏感头，原样落库，符合预期）→ 执行期 `resolveForExecution()` 直接抛错（实测报 `AES-GCM decrypt failed`）→ `http-api-tools.ts:158-164` 转成「请求头解密失败，请联系管理员在管理后台重新保存该工具的请求头后重试」。**而重新保存无效**：值仍是明文 `enc:...`，照样原样落库、照样被送进解密 → 该工具永久不可用。

**影响面（复核补充）**：触发条件罕见——需要非敏感头的值恰好以字面量 `enc:` 开头。但一旦命中，工具**永久不可用**，且错误提示引导的「重新保存」是无效操作，管理员会被导向一个死胡同。

**修复方向**：解码时用与编码同一个谓词 `isSensitiveHeaderKey(key)` 判断是否解密（历史数据天然兼容：敏感键的存储值一律带 `enc:` 前缀，非敏感键一律明文）；更稳妥的做法是存储形态带类型标记（如 `enc:` 只允许出现在敏感键上，保存期就拒绝非敏感键使用该前缀）。

---

### BUG-S4（前端 / P1）发送失败回滚打到了当前会话，而不是消息实际发往的会话

**位置**：`desktop/src/composables/useChat.ts:474-484`

**代码现状**

```ts
const sid = sessionId.value!                       // 入口捕获的 sid
...
const sent = await wsSendMessage(sid, resolvedText, eventId, imageUrls, localSkills, agentsMdContent)
if (!sent) throw new Error('消息发送失败，网络连接不可用，请重试')
...
} catch (error: any) {
  sending.value = false
  ...
  if (sessionId.value) {                          // ← 用的是「当前」会话，不是 sid
    sessionStore.removeTrailingEmptyAssistant(sessionId.value)
    sessionStore.removeLastUserMessage?.(sessionId.value)
    sessionStore.fetchSession(sessionId.value)
  }
}
```

**同文件里的正确写法**（`useChat.ts:730-733`，M-10 的修复注释）：

```ts
// M-10：失败时回滚乐观编辑——恢复截断/更新前的完整消息列表。
// 必须写回入口捕获的 sid：执行期用户可能已切到别的会话，
// 用 sessionId.value 会把当前会话的消息整表换成编辑目标会话的快照。
sessionStore.setMessages(sid, sidMessagesBeforeEdit)
```

**复现**

1. 用户在会话 A 发送消息 → 乐观用户气泡 + 空 assistant 占位写入 A。
2. WS 发送挂起（连接建立等待 / 服务端未应答）→ 期间用户切到会话 B。
3. 发送失败 → catch 用 `sessionId.value`（= B）回滚。

**实测结果**

```
AssertionError: expected [] to deeply equal [ 'B user' ]                       ← B 的最后一条用户消息被删了
AssertionError: expected [ 'hello from A', '' ] to deeply equal []             ← A 的乐观消息没被回滚，成了幽灵气泡
```

**影响**

- 会话 B 的尾部空 assistant 占位被摘掉——若该气泡正是在流式中的气泡，`stores/session/messages.ts:408-418` 会连同流式登记一起删除，**B 的进行中回复当场销毁**，后续 `content_delta` 帧找不到落点。
- 会话 B 最后一条乐观用户消息被误删。
- 会话 A 的失败消息留在屏幕上成为幽灵气泡（这正是该段注释想避免的）。

**修复方向**：catch 分支改用入口捕获的 `sid`——`prepareAndSendMessage` 与 `sendMessage` 各自的 catch 都要改（后者的执行失败回滚目前同样用 `sessionId.value`，见 `useChat.ts:525-531`），与 `editAndResend` 保持同一口径。

---

### BUG-S1（前端 / P1）内容单帧暴涨超过两屏后，自动贴底被永久关闭

**位置**：`desktop/src/composables/useChatScroll.ts:88-102`（`writeBottom`），阈值定义在 `:16-20`

**代码现状**

```ts
/**
 * 自动补位的最大距底距离（倍屏）。超过说明用户已经真正离开底部，不再强行拉回；
 * 「跟随中但底部被面板挤走」通常只有几十到几百 px，远小于该上限。
 */
const MAX_FOLLOW_DISTANCE_RATIO = 2

function writeBottom() {
  const el = container.value
  if (!el || disposed || userScrolledUp.value) return
  const dist = distanceFromBottom(el)
  if (dist <= 1) return
  if (dist > el.clientHeight * MAX_FOLLOW_DISTANCE_RATIO) return   // ← 问题所在
  programmatic = true
  el.scrollTop = el.scrollHeight
  ...
}
```

**复现**

1. 贴底态：容器 500px 高，`scrollTop = 1500`、`scrollHeight = 2000`。
2. 一张大工具卡 / 长 diff / 一次性渲染的代码块在**一帧内**插入 → `scrollHeight` 2000 → 6000；浏览器保持 `scrollTop = 1500` 不变（内容在下方增长）。
3. ResizeObserver → `scheduleFollow()` → `writeBottom()`：`dist = 6000 - 1500 - 500 = 4000 > 500 × 2` → **直接 return**。
4. 更糟的是 `lastFollowAt`（第 98 行）也没被更新 → 之后每次 `scheduleFollow()` 都重复同样的判断，`dist` 随流式输出继续变大 → **自动跟随不再恢复**（直到用户显式点「回到最新」或发送下一条消息——两者都走 `resumeFollow()`，可恢复）。

**实测**：`expected 5500` vs 实际停在 `1500`；第二轮再涨到 9000 时仍停在原处。

**为何是 BUG**：注释说这个阈值用于识别「用户已经真正离开底部」，但该场景**已由 `userScrolledUp` 覆盖**（第 91 行）。也就是说第 94 行唯一能触发的状态就是「我们正在跟随，但内容刚暴涨」——恰好是最需要跟随的场景。旧实现（`53fb6dab^`，2026-10-22 重构前）根本没有 `writeBottom` 与该阈值，是 `53fb6dab` 新引入的。

**修复方向**：阈值应区分「内容在下方增长」与「用户主动上移」——比较 `scrollTop` 是否相对基准**上移**；位置未动而只是内容变高时应继续贴底。现有用例「距底超过两屏时不强行拉回」把 `scrollTop` 从 1500 改成了 100（位置确实上移），按上述修法仍然成立。注意该修复与 BUG-S3 是配套的：阈值放宽后，「位置上移」必须能独立停止跟随，否则滚动条拖拽场景会更难恢复。

---

### BUG-E1（后端 / P2）必填参数配了默认值时，校验先于渲染导致默认值永远用不上

**位置**：`backend-ts/src/harness/tool/impl/http-api-executor.ts:340-356`（`validateArguments`） vs `:288-302` / `:309-322`（模板渲染）

**代码现状**

```ts
// 渲染取值口径：实参 > 默认值 > 原样保留
return template.replace(PLACEHOLDER_RE, (match, name) => {
  const param = params.find((item) => item.name === name);
  if (param == null) return match;
  const value = args[name];
  if (value !== undefined && value !== null) return String(value);
  if (param.defaultValue != null) return param.defaultValue;   // ← 默认值分支
  return match;
});

// 校验：先于渲染执行
for (const param of params) {
  const value = args[param.name];
  if (value === undefined || value === null) {
    if (param.required === 1) {
      return `缺少必填参数 ${param.name}（${param.label}）`;    // ← 直接判缺失
    }
    continue;
  }
```

**复现**：参数 `{ name: 'city', required: 1, defaultValue: '北京' }`，`arguments={}` → 校验阶段直接返回「缺少必填参数 city（城市）」，URL 根本没机会渲染，默认值分支是死代码。

**影响**：管理后台允许同时勾选「必填」并填写「默认值」（`admin/src/views/http-tool/HttpToolListView.vue:214-215`，两个控件并列、无互斥），后端也照单全收，于是这类工具**永远无法被调用**，且模型拿到的是误导性的「缺参数」报错而不是可用的默认值。

**修复方向**：`validateArguments` 在判定「必填缺失」前先考虑 `defaultValue`（有默认值即视为满足）；或保存期禁止「必填 + 默认值」同时存在。

---

### BUG-C1（后端 / P2）空串环境变量顶掉默认值，路径类配置静默变空

**位置**：`backend-ts/src/config/app-config.ts:385-399`（`resolvePlaceholders`）

**代码现状**

```ts
value.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (_m, key, def) => {
  if (key === 'HOME' || key === '$HOME') return process.env.HOME ?? def ?? '';
  if (process.env[key] !== undefined) {      // ← 空串也算「已设置」
    return process.env[key] as string;
  }
  const fromConfig = lookupPath(root, key);
  if (fromConfig !== undefined) return fromConfig;
  return def ?? '';
});
```

**复现**

1. `.env` / systemd `Environment=` 里写 `SKILLS_DIR=`（空值，运维写 .env 时并不少见）→ `process.env.SKILLS_DIR === ''` → 判定为「已设置」→ `config/application.yml:73` 的 `skills-dir: ${SKILLS_DIR:./skills}` 默认值被顶掉 → `cfg.app.harness.skillsDir === ''`。
2. `WORKSPACE_ROOT=` 同理顶掉 `application.yml:70` 的 `workspace-root`。实测（配置层用例）：两者均被解析成空串。
3. 空路径经 `path.resolve('')` 一律落成**进程 cwd**（`container-mount-planner.ts:297` 的 `under()`：`leaf === '' ? path.resolve(root)`；`PathSandbox` 构造器 `path-sandbox.ts:22` 同口径）。

**影响（复核修正）**

- **host 模式（默认）**：`SkillLoader`（`create-app.ts:548`）以 cwd 为根扫描技能，按用户工作区（`session.service.ts:226` 的 `resolve(workspaceRoot, userId, sessionId)`）落到后端工作树内——属目录污染/误用。不构成越权：host 模式本就无隔离（模型经 shell 已可触达宿主，容器隔离方案即为此设计）。
- **docker 模式（默认关闭）**：技能 rw 挂载的 host 变成 cwd，且 `isPlatformSkillsRoot`（`container-mount-planner.ts:212`）恰为登记根时跳过「必须含 `/{userId}/` 段」检查。但默认布局下 `distDir`（`application.yml:94` 的 `/opt/mao/backend-ts/dist`）与 `uploadDir`（`./uploads`）都是 cwd 下的登记根子目录，`assertSafe` 的父目录防护（`:226-232`）会先抛 `MountPlanError`。
- **实跑验证（贴近生产布局：cwd 下含 `dist/` 与 `uploads/`，其余数据根在独立目录）**：`planner.plan()` 抛 `MountPlanError: mount skills: <cwd> is a parent of registered root <cwd>/dist`——**挂载被拒绝，而非被接受**。初查报告「整个后端工作树被 rw 挂进每个用户容器（含 .env 密钥）」只在 `distDir` 与 `uploadDir` 都被改到 cwd 之外时才成立；默认布局下的真实后果是**所有用户的容器创建失败**（可用性故障）。
- 口径不一致旁证：同文件 `coerceTypes` 对 `MAO_USER_HOME_DIR` 等用的是 `if (process.env.X)`（空串按未设置），与 `${VAR:default}` 路径的判定互相矛盾。

**修复方向**

- `resolvePlaceholders` 判定环境变量「已设置」时应排除空串（`process.env[key] != null && process.env[key] !== ''`），与 `coerceTypes` 的 `if (process.env.X)` 口径对齐。
- 除 `shareDir` 外，`skillsDir` / `workspaceRoot` / `userSkillsDir` / `uploadDir` 也需要与 `resolveShareDir` 同款的启动即拒（空值 / 相对路径 / `~` 无法解析），让误配在启动时报错，而不是拖到首次容器创建才炸。

---

### BUG-C2（后端 / P2）数字型环境变量为空串时被解析成 0

**位置**：`backend-ts/src/config/app-config.ts:414-424`（`coerceTypes`）

**代码现状**

```ts
const n = (v: unknown, d: number) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;      // Number('') === 0，且有限 → 默认值永远用不上
};
...
cfg.server.port = n(process.env.MAO_TS_PORT ?? cfg.server.port, 9080);
cfg.app.harness.cleanup.intervalMs = n(process.env.MAO_CLEANUP_INTERVAL_MS ?? ..., 24 * 3600 * 1000);
```

**复现**：`MAO_TS_PORT=` → `Number('') === 0` → `Number.isFinite(0)` 为真 → `cfg.server.port = 0`。实测断言 `expected +0 to be 9080`。

**影响**

- 端口 `0` = 随机端口：进程起来了，但单域 nginx 的 `/api/` upstream 与蓝绿健康检查（`scripts/lib/blue-green.sh`）都按配置端口探测 → **服务不可达，且看起来「已启动」**。
- `MAO_CLEANUP_INTERVAL_MS=` → `intervalMs = 0` → `runtime-cleanup-scheduler.ts:41` 的 `setInterval(..., 0)` 被 Node 钳到 1ms → 对整个 runtime 目录每秒上千次扫描，CPU 打满 + 日志刷屏。
- `MAO_CONTAINER_MEMORY_MB=` → `memoryMb = 0` → `container-registry.ts:462` 拼出 `--memory 0m`（0 字节内存限制，docker 侧报错或容器无法启动）。

**修复方向**：`n()` 应先把空串 / 空白当作「未设置」；`b()` 也要保持一致口径（`'KEY='` 不应被当成「显式 false」，如 `FLYWAY_ENABLED=` 会静默关闭迁移）。

---

### BUG-S2（前端 / P2）键盘滚动既停不了跟随，也触发不了「加载更早历史」

**位置**：`desktop/src/composables/useChatScroll.ts:8-13, 186-212, 222-240`

**代码现状**

```ts
/**
 * 手势窗口：只有手势（滚轮/触摸/按键/鼠标按下）之后这段时间内派发的 scroll，
 * 才允许改变「是否跟随」。……
 */
const GESTURE_WINDOW_MS = 250
...
function markGesture() { lastGestureAt = performance.now() }
function handleWheel(event: WheelEvent) { ... markGesture() ... }
function handleTouchStart(event: TouchEvent) { ... markGesture() ... }
function handleTouchMove(event: TouchEvent) { ... markGesture() ... }
function handlePointerDown() { markGesture() }
// ← 没有 keydown / keyup 处理
```

```ts
// 第 222 行：窗口外的 scroll 一律不改变跟随状态
if (performance.now() - lastGestureAt <= GESTURE_WINDOW_MS) { ... }
...
// 第 240 行：分页的前置条件是 userScrolledUp === true
if (loading || !userScrolledUp.value || el.scrollTop > 120 || !options.canLoadOlder()) return
```

**复现**：用户把焦点放在消息区内的可聚焦元素上，按 `ArrowUp` / `PageUp` / `Home` → 浏览器滚动容器 → `scroll` 事件触发。但整个模块没有 `keydown` 监听，`lastGestureAt` 仍是 `-Infinity` → 窗口判定为假 → `userScrolledUp` 始终为 `false`。

**影响**

1. 键盘滚动后，下一个 ResizeObserver tick 立刻把视野拽回底部 → **键盘用户无法阅读历史**。
2. 第 240 行的分页门槛要求 `userScrolledUp === true` → **键盘用户永远触发不了「加载更早历史」**。
3. 注释把「按键」列为手势来源，但代码里没有对应实现——文档与实现不一致。

**回归性**：`53fb6dab` 之前的实现对**每个** scroll 事件都判方向（无时间窗，见 `git show 53fb6dab^:desktop/src/composables/useChatScroll.ts`），键盘滚动是可用的；本次重构引入手势窗口后，该能力消失。

**修复方向**：补 `keydown` 处理器（`ArrowUp` / `PageUp` / `Home` / `Space`）调用 `markGesture()` 并在向上键时 `stopFollowing()`，在三个面板（`ChatPanel.vue` / `SideChatPanel.vue` / `SubagentChatPanel.vue`）挂载。

---

### BUG-S3（前端 / P2）流式输出期间滚动条拖拽上滑被判成「布局变化」

**位置**：`desktop/src/composables/useChatScroll.ts:214-240`（`handleScroll` 分支顺序）

**代码现状**

```ts
if (performance.now() - lastGestureAt <= GESTURE_WINDOW_MS) {
  const contentShrank = lastScrollHeight >= 0 && el.scrollHeight < lastScrollHeight - 2
  const contentGrew   = lastScrollHeight >= 0 && el.scrollHeight > lastScrollHeight + 2
  if (lastScrollTop < 0) {
    if (distanceFromBottom(el) >= NEAR_BOTTOM) stopFollowing()
  } else if (contentShrank || contentGrew) {        // ← 先命中「内容变化」
    if (userScrolledUp.value && distanceFromBottom(el) < NEAR_BOTTOM) userScrolledUp.value = false
  } else if (el.scrollTop < lastScrollTop - SCROLL_UP_TOLERANCE) {   // ← 位置上移永远走不到
    stopFollowing()
  } else if (distanceFromBottom(el) < NEAR_BOTTOM) {
    userScrolledUp.value = false
  }
}
```

**受影响范围（复核修正）**

- 滚轮上滑（`handleWheel`，:190-195）与触摸上滑（`handleTouchMove`，:202-207）都**直接**调用 `stopFollowing()`，不经过 `handleScroll` 的分支——这两类主要交互路径**不受本 BUG 影响**。
- 实际受影响的只有**滚动条拖拽**：`handlePointerDown`（:210-212）只开手势窗口，方向判定全靠 `handleScroll`，而 `contentGrew` 分支（:229）先于位置上移分支（:232）命中 → `stopFollowing()` 不执行 → 跟随态下 `writeBottom` 持续把视野拽回底部，拖拽被对抗。
- 该问题**在 `53fb6dab` 之前即存在**（旧实现同样是内容分支在前，见 `git show 53fb6dab^`），并非本次重构引入，与手势窗口无关（窗口只决定哪些 scroll 事件参与判定，不改变分支顺序）。初查「被手势窗口进一步放大」的说法不成立。

**复现**

1. 贴底态：`scrollHeight = 2000`（基准 `lastScrollHeight = 2000`）。
2. Agent 正在流式输出，内容长高 → `scrollHeight` 变 3000（基准仍是 2000）。
3. 用户拖动滚动条上滑：`pointerdown` 打开手势窗口（但不直接停止跟随），`scrollTop` 1000 < 基准 1500 → 这是明确的用户上移。
4. 但 `contentGrew = 3000 > 2000 + 2` 为真 → 命中第一个分支 → `stopFollowing()` 从不执行 → `userScrolledUp` 保持 `false`；流式持续期间每个新 scroll 事件仍可能带 `contentGrew`。

**影响**：仅滚动条拖拽用户：Agent 流式输出期间无法上滑阅读历史、无法触发「加载更早历史」。键盘用户受 BUG-S2 影响（症状相同）；滚轮 / 触摸用户不受影响。

**修复方向**：把「位置上移超过容差」提为独立且优先的判据，但 `contentShrank` 必须留在位置判定**之前**——内容塌陷（REST 回填 / roundLimit 截断）时浏览器会把 `scrollTop` 向下钳制，产生假的「位置上移」，旧实现的注释对此有明确记录。正确顺序：`contentShrank` → 位置上移 → `contentGrew`。

---

## 三、验证用例

### 3.1 新增文件

| 文件 | 覆盖 BUG |
|------|---------|
| `backend-ts/src/http-tool/http-tool-headers.review-bugcheck.spec.ts` | BUG-H1、BUG-H2 |
| `backend-ts/src/harness/tool/impl/http-api-executor.review-bugcheck.spec.ts` | BUG-E1、BUG-E2、BUG-E3 |
| `backend-ts/src/config/app-config.review-bugcheck.spec.ts` | BUG-C1、BUG-C2 |
| `desktop/src/composables/useChatScroll.review-bugcheck.test.ts` | BUG-S1、BUG-S2、BUG-S3 |
| `desktop/src/composables/useChat.rollback.review-bugcheck.test.ts` | BUG-S4 |

用例断言的是**应有行为**，因此在对应缺陷修复前**必然失败**——失败即证明缺陷真实存在。修复后应把用例从「失败」转为「通过」。

### 3.2 运行方式

用例文件用 `*.review-bugcheck.*` 后缀与仓库既有的 `*.bugcheck.*`（历史修复回归用例）区分开，并被排除在默认测试之外——否则未修复的缺陷会让 CI 恒红。

```bash
# 后端：只跑本次审查的验证用例（当前应为「全部失败」）
cd backend-ts && npm run test:bugcheck

# 前端：同上
cd desktop && npm run test:bugcheck
```

配套改动：

- `backend-ts/vitest.config.ts` / `desktop/vitest.config.ts`：`exclude` 增加 `*.review-bugcheck.*`。
- 新增 `backend-ts/vitest.bugcheck.config.ts` / `desktop/vitest.bugcheck.config.ts`：只收集 `*.review-bugcheck.*`，关闭覆盖率。
- `backend-ts/package.json` / `desktop/package.json`：新增 `test:bugcheck` 脚本。

### 3.3 实跑结果（复核后重跑）

```
# cd backend-ts && npm run test:bugcheck
 Test Files  3 failed (3)
      Tests  12 failed | 2 passed (14)

# cd desktop && npm run test:bugcheck
 Test Files  2 failed (2)
      Tests  7 failed (7)
```

失败明细与预期缺陷一一对应（2 个通过的用例分别断言「非敏感头不以 `enc:` 开头时正常透传」与「100.100.100.200 当前被当成非私网地址（漏网根因记录）」）：

```
× BUG-E1 validateArguments 不应在参数存在默认值时判为缺失       → expected '缺少必填参数 city（城市）' to be null
× BUG-E1 必填参数缺省时应使用默认值完成请求                        → expected true to be false
× BUG-E2 跨主机重定向应剥离 Authorization / 自定义密钥头            → expected 'Bearer super-secret' to be undefined
× BUG-E3 100.100.100.200 应被识别为云元数据端点                   → expected false to be true
× BUG-E3 100.100.100.200 不应被当成公网主机直接放行                → 请求已发出（fetch 被调用）
× BUG-E3 URL 模板的主机占位符由模型指定元数据地址时必须被拒绝       → expected "spy" to not be called at all, but actually been called 1 times
× BUG-H1 非敏感头值恰好以 enc: 开头时执行期仍应原样透传            → 请求头解密失败
× BUG-H2 掩码哨兵不得被当作真实请求头值落库                        → expected '******' not to be '******'
× BUG-C1 SKILLS_DIR= 空串时不应把 skills-dir 解析成空路径           → expected '' not to be ''
× BUG-C1 WORKSPACE_ROOT= 空串时不应把 workspace-root 解析成空路径   → expected '' not to be ''
× BUG-C2 MAO_TS_PORT= 空串时端口应为默认 9080，而不是 0            → expected +0 to be 9080
× BUG-C2 MAO_CLEANUP_INTERVAL_MS= 空串时应保留默认间隔              → expected +0 to be 86400000

× 内容暴涨（位置未动）时应继续贴底，而不是停在原地                   → 停在 1500（应为 5500）
× 内容连续暴涨时跟随不应永久失效                                   → 停在 1500（应为 8500）
× 键盘上滑（ArrowUp / PageUp）应能停止跟随                          → userScrolledUp 仍为 false
× 键盘上滑应能触发加载更早历史（分页）                               → loadOlder 未被调用
× 拖动滚动条上滑应停止跟随（内容同时在增长）                         → userScrolledUp 仍为 false
× 拖动滚动条上滑应触发加载更早历史                                   → loadOlder 未被调用
× 失败回滚只作用于发起发送的会话，不影响期间切换到的会话             → B 的消息被删 / A 的幽灵消息未回滚
```

### 3.4 未被本次改动影响的既有测试（复核重跑）

```
# cd backend-ts && npm test            （默认套件，不含 review-bugcheck）
 Test Files  384 passed | 1 skipped (385)
      Tests  4621 passed | 13 skipped (4634)

# cd desktop && npm run test:unit      （默认套件，不含 review-bugcheck）
 Test Files  80 passed (80)            ← vitest 部分
      Tests  723 passed (723)
```

类型检查同样通过：

```
cd backend-ts && npx tsc -p tsconfig.json --noEmit   # 本次新增文件零报错
cd desktop && npx vue-tsc -b --force                  # exit 0
```

> 注：`npm run test:unit` 附带的 `node --test electron/*.cjs` 有 2 个**既有**失败（`gitOperations` 的身份注入依赖机器无全局 git 身份、`localShell` 依赖 macOS `/private` 前缀之外的环境），与本次审查无关，复核时亦未因本次改动变化。

---

## 四、修复建议顺序

1. **BUG-E3 + BUG-E2**（安全 P0）：补元数据地址硬拒 + 跨主机重定向剥离凭据。这两条可组合利用，建议同批修复。
2. **BUG-H2**（P1）：掩码按值语义处理，改名场景拒绝保存。
3. **BUG-S4 / BUG-S1**（P1）：回滚用 `sid`（两处 catch 同改）；贴底阈值区分「内容暴涨」与「用户上移」。S1 的阈值修复需与第 4 组 S3 配套。
4. **BUG-S2 + BUG-S3**（P2，手势逻辑同批）：补 keydown 手势来源；`handleScroll` 分支顺序改为 `contentShrank → 位置上移 → contentGrew`。
5. **BUG-H1 / BUG-E1 / BUG-C2**（P2）：解码按键判定；校验考虑默认值；数字环境变量空串口径。
6. **BUG-C1**（P2）：空串环境变量按未设置 + 路径类配置启动即拒。单独列组是因为它防的是整类运维误配（空串 .env），改动小但需要先定口径。

修复完成后，请把对应 `*.review-bugcheck.*` 用例从两处 `vitest.config.ts` 的 `exclude` 列表中移除，并入默认测试套件。
