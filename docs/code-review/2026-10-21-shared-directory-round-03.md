# 共享目录 /opt/mao-data/share 第三轮复审（round-03：修复验证）

> 审查对象：修复 commit b2ff57ed（round-02 两个 bug 的修复），分支 `feat/shared-directory`
> 方法：修复代码通读 + 临时对抗性测试（9 例，跑通后已删除，未改任何生产代码）+ 真实 E2E 后端启动复现 + build 通过 + 全量测试 4566 passed / 0 failed
> 结论：**round-02 两个 bug 修复均正确闭环、无回归；但复审中新发现 1 个 P2 bug（E2E 后端启动失败，遗留自 feature commit 4f3d2bbd，非本次修复引入）。建议修复后合并。**

---

## Bug 3（P2）：E2E 后端在 /opt 不可写的开发机上启动失败——`.env.e2e` 未重定向 `MAO_SHARE_DIR`，启动 mkdir 默认 `/opt/mao-data/share` 报 EACCES

【位置】
- `backend-ts/src/create-app.ts:279-280`（`resolveShareDir` 通过后无条件 `mkdirSync(shareDir, {recursive:true})`，默认值 `/opt/mao-data/share`）
- `scripts/e2e-setup.sh:236-243`（生成 `.env.e2e` 的 heredoc：重定向了 `MAO_RUNTIME_DIR`/`MAO_USER_HOME_DIR`/`WORKSPACE_ROOT`/`FILE_UPLOAD_DIR` 到 `.e2e-data/`，**遗漏 `MAO_SHARE_DIR`**）

【问题描述】
E2E 隔离环境的既定原则（e2e-setup.sh 自己的注释：「运行期目录全部指向 e2e 临时目录，**严禁触生产 /opt/mao-data**」）要求所有 `/opt/mao-data` 运行期目录经 `.env.e2e` 重定向。feature commit 4f3d2bbd 新增的 shareDir 启动创建没有同步进这份重定向清单：`.env.e2e` 不设 `MAO_SHARE_DIR` → 取默认 `/opt/mao-data/share` → 后端启动即 `mkdirSync` 该路径。在 /opt 非后端用户可写的机器（典型开发机：macOS `/opt` 为 root:wheel 755；多数 Linux 开发机同理）上抛 EACCES，`bootstrap` catch 后 `process.exit(1)`，E2E 后端永远起不来 → 根目录 `npm test`（Playwright）在 global-setup 等后端就绪时超时失败。

影响面：开发机上的 E2E 全量套件（admin/桌面 Playwright）完全不可用；CI 不受影响（AGENTS.md：CI 不跑 Playwright）；生产不受影响（`/opt/mao-data` 由部署创建、后端用户可写）。附带：无 `.env` 的开发机上 `npm run start:dev` 走全默认配置会栽在同一个 mkdir 上。

该问题**遗留自 feature commit 4f3d2bbd，不是修复 commit b2ff57ed 引入**（修复只拦截相对/空值，`/opt/mao-data/share` 是合法绝对路径，resolveShareDir 放行、mkdirSync 照旧执行），但存在于分支当前状态，且 round-02 未覆盖（round-02 审过 create-app 的 mkdirSync 口径但未联到 E2E 重定向清单）。

【复现/验证方式】
1. `bash scripts/e2e-setup.sh` 成功（建 mao_e2e 库 + 迁移 + 种子 + 生成 `.env.e2e`，已验证其中无 `MAO_SHARE_DIR`）。
2. 按 `tests/global-setup.ts:103-110` 的口径真实拉起 E2E 后端（`node --import tsx src/main.ts`，cwd=backend-ts，env=`.env.e2e` 解析值 + `FLYWAY_ENABLED=false`）：
   ```
   EXIT CODE: 1
   {"level":"ERROR","message":"Failed to start Mao TS backend EACCES: permission denied, mkdir '/opt/mao-data/share'"}
   ```
3. 佐证修复方向：同一命令加 `MAO_SHARE_DIR=$PWD/.e2e-data/share` 后后端正常启动并监听：
   ```
   STILL RUNNING after 40s (startup OK, killed by timeout)
   {"message":"Server listening at http://172.20.213.50:9180"}
   ```
   （即 shareDir mkdir 是唯一卡点。）

【严重程度】P2（默认配置下必然触发、开发机 E2E 工作流整体不可用；生产/CI 不受影响；一行修复）

【建议修复方向】
`scripts/e2e-setup.sh` 的 `.env.e2e` heredoc 补一行（与其余重定向同口径）：
```
MAO_SHARE_DIR=$ROOT_DIR/backend-ts/.e2e-data/share
```

---

## round-02 两个 bug 的修复验证（均闭环，无回归）

### Bug 1 修复（resolveShareDir）——闭环

`app-utils.ts:35-42`：expandHome 后校验非空 + isAbsolute，否则抛 `MAO_SHARE_DIR must be a non-empty absolute path, got '...'`；`create-app.ts:279` 在 mkdirSync 之前调用。临时测试 9 例全部通过，覆盖：

- 放行：`/opt/mao-data/share`、`/mnt/share/`（尾斜杠归一为 `/mnt/share`）、`~/share`、`$HOME/share`（均展开为 HOME 下绝对路径）
- 拒绝：`''`、`share`、`./share`、`relative/../share`、裸 `~`、`~foo/share`（错误信息含原始值）
- 边界：`/opt/mao-data/share/..` 在 resolveShareDir 层放行（合法绝对路径，归一为 `/opt/mao-data`），由 planner 父目录防护在下游兜底——分层正确，无误拒
- 生产路径唯一性：`cfg.app.harness.shareDir` 的全部消费点只有 `create-app.ts:279`（grep 确认），planner/registry 收到的都是已校验的绝对路径

### Bug 2 修复（path.relative 父目录防护）——闭环

`container-mount-planner.ts:223-230`：`root.startsWith(host + path.sep)` 改为 `path.relative(host, root)` 包含判定（`rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)`），并删除死代码 `|| root === host`。临时测试覆盖的回归矩阵全部通过：

| 场景 | 结果 |
|---|---|
| shareDir=`/`（Bug 2 本体） | 拒（`/is a parent of registered root/`） |
| shareDir=`/` 经 `ensureRunning` | fail-fast 抛 MountPlanError，未发出任何 `docker run` |
| shareDir=全部登记根的父目录（`/opt/mao-data` 类） | 拒 |
| shareDir=dist 与 skills 的共同父目录 | 拒 |
| shareDir=`/opt/mao`（dist 在 `/opt/mao/backend-ts/dist` 之下） | 拒 |
| shareDir 与某根为兄弟（`share2`） | 放行 |
| shareDir 与某根前缀相似非父子（`sharex`） | 放行 |
| shareDir 位于 distDir/skillsDir 之下 | 拒（与旧口径一致：shareDir 自身进 registeredRoots 后外层挂载反向触发父目录防护） |
| 正常每用户挂载（host 位于登记根之下，11 条清单） | 不受影响 |
| 8 个每用户根相等/其下 | 拒（`must not be or under per-user data root`） |
| shareDir=distDir/skillsDir | 拒（`duplicate container path`） |
| 合法值 `/mnt/share`、`/opt/mao-data/share`、尾斜杠 | 放行，ro，containerPath===hostPath |
| 指纹稳定性（含尾斜杠、会话工作区不进指纹） | 与修复前一致 |
| `ensureRunning` 合法 shareDir | 正常建容器、ro 挂载、二次调用不重建 |

新旧判定语义等价性分析：`root.startsWith(host + sep)` 与 `path.relative` 包含判定仅在 `host='/'`（旧式拼出 `'//'` 失效）与病态名 `..xyz` 子目录两处不同，后者与代码库既有 `isUnder`（`path-sandbox.ts:127-130`）同款惯用法，非回归。

### 顺带处理的 round-02 观察——均已落实

- 观察 1（测试卫生）：`defaultsShareDirWhenEnvUnset` 其余 root env 重定向到 `useTmpDir` 临时目录，不再有 `/opt/mao-data/workspace/7` 的 mkdir 尝试；afterEach 经 ROOT_ENV_KEYS 完整还原。✓
- 观察 2（测试缺口）：新增 `shellWorkdirUnderShareRootIsAllowed`（shell workdir 在 share 子目录 pwd 成功）与 `rejectsShareDirEqualToDistOrSkills`。✓
- 观察 3（提交卫生）：workspace-write 抖动修复仍在同一 commit（非交互 rebase 不可拆分），改动本身正确，无功能影响。✓

---

## 其他观察（非 bug）

1. **新增测试的小覆盖缺口（P3）**：`resolveShareDir` 单测未覆盖 `$HOME/share` 放行与裸 `~`/`~foo/share` 拒绝（本次临时测试已验证行为正确）；也无集成级用例证明 `create-app.ts:279` 真的接了 `resolveShareDir`（单测只测函数本身，接线是一行、已人工核对）。建议后续补 `$HOME`/裸 `~` 两断言，成本极低。
2. **E2E 缺口无测试守护（P3）**：Bug 3 这类"启动期 mkdir 默认 /opt 路径"问题单测无法覆盖（create-app 需 DB），只能靠 e2e-setup.sh 重定向清单人工维护；修复后同样无回归测试，属该类问题的固有局限。
3. **修复未记 CHANGELOG**：符合 AGENTS.md「内部重构/单测/无行为依赖升级可不记」——0.0.325 尚未发版，加固属同一特性的一部分，无需单独条目。✓

---

## 总体结论

- round-02 Bug 1（相对/空值 shareDir 静默按 cwd 解析）：**修复正确闭环**，启动即拒、分层合理、无误拒合法值。
- round-02 Bug 2（shareDir=`/` 逃过父目录防护）：**修复正确闭环**，`/` 场景由放行变拒绝，全部既有场景行为不变（9 例回归矩阵验证）。
- 新发现 Bug 3（P2，E2E 后端启动 EACCES）：遗留自 feature commit，修复一行（e2e-setup.sh 补 `MAO_SHARE_DIR` 重定向），已验证修复方向有效。
- build 通过；全量测试 4566 passed / 13 skipped / 0 failed；工作区干净（临时测试已删除）。
- **建议：修复 Bug 3 后合并。**
