# 代码审查：Agent 团队经验库（round-01）

- 审查对象：worktree `.worktrees/agent-experience-library`，分支 `feature/agent-experience-library`
- 审查范围：`git diff c0191676..HEAD`（单提交 7a79d974，0.0.339），仅功能逻辑，不含文档变更
- 技术方案：`docs/plan/2026-10-24-agent-experience-library-technical-design.md`
- 审查日期：2026-10-24
- 结论：发现 **2 个「一般」级 bug**（均已用测试复现验证）、1 个轻微问题、1 个存疑项；其余（迁移/V169、admin 六接口、容器挂载 ro→rw 与指纹、宿主沙箱登记、提示词分节与 manifest、admin UI）逻辑正确，相关既有测试 217 + 794 个全部通过。

---

## Bug 1（一般）：Agent 经工作区挂载链接 `团队经验/` 写入时，索引刷新回调永远不触发——技术方案 §3.5 触发点 2 在主流程失效

**位置**

- `backend-ts/src/harness/experience/experience-index.service.ts:124-134`（`refreshIfUnderRoot` 的 `isUnder(resolved, this.root)` 词法判定）
- `backend-ts/src/harness/tool/impl/write-file-tool.ts:54,64` / `backend-ts/src/harness/tool/impl/edit-file-tool.ts`（`notifyFileChanged(filePath)` 传入的是 `pathSandbox.resolveLenient` 的**词法解析**路径）

**问题描述**

`resolveLenient` 只做 `path.resolve` 词法拼接，不解析符号链接（宿主模式 L75 直接返回词法路径；容器严格模式 `resolveLenient` → `resolve` 返回的同样是词法路径，`assertNoSymlinkEscape` 只校验不改写）。因此 Agent 按路标文案以相对路径 `团队经验/2026-10-24-xxx.md` 写入时，回调收到的是 `<workspace>/团队经验/2026-10-24-xxx.md`，`refreshIfUnderRoot` 里 `isUnder(resolved, this.root)`（this.root = `<shareDir>/agent-experience`）判定为假，直接 return——**文件经链接真实落进了库目录，但 INDEX.md 不刷新**。

而路标提示词（`prompt-engine.ts` EXPERIENCE_LIBRARY_HINT）只引导 `团队经验/` 相对路径，从不暴露共享目录绝对路径，所以「写工具成功回调」这一刷新触发点在生产主流程中**一次都不会生效**，仅当 Agent 碰巧用绝对路径直写库目录时才触发（单测覆盖的恰是这条非主流程路径，`experience-index.service.spec.ts:153-165`）。

**影响**

- 同一会话内沉淀经验后立即 `grep 团队经验/INDEX.md` 拿到的是陈旧索引（漏掉刚写的新文档；`edit_file` 修正经验后摘要/last_verified 行不更新）；
- 技术方案 §5「Agent 视角完整流程」第 3 步「写工具回调自动刷索引」实际不发生，靠触发点 1（下一次**建会话**时 `syncForSession` → `ensureFresh`）或触发点 3（admin 打开列表）兜底自愈。功能最终一致，但设计内的即时刷新整体失效，陈旧窗口从「shell 旁路写入才有」扩大为「一切写入都有」。

**复现/验证方式**

临时验证用例（已跑完删除，核心断言如下；复刻 `create-app.ts` 宿主侧 `addAllowedRoot(shareDir)` 装配）：

```ts
const sandbox = new PathSandbox(workspace);
sandbox.addAllowedRoot(shareDir);
const tool = new WriteFileTool(sandbox, (p) => indexService.refreshIfUnderRoot(p));
// 挂载链接后，按路标文案相对路径写入
await tool.execute(JSON.stringify({ path: '团队经验/2026-10-24-foo.md', content: '---\ntitle: X\n---\nbody' }), workspace);
// 文件确实经链接落进库目录，但 INDEX.md 仍为 '<!-- count: 0 -->'
// 对照：绝对路径直写库内 → 立即刷新为 '<!-- count: 2 -->'
```

- 运行：`cd backend-ts && npx vitest run src/harness/experience/zz-review-verify.spec.ts`
- 结果：4/4 通过——① 宿主模式：相对路径写入成功、文件落在 `<share>/agent-experience/42/` 下，但 INDEX.md 保持 `count: 0`；同用例随后绝对路径写入触发刷新变 `count: 2`（同时证明陈旧自愈逻辑本身正常，仅触发判定漏了链接路径）；② 容器 strict 模式（`new PathSandbox(workspace, { strict: true })`）同样不刷新；③ `edit_file` 经链接编辑后文档 mtime > 索引 mtime（索引陈旧的客观证据）。

**修复建议**

在 `refreshIfUnderRoot`（或 `notifyFileChanged`）中，词法判定不命中时对存在路径补一次 realpath 再判定：写回调发生在 `writeFileSync` 成功之后，文件必存在，`realpathSync(absPath)` 可靠地把 `<ws>/团队经验/x.md` 解析为 `<share>/agent-experience/<id>/x.md` 再走既有判定。例如：

```ts
const resolved = path.resolve(absPath);
let target = resolved;
if (!isUnder(resolved, this.root)) {
  try { target = realpathSync(resolved); } catch { return; } // 不存在则确非经验文件
}
if (!isUnder(target, this.root)) return;
```

并补一条「经挂载链接相对路径写入 → INDEX.md 立即含新条目」的回归用例（现有用例只测绝对路径直写）。

---

## Bug 2（一般）：存量会话只注入路标不补挂载，Agent 首次写入即在工作区建出真实 `团队经验/` 目录，并**永久阻塞**该工作区后续挂载

**位置**

- `backend-ts/src/session/session.service.ts:185,195-209`（挂载仅在 `createSession` 内执行一次）
- `backend-ts/src/harness/core/harness-service.ts:333-338`（`context.experienceLibrary` 每轮 `buildContext` 按开关注入，不校验链接是否存在）
- `backend-ts/src/harness/experience/experience-mount.service.ts:59-62`（`ensureDirSymlink` 遇同名真实目录仅 warn 后跳过，无自愈）

**问题描述**

挂载（`syncForSession`，全局唯一调用点是 `createSession`）与路标注入（`buildContext` 每轮执行）时机不一致：功能上线**之前**创建的存量 CLOUD 会话（尤其 git/项目模式共享工作区）升级后每轮都被注入「工作区内 `团队经验/` 目录是共享经验库」的路标，但工作区里没有链接。Agent 照路标执行 `write_file 团队经验/2026-10-24-x.md` 时，`WriteFileTool` 会 `mkdirSync` 父目录（write-file-tool.ts:62），于是在工作区创建**真实目录** `团队经验/`——经验写进了这个本地目录（共享库目录此时甚至尚未创建），跨会话、跨成员共享完全落空；随后该工作区新建会话时 `ensureDirSymlink` 发现同名非符号链接路径，仅打 warn 即跳过，**该工作区从此再也挂不上经验库**，需人工删除该目录才能恢复。

**影响**

- 升级当日所有存量活跃会话（最典型：项目/git 工作区）都会命中：提示词说有库、实际写进假库；
- 假目录一旦产生即永久阻塞后续挂载，且只有 `harnessLog('warn')` 一条日志，无任何 admin 可见信号；
- 数据不丢失（写在工作区内）、会话不中断，故定「一般」而非「重大」。

**复现/验证方式**

```ts
// 旧会话工作区：从未挂载链接
const workspace = join(base, 'ws-old'); mkdirSync(workspace, { recursive: true });
const tool = new WriteFileTool(sandbox, (p) => indexService.refreshIfUnderRoot(p));
await tool.execute(JSON.stringify({ path: '团队经验/2026-10-24-old.md', content: 'x' }), workspace);
// → existsSync(join(workspace, '团队经验/2026-10-24-old.md')) === true（真实目录，非共享）
// → existsSync(join(shareDir, 'agent-experience')) === false（库目录根本没建）
mountService.syncForSession(workspace, 42, true);   // 同工作区新会话挂载
// → lstatSync(join(workspace, '团队经验')).isSymbolicLink() === false（被真实目录阻塞，仅 warn）
```

- 运行：同上临时验证文件，结果通过（写入落真实目录、库目录不存在、后续 `syncForSession` 不再建链接）；
- 既有用例 `experience-mount.service.spec.ts:48-55`（"leaves non-symlink paths untouched"）从另一侧印证了「真实目录 → 永久跳过」的行为是被当前实现固化的。

**修复建议**

任选其一（推荐 a，改动最小且顺带兜住挂载瞬时失败的场景）：

- a) `harness-service.ts` 装配 `context.experienceLibrary != null` 时（或 `session.service` 侧在会话被复用/run 启动路径上）幂等补挂一次：`syncForSession` 本身幂等、成本为几次 lstat，能同时覆盖存量会话与建会话时挂载瞬时失败降级的场景；
- b) `ensureDirSymlink` 遇到**空**真实目录时替换为链接（非空仍跳过但需可观测）；至少把「挂载被同名目录阻塞」从 harnessLog warn 升级为 admin 可见的告警/指标。

---

## 轻微问题

### L1（轻微）：`index.md`（小写）可绕过 INDEX.md 写删保护

**位置**：`backend-ts/src/agent/agent-experience-library.routes.ts:90,109` 与 `backend-ts/src/harness/experience/experience-index.service.ts:93,110`——三处守护均用区分大小写的 `=== 'INDEX.md'` 字面比对，而 `requireDocFileName` 只校验 `.md` 后缀。

**问题**：admin PUT/DELETE `index.md` 不被拦截。Linux 生产盘上产生一个与 `INDEX.md` 并列的 `index.md` 垃圾文件，且会被 `scanDocs` 当作普通经验文档收进索引（仅 `entry.name === 'INDEX.md'` 被排除，`experience-index.service.ts:141`）；macOS 开发盘行为随卷大小写敏感性而异。已验证：`svc.writeDoc(dir, 'index.md', 'x')` 不抛错（本机大小写敏感卷上 INDEX.md 未被覆盖、产生并列文件）。

**修复建议**：文件名守护改为大小写不敏感比对（`fileName.toLowerCase() === 'index.md'` 即拒绝），扫描侧同步。

## 存疑

- **`scanDocs` 无读取上限**（`experience-index.service.ts:146`）：admin PUT 有 1MB 上限，但 Agent 可用 `write_file` 直写超大 `.md` 进库（写工具无大小限制），此后每次 `ensureFresh` 全量读入。仅性能/内存面，无正确性影响，未列为 bug；若关注可在扫描侧对超限文件跳过正文解析、仅以文件名入索引。

## 已排查无问题的点

- V169 迁移、repository/service/routes 的开关透传（`SELECT *` + `toCamel` 行映射，读写路径完整；bundle 导入导出按方案不含新列）；
- 容器 share 挂载 ro→rw：`fingerprintOfMounts` 序列化含 `mode`，指纹变化可触发存量容器重建（有专门用例）；
- `assertSafe` 新增 `share` 根 rw 例外限定恰为 shareDir 根；`assertShareDirIndependent` 未受影响；
- 宿主侧 `addAllowedRoot(shareDir)` 登记与严格模式 `assertNoSymlinkEscape` 对「链接目标命中允许根」的放行；
- `deleteWorkspaceDirectory` 删工作区不跟随链接（有回归用例锁死）；`.git/info/exclude` 幂等追加；换 Agent 重绑链接；
- 提示词分节位置（最佳实践经验之后、memories 之前）、`INJECTED_SECTION_KEYS` 登记、开关关/LOCAL 时零输出；
- admin 六接口路径穿越/INDEX.md 保护/权限码（与既有 GET 只要求登录的约定一致）；
- admin UI（AgentExperienceLibraryDialog / AgentListView）交互与 api 调用。

## 验证命令汇总

- 临时复现用例：`cd backend-ts && npx vitest run src/harness/experience/zz-review-verify.spec.ts` → 5/5 通过（Bug1 三例、Bug2 一例、L1 一例；跑毕已删除该文件）
- 既有套件回归：`npx vitest run src/harness/experience src/harness/tool/impl/file-tools.spec.ts src/agent/agent-experience-library.routes.spec.ts src/harness/core/prompt-engine.spec.ts src/harness/container` → 18 files / 217 tests 全过
- 域回归：`npx vitest run src/agent src/session` → 56 files / 794 tests 全过
