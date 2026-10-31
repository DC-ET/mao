# 容器 /etc/hosts 注入（Docker 模式）代码审查报告 · Round 1

- 审查日期：2026-10-31
- 需求方案：`docs/plan/2026-10-31-container-hosts-injection.md`
- 审查范围：`git status --short` 中未提交改动（仅代码，未审查 docs/ 与 CHANGELOG）
- 结论：**可合并（无阻塞项）**；重要 1 项、建议 3 项
- 验证方式：新增临时 vitest 用例（已在验证后删除），并复用现有 19 个 `harness/container` + `settings` spec（277 tests 全通过）、`admin` 侧 `vue-tsc -b` 通过、后端生产代码 `tsc` 无新增错误

---

## 一、重要（1 项）

### I-1 「解析降级」结果被当作期望指纹参与漂移判定：一次瞬时读库 / 读 hosts 文件失败会把用户容器整机重建（恢复后再重建一次）

- 位置：
  - `backend-ts/src/harness/container/container-registry.ts:421-437`（`hostsInjectionDrifted()` / `currentHostsFingerprint()`，被 `:313`、`:331` 两个复用分支调用）
  - `backend-ts/src/harness/container/container-hosts-resolver.ts:82-131`（`buildPreview()` 的两处降级：读设置失败 → `inheritEnabled=true` + 自定义规则丢弃；读 `/etc/hosts` 失败 → 继承条目丢弃）
- 问题描述：
  方案 §4.6 要求解析失败时"降级、不阻塞容器创建"，但降级后的结果与"配置真的为空"无法区分，而 `currentHostsFingerprint()` 把降级结果当成了权威的期望指纹。于是：
  1. 系统设置读失败（DB 抖动 / 连接池耗尽 / 主从切换）→ 自定义规则整体丢失 → 期望指纹变化 → `hostsInjectionDrifted()` 返回 true → `rebuildEntry()`（`stop -t 10` → `rm -f` → `run -d`）；
  2. 故障恢复、resolver 5s TTL 到期后指纹又变回原值 → 再次漂移 → 再重建一次；
  3. 降级窗口内新建的容器会"静默"丢掉宿主继承 / 自定义规则（新建后指纹=降级值，恢复后不会自动补回，只能等下一次其它漂移或人工重建）；
  4. 同一路径下 `preview().hostsFileError` 只会暴露文件读取失败，设置读取失败只在 harness 日志里有一条 warn，后台面板会显示"自定义规则为空"，管理员无法判断是配置真没了还是读库失败。
- 复现 / 验证（临时用例，已验证通过）：
  ```ts
  // 真实 resolver + ContainerRegistry
  const resolver = new ContainerHostsResolver({
    systemSettingService: { async getValue(key) {
      if (failSettings) throw new Error('db down');
      return key === CONTAINER_EXTRA_HOSTS_KEY ? '[{"host":"a.internal","ip":"10.1.2.3"}]' : null;
    } },
    readHostHostsFile: async () => { if (failFile) throw new Error('EACCES'); return '10.0.0.9 file.internal'; },
    now: () => clock,            // 手工推进时钟越过 5s TTL
  });
  const registry = makeRegistry(base, log, () => resolver.resolve());

  await registry.ensureRunning(7);                 // run -d 含 --add-host a.internal:10.1.2.3
  failSettings = true; clock += 10_000;            // 瞬时读库失败
  await registry.ensureRunning(7);                 // 实测 dockerOps = ['stop -t','rm -f','run -d']  ← 容器被重建
  failSettings = false; failFile = true; clock += 10_000;   // 瞬时读文件失败
  await registry.ensureRunning(7);                 // 实测 dockerOps = ['stop -t','rm -f','run -d']  ← 再重建
  failFile = false; clock += 10_000;               // 恢复
  await registry.ensureRunning(7);                 // 实测 dockerOps = ['stop -t','rm -f','run -d']  ← 第三次重建
  // hostsFingerprint 最终回到初始值
  ```
  实测输出：`{"opsOnDbBlip":["stop -t","rm -f","run -d"],"opsOnFileBlip":["stop -t","rm -f","run -d"],"opsOnRecovery":["stop -t","rm -f","run -d"]}`
- 影响面：任何用户在下一次容器调用时（工具调用 / 终端 / MCP 都走 `ensureRunning`）被整机重建，容器内 shell / 终端 / 在途任务全部中断（方案 §7.2 明确这是需要用户感知的代价，但此处代价来自与配置无关的瞬时故障）；一次故障最多造成 2 次重建，且故障窗口内新建容器会丢配置。
- 修复建议（供后续 worker 执行）：
  - `ContainerHostsResolver` 的 `ContainerHostsPreview` 增加 `degraded: boolean`（或 `settingsError: string | null`），`buildPreview()` 在两处 catch 里置位；
  - `ContainerRegistry.hostsInjectionDrifted()` 在拿到降级结果时直接 `return false`（保留旧指纹、不重建），只在解析成功时比对指纹；同时 `createAndStart()` 也应在降级时不写入新指纹（或写入"上次成功指纹"），避免降级值被固化；
  - 预览接口把 `degraded/settingsError` 透出给后台面板，避免"读库失败"被显示成"规则为空"。

---

## 二、建议（3 项）

### S-1 前端 IP 校验未覆盖后端 `ssrf.ts` 的全部云元数据地址，与"前后端同口径"不符

- 位置：`admin/src/views/settings/containerHosts.ts:33-41`（`isBlockedContainerHostIp`），对照 `backend-ts/src/common/ssrf.ts:97-108`（`CLOUD_METADATA_IPS`）与 `backend-ts/src/common/container-hosts.ts:68-77`（`isBlockedContainerHostIp`）
- 问题描述：后端用 `isCloudMetadataIp()` 拦截 5 个地址（`169.254.169.254`、`100.100.100.200`（阿里云，本项目线上云厂商）、`169.254.0.23`（腾讯云）、`169.254.170.2`（AWS ECS）、`fd00:ec2::254`），前端只硬编码了 `169.254.169.254`。文件头注释声称"校验口径与后端一致"，实际不一致。
- 复现 / 验证（临时用例，已验证：该断言失败即为问题成立）：
  ```ts
  import { validateCustomHostEntry as backendValidate } from '../common/container-hosts.js';
  import { containerHostEntryError as frontendValidate } from '../../../admin/src/views/settings/containerHosts.js';
  ['169.254.169.254','100.100.100.200','169.254.0.23','169.254.170.2'].map(ip => ({
    ip, backend: backendValidate('a.internal', ip), frontend: frontendValidate('a.internal', ip),
  }));
  // 实测：backend 全部返回错误；frontend 对 100.100.100.200 / 169.254.0.23 / 169.254.170.2 返回 null（放行）
  ```
- 影响面：管理员在「容器域名解析」面板录入这三个地址时前端校验通过、提交后后端返回 `PARAM_INVALID`（"容器域名解析规则不合法：…"），得到的是迟到的失败提示，而不是就地拦下；安全侧无影响（后端仍拦截）。
- 修复建议：前端 `RESERVED/blocked` 判定改为与后端一致的云元数据地址集合（建议把该集合收敛到一处共享常量或在前端显式列出同样 5 项）。

### S-2 `parseHostHostsFile()` 在恰好达到上限时误报 `truncated`

- 位置：`backend-ts/src/common/container-hosts.ts:166-176`（`if (entries.length >= limit) { truncated = true; break; }`）
- 问题描述：传入恰好 `limit` 条有效条目、后面没有任何条目时也会 `truncated = true`，调用方（`container-hosts-resolver.ts:114-117`）据此打下误导性 warn "`/etc/hosts` entries exceed limit, truncated"。
- 复现 / 验证（临时用例，已验证）：
  ```ts
  const content = Array.from({ length: 100 }, (_, i) => `10.0.0.1 h${i}.internal`).join('\n');
  const parsed = parseHostHostsFile(content);
  expect(parsed.entries).toHaveLength(100);
  expect(parsed.truncated).toBe(true);   // ← 实际为 true，但并未发生截断
  ```
- 影响面：仅日志噪音（上线首日排查"继承条目为何不全"时会被这条 warn 误导），不改变注入结果。
- 修复建议：改为"越过上限才算截断"，例如在 push 之前判 `if (entries.length >= limit) { truncated = true; break; }`，push 之后不再置位；或返回 `entries.length > limit` 语义。

### S-3 「容器管理」单行重建用陈旧的 `busy` 快照传 `force=true`，绕过后端忙碌保护

- 位置：`admin/src/views/settings/components/ContainerRebuildPanel.vue:141`（`callRecycle(row.userId, includeBusy.value || !row.busy)`），对照 `:179`（"重建全部"只传 `includeBusy.value`）与后端 `backend-ts/src/harness/container/container-registry.ts:275-283`（`recycleUser` 中 `!opts.force && isBusy(entry)` 才跳过）
- 问题描述：方案 §4.11.3 约定"`force` 由全局勾选决定"。实现里单行按钮在 `row.busy === false` 时也传 `force=true`，而后端 `recycleUser` 拿到 `force=true` 会跳过**当下重新计算**的忙碌判定。`row.busy` 只是 `listEntries()` 那一刻的快照（由容器内 agent 的 `runtime_status` 上报驱动），列表打开后用户新起任务、上报尚未到达时会话就变成"看似空闲"。
- 复现 / 验证（后端行为已验证，组合出问题场景）：
  ```ts
  await registry.ensureRunning(7);
  registry.reportRuntimeStatus(7, { shellSessions: 0, pendingTasks: 1, attachedTerminals: 0 }); // 有在跑任务
  expect((await registry.recycleUser(7, { force: false })).status).toBe('skipped-busy'); // 后端保护生效
  expect((await registry.recycleUser(7, { force: true })).status).toBe('rebuilt');       // force 直接重建
  ```
  前端侧：`includeBusy=false` + 快照 `row.busy=false` → `force=true` → 命中第二行分支，在途任务被中断；而同一时刻「重建全部」会正确跳过。
- 影响面：后台文案承诺"默认跳过有在跑任务的容器"，但单行重建在快照过期窗口内会强制中断在途任务（确认弹窗只做通用提醒，管理员并未勾选"包括正在运行任务的容器"）。属功能语义不一致 + 小概率工作中断，非数据破坏。
- 修复建议：单行重建改为 `callRecycle(row.userId, includeBusy.value)`，与「重建全部」和后端保护语义一致；若确实想"该行当前空闲就强制"，应在弹窗里显式说明并复用后端返回的 `skipped-busy`。

---

## 三、已检查且未发现问题的点（供参考，避免重复审查）

- `common/container-hosts.ts`：host 归一化/长度/保留名、IP 段拦截（环回、云元数据、0/8、224/4、240/4）、JSON 解析与重复/数量/体积校验、`mergeContainerHosts` 自定义覆盖与排序、指纹稳定序列化（与 `createAndStart` 侧同源）。
- `container-hosts-resolver.ts`：设置读取、开关关闭不读文件、5s TTL 与 `invalidate()`、降级不抛错（降级语义问题见 I-1）。
- `container-registry.ts`：`--add-host` 注入位置与格式、`hostsFingerprint` 固化、running / stopped 两条复用分支的漂移判定（含"旧条目无指纹 + 期望为空不重建"）、`recycleUser` 的 none / skipped-busy / force / failed（含 stopped 容器重建）、`listEntries` 过滤与排序、与 `withUserLock` 的串行化。
- 路由与权限（临时 Fastify 用例验证）：`GET /v1/system-settings/container-hosts/preview`（`settings:read`，403 生效，返回结构正确）、`GET /v1/admin/containers`（`container:manage`）、`POST /v1/users/:id/container/recycle`（`container:manage`、`force` 透传、无 `containerOps` 时不注册）；单 key PUT 的 `afterSave` 传入的 key 与常量完全一致（缓存失效链路正确，无路由前缀/参数冲突）。
- `settings.service.ts`：`runtime.container.inheritHostHosts` / `runtime.container.extraHosts` 的 `validateValue` 分支（非空才校验、`null/''` 语义、不误伤其它 key），以及批量保存路径不会误写这两个 key（`SPECIAL_KEYS` + `settingsByCategory` 双重排除）。
- `V176`（`INSERT IGNORE` 两行，列/值匹配，`system_setting.value` 已在 V093 改为 TEXT，8KB 上限不会撞列宽）、`V177`（`permission` 唯一 code + `role_permission` 唯一键，写法与 V118 先例一致）。
- 管理后台：`SystemSettingsView` 的 TOC/渲染分支/id 映射与两个面板根节点 id 对齐、`ContainerHostsPanel` 的开关/校验/保存/预览刷新、`UserDetailDrawer` 的权限门槛与结果提示；`cd admin && npx vue-tsc -b` 通过（无类型错误）。

## 四、备注

- 本次审查使用的临时用例文件为 `backend-ts/src/__review_tmp__/*.repro.spec.ts`，验证完成后已删除，工作区未留残留（`git status --short` 与审查开始时一致）。
- 审查未覆盖（环境限制）：真实 Docker / MySQL 联调（`docker run --add-host` 的实际写入、Flyway 执行 V176/V177、浏览器端交互）；上述结论基于源码、单测与临时用例。
