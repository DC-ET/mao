# 技能视图（Skill View）容器技能挂载收口 代码审查报告 · Round 1

- 审查日期：2026-11-03
- 需求方案：`docs/plan/2026-11-03-skill-view-container-isolation-technical-design.md`（验收基准：G1~G5 + §4 详细设计）
- 审查范围：`cd mao && git status` 列出的全部未提交改动（23 个已跟踪文件 + 3 个新增文件）；按审查要求不含文档措辞审查
- 结论：**可合并（无阻塞项）**；重要 1 项、建议 1 项（同一主题：新配置项在人机两侧的一致性 / 装配缺口）
- 验证方式：新增临时 vitest 探针（`src/harness/skill/zz-review-probe.spec.ts`，验证后已删除，复现要点见各条内联代码）+ 只读核对生产环境事实（后端进程 cwd `/data/mao/backend-ts`、`.env` 中 `SKILLS_DIR=/opt/mao-data/skills`、无 `SKILL_VIEWS_DIR`）+ 现有 4 个受影响 spec（41 用例）全绿

---

## 一、重要（1 项）

### I-1 视图根在容器侧的解析基准与宿主机不一致：`SKILL_VIEWS_DIR` 未配（或配成相对路径）时，容器内所有技能文件读取被 strict 沙箱判成逃逸

- 位置：
  - `backend-ts/src/harness/container/container-registry.ts:751`：`'-e', `MAO_SKILL_VIEWS_DIR=${this.opts.skillViewsDir}`` —— 注入的是**配置原值**
  - `backend-ts/src/harness/container/container-mount-planner.ts:109` + `:311-313`：挂载路径走 `path.resolve(root)`（**后端进程 cwd**，生产为 `/data/mao/backend-ts`）
  - `backend-ts/src/harness/container/runtime-agent.ts:45` + `container-tool-executor.ts:73`：容器侧用该 env 值经 `path.resolve` 得到沙箱允许根＝**容器进程 cwd**（`Dockerfile.runtime:41` 未设 `WORKDIR`，容器 cwd 为 `/`）
  - 默认值来源：`backend-ts/config/application.yml:74`、`backend-ts/src/config/app-config.ts:256`（均为 `./skill-views`）
- 问题描述：
  技能视图的物理落点由**宿主机**解析（`/data/mao/backend-ts/skill-views/{u}`，即 `-v` 的宿主/容器路径），而容器内沙箱允许根由**容器 cwd** 解析同一相对值（`/skill-views/{u}`）。两者不等 → `PathSandbox.assertNoSymlinkEscape` 在沿 `{runtime}/{u}/{s}/skills/{name}` 软链校验时，realpath 落在允许根之外，直接抛
  `Path escape attempt (symlink)`（`backend-ts/src/harness/safety/path-sandbox.ts:74-110`）。
  触发条件正是设计 §4.1 明确允许、CHANGELOG/`config.md` 描述为“功能可跑/仅偏离数据目录约定”的**回落场景**：`SKILL_VIEWS_DIR` 未配置（生产 `.env` 当前确实未配置，见下）或配成相对路径。此时：
  - 后端物化、会话软链、挂载全部正常（`ls`/`cat` 走 shell 不受路径校验，仍可读）；
  - 但提示词引导的主链路 —— `read_file` 读 `…/skills/<name>/SKILL.md`、`glob_search`/`grep_search`/`read_bytes` —— **对容器内任意技能文件一律失败**，返回“路径逃逸”错误，模型极易误判为技能缺失而放弃或乱找替代，直接破坏 G3/G4 的可用性承诺，且现象难以定位。
  - 与历史回归同源：`0.0.393` 修复的正是“容器内读 SKILL.md 被判符号链接逃逸”，本次只是把根从 `skillsDir` 换成 `skillViewsDir`，而**新根多了一个“默认值即相对路径”的坑**（旧 `SKILLS_DIR` 生产一直显式配绝对路径，所以未暴露）。
- 复现 / 验证（临时用例，A1 实测失败、A2 对照组通过）：
  ```ts
  // 模拟「宿主机 cwd ≠ 容器 cwd」：宿主机侧按后端 cwd 生成挂载清单，容器侧按容器 cwd 解析 env
  const hostCwd = useTmpDir('host-cwd-');          // 等价于 /data/mao/backend-ts
  const containerCwd = useTmpDir('container-cwd-'); // 等价于容器 /（Dockerfile 无 WORKDIR）
  // 1) planner 用相对配置 → 挂载点 = hostCwd/skill-views/7
  process.chdir(hostCwd);
  const mounts = new ContainerMountPlanner(rootsOf(base, './skill-views')).plan(7);
  const view = mounts.find(m => m.purpose === 'skillViews').hostPath; // hostCwd/skill-views/7
  // 2) 后端物化 + 会话软链（与 SkillSyncService 产物一致）
  mkdirSync(join(view, 'java'), { recursive: true });
  writeFileSync(join(view, 'java', 'SKILL.md'), '---\nname: java\n---\nbody');
  symlinkSync(join(view, 'java'), join(runtimeDir, '7/11/skills/java'), 'dir');
  // 3) 容器侧：env 原值 → 允许根 = containerCwd/skill-views/7（≠ 挂载点）
  process.chdir(containerCwd);
  const executor = new ContainerToolExecutor({ ..., skillViewsDir: './skill-views', ... }, 7);
  const res = JSON.parse(await executor.handleToolCall('read_file',
    JSON.stringify({ path: join(runtimeDir, '7/11/skills/java/SKILL.md') }), envelopeOf(ws)));
  // 实测：res.error = '错误：Path escape attempt (symlink): …/runtime/7/11/skills/java/SKILL.md'
  // 注：两处 chdir 需在 finally 恢复原 cwd；rootsOf/envelopeOf 为用例内构造 roots/envelope 的小工具函数
  ```
  - A1（相对值）：`parsed.error` 有值 → 断言失败（问题成立）。
  - A2（对照组，`skillViewsDir` 给绝对路径）：`parsed.content` 含 `name: java` → 通过，证明机制本身正确、仅解析基准失配。
- 影响面：`SKILL_VIEWS_DIR` 漏配即为容器内“技能文件不可读”（只影响 docker 模式的文件工具；host 模式、shell、后端物化、挂载、容器重建均不受影响）。生产 `.env` 现状：`SKILLS_DIR=/opt/mao-data/skills` 等数据根均为绝对路径，但没有 `SKILL_VIEWS_DIR`（本改动尚未部署），落库与否完全取决于部署时是否人工补——见 I-2。
- 修复建议（供后续 worker 执行，任选其一，推荐 ①）：
  1. 注入前规范化：`container-registry.ts:751` 改为 `-e MAO_SKILL_VIEWS_DIR=${path.resolve(this.opts.skillViewsDir)}`（或 `path.posix.normalize`），使容器侧拿到与挂载点逐字节一致的绝对路径；顺带把同类注入（`MAO_SKILLS_DIR` 已移除，其余根建议一并核对）统一为“注入前 resolve”。
  2. 或在 `app-config.ts` 加载期把 `harness.skillViewsDir` 归一为绝对路径（`path.resolve`），下游全部消费归一值。
  3. 或在 docker 模式下对“非绝对路径”fail-fast / 记 error 级告警，避免静默降级（可与 I-2 一起做）。

---

## 二、建议（1 项）

### S-1 部署模板 `backend-ts/.env.example` 未补 `SKILL_VIEWS_DIR`（本次新数据根的装配缺口，是 I-1 的触发入口）

- 位置：`backend-ts/.env.example:36-42`（“上传与存储（本地磁盘路径，仍由环境变量控制）”段：`FILE_UPLOAD_DIR` / `WORKSPACE_ROOT` / `MAO_RUNTIME_DIR` / `MAO_USER_HOME_DIR` / `SKILLS_DIR` / `USER_SKILLS_DIR` / `MAO_SHARE_DIR`，无 `SKILL_VIEWS_DIR`）
- 问题描述：`.env.example` 是仓库内**受版本控制**的部署模板（文件头写明“copy to backend-ts/.env and edit”），且本次新增的是**数据根类**变量——项目既有约定是在新增数据根时同步更新它：先例 `4f3d2bbd`（新增公共共享目录 `/opt/mao-data/share`）提交信息里明确列了“文档：CHANGELOG …、`.env.example`、application.yml”，并给 `.env.example` 加了 `MAO_SHARE_DIR` 一行。本次 CHANGELOG 0.0.425 也强调“**生产部署须在 `backend-ts/.env` 补配 `/opt/mao-data/skill-views`**，漏配会回落…”，但模板没有这条：照模板部署会静默跳过该步 → 直接落到 I-1 的故障态。同时 `skills/mao-cli/reference/config.md` 把 `SKILL_VIEWS_DIR` 的“是否必须”标为「否」，与 CHANGELOG/方案 §5.2 ① 的「✅ 必须」不一致，进一步降低补配概率（此条仅作为 I-1 的证据，不计为文档问题）。
- 复现 / 验证（一条命令即可复现缺口；临时用例亦可）：
  ```bash
  # application.yml 中的数据根占位符 vs .env.example 实际键集合
  cd mao/backend-ts
  grep -oE '\$\{[A-Z_]+' config/application.yml | tr -d '${' | sort -u > /tmp/a.txt
  grep -oE '^[A-Z_]+=' .env.example | tr -d '=' | sort -u > /tmp/b.txt
  comm -23 /tmp/a.txt /tmp/b.txt | grep -E 'SKILL|WORKSPACE|RUNTIME|USER_HOME|UPLOAD|SHARE'
  # 实测输出：SKILL_VIEWS_DIR（数据根类唯一缺口）+ MAO_CLOUD_RUNTIME（模式开关，非数据根、非本次改动引入）
  ```
- 影响面：部署流程漏配 → 视图落在后端 cwd（`/data/mao/backend-ts/skill-views`）而非 `/opt/mao-data/skill-views`：偏离数据目录约定（漏备份/漏监控、`.gitignore` 兜底），且叠加 I-1 后容器内技能不可读；不涉及数据破坏。
- 修复建议：`.env.example` 在 `USER_SKILLS_DIR` 行后（与先例 `MAO_SHARE_DIR` 同一位置风格）补 `SKILL_VIEWS_DIR=/opt/mao-data/skill-views`；如采纳 I-1 的方案 1/2，可同时把 `config.md` 的「是否必须」改为与 CHANGELOG 一致（本轮如按“不审文档”处理，可只改 `.env.example`）。

---

## 三、已检查且未发现问题的点（供参考，避免重复审查）

- `SkillViewService`（新增，全文逐行 + 探针）：
  - 指纹 `{maxMtimeMs}-{fileCount}-{totalBytes}` 与拷贝规则同源（`.git`、悬空软链、逃逸软链、特殊文件两侧一致跳过），常规更新（改内容 / 增删文件 / 目录重命名 / 新文件写入）都会抬升 maxMtime 或以计数变化被识别（C3 探针：`.git` 不进视图，且后续调用命中短路不重建）；
  - 原子替换（暂存拷贝 → 旧视图改名 `.old` → `rename` 换入 → 清 `.old` → 写 meta）顺序正确，路径稳定；换入失败有回滚分支；旧视图存在时不出现空目录（进程内同步执行，无观察窗口）；
  - meta 缺省/不可解析 → 重建；meta 写入失败仅告警（下次重建，安全方向）；源缺失/非目录 → 清视图+meta 返回 null；`isValidSkillName` 二次校验（`.meta`、`../x` 等非法名被拒，view 路径无穿越面）；
  - 并发去重：`inFlight` 的 `finally` 自摘除正确，**物化失败后同进程重试会真正重跑**（C5 探针：把 `{views}/.tmp` 占位成普通文件制造拒绝，解除后重试成功，无“失败 Promise 残留导致永久失败”）；
  - 拷贝边界（C1/C4 探针）：技能根内部**目录软链**被 dereference 成实体目录（作者用例只覆盖文件软链）、执行位保留、视图被手工换成软链时能挪走重建；生产 `/opt/mao-data/skills` 实测仅 1 个软链（`ntxbiz-finance-calculate`，根级软链场景已有覆盖），无内部软链依赖。
- `SkillSyncService`：merged 语义（用户技能同名覆盖系统技能）、系统技能先物化后建链、存量“指向源”软链与悬空链迁移、清理器删掉会话 skills 目录后的自愈、源下线清链+清视图、失败降级（删链）与下一轮恢复、`state` 增删与 `getRemovedSkillNames`（仅 LOCAL 客户端同步消费，不受本次删键影响）均自洽。
- `ContainerMountPlanner`：`skillViews`(ro) 按用户挂载、`skills` 挂载消失、`isPlatformSkillsRoot` 例外删除、`registeredRoots`/`assertShareDirIndependent` 增加两个技能根、父目录防护对 `/opt/mao-data` 场景仍生效、重复容器路径探测、缺失视图目录容忍（不 mkdir，docker 自动建）、指纹随清单变化（存量容器一次性重建）；生产配置（`shareDir=/opt/mao-data/share`、`skillsDir=/opt/mao-data/skills`、cwd=`/data/mao/backend-ts`）与新增独立性校验无冲突（不会 fail-fast 卡住容器创建）。
- `ContainerToolExecutor` / `runtime-agent`：允许根按用户收窄为 `{skillViewsDir}/{u}`；经视图软链读 `SKILL.md` 通过 strict 校验，指向他人视图（`skillViews/8/...`）或视图外目录的软链被拒；`/tmp` 允许根未掩盖该用例（夹具落在仓库内 `.tmp-test`）；env 默认值 `MAO_SKILL_VIEWS_DIR` 接线正确（绝对默认值本身无误，问题只在注入原值，见 I-1）。
- 安全边界：容器内不再有 `skillsDir` 的挂载与允许根（G1）、视图 ro（G2）、按用户挂载（无跨用户挂载路径）、`.meta` 只暴露路径信息、`shareDir` 未成为绕过面；host 模式仍为零改动（非 strict 解析下会话路径词法命中已登记 runtime 根，写入会落到视图而非共享源，属方案 §4.8/§4.9 已接受边界）。
- 既有机制：清理器只删会话级 `skills` 软链、视图与 `.tmp`（1h 阈值）分开处理；挂载指纹含 mode/purpose，rw→ro 变更能在 running/stopped 两条复用分支触发重建；LOCAL 模式 zip 链路（`writeSyncZip` / `zipSkillsForLocal`）仍直接打包源目录，未受影响；生产技能包实测无“写自身目录”逻辑（playwright 等只读自身 `cli.config.json`，依赖装到 HOME/全局前缀），ro 视图不阻碍合法用法。
- 装配完整性：`RuntimeDataResolver` / `SkillViewService` / `ContainerRegistry` / planner roots / `RuntimeCleanupScheduler` / `ContainerToolExecutor` 六处注入点齐全（新增 resolver 方法暂未被调用，属预留，非缺陷）。

## 四、备注

- 本次审查使用的临时用例文件为 `backend-ts/src/harness/skill/zz-review-probe.spec.ts`，验证完成后已删除；`git status --short` 与审查开始时一致（仅剩本轮改动的 23+3 项）。
- 未覆盖（环境限制）：真实 Docker 容器内联调（`docker exec` 验证 EROFS / 源不可见 / `npm install . -g`）、MySQL 与蓝绿切换下的存量容器重建、真实浏览器链路；上述结论基于源码、只读环境核对、单测与临时探针。
- 审查中发现但**未计入 bug** 的两点，供决策参考：
  1. 方案 §4.2（“失败时技能目录维持上次可用状态”）与 §4.3（“物化失败→删除已有链接”）表述冲突，实现按 §4.3 且作者用例固化；本次按“具体条款优先”不判定为缺陷（仅在“旧视图完好”时属可用性额外损失，可二期统一措辞/行为）。
  2. 指纹对“同大小 + 同 mtime”的内容替换不敏感（C2 探针可复现：同 tick 内改写 2 字节文件不触发重建）——方案 §4.2 已显式列为可接受容忍，且生产更新（部署 rsync / 后台上传）mtime 必然前移，不计为缺陷。
