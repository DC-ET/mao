# 开放接口调用中心代码审查（2026-10-09）

审查范围：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/open-api-call-center`，分支 `feature/open-api-call-center` 上未提交的功能代码。未改生产代码。下列 3 条均已用失败测试复现（Vitest 3.2.7，`cd backend-ts && ./node_modules/.bin/vitest run src/openapi/open-api-call-log.review-probe.spec.ts --coverage.enabled=false`，3 failed）。探针文件已删除，复现代码附在每条下面。

## BUG-1 并发失败通知把同一 10 分钟桶的次数覆盖成 1

`OpenApiCallLogService.noteFailure` 在写入 Map 之前要 `await tokens.findById`。两次失败如果叠在这次查询上，后完成的那次会用 `count: 1` 盖掉已经记下的次数。10 分钟聚合通知因此少报。顺序到达（第一次查询已经返回）的失败计数是对的，现有单测覆盖的是这条路径。

外部调用失败往往是同一时刻打进来的，这正是聚合通知要数的场景。`insertIgnore` 的去重键是 `tokenId + errorCode + bucket`，后一次 flush 即使带着正确次数也会被丢掉，库里留下的是偏小的那条。

复现：两次 `markRejected`（`PARAM_INVALID`）并发，第一次 `findById` 挂起直到第二次已经 `set`。`flushFailures` 投出的 `count` 为 **1**，期望 **2**。

```
AssertionError: expected 1 to be 2
```

```ts
const first = await service.begin({ source: 'API', tokenId: 3, userId: 7, body: { message: 'a' } });
const second = await service.begin({ source: 'API', tokenId: 3, userId: 7, body: { message: 'b' } });
findById.mockImplementation(async () => {
  tokenLookups += 1;
  if (tokenLookups === 1) await firstGate;
  return { id: 3, name: 'ci', logFullBody: 0 };
});
const p1 = service.markRejected(first!.id, 1_000, new BusinessException(ErrorCode.PARAM_INVALID, '坏'));
await vi.waitFor(() => { if (tokenLookups < 1) throw new Error('wait'); });
const p2 = service.markRejected(second!.id, 1_000, new BusinessException(ErrorCode.PARAM_INVALID, '又坏'));
await vi.waitFor(() => { if (tokenLookups < 2) throw new Error('wait'); });
releaseFirst();
await Promise.all([p1, p2]);
await service.flushFailures(600_000);
expect(recordOpenApiCallFailed.mock.calls[0][0].count).toBe(2);
```

相关代码：`backend-ts/src/openapi/open-api-call-log.service.ts` 的 `noteFailure`（先 `await findById`，再 `this.failures.set` 且 `count` 固定为 1）。

## BUG-2 已知触发器的验签失败可以无限写入调用流水

`WebhookTriggerService.handleFire` 在验签失败时立刻 `recordDirect` 并返回，触发器限流在验签通过之后才执行。技术方案写明：已查到触发器的验签失败不走按 IP 的 20 条/分钟抑制，量级由该触发器自己的限流器约束（未绑定会话为 10 次/分钟）。当前这条路径既不查触发器限流器，也不走 IP 抑制。

知道 Webhook URL 的调用方（配错签名、重试风暴）会按请求逐条插入 `open_api_call_log`。这些行都是 `rejected`，会把拒绝率和流量统计抬高，清理任务也要跟着删。

复现：真实 `FixedWindowRateLimiter`，对已存在且未绑定会话的触发器连续 25 次错误签名。对外仍是 `not_found`，`recordDirect` 被调用 **25** 次，期望不超过 `TRIGGER_RATE_LIMIT_UNBOUND`（10）。

```
AssertionError: expected 25 to be less than or equal to 10
```

相关代码：`backend-ts/src/openapi/webhook-trigger.service.ts` 的 `handleFire`。验签失败分支在 `rateLimiter.allow` 之前 `recordDirect` 并 return。

## BUG-3 已自动停用的 API Token 会把公开 Webhook 挡在验签之前

`POST /v1/open/hooks/**` 是公开路径，本应只做 HMAC。`preHandler` 在判断公开路径之前，只要 `auth.tokenAutoDisabled` 就直接 `403 TOKEN_AUTO_DISABLED`。

`mao_` Token 在整个 `/v1/open/**` 上都会解析，Webhook 也算。调用方如果把 API Token 放在同一个 HTTP 客户端的 `Authorization` 里，Token 一旦被连续失败自动停用，合法签名的 Webhook 也会变成 403，进不了 `handleFire`。吊销和过期只让身份解析失败，公开路径仍会继续进路由。

复现：从 `create-app.ts` 抽出 `if (auth.tokenAutoDisabled)` 到下一个 `isPublicPath` 判断之间的源码，挂到 Fastify `preHandler` 上，再 `inject`：

`POST /api/v1/open/hooks/abc`，`Authorization: Bearer mao_disabledxx`，resolver 返回 `auto_disabled`。

`isPublicPath('POST', '/api/v1/open/hooks/abc')` 为 true，响应却是 **403**，路由处理器没有执行。

```
AssertionError: expected 403 not to be 403
```

相关代码：`backend-ts/src/create-app.ts` 的 `preHandler`（`tokenAutoDisabled` 分支在 `isPublicPath` 判断之前 return）。
