# 评审存档：share 按 Agent 隔离（形态 C）方案 + 迁移脚本

> 评审执行：独立子代理（reviewer），只读评审；任务 ID 531 / child session 2342；评审时间 2026-11-09。
> 评审基线：技术方案初稿、调研报告 v2、迁移脚本初稿（353 行）。
> 结论：**无 P0；5 项 P1 + 7 类 P2**；已全部处置（P1 全修、P2 按建议处理），修复后复验通过——见文末「修复记录」。

---

# share 按 Agent 隔离（形态 C）方案 + 迁移脚本 独立评审

> 评审方式：只读。已核对源码仓库真实代码、生产 share 目录、DB（只读 SELECT）、全仓库 grep。**未修改任何文件，未执行任何写操作**（未 cp/rm/UPDATE/docker 变更）。
> 评审基线：`mao/docs/plan/2026-11-09-share-per-agent-isolation-technical-design.md`、`mao/docs/research/2026-11-09-share-per-agent-isolation.md`、`mao/scripts/migrate-share-per-agent.sh`。

---

## 一、总体结论

- **未发现 P0（阻断级）问题**；方案技术主体可实施，代码事实核验基本全部成立。
- 发现 **5 项 P1（进入 `apply` 前必须修）**，全部集中在**迁移脚本与迁移流程的校验/回滚面**，不是代码改造面；代码改造面（4 文件 + 测试）覆盖完整、机制引用准确。
- 另有 7 类 P2（文档事实错误、行号漂移、脚本健壮性、归属复核），其中 P2-2/P2-3 建议顺手修。
- 结论：**可以进入开发（代码改造）与 phase1**；**phase2/phase3 建议在 P1-1~P1-5 修完后执行**（预计 0.5 人日内可修完）。不建议在未修 P1-1/P1-2 的情况下把 `verify` 当作 phase3 的放行闸门。

---

## 二、问题清单

### P0 阻断（方案不可实施 / 会出数据事故）
**无。** 未发现会导致数据丢失、越权挂载、迁移不可执行的问题。以下逐条是可验证的 P1/P2。

### P1 重要（必须修）

**P1-1 verify 存在"恒假 FAIL"，与 phase3 的前置条件形成循环依赖**
- 位置：`scripts/migrate-share-per-agent.sh:304`（`check "旧残留已清理（share/scripts 不存在，phase3 后生效）"`）＋ `plan` L316（phase3 前置"② verify 通过"）、L318/§10.1 步骤 4（"verify + 回归"在 phase3 **之前**执行）。
- 问题：该项在 phase3 之前必然 `FAIL`，而 phase3 又要求 verify 通过 → 按方案顺序执行时 `FAIL=1`、脚本退出码 1。
- 影响：操作者要么习惯性忽略 verify 失败（下次真失败也会被忽略），要么永远不执行 phase3（旧残留常驻，"零公共面"承诺打折）。§10.2 的"回滚触发条件"也会因此失去可信基准。
- 修复：verify 拆模式——`verify --pre-phase3`（该项输出 WARN/INFO，不计 FAIL）与 `verify --post-phase3`（计 FAIL）；或把该项挪到 phase3 之后的独立检查，并让退出码语义与"是否阻断"一致。

**P1-2 引用更新是"静态快照 + 静默跳过"，且 verify 不校验 14 条规则是否落实**
- 位置：脚本 `replace_in_file()`（L88-101：文件不存在只打 `[跳过·不存在]`，命中 0 只打 `[0命中]`）、`phase2_actions` 规则循环（L235-242）、`do_verify`（L289-315，无残留扫描）；`plan` L312"清单全覆盖"、L264"命中 0 次打印无需更新不报错"。
- 问题：经验库是**被 Agent 持续维护**的（`scheduled_task` #76"周度复盘与去重合并"每周会合并/改名文档，实测 `next_fire_time=2026-11-15`）。14 条规则的目标文件名是硬编码快照，任一条被改名/合并 → 替换静默失配，"命中 0 次"与"已完成"不可区分。
- 影响：phase3 删掉旧路径后，被漏改的经验文档/工作区文档永久断链，而 verify 全绿——这正是本次迁移要消灭的"断链无告警"。
- 修复：① phase2 前置：规则目标文件缺失应 `die`（或 `--allow-missing` 显式放行并打印清单）；② verify 增加**旧路径残留扫描**（对 `{shareDir}` 与规则涉及的工作区目录 `grep -rF` 旧串，排除已接受的历史快照目录），命中即 FAIL 并输出行号。

**P1-3 `session_workspace_rules` 不会"随文件 mtime 自动刷新"（方案事实错误）**
- 位置：`plan` L312 注："`session_workspace_rules` 快照随文件 mtime 自动刷新，无需处理"；源码 `backend-ts/src/harness/core/workspace-rules-snapshot.service.ts:51-70`（`resolve()`：workspace 一致且文本非空 → **直接返回快照文本**，磁盘已变只打 `changed on disk but snapshot retained` 日志；仅 `invalidate()`（压缩提交，L72-77）或新会话才重读盘）。
- 实测：`session_workspace_rules` 32 行含旧路径，其中 `source_path=workspace/feishu-chat/3/oc_6783…/AGENTS.md` **5 行**——正是 phase2 要改的那个文件。
- 影响：改完 AGENTS.md 后，这 5 个存量会话仍会把旧 `settings_t.xml` 路径注入系统提示；phase3 后 agent 6 在这些会话里持续失败，直到会话压缩或新建。方案对"存量会话下一轮即生效"的承诺只对 `agent_experiences`（每轮重建）成立。
- 修复：改正方案措辞（"per-session 冻结，新会话/压缩后生效"）；若要立即生效，在 phase2 追加一条按 `source_path` 命中的快照删除（下轮自动重建），否则明确写入"接受项"。

**P1-4 DB 引用更新没有备份与反向 SQL，"回滚无数据丢失"只覆盖文件面**
- 位置：脚本 `db_apply_updates()`（L205-222）、DB 预览（L231-238 仅 `LEFT(content,200)`，不落盘）；`plan` §7.2（L262-266 备份仅描述 tarball + 文件副本）、§7.7（L330-332 回滚）。
- 问题：6 行 DB 前像未落盘；REPLACE 命中范围只靠 `WHERE` 约束，回退需人工凭终端输出复原；UPDATE 未打印 affected rows（`-N -B` 无输出），也无法确认命中行。
- 影响：文案写错/误命中时无法按文档回滚。
- 修复：phase2 apply 前将 `agent_experiences WHERE id IN (66,74,75,76)`、`scheduled_task WHERE id IN (96,97)` 的 `id + 全量 content/prompt` 导出到 `$BK/db-before.sql`，并在脚本/文档给出反向 SQL；UPDATE 后打印 affected rows。

**P1-5 §9.3 的业务回归用例不可执行（引用的是已失效任务）**
- 位置：`plan` L394-397（"定时任务 #97 一次手动触发；#96 按计划执行"）。
- 实测（只读）：`scheduled_task` #96 `once=1, finished=1, finished_at=2026-11-04`（一次性已完成）；#97 `deleted=1`（已 soft-delete，`last_fire=2026-11-04`）；#54 亦为 finished。**当前唯一活跃且引用 share 的任务是 #76，只引用未变的 `agent-experience/5`。**
- 影响：phase3 前置"观察 ≥1 天（无旧路径不存在类异常）"失去主要信号源；"脚本新路径可执行"这条验收实际未被验证。（另一面：这也说明本次迁移的**在线依赖风险比方案描述更低**。）
- 修复：回归改为 ① 新建一次性任务或手工在容器内执行 `python3 /opt/mao-data/share/agents/5/scripts/skill-cli-health-check.py --help`、`bash …/agents/5/scripts/push_flow.sh`（只读子命令）；② agent 6 侧跑一次 `mvn -s /opt/mao-data/share/agents/6/settings_t.xml -v`；并把 #96/#97 的 prompt 更新标注为"历史行同步"，不作为回归依据。

### P2 建议

**P2-1 归属核对（数据结论，建议写进 §11.2#1 定论）**
- `settings.xml`：实测仅 agent 5 使用（25 条消息/15 会话）→ `agents/5/` ✔。
- `settings_t.xml`：agent 6（6 条/4 会话）为主，但 **agent 5 也有 11 个会话触碰过该路径**（抽查为目录列举/审计，非 `mvn -s` 使用）→ 方案应把"agent 5 是否也要一份 settings_t"写成明确结论。
- `share/scripts/`：agent 5 主用（110 条/33 会话），agent 6 仅 3 条 `ls` 列举 → 默认全归 5 合理，同样建议写"agent 6 是否需要副本"的结论。
- 另：`share/scripts` 已被今日 09:53 的实验整目录复制到 `agent-experience/{1,3,4,5,6}/share/`（各 148K，内容与 `share/scripts` 一致）——phase1 删除试验副本的判断成立，且原目录仍在，无数据损失。

**P2-2 `MAO_CONTAINER_AGENT_ID` 由"无消费方"改为硬依赖 `exit(1)`，与 2026-11-07 方案 §289 相反**
- 核对结论：风险可控——后端每次重启后 `entries` 为空，首次使用走 `docker run` 名称冲突 → `cleanupHalfCreated`（`docker rm -f`）→ 以带 env 的参数重建；`docker start` 不会复用到无 env 的旧容器（`container-registry.ts` `createAndStart`/`dockerStart` 失败路径均已收口）。
- 建议：在方案里补一句"为何现在可以做硬依赖"的论证，并确认运行时启动失败→`waitSocketReady` 超时→清理→重建这条链（避免出现"容器持续重建失败"的死循环）。

**P2-3 豁免写法应绑定 purpose**
- §5.1 写"删除整根特例、替换为精确路径豁免（`host === 上述两条之一`）"。若只按路径判断，任何 purpose 只要路径恰好等于那两条即可绕过"rw 必须含 `/{userId}/` 段"规则。建议实现为 `(purpose === 'share' || purpose === 'shareAgent') && host === expected`，保持 purpose↔路径 1:1（与 `expectedAgentPaths` 同构）。

**P2-4 文档行号漂移（会误导开发）**
- `plan` L180"create-app.ts（shareDir resolve+mkdir 处，L278-281）"→ 实际 `create-app.ts:286-287`。
- `plan` L500"container-mount-planner.ts:116, 135-158, 204-274"→ `assertSafe` 实际起于 **209**（116、135-158 准确）；`container-registry.ts:395` 为 `ensureRunning` 定义行（建议写符号名而非行号）。

**P2-5 迁移脚本健壮性细节（均非致命，建议一并修）**
- `--share-dir` 只影响目录操作，FILE_RULES 的 old/new 与 DB SQL 全部硬编码 `/opt/mao-data/share`（L59-72、L209-221）→ 非默认目录时行为不一致。
- `phase1` 中断后重跑**不会补齐**：`copy_if_missing_dir` 见目标目录即跳过（L150-157），半截 `cp -a` 会永久留存 → 建议 `cp -a` 到临时名后原子 `mv`，或加 `--force-copy`。
- `replace_in_file` 用 `open(path,'w')` 原地截断写（L92-96），非原子 → 建议 tmp + rename（有备份兜底，但并发读者可能读到半截）。
- L167 `replace_in_file … || true` 吞掉 `push_fast.sh` 自引用修补失败（verify 的 grep 项尚可兜住，建议去掉 `|| true`）。
- verify 的 DB 分支：`db_available` 失败时只 note 跳过并以 `FAIL=0` 成功返回（L306-313）→ **假 OK**；建议 DB 不可达时给非 0 退出码或要求显式 `--no-db`。
- `check "试验副本已清除" test -z "$(find … 2>/dev/null)"`（L300-301）：find 出错也返回空串 → **假 OK**；建议检查 find 退出码或改用 `-print -quit`。
- `phase3` 自身不备份、不机器校验前置条件（仅打印提示 L267-283），`--yes` 下直接 `rm -rf` → 建议对将删的 3 项打 `phase3-residual.tgz` 并要求二次确认。
- 其余核对通过：`set -euo pipefail` 与 `[[ ]] && return 0` / `read … || answer=""` 组合不会误退出；`confirm` 语义正确；未知参数 `exit 2`；`plan` 全程只读（含 DB）；phase1 备份路径 `/opt/mao-data/backup`（不在任何容器挂载面）正确；`MYSQL_PWD` 传参不落盘不打印。

**P2-6 5 个"当前态"文件含旧路径但不在附录 A（建议显式列为"已核不改"而非遗漏）**
- `workspace/13/projects/feishu-2-private-13/repos/bill/docs/requirements/20261105-…/{change-list.md,technical-design.md}`（4 处 `mvn -s /opt/mao-data/share/settings.xml`）；
- `workspace/feishu-chat/2/oc_59b2…/work/tengju/PLAN_4292880.md`（`share/tools/vtn-biz-cli-0.8.7`，该目录已不存在）；
- 本工作区 `chat-files/analysis/reports/*/*.json`（历史命令快照，含 `share/scripts/mao-mysql.sh`、`share/settings.xml`）。
以上均为历史快照/第三方仓库文档，可不改，但建议在附录 A 增加"已核查、按历史面接受"清单，避免 phase3 后反复判断。

**P2-7 其他零碎**
- `backend-ts/config/application.yml:76`（`share-dir: ${MAO_SHARE_DIR:/opt/mao-data/share}`）未列入改动清单（值不变，仅建议同步注释）。
- 容器内 `/opt/mao-data/share` 会以**空目录**存在（docker 自动创建的挂载父目录）：agent 可能在容器内自行重建 `settings.xml`/`scripts`，造成"本容器可用、重建即失效"的假象 → 建议提示词/README 明确"旧路径已不存在，不要自建同名文件"。
- `__pycache__` 会随 `cp -a scripts` 进入 `agents/5/scripts`（调研 §4.4 提过清理，方案未列）。
- 工作量：现有 spec 需**反向改写**（`container-tool-executor.spec.ts` 的 `readsFileUnderShareRoot` 明确断言"他 Agent 目录可读"，方向要反转；planner spec 的 `shareDirMissingIsTolerated`、share 指纹用例、`rw && purpose!=='share'` 辅助断言都要改）——"1~1.5 人日"偏紧，建议按 1.5~2 人日排。`admin/src/views/agent/AgentExperienceLibraryDialog.vue:10` 的"服务器共享目录"文案仍成立（经验库按 Agent 共享），可不改。

---

## 三、核验通过项简表（主要断言逐条）

| # | 方案断言 | 结论 | 证据 |
|---|---|---|---|
| 1 | share 整根 rw 单条挂载、L116 | ✔ | `container-mount-planner.ts:116` |
| 2 | `assertShareDirIndependent` 存在且语义不变 | ✔ | 同文件 L144-158 |
| 3 | `isSharedShareRoot` 整根特例需删除 | ✔ | L263-270 |
| 4 | 指纹漂移 → 存量容器自动重建 | ✔ | `container-registry.ts:511-513` + L409/L431 |
| 5 | 旧容器"自愈"（首次使用重建） | ✔ | 后端重启后 entries 空 → `docker run` 名称冲突 → `cleanupHalfCreated`（`docker rm -f`）→ 重建 |
| 6 | `MAO_SHARE_DIR` / `MAO_CONTAINER_AGENT_ID` 注入 | ✔ | `container-registry.ts:816 / 799` |
| 7 | `MAO_CONTAINER_AGENT_ID` 原先无消费方 | ✔ | 全仓 grep 唯一命中即注入行 |
| 8 | `resolveRoots` 调用点影响面 | ✔ | 仅 `runtime-agent.ts:84`（构造器）+ L505（`prepareSkillViewCompatLinks` 入参）+ spec；改签名需同步 2 处 |
| 9 | 经验索引回调 `shareDir+EXPERIENCE_ROOT_SUBDIR` | ✔ | `container-tool-executor.ts:153-155` |
| 10 | 容器内沙箱允许根 L80-97（share 在 L96） | ✔ | 需替换为两条子路径 |
| 11 | 宿主沙箱维持 share 整根 / 启动 mkdir | ✔ | `create-app.ts:468` / `create-app.ts:286-287` |
| 12 | 经验库服务构造 L527-528、每轮幂等重挂 L412 | ✔ | `create-app.ts:527-528`、`harness/core/harness-service.ts:412` |
| 13 | **全仓 shareDir 消费面**（改动 4 文件是否够） | ✔ | 后端非测试消费者仅 6 文件（planner/registry/executor/runtime-agent/create-app/app-config+app-utils）；`dist` 为编译产物；admin/desktop/agent-cli/shared/tests 零引用；`e2e-setup.sh` 仅重定向 env；无宿主 cron/systemd 引用 |
| 14 | DockerSendBytesBridge / envelope / mcp-bridge 无 share 依赖 | ✔ | `read-bytes-bridge.ts` 复用同一沙箱；`session-envelope-builder.ts` 仅 deps env |
| 15 | 经验库"零迁移、零改动" | ✔ | 软链目标/admin/经验服务全部基于 `join(shareDir,'agent-experience')`；实测 N 个 AGENTS.md 均引用 `agent-experience/{A}`（路径不变） |
| 16 | DB 面：`agent_experiences` 4 行、`scheduled_task` 2 行 | ✔ | #66(agent6)/#74(5)/#75(1)/#76(6)；#96/#97(agent 5) |
| 17 | 其他表是否还有旧路径 | ✔（无新增） | `agent*_prompt`/`memory_item`/`mcp_server`/`*_env_variable`/`user_command`/`notification`=0；`message` 1313/464 与 `subagent_execution` 5 为历史接受项 |
| 18 | 14 条规则 / 23 处命中计数 | ✔ | 逐文件实测 6/4/11/2；tools 两规则各 1 处 |
| 19 | 试验副本可删 | ✔ | 5×148K，内容= `share/scripts` 完整副本，今日 09:53 生成，原件保留 |
| 20 | SQL REPLACE 目标串真实存在、幂等 | ✔ | #66 含 `/opt/mao-data/share/settings_t.xml`；#74/75/76 含旧共享文案；替换后不会二次命中 |
| 21 | 脚本默认只读、phase1 备份落点、密码不落盘 | ✔ | `plan` 仅 SELECT/读；`/opt/mao-data/backup`；`MYSQL_PWD` |
| 22 | 权限可行（新目录 mkdir 与容器读写） | ✔ | 后端以 **root** 运行（实测 `node dist/main.js` root）；容器内 root；`settings.xml` 600 root 对 root 容器可读 |

**未覆盖/剩余风险（诚实声明）**：① 未做真机 docker 挂载复现（评审只读，未起容器），"子路径隔离 ENOENT"沿用方案自述的 2026-11-09 实测；② 未逐一执行 `container-*.spec.ts`（只做静态断言比对），spec 改写量可能超出方案估计；③ 蓝绿窗口内新旧实例并发重建容器属既有机制，本次未额外验证（方案已列为中风险）；④ host 模式旁路与同用户跨 Agent 共享面属已声明的不承诺项，本次不构成问题。

---

## 四、建议的下一步（交给 worker 执行，本次不实施）

1. 修 P1-1（verify 分模式）→ P1-2（残留扫描 + 缺失文件 fail）→ P1-4（DB 前像落盘 + 反向 SQL）→ P1-3（改正 `session_workspace_rules` 描述，决定是否清理 5 行快照）→ P1-5（重写回归用例）。
2. 顺手落 P2-3（豁免绑 purpose）、P2-5（原子写/退出码/find 判定），并把 P2-1/P2-2/P2-6 写进方案定论。
3. 修完后按 §10.1 顺序执行：`apply --phase=1` → `apply --phase=2` → 部署 → `verify --pre-phase3` + 新回归 → 观察 → `apply --phase=3` → `verify --post-phase3`。

---

## 五、修复记录（2026-11-09 实施，对应脚本 v2 / 方案 v3）

### P1（全部修复）
- **P1-1** verify 分模式：默认 `pre-phase3`（根目录待删项记 WARN 不计 FAIL），`--post-phase3` 时全部残留计 FAIL——phase3 之前不再恒假 FAIL，退出码与"是否阻断"一致。
- **P1-2** phase2 apply 时规则目标文件缺失 → 列出后中止（`--allow-missing` 显式放行）；verify 新增残留扫描（经验库 `**/*.md`、`agents/5/scripts`、13 个规则目标文件；模式 `/opt/mao-data/share/{scripts,settings,tools}`），命中输出行号，`--post-phase3` 下计 FAIL。
- **P1-3** 方案/调研表述改为"per-session 冻结，新会话/压缩后生效"；phase2 追加定向 DELETE（oc_6783 的 5 行旧快照，下轮 resolve 未命中即按已更新文件重建）。
- **P1-4** phase2 apply 前导出 DB 前像 `$BK/db-before.sql`（`mysqldump --no-create-info --skip-extended-insert --replace --skip-lock-tables --set-gtid-purged=OFF`；生产账号无 RELOAD 权限，经实测不能加 `--single-transaction`）；每条 UPDATE/DELETE 同连接打印 `ROW_COUNT()`；§7.7 补回滚命令。
- **P1-5** §9.3 重写为手工冒烟（skill-cli-health-check --help / push_flow.sh / `mvn -s agents/6/settings_t.xml -v` / host 模式读团队经验 / admin 经验库）；#96/#97 标注"历史行同步"，不作回归依据。

### P2（已按建议处理）
- **P2-1** 归属结论写入 §11.2#1：settings.xml→agent5（仅其使用）、settings_t.xml→agent6（agent5 仅目录列举）、scripts→agent5。**（2026-11-09 用户补充决策覆盖此项：settings.xml→agents/{1,3,4,5}、settings_t.xml→agents/6、scripts→agents/{1,3,4,5,6} 各一份；脚本 phase1/verify 与两份文档已同步。）**
- **P2-2** §5.2 补"为何可做硬依赖"论证（后端重启 entries 空 → `docker run` 名称冲突 → `cleanupHalfCreated` 重建且带 env；失败链已收口）。
- **P2-3** §5.1 豁免改为 purpose 绑定表达式 `(purpose==='share' && host===expected) || (purpose==='shareAgent' && host===expected)`。
- **P2-4** 行号修正：§5.4 `create-app.ts:286-287`；附录 B `assertSafe` 209 起（116、135-158、312、326）；调研报告同步。
- **P2-5** 脚本健壮性：原子写（tmp+`os.replace`）、目录复制临时名+`mv`、去掉 `|| true`、verify DB 不可达须 `--no-db`（否则 FAIL）、find 退出码+空输出双重判定、phase3 备份 `phase3-residual.tgz`、非默认 `--share-dir` 打印 WARN。
- **P2-6** 附录 A 增补"已核查、按历史面接受"清单（bill 需求文档、tengju PLAN、本工作区 analysis JSON）。
- **P2-7** `application.yml:76` 注释列入 §5.4/§6；提示词补"旧路径已迁移，勿自行重建"；phase1 清理 `__pycache__`；工作量上调为 2.5~3 人日。

### 复验结果（2026-11-09）
- `bash -n scripts/migrate-share-per-agent.sh` 通过；`plan` 只读预演复跑通过（14 条规则命中与预期一致）。
- `verify`（迁移前基线）：OK=6 / FAIL=23（归属决策后：`agents/{1,3,4,5}/settings.xml`、`agents/{1,3,4,5,6}/scripts` 等结构未建，符合预期）/ WARN=7（旧残留，pre 模式不计 FAIL），退出码 1。
- `verify --post-phase3`、`verify --no-db`、非默认 `--share-dir` 告警行为均实测符合设计。
- DB 前像导出用真实库实测：`agent_experiences` 4 行 + `scheduled_task` 2 行 + `session_workspace_rules` 5 行 = 11 条 REPLACE 语句。