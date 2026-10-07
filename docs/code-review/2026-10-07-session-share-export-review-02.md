# 会话只读分享与 Markdown 导出 — 代码审查（第二轮）

- 日期：2026-10-07
- 范围：当前 git 工作区未提交改动中的功能逻辑（文档 diff 未审）
- 对照：`docs/plan/2026-10-06-session-share-export-technical-design.md` 的预期行为
- 审查方式：不把上一轮的三处问题当作仍未修复。疑点用临时探针 `backend-ts/src/session/session-share-review-probe.spec.ts` 跑失败用例确认，跑完已删除该文件，未改产品代码，也未改原有测试。

## 结论

发现 2 个功能缺陷。上一轮的三处（导出读取 `function.arguments`、导出会话文件变更排除已逻辑删除消息、小写 token 的审计 path 替换为 `{token}`）在当前代码里已经按对应路径生效，本轮不再列入。

## BUG-1 边路任务的分享和导出会带出从父会话复制来的消息与文件变更

设计要求边路任务可以分享、导出，但只含边路自身消息，不带父会话上下文（父上下文属于另一会话的授权域）。

`contextMode === 'fork'` 时，`forkParentMessages` 把父会话里 `deleted = 0` 的消息物理复制进边路会话，并写上 `sourceSessionId = parentSessionId`；对应的 `message_file_change` 也按新消息 id 复制进来。边路自己随后发出的消息 `sourceSessionId` 为空。

分享和导出都没有按这个标记排除副本：

- 只读视图调用 `getMessagesByRounds`（只加了水位 `id <= watermark` 和 `deleted = 0`），再把这一页全部消息 id 拿去取文件变更摘要。
- 导出同样拉全量轮次，文件变更走 `listSummaryBySession`。这条 SQL 已按 `m.deleted = 0` 过滤，但没有排除 `source_session_id` 指向父会话的行。

站内边路面板需要看到分叉历史，所以不该在 `getMessagesByRounds` 上全局过滤。缺的是分享视图和导出这两条出口。

```138:144:backend-ts/src/session/session-share.service.ts
    const page = await this.sessionService.getMessagesByRounds(session.id!, roundLimit, beforeMessageId, {
      maxMessageId: Number(share.messageWatermark),
    });
    const changes = await this.sessionService.getFileChangeSummariesByMessageIds(
      session.id!,
      page.messages.map((m) => m.id!),
    );
```

```629:642:backend-ts/src/harness/core/harness-service.ts
      for (const m of messages) {
        const newId = await tx.insert('message', {
          sessionId: sideSessionId,
          role: m.role,
          content: m.content,
          // ...
          sourceSessionId: parentSessionId,
          createdAt: m.createdAt,
          deleted: 0,
        });
```

导出模板的「任务目标」取第一条 USER。父副本排在边路自己的消息前面，于是任务目标写成父会话的问题，边路自己的问题不会出现在四节模板里。文件变更清单两份都在。

子代理结果回写使用的是子会话 id，不是父会话 id。排除条件应是「`sourceSessionId` 等于该边路的 `parentSessionId`」，不能把所有非空 `sourceSessionId` 都丢掉。

复现：探针按分叉后的实际页面喂入四条消息（父 USER/ASSISTANT 的 `sourceSessionId = 99`，边路自己的两条为 `null`）以及对应的 `parent-secret.ts`、`side-own.ts`，分别走 `readView` 和 `SessionExportService.render`。

失败断言（分享）：

```text
AssertionError: expected { hasParentText: true, …(3) } to deeply equal { hasParentText: false, …(3) }

- Expected
+ Received

  {
    "hasOwnFile": true,
    "hasOwnText": true,
-   "hasParentFile": false,
-   "hasParentText": false,
+   "hasParentFile": true,
+   "hasParentText": true,
  }
```

失败断言（导出）：

```text
AssertionError: expected { hasParentText: true, …(3) } to deeply equal { hasParentText: false, …(3) }

- Expected
+ Received

  {
    "hasOwnFile": true,
-   "hasOwnText": true,
-   "hasParentFile": false,
-   "hasParentText": false,
+   "hasOwnText": false,
+   "hasParentFile": true,
+   "hasParentText": true,
  }
```

`hasOwnText: false` 是因为模板只把第一条 USER 放进「任务目标」。当前第一条是父会话问题 `父会话里的密钥 sk-parent-secret`，边路自己的问题 `边路自己的问题` 没有进入正文。

命令与下面的 BUG-2 相同。本条是其中第 1、第 2 个失败用例。

## BUG-2 大写 hex 的分享 URL 仍会把完整 token 写入审计 path

上一轮的脱敏是 `path.split(share.shareToken).join('{token}')`，按库里存的 token 做大小写敏感替换。新建 token 是小写 hex，小写 URL 会被换成 `{token}`。

路由上的 `pathToken` 用 `/^[0-9a-f]{64}$/i` 接受大写，并且原样返回。读接口把这个原样 token 拼进 path：`/v1/share/${token}`、`/v1/share/public/${token}`。

`session_share.share_token` 是 `CHAR(64)`，表只有 `DEFAULT CHARSET=utf8mb4`，没有像 `company_sso_identity` 那样指定 `utf8mb4_0900_bin`。MySQL 8 下 utf8mb4 的默认校对是大小写不敏感的，`WHERE share_token = ?` 会命中小写行，并返回库里的小写 token。脱敏拿小写 token 去切大写 path，切不开，审计 `path` 仍是完整 token。管理后台审计卡片展示的就是 `row.path`。

```107:113:backend-ts/src/session/session-share.routes.ts
function pathToken(request: { params: unknown }): string {
  const token = (request.params as { token?: string }).token ?? '';
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    throw new BusinessException(ErrorCode.SHARE_NOT_FOUND);
  }
  return token;
}
```

```271:274:backend-ts/src/session/session-share.service.ts
function redactShareToken(path: string, token: string): string {
  if (!token) return path;
  return path.split(token).join('{token}');
}
```

复现：用真实 `SessionShareService` 和 `registerSessionShareRoutes`。查找按小写比较（对齐上述校对；现有单测里的内存仓库是大小写敏感的，大写 URL 会直接 404，审计写不出来，所以探针把查找改成不区分大小写）。创建分享后 `GET /v1/share/${token.toUpperCase()}`，断言 READ 审计 path 不含这串大写 token，也不含库里的小写 token。

失败断言：

```text
AssertionError: expected '/v1/share/74CDE70AC40C2970C6E4DBF1B15…' not to contain '74CDE70AC40C2970C6E4DBF1B1523DA009E8C…'

Expected: "74CDE70AC40C2970C6E4DBF1B1523DA009E8CE2487EF458EEBC7F64D1EB27EB0"
Received: "/v1/share/74CDE70AC40C2970C6E4DBF1B1523DA009E8CE2487EF458EEBC7F64D1EB27EB0"
```

同一条用例后半段还有匿名路径 `GET /v1/share/public/${token.toUpperCase()}`。登录路径已经失败，那次请求没有发出。匿名 path 走同一个 `redactShareToken`。

## 验证命令

```bash
cd backend-ts && npx vitest run src/session/session-share-review-probe.spec.ts
# Test Files  1 failed (1)
# Tests  3 failed (3)
# exit=1
```

探针文件已删除。产品代码与审查开始时的测试文件保持原状。
