# 三级环境变量（用户 / 工作区 / 系统）代码审查

- 日期：2026-10-18
- 范围：`mao/` 工作区未提交改动；本报告以审查时快照为准（并发编辑导致工作区在审查期间变化，快照 md5：`env-variable.service.ts` `a860095d…`、`env-variable.routes.ts` `81c212ff…`、`workspace-key.ts` `0e8c523e…`）
- 方法：只读精读后端 env 域 / 三条注入链路 / 前端三处入口；用 `/tmp` 下的临时脚本与 `fastify.inject` 复现，未改动仓库代码
- 已跑验证：`backend-ts` build 通过；`src/env` 21 个用例、`src/harness/{shell,terminal,container}` 169 个用例全部通过；`desktop` / `admin` build 通过

## 总体结论

**未发现阻塞项（0 个阻塞），可合并；但有 2 个中等功能缺陷建议合并前修复，另有 2 个低优先级边界问题。** 三条注入链路（host shell / 容器 envelope / 云端终端）的注入、删除 unset、工作区绑定与保留键双保险整体一致，未发现链路级行为分裂。

| 编号 | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| BUG-1 | 中 | `backend-ts/src/env/env-variable.routes.ts:52,88,138` | PUT 缺少 `envValue` 时被 `?? ''` 兜底，静默把已存变量值清空 |
| BUG-2 | 中 | `backend-ts/src/env/env-variable.service.ts:282-284,310` | `effective-env` 按「低优先级先占位」归因，来源/备注/条数与实际生效值相反 |
| BUG-3 | 低 | `backend-ts/src/env/env-variable.service.ts:545-552` | `INHERITED` 过滤漏平台密钥键名（`SETTINGS_SECRET` 等），新接口可被枚举 |
| BUG-4 | 低 | `backend-ts/src/env/workspace-key.ts:15-16` | 非空 workspace 未 `trim`，带前后空白的路径被当作相对路径解析，变量永不生效 |

---

## BUG-1【中】更新接口缺少 `envValue` 时静默清空变量值

### 位置

- `backend-ts/src/env/env-variable.routes.ts:50-53`（用户层 PUT）
- `backend-ts/src/env/env-variable.routes.ts:86-89`（工作区层 PUT）
- `backend-ts/src/env/env-variable.routes.ts:136-139`（系统层 PUT）
- 对照：`backend-ts/src/env/env-variable.service.ts:334-338` `requireValueOnUpdate` 明确要求「更新时值必传」

### 问题

三个 PUT 路由都把 `body.envValue ?? ''` 传给 service。service 的 `requireValueOnUpdate` 只在值 `== null` 时报 `PARAM_INVALID`，路由提前把 `undefined` 变成了空串，因此「必传」约束被绕过，缺失值被当成「显式清空」落库。

### 影响

任何按「局部更新」语义只传 `note`（或只改 `envKey`）的调用方都会在无提示的情况下丢掉已加密保存的值；随后下一条命令 `export KEY=''`。用户层变量被清空后会覆盖系统层同名变量；工作区层被清空后会覆盖用户/系统层，属于静默数据丢失与优先级反转。

### 触发条件

`PUT /v1/user/env-variables/:id`、`PUT /v1/user/workspace-env-variables/:id`、`PUT /v1/admin/system-env-variables/:id` 的 body 不含 `envValue`。前端三个弹窗都要求重新输入值，因此 UI 主流程不触发；API / 脚本调用会触发。

### 建议修复

路由不要兜底：传 `envValue: body.envValue`，让 service 对 `undefined/null` 抛 `PARAM_INVALID`；若需保留「显式空串清空」，用 `Object.prototype.hasOwnProperty.call(body, 'envValue')` 区分「未传」与「传空串」。

### 验证用例（已在临时副本实测：当前返回 `code=0`，`resolveForSession` 变为 `{ KEEP_ME: '' }`）

```ts
it('PUT 不传 envValue 时必须报错而不是清空', async () => {
  const { app } = buildApp();
  const created = (await app.inject({
    method: 'POST', url: '/v1/user/env-variables',
    payload: { envKey: 'KEEP_ME', envValue: 'orig' },
  })).json().data;

  const put = await app.inject({
    method: 'PUT', url: `/v1/user/env-variables/${created.id}`,
    payload: { note: 'only note' }, // 未传 envValue
  });
  expect(put.json().code).toBe(ErrorCode.PARAM_INVALID.code); // 期望 400 语义；当前为 0
  expect(await service.resolveForSession(9, null)).toEqual({ KEEP_ME: 'orig' });
});
// 工作区层、系统层 PUT 用同一断言复跑，当前三处都失败
```

---

## BUG-2【中】「当前生效变量」的来源归因与真实优先级相反

### 位置

- `backend-ts/src/env/env-variable.service.ts:282-284`（先 SYSTEM、再 USER、再 WORKSPACE 调用 `pushRows`，`seen` 先到先得）
- `backend-ts/src/env/env-variable.service.ts:310`（`totals` 同样按先占位统计）
- 消费方：`desktop/src/components/chat/EnvVarsDrawer.vue:23-45`（按 source 分组、显示 note）

### 问题

`resolveForSession` 的合并顺序是 system → user → workspace（后者覆盖前者），但 `resolveEffectiveEnv` 用同一个 `seen` 从低优先级开始去重：同名变量留在 SYSTEM 分组，USER/WORKSPACE 行被直接丢弃。实测同一个 key 三层都配置时：

```text
resolveForSession -> { SHARED: 'ws-value' }      # 实际生效工作区值
resolveEffectiveEnv -> [{ envKey:'SHARED', source:'SYSTEM', note:'sys' }]
totals -> { system:1, user:0, workspace:0, ... } # 实际应为 workspace:1
```

### 影响

会话头部抽屉是需求的核心可观测入口。用户会看到「这个变量来自系统全局、备注是系统的」，而实际执行用的是工作区值；覆盖关系完全不可见，排障时会被误导。另外 `effective-env` 不解密，解密失败的变量仍会以「生效」出现（注入侧却跳过），进一步扩大配置态视图与真实环境的偏差。

### 触发条件

同一变量名在两层及以上配置（尤其 system 与 workspace、user 与 workspace），打开会话头部「环境变量」抽屉或直接请求 `/v1/sessions/:id/effective-env`。

### 建议修复

按 `workspace → user → system` 顺序去重（保留最高优先级并标记低层为「已覆盖」），或先计算每个 key 的胜出层再分组；`totals` 按胜出层计数。若要保持「每层都展示」，则 VO 增加 `overridden: boolean`，UI 标注覆盖关系。解密失败的行不应计入生效项。

### 验证用例（临时脚本实测：当前断言失败）

```ts
it('effective-env 的来源应为最高优先级层', async () => {
  await service.createSystem({ envKey: 'SHARED', envValue: 'system-value', note: 'sys' });
  await service.createUser(42, { envKey: 'SHARED', envValue: 'user-value', note: 'usr' });
  await service.createWorkspace(42, {
    workspacePath: '/tmp/ws/proj', envKey: 'SHARED', envValue: 'ws-value', note: 'ws',
  });

  expect(await service.resolveForSession(42, '/tmp/ws/proj')).toEqual({ SHARED: 'ws-value' });
  const eff = await service.resolveEffectiveEnv(42, '/tmp/ws/proj');
  expect(eff.items.filter((i) => i.envKey === 'SHARED'))
    .toEqual([{ envKey: 'SHARED', source: 'WORKSPACE', note: 'ws' }]);
  expect(eff.totals).toMatchObject({ system: 0, user: 0, workspace: 1 });
});
```

---

## BUG-3【低】`INHERITED` 枚举出平台密钥的键名

### 位置

- `backend-ts/src/env/env-variable.service.ts:545-552` `isDisplayableInheritedKey`
- 调用点：`env-variable.service.ts:297-305`（把 `process.env` 的键名放进 `effective-env` 响应）

### 问题

过滤只覆盖 `isSensitiveChildEnvKey`、`APP_`/`MYSQL_`/`MAO_` 前缀与 `JWT_SECRET`。项目 `.env.example` 中的 `SETTINGS_SECRET`、以及 `DINGTALK_OAUTH_SECRET`、`*_API_KEY` 等都不在过滤范围。新接口 `/v1/sessions/:id/effective-env` 会把这些键名返回给任意登录用户（只返回键名，不返回值）。

### 影响

新增了一个平台配置面的枚举通道，攻击者可据此确认服务端使用了哪些密钥/集成（如 settings 主密钥、DingTalk OAuth），提高定向攻击与社工的准确度；与「INHERITED 只列非敏感键」的设计意图不符。值本身未泄漏。

### 触发条件

部署环境存在 `SETTINGS_SECRET` / `DINGTALK_OAUTH_SECRET` / `SOME_API_KEY`（前两项在 `.env.example` 中即有），请求有效会话的 `effective-env`。

### 建议修复

对 `INHERITED` 改白名单（只放行 `PATH`/`LANG`/`TMPDIR`/`TERM` 等基础键），或追加按名称的敏感词过滤（`/(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i`），并把 `SETTINGS_SECRET` 补进 `isSensitiveChildEnvKey`。

### 验证用例（临时脚本实测：三项均 `listed: true`）

```ts
it('INHERITED 不列平台密钥键名', async () => {
  process.env.SETTINGS_SECRET = 'x';
  const eff = await service.resolveEffectiveEnv(1, null);
  const names = eff.items.map((i) => i.envKey);
  expect(names).not.toContain('SETTINGS_SECRET');
  expect(names).not.toContain('DINGTALK_OAUTH_SECRET');
});
```

---

## BUG-4【低】workspace 归一化不对非空值 `trim`，带空白路径永不命中

### 位置

- `backend-ts/src/env/workspace-key.ts:15-16`

### 问题

第 15 行用 `String(workspace).trim() === ''` 判断空值，但第 16 行用未 trim 的原串做 `path.resolve`。`" /tmp/ws "` 会被解析成 `<backend cwd>/ /tmp/ws `（相对路径），而不是 `/tmp/ws`。

### 影响

通过 API 写入带前后空白的 `workspacePath` 后，变量存到一个永远不会被会话命中的键；同一用户后续用正常路径配置的同名变量不会覆盖它，造成「保存成功但不生效」的排查困难。

### 触发条件

`POST /v1/user/workspace-env-variables` 或 `GET ...?workspace=` 传入首尾带空白的路径（前端不会主动产生，属 API 边界）。

### 建议修复

`return path.resolve(String(workspace).trim());`，并补一条 `normalizeWorkspaceKey(' /tmp/ws ', root) === '/tmp/ws'` 的单测。

### 验证用例

```ts
it('workspace 前后空白按同一键归一化', async () => {
  expect(normalizeWorkspaceKey(' /tmp/ws ', '/tmp/root')).toBe('/tmp/ws');
  await service.createWorkspace(1, { workspacePath: ' /tmp/ws ', envKey: 'X', envValue: 'v' });
  expect(await service.resolveForSession(1, '/tmp/ws')).toEqual({ X: 'v' });
});
```

---

## 已核对且未发现问题的关键点

1. **host shell 删除语义**：`createSession` 注入并登记初始键；`refreshUserEnvironment` 接收第 5 参，`refreshEnvironment` 用 `nextKeys` 重算 `userEnvironmentKeys` 并 `unset` 已删除键；`PATH` 守卫保留。
2. **workdir 子目录不换绑**：`handleExec` 用工具上下文 `workspace` 解析变量，`getOrCreate` 的第 7 参 `envWorkspace` 固定为会话创建时 workspace；`handleWriteStdin` 用 `session.envWorkspace`。
3. **容器链路**：`RuntimeEnvelope.envVars` 由 `SessionEnvelopeBuilder` 宿主侧填充，`ContainerToolExecutor` 以 `() => currentEnvelope?.envVars` 传给容器内 `ShellSessionManager`，容器内零查库；`container-import-constraints.spec.ts` 的 `env-variable.(service|repository)` 模式能拦住 env 域 import。
4. **终端链路**：`TerminalManager.buildEnv` 在 spawn 时注入，失败只告警不阻断；已打开 PTY 不感知后续变更与设计一致。
5. **优先级与保留键**：`resolveForSession` 顺序 system < user < workspace；写入侧 `assertConfiguredEnvKey` 与合并侧 `isReservedEnvKey` 双保险，大小写变体（`path`/`Path`）均拒绝；`PATH` 不会进 unset 清单。
6. **缓存**：`bundle`（开关+系统层）、`user:{id}`、`ws:{id}:{path}` 分离，写入后本实例失效；DB 异常均降级为空结果，不阻塞 shell/终端创建。
7. **权限**：用户侧 userId 取登录态；工作区/用户层查询均带 `user_id`；`effective-env` 校验 `session.userId === 登录用户`；admin 无用户层写路由（POST 实测 404）；`/v1/admin` 读操作命中审计前缀。
8. **前端主流程**：设置页、抽屉、管理后台面板均做到「编辑不回显时值必填」、保存后刷新、无工作区会话给出明确提示；构建通过。
