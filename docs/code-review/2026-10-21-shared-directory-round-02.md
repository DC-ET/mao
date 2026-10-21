# 共享目录 /opt/mao-data/share 第二轮独立 Code Review（round-02）

> 审查对象：分支 `feat/shared-directory`（commit 4f3d2bbd，17 文件，`git diff main..HEAD`）
> 审查视角：回归风险（挂载指纹漂移重建 / mountedPaths / ensureWorkspaceMounted / idle 回收 / 并发 recycle）、设计文档 v1.1 逐条对照、对抗性 shareDir 误配、测试充分性
> 方法：代码通读 + 临时对抗性测试（17 例，跑通后已删除，未改任何生产代码）+ 全量测试 4576 passed / 0 failed
> 结论：**2 个 bug（P2 × 1，P3 × 1），建议修复后合并**（均为误配 fail-fast 缺口，正常配置下功能正确）

---

## Bug 1（P2）：相对路径 / 空值 `MAO_SHARE_DIR` 静默按 cwd 解析且不被 fail-fast，误配时整个后端工作树（含 .env 密钥）被 ro 挂进所有用户容器

【位置】
- `backend-ts/src/create-app.ts:277`（`const shareDir = resolve(expandHome(cfg.app.harness.shareDir));`——`resolve()` 把相对路径/空值静默变成 cwd 绝对路径，无任何校验）
- `backend-ts/src/config/app-config.ts:384-396`（`resolvePlaceholders`：`MAO_SHARE_DIR=""` 时 `process.env[key] !== undefined` 成立，空串原样采用，不回落默认值）
- `backend-ts/src/harness/container/container-mount-planner.ts:205-208`（`assertSafe` 的 owningRoot 校验对 share 条目恒真通过：`shareDir` 自身就在 `registeredRoots` 里，`host === root` 平凡命中）

【问题描述】
第一轮把「`MAO_SHARE_DIR=""` 解析为 cwd 但会被 assertSafe owningRoot 检查 fail-fast」列为已接受边界——**该归因不成立**。实测：owningRoot 校验对 share 挂载条目恒真通过（shareDir 自己是登记根）；真正兜住 `""`/`"."` 的只有父目录防护，且仅当 cwd 恰好是另一登记根的父目录时成立——生产默认布局（systemd `WorkingDirectory=/opt/mao/backend-ts`，`distDir=/opt/mao-data/...` 不对，默认 `dist-dir=/opt/mao/backend-ts/dist` 在 cwd 之下）下 `""`/`"."` 会被拒，但：

1. **相对路径**（如 `MAO_SHARE_DIR=share`、`relative/../share`）：解析为 `{cwd}/share`，无任何登记根在其下 → **静默放行**，`{cwd}/share` 被 ro 挂进每个用户容器；
2. **空值 + 自定义 distDir**（`MAO_CONTAINER_DIST_DIR` 迁出仓库目录，该 env 在 config.md 中作为容器调参公开）：`""` 解析为 cwd 自身 → **静默放行**，整个 `/opt/mao/backend-ts` 工作树被 ro 挂进每个用户容器。该目录含 `backend-ts/.env`（`start-backend.sh:18` 从该目录 source），内有 `MYSQL_PASSWORD`、`JWT_SECRET`、`SETTINGS_SECRET`、`APP_GIT_CREDENTIAL_SECRET`、`APP_MCP_SECRET`、LDAP/飞书 secret、`TAVILY_API_KEY`、OSS STS 等——容器内任意 CLOUD 用户经 `read_file`/`glob_search`/`grep_search`/`shell` 绝对路径即可读取，构成跨用户密钥泄露。

注意 `skillsDir` 默认为相对路径 `./skills`，运维照抄该写法设 `MAO_SHARE_DIR=./share` 是合理误操作，不是纯臆测。

【复现/验证方式】
临时测试（已删除）`src/harness/container/zz-temp-share-adversarial.spec.ts`，两例均跑通：

- 例 A（夹具根在 cwd 之下，镜像生产默认布局）逐项探测 `plan(7)` 结果：
  ```
  BADPATH-OUTCOMES {
    "share":             "ACCEPTED hostPath={cwd}/share",
    "":                  "REJECTED MountPlanError",   // 仅因夹具根都在 cwd 下
    "/":                 "ACCEPTED hostPath=/",       // 见 Bug 2
    "relative/../share": "ACCEPTED hostPath={cwd}/share",
    ".":                 "REJECTED MountPlanError"    // 仅因夹具根都在 cwd 下
  }
  ```
- 例 B（夹具根用 `useTmpDirOutsideRepo` 放到 cwd 之外 + distDir 迁出，镜像"自定义 distDir"生产形态）：`shareDir=''` 时 `plan(7)` **不抛错**且 share 条目 `hostPath === process.cwd()`；`shareDir='share'` 时 `hostPath === {cwd}/share`。断言 `expect(hostPath).toBe(process.cwd())` 通过。

【严重程度】P2（需误配触发；默认布局部分缓解；自定义 distDir 下为静默密钥泄露）

【建议修复方向】
在 `create-app.ts` 装配前（或 `assertShareDirIndependent` 内）对**原始配置值**做绝对路径校验：`shareDir` 为空或非 `path.isAbsolute` 时启动即抛明确配置错误（如 `MAO_SHARE_DIR must be an absolute path, got ''`）。注意必须在 `resolve(expandHome(...))` **之前**判断，否则相对路径已被静默转绝对。另可考虑 `resolvePlaceholders` 对空串回落默认值（与 Spring `${VAR:default}` 语义一致），但显式报错比静默回落更符合本方案 fail-fast 原则。

---

## Bug 2（P3）：`shareDir='/'` 逃过父目录防护（`host + path.sep` 拼成 `'//'` 永不匹配），整棵宿主文件系统将被 ro 挂进所有容器

【位置】
`backend-ts/src/harness/container/container-mount-planner.ts:224-229`（父目录防护）：
```ts
for (const root of registeredRoots) {
  if (root === host) continue;
  if (root.startsWith(host + path.sep) || root === host) {
    throw new MountPlanError(`mount ${mount.purpose}: ${host} is a parent of registered root ${root}`);
  }
}
```

【问题描述】
`host='/'` 时 `host + path.sep` 拼出 `'//'`，而任何绝对登记根都不以 `'//'` 开头 → 判定恒 false → 防护静默失效。叠加 Bug 1 同款的 owningRoot 平凡通过（shareDir 自身是登记根），`MAO_SHARE_DIR=/` 时 `plan(7)` **不抛错**，share 条目 `hostPath='/'` 会被 `--volume /:/:ro` 挂进每个用户容器：`/etc/shadow`、`/root`、`/home`、以及未被逐用户 rw 挂载遮蔽的其他用户数据（如 `/opt/mao-data/workspace/8`）全部可读。

该表达式缺陷是**既有代码**（非本次引入），但本次特性把它变成承重部件：设计文档 §4.1 明确宣称"父目录防护：shareDir 若被误配为某登记根的父目录（如 /opt/mao-data）直接抛 MountPlanError"——对 `/opt/mao-data` 成立，对 `/` 不成立。第一轮用 `/opt/mao-data` 类路径验证过该防护，未覆盖 `/` 这个唯一特殊值。

【复现/验证方式】
临时测试（已删除）`relativeAndRootShareDirEscapesFailFast`：`new ContainerMountPlanner({...roots, shareDir: '/'}).plan(7)` 不抛错，share 条目 `hostPath='/'`（见 Bug 1 例 A 输出中 `"/": "ACCEPTED hostPath=/"`）。断言 `expect(outcomes['"/"']).toBe('ACCEPTED hostPath=/')` 通过。

【严重程度】P3（触发配置荒谬、概率极低；但一旦触发影响为整机文件系统暴露，且修复是一行表达式）

【建议修复方向】
父目录防护改用 `path.relative` 包含判定，天然处理 `host='/'`：
```ts
const rel = path.relative(host, root);
if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
  throw new MountPlanError(`mount ${mount.purpose}: ${host} is a parent of registered root ${root}`);
}
```
（顺带删掉条件里已被 `continue` 覆盖的死代码 `|| root === host`。）

---

## 其他观察（非 bug，供参考）

1. **测试卫生（P3）**：`runtime-agent.spec.ts:170-185` `defaultsShareDirWhenEnvUnset` 只删 `MAO_SHARE_DIR`，其余 root env 均为未设置状态，`PathSandbox` 构造器会 `mkdirSync('/opt/mao-data/workspace/7', {recursive:true})`（`path-sandbox.ts:22-26`，异常被 catch 吞掉）。在 `/opt` 可写的机器（root 身份的 CI 容器）上会留下真实目录。建议该用例显式设 `MAO_WORKSPACE_ROOT` 等指向临时目录，或改探针 `PathSandbox` 构造。
2. **测试缺口（P3）**：设计 §4.1 正文声称"shareDir 等于 distDir/skillsDir 会被重复容器路径检测拒绝"，但 §8 测试计划未列该用例，现有 spec 无回归覆盖。本次已临时验证行为正确（两者均抛 `MountPlanError`），建议补一条 `rejectsShareDirEqualToDistOrSkills` 防回归。同理，glob/grep/shell 对 share 的可达性（设计 §1.2 目标 2 与 CHANGELOG 均声称）只有 read_file 有测试，本次临时验证三者均正常（同一 `resolveLenient` 代码路径），建议至少补 shell workdir 一例。
3. **提交卫生（P3）**：`file/workspace-write.service.spec.ts` 的 `vi.waitFor` 抖动修复与本特性无关，混在同一 feature commit 里；改动本身正确（条件等待替代固定 15ms），无功能影响。
4. **误配接受面说明**：shareDir 设为 mao 数据树之外的任意合法绝对路径（如 `/etc`、`/var/tmp`）会被接受——这与 `distDir`/`skillsDir` 的既有行为一致（登记根机制），属"管理员自选路径"设计而非缺陷，仅提示运维文档已强调"共享即公开"。

---

## 已验证无问题的重点（第一轮结论抽查 + 本轮新增）

- **回归风险**：share 条目进标准挂载清单后，`standardMountsFingerprint` 与 `createAndStart` 的 `fingerprintOf(plan().filter(!sessionWorkspace))` 同源同序列化，临时测试验证两次计算一致且重复 `ensureRunning` 不触发第二次 `docker run`（无无限重建）；`mountedPaths` 含 shareDir 后 `isMounted`/`ensureWorkspaceMounted` 对 share 下路径直接放行不重建；idle 回收、并发 recycle（世代/锁机制）与新条目无交互；误配时 `ensureRunning` 在 `mountPlanDrifted` 路径抛 `MountPlanError` 且未发出任何 `docker run`（fail-fast 到位）。
- **对抗性配置**：尾部斜杠归一后放行且指纹不变；`..` 归一到兄弟目录放行、归一进 workspaceRoot 拒绝；8 个每用户根（workspace/runtime/userHome/userSkills/upload/channel/deps/tmp）相等或其下均拒绝；`/mnt/share`、`/opt/mao-data/share`、`/srv/mao-share` 等合法值放行；share 内指向外部/每用户根的 symlink 均被逃逸检测拒绝；shareDir 位于 distDir/skillsDir 之下被父目录防护保守拒绝（无害）。
- **设计对照**：§3.1 三处配置 + 启动创建、§4.1 挂载 + assertShareDirIndependent 等式校验、§4.2 沙箱放行、§4.3 env 透传（`-e MAO_SHARE_DIR` + `:ro` 卷）、§4.4 指纹漂移重建、§8 测试计划 8 条、§9 文档清单（CHANGELOG 0.0.325 / config.md / deploy.md / DEPLOY.md 链接有效 / .env.example / application.yml；README 与 mao-cli SKILL.md 未列数据目录结构，无需改）全部落地。
- **全量测试**：`cd backend-ts && npm test` → 376 files passed / 1 skipped，4576 passed / 13 skipped / 0 failed（含临时测试；基线 4560 + 临时 17 - 删除后一致）。
