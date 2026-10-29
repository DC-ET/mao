# 代码审查报告：会话来源全链路标记与筛选（第 1 轮）

- 日期：2026-10-30
- 审查范围：worktree `feat/session-source-lineage` 分支全部未提交改动（18 个修改文件 + 3 个新增文件），技术方案 `docs/plan/2026-10-29-session-source-lineage-technical-design.md`
- 审查方式：逐文件通读 diff + 临时 vitest 用例实测验证（验证后已删除，未留在仓库）；未修改任何业务代码

## 结论

发现 1 个已验证的 bug（低严重度）。其余核查方向（四个写入点参数位、闭集扩宽连锁面、admin 筛选 SQL 拼接、desktop 徽标容错、既有测试更新意图）均未发现问题，验证过程见文末附录。

## Bug 清单

### BUG-1（低）：`listSessionsForAdmin` 的 source 非法值被当作过滤条件，与设计定案「非法值按不过滤处理」相悖

- 位置：`backend-ts/src/session/session.service.ts:489-493`（`listSessionsForAdmin` 的 source 分支）
- 引入方式：本次需求新增的 admin 来源筛选参数（`session.service.ts` + `admin-session.routes.ts`）
- 现象：
  - 技术方案 §4.1-6 定案明确：「非法值直接忽略（admin 侧无伪造面，宽松处理即可）——**定案：不校验，非法值按不过滤处理**」；
  - 本次代码中的行内注释同样声称「非法值宽松忽略（admin 无伪造面）」，CHANGELOG 0.0.381 也写了「（非法值宽松忽略）」；
  - 但实现只判空（`source != null && source.length > 0`）即拼 `source = ?`，**没有对非法值做忽略**：任何非空字符串（如 `?source=Feishu`、`?source=feishu `、`?source=feishuss`）都会作为等值条件进入 WHERE，查询命中 0 行。
- 业务影响（低）：管理后台来源下拉只会发出七个合法值，正常操作不触发；但管理员手动改地址栏 / 书签里的 `source` 值拼写有出入（如大小写 `Feishu`、尾随空格）时，列表显示为空——管理员会误读为「该来源没有会话」，而设计口径是「非法值不过滤、回全量」。SQL 走参数化拼接，无注入风险，仅是筛选语义与定案不符 + 代码注释/CHANGELOG 与实际行为不一致。
- 复现（已用临时 vitest 验证通过，验证后已删除）：
  1. 构造 `SessionService`，`sessionRepo.selectPage` 为捕获 `whereSql`/`params` 的 mock；
  2. 调 `listSessionsForAdmin(1, 10, null, null, null, null, null, null, null, 'Feishu')`（`'Feishu'` 不在 `SESSION_SOURCE_VALUES` 闭集内）；
  3. 实际捕获到 `whereSql` 含 `source = ?` 且 `params` 含 `'Feishu'` → 真实执行时返回空集；
  4. 按设计定案，此处 whereSql 不应含 source 条件（等价于不过滤）。
- 建议核对方向（供修复参考，未改动代码）：该分支要么按定案在拼条件前用 `isSessionSource(source)` 校验、非法回落不过滤，要么同步修正技术方案定案 / 注释 / CHANGELOG 的「宽松忽略」表述，二选一保持一致。

## 附录：已核查且未发现问题的方向

以下各项均通过通读代码 + 临时测试实测确认无误（临时 spec 共 6 用例全部通过后删除）：

1. **四个 createSession 写入点（16 位置参数，`as unknown as` 强转无编译期保护）**：飞书（`app-feishu-messaging.ts:75-80`，p2p 与群聊共用 factory，钉钉/飞书的 p2p control 也路由回同一 factory）、钉钉（`dingtalk/runtime.ts:117-124`）、微信（`weixin/session.service.ts:60-77`）、开放接口（`openapi/open-run.service.ts:149-166`）均只追加一个尾参，中间参数零串位。用真实 `SessionService.createSession`（真实落库逻辑，非 mock 断言）逐通道复刻四组实参跑通：`source` 分别落 `'feishu'/'dingtalk'/'weixin'/'openapi'`，workspace/projectKey/title/permissionLevel/modelId 各就各位（微信的 `projects/weixin-bot` 工作区、open-run 的 READ_ONLY 默认档位均与既有行为一致）。
2. **闭集扩宽连锁面**：`USER_SETTABLE_SESSION_SOURCES`（`['web','embed']`）与 `isUserSettableSessionSource` 原样未动，POST `/v1/sessions`（session.routes.ts:159）与 PUT `/v1/sessions/:id/source`（:332）的用户入口守卫、`markSessionSource` embed-only 守卫（session.service.ts:379）均不读 `SESSION_SOURCE_VALUES`，新来源值无法被用户伪造；后端 `SessionGroupKey.of` 与 desktop `cloudGroupKey` 对新值无专属分支，按路径/模式启发式落桶（embed/signal 专属分支保持），与扩宽前落桶一致。`GET /v1/sessions?source=` 分支随 `isSessionSource` 扩宽接受七值，但仅按 userId 圈定本人会话、无越权面（400 文案「（web 或 embed）」字样略滞后，属文案问题不计 bug）。
3. **admin 筛选 SQL**：`clauses`/`params` 严格 lockstep（user_id → source → agent_id → execution_mode → phase → keyword → status），source 单独与 userId+keyword 组合两种形态均实测占位符数量与参数顺序一致；`admin-session.routes.ts` 实参顺序与 service 形参顺序逐位对应。V109 迁移 `source VARCHAR(16) NOT NULL DEFAULT 'web'` 对存量行回填 'web'，故筛选 `source='web'` 与 `toAdminSessionVO` 的 `?? 'web'` 显示口径一致，不存在「显示为 Web 但筛 Web 筛不到」的 NULL 行。
4. **desktop 徽标容错**：`sourceBadge` 对 `undefined`/`'web'` 返回 null 不渲染，未知脏值回落原文 tooltip；desktop `Session.source?: string`（types.ts:48）可选；数据链路完整——后端 `toSessionVO` 恒输出 source、`normalizeSession` 展开透传、WS `session_snapshot` 只 patch phase 不整体替换实体、`updateSession` 与既有实体合并，徽标不会因增量更新丢失；`@mao/contracts` 直出 src 无构建步骤，两端 `Record<SessionSource,string>` 穷尽由 vue-tsc 兜底（admin/desktop `npm run build` 均通过）；徽标 DOM 在 `.task-index-panel` 容器内，CSS 作用域生效。
5. **被更新的既有测试**：open-run spec 的 API→`'openapi'`、WEBHOOK→`'openapi'`、SIGNAL→`'signal'` 三态断言与实现一致；新增「复用既有会话不改写 source」用例与真实代码路径相符（`sessionId` 指定时走 loaded 分支，全程无 source 写点）；weixin spec 补第 16 参 `'weixin'` 后 16 个匹配器与真实实参逐位对应。全部后端 443 个测试文件（5206 用例）通过，admin/desktop 构建通过。

## 附：验证环境

- 后端全量：`cd backend-ts && npm test` → 443 passed | 1 skipped（含本 worktree 短路径，无 EADDRINUSE 干扰）
- 前端：`cd admin && npm run build`、`cd desktop && npm run build` 均通过
- 临时验证用例（已删除）：`backend-ts/src/session/tmp-review-verify.spec.ts`，6 用例覆盖四个写入点端到端落库 + admin source 筛选 SQL 捕获（单值/组合）
