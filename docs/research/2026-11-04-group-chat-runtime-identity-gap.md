# 群聊会话「运行身份」缺口调研：技能路径按会话归属拼装、执行容器按发言者隔离

> 日期：2026-11-04。**仅调研与取证，不含代码改动。**
> 触发案例：飞书群 `oc_6db395f2fe2cad6b7ad21db1d57b9c95`（会话 1607，归属用户 17 王昭文）——群成员 67 秦翌翔 @ 机器人执行时，`read_file` 读技能文档被容器沙箱判越界（`Path escape attempt`），且技能对应 CLI 在发言者容器整体缺失。
> 相关背景：`system_setting.runtime.mode=docker`（DB 最近更新 2026-10-31 21:28:37，当前 89/90 用户跟随 docker）、技能视图按用户物化（CHANGELOG 0.0.425，11-03）。
> 后续方案：`docs/plan/2026-11-04-group-chat-runtime-identity-technical-design.md`（定稿 V1：运行身份对齐 + 可解释性；容量优化改用「内容寻址 + 硬链接」，**已废弃** agent 级共享视图挂载）。

## 一、结论摘要

| # | 结论 | 等级 |
|---|---|---|
| 1 | **确定性缺陷、已复现**：群聊/话题会话里，提示词中的技能文件路径按「会话归属用户（owner）」拼装，而文件工具在「本次发言用户」的容器内执行——路径必然不可达：`read_file` 报 `Path escape attempt`（strict 沙箱），`shell` 侧同一路径是 No such file（跨用户目录未挂载）。 | P0 |
| 2 | **同一根因的第二类表现**：技能 CLI 与依赖（`deps/{uid}/npm/bin`）、用户技能目录（`userskills/{uid}`）、HOME 下的凭据缓存全部按用户隔离；非 owner 发言时，技能文档里要求的 CLI（apollo-cli / devops-cli / xxl-job 等）在发言者容器里不存在，任务实际不可执行。 | P0 |
| 3 | **影响面不止技能**：凡「宿主侧按 uid 拼路径/写字节、容器侧按 uid 读」的链路全部错位——`dump_user_messages`、`open_web_page` 缓存、压缩归档与回读指引、`generate_image` 产物目录、飞书/钉钉发送工具的容器读字节；MCP stdio 容器寻址用的是 owner，与文件工具（发言者）不在同一容器。 | P1 |
| 4 | **成因是设计缺口而非笔误**：docker 运行模式把「执行身份」收窄到发言者（`executionUserId`），但技能同步、提示词路径与一批宿主侧工具仍按「会话归属」拼装。host 模式被宽松沙箱与全局文件系统掩盖，长期未暴露。 | — |
| 5 | **修复方向（建议单独立项）**：定义统一「运行身份 = `executionUserId ?? session.userId`」——所有**执行期资源**（技能、runtime 子目录、uploads、deps、凭据缓存）跟随运行身份；会话归属仅用于会话归属/权限/列表展示。 | 方案见 §6 |

## 二、现场证据（2026-11-04）

### 2.1 报错现场

容器 `mao-user-67` 日志（`docker logs mao-user-67`），与消息表 614208（TOOL 结果）一致：

```
10:58:20.253 WARN Path escape attempt blocked: /opt/mao-data/runtime/17/1607/skills/apollo-cli/SKILL.md
10:58:20.253 WARN ReadFileTool blocked by sandbox: Path escape attempt: /opt/mao-data/runtime/17/1607/skills/apollo-cli/SKILL.md
```

提示词里的技能路径来自宿主侧 `formatCloudSkillsPath(context.userId=17, 1607, …)`；执行容器是 67 的（`MAO_CONTAINER_USER_ID=67`）。

### 2.2 三个事实源各自为政

| 事实源 | 落点 | 对容器 67 可见性 |
|---|---|---|
| 提示词技能路径（宿主生成） | `runtime/17/1607/skills/{name}/SKILL.md`（软链 → `skill-views/17/{name}`） | ❌ 未挂载 → 沙箱拒绝 |
| 容器实际挂载 | `runtime/67`、`skill-views/67`、`userskills/67`、群工作区（rw）、share | —（`skill-views/67` 为空） |
| 技能 CLI 依赖 | `deps/17/npm/bin`（已装 11 个 CLI）；`deps/67` 不存在 | ❌ 发言者容器无任何技能 CLI |

补充事实：`runtime/67/1607/` 下只有 `shellOutput`（shell 按发言者落盘，正确），没有 `skills`；`userskills/67` 为空。

### 2.3 会话与成员事实（DB）

- `session 1607`：`user_id=17`（王昭文），`project_key=feishu-chat-2-oc_6db395f2fe2cad6b7ad21db1d57b9c95`，执行模式 CLOUD。
- 10:57:23 秦翌翔（67）触发本轮（message 614142）；10:58 读技能被拒、CLI 缺失；11:10:00 王昭文（17）再次触发，环境切回 17 的容器（message 615288 佐证）。
- 会话内 llm_call 的执行身份分布：`17, 35, 67`（同会话 ≥3 个执行用户）。

### 2.4 影响范围量化

- 全量：**21 个**飞书/钉钉群会存在「非 owner 执行」历史；近 7 天 **5 个**；最大一个群会话有 **10 个**不同执行用户（按 `llm_call.user_id <> session.user_id` 统计）。
- 全站 90 个用户中 89 个跟随 docker（唯一 host 用户是运维本人），即群聊里非 owner 发言的场景都会踩到。

### 2.5 用户可见后果

本轮任务的 agent 最终回复（message 614396，节选）：“11-04 起的执行容器改为按用户隔离，只挂载了当前用户（秦翌翔）的目录。之前缓存的王昭文 Apollo 开放平台 token 不可见，`apollo-cli` 技能副本（`skill-views/67`）也为空，所以无法像前几次那样直接改”——任务被阻塞，交还用户人工选择替代路径。即：**不是静默失败，是任务实质性不可执行**。

## 三、根因链路（代码级）

### 3.1 两类身份的定义

- **会话归属** `session.userId`：群会话创建者为「群内第一个完成绑定的成员」（`app-feishu-messaging.ts:69-83`，会话工厂用当前发信人建会话并落库）。
- **运行身份** `executionUserId`：本次触发的发言成员；由入站处理器给出（`app-feishu-handler.ts:140`、`feishu/agent-inbound-handler.ts:705`、`dingtalk/runtime.ts:221-225`），在 `HarnessService.execute` 里写入上下文（`harness-service.ts:119-122`）。

### 3.2 各环节取值对照

| # | 环节 | 取值身份 | 代码位置 |
|---|---|---|---|
| 1 | 技能同步 + 会话技能软链 | **owner** | `harness-service.ts:321` → `skill-sync-service.ts:45-47`（`runtime/{u}/{sid}/skills` → `skill-views/{u}/{name}`） |
| 2 | 提示词技能文档路径 | **owner** | `prompt-engine.ts:601,625`（`formatCloudSkillsPath(context.userId, …)`） |
| 3 | 可用技能清单 / 用户技能文档 | **owner** | `harness-service.ts:483,506`（`session.userId ?? 0`） |
| 4 | 上传目录提示（incoming） | **owner** | `prompt-engine.ts:653` |
| 5 | docker 工具执行（shell / read_file / write_file / edit_file / glob / grep） | **发言者** | `tool-dispatcher.ts:379`（`routeUserId = executionUserId ?? userId`）→ `docker-tool-router.ts:83` |
| 6 | 容器沙箱允许根（strict） | **容器用户 = 发言者** | `container-tool-executor.ts:64-90`（workspace/u、runtime/u、home/u、userskills/u、skillViews/u、uploads/u、share、/tmp） |
| 7 | 容器挂载清单 | **发言者** | `container-mount-planner.ts:86-110` |
| 8 | shell / envelope / deps env（本身自洽） | **发言者** | `session-envelope-builder.ts:24-97`、`buildDepsEnv` |
| 9 | 压缩归档写入 + 回读指引 | owner | `session-compaction-orchestrator.ts:109` / `session-history-loader.ts:47` |
| 10 | `dump_user_messages` 落盘 | owner | `dump-user-messages-tool.ts:152`（SERVER_ONLY，宿主侧执行） |
| 11 | `open_web_page` 全文缓存 | owner | `open-web-page-tool.ts:180`（SERVER_ONLY） |
| 12 | `generate_image` / `edit_image` 产物 | owner | `generate-image-tool.ts:60-76`（`uploads/{uid}/`） |
| 13 | 飞书/钉钉发送工具容器读字节 | owner | `tool-dispatcher.ts:401`（非 shell 宿主工具一律 `userId`）→ `send-file-bytes.ts` → `read-bytes-bridge.ts` |
| 14 | MCP stdio 容器寻址 | owner | `routing-mcp-client-manager.ts:10-12,37,57` + `app-container-runtime.ts:169-177`（`session.userId`） |
| 15 | 长期记忆注入 | owner | `harness-service.ts:642-649` |

**冲突点 = 1~4 与 5~8。** 提示词描述的资源（技能、上传目录）在 owner 的路径空间；执行发生在发言者的容器（挂载、沙箱、CLI 环境都在发言者）。5~8 本身是「发言者身份」的正确实现，问题在于资源侧没有跟上。

**同源差异（本次未修，但属同一决策面）：** 9~15 都停留在「会话归属」语义——其中 13、14 会造成「工具看到的环境」与「shell/文件工具看到的环境」撕裂（发送工具去 owner 容器读字节、MCP 在 owner 容器执行），在群聊多发言者场景下同样不可预期。

## 四、影响分级

| 级别 | 问题 | 证据 |
|---|---|---|
| P0 | 非 owner 发言时技能文档不可读（Path escape / ENOENT），agent 误导性报错 | 已复现（§2.1） |
| P0 | 非 owner 发言时技能 CLI 缺失（deps 按用户），技能实质不可用 | 已复现（`deps/17/npm/bin` 有 11 个 CLI vs `deps/67` 不存在） |
| P1 | `dump_user_messages` / `open_web_page` 缓存 / 压缩归档：写入 owner 空间、回读在发言者容器 → 同样读不到 | 代码确认（§3.2 #9-11） |
| P1 | 发送工具（feishu/dingtalk）读发言者容器内文件 → 去 owner 容器找，找不到 | 代码确认（#13） |
| P1 | `generate_image` 产物落 owner 的 uploads；发言者容器不可见（若换发言者继续操作会错位） | 代码确认（#12） |
| P2 | MCP stdio 在 owner 容器执行，与文件工具不在同一文件系统视图 | 代码确认（#14） |
| P2 | 群聊中 owner 的「用户技能清单」进入每一轮提示词（其他成员可见名字与描述）——轻微信息暴露；同时非 owner 成员自己的用户技能在群聊中完全不可用 | 代码确认（#3） |
| P2 | 长期记忆按 owner 注入 | 代码确认（#15） |

## 五、为什么现在集中暴露

- 10-14：docker 运行模式引入（`f75b366c`，含 `executionUserId` 路由）。
- 10-31 21:28：全局 `runtime.mode` 切 docker（DB `updated_at`），群聊里非 owner 的发言开始真正落在各自容器。
- 11-03：0.0.425 技能视图改造——技能副本按用户物化（`skill-views/{uid}`），容器挂载从全局可写 `skills` 改为按用户 `skillViews`（挂载指纹变化还触发了一次存量容器重建），隔离面变化被更多使用者直观感知。
- host 模式（1 个用户）下同样按 owner 拼装，但宽松沙箱 + 整机文件可见，不报错 → 长期掩盖；私聊恒有 owner==发言者 → 也掩盖。

## 六、修复方案评估

> 结论（2026-11-04 定稿）：采用方案 A；方案 B/C 废弃（理由见方案 §6.3，容量问题改由 V2 内容寻址 + 硬链接解决）；方案 D 仅作为可解释性兜底的组成部分，不单独实施。

### 方案 A（推荐）：统一「运行身份」

定义 `runtimeUserId = executionUserId ?? session.userId`，作为**所有执行期资源**的寻址依据；`session.userId` 只保留会话归属语义（归属、权限、列表展示）。

| 改动位置 | 改法 |
|---|---|
| `harness-service.buildContext` / `execute` | 把 `executionUserId` 传进 `buildContext`（或先赋值再同步），`syncToSession(agent, runtimeUserId, sessionId)`；`getUserSkillNames/Documents(runtimeUserId)` |
| `prompt-engine` 技能目录 / incoming / 用户命令 | 统一取 `context.executionUserId ?? context.userId` |
| `session-compaction-orchestrator` / `session-history-loader` | **归档保持 owner**（不拆分、不按发言者），非 owner 执行时不注入回读指引（定稿 D6） |
| `tool-dispatcher` 的 SERVER_ONLY / 宿主工具 / 发送工具 | 需要「与执行环境同视图」的工具（dump_user_messages、open_web_page、generate_image、edit_image、feishu/dingtalk send）取运行身份 |
| `SkillSyncService` | 同步状态键由 `(agentId, sessionId)` 改为 `(agentId, runtimeUserId, sessionId)`，避免不同发言者互相清链、误删 |
| MCP 容器寻址 | **保持 owner**（定稿：已知差异 + warn 日志，后续单独评审） |

效果：每个群成员按自己的技能授权、自己的 CLI/凭据执行，提示词路径与容器视图一致；owner 的用户技能清单不再进入其他成员的每一轮提示词。

风险与注意：

- 同一群会话的可用技能集合随发言者变化（尤其用户技能）——这是「按人授权」的必然结果，需在文档/产品文案中说明；
- 技能视图按发言者物化，每新增一个发言者多一份 `skill-views/{uid}`（现网均值约 10 MB/用户），磁盘线性增长；清理走 `runtime-cleanup-scheduler`（按 `runtime/{uid}/{sid}/skills` 遍历，已覆盖）；
- 每个群成员首次使用需自行安装技能 CLI（`npm install . -g` → `deps/{uid}`），首轮有一次性安装成本，可考虑镜像预装高频 CLI；
- 提示词前缀随发言者切换而失效（prompt cache 命中率略降），同一执行内无影响；
- 定时任务 / 手动压缩 / 侧任务没有 `executionUserId`，保持 owner（与现状一致）；崩溃恢复与子代理按 `last_runtime_user_id` 继承本次执行身份（定稿 D9）；

### 方案 B（不推荐）：把 owner 的技能面挂进发言者容器

把 `runtime/{owner}/{sid}/skills` 与 `skill-views/{owner}` 以 ro 挂进所有发言者容器。

- 违背按用户挂载的结构：挂载清单要引入「他人目录」例外、沙箱要新增允许根；
- `skill-views/{owner}` 含 owner 的**用户技能**副本，等于把个人技能内容暴露给所有群成员容器，与「个人技能隔离」冲突；
- 动态挂载变更会触发容器重建，群成员越多抖动越大。

### 方案 C（不推荐）：会话级共享技能目录

把会话技能物化到群工作区或新的 session 级根，供所有成员挂载。

- 所有成员可读（写入方另需定义），用户技能私有性消失；
- 技能更新、清理、权限模型都要重做，超出缺陷修复范围。

### 方案 D（止血，可先做）：非 owner 发言时显式降级

当 `executionUserId != null && executionUserId != session.userId` 时，提示词不再输出技能文件路径，改为「技能文档仅对会话创建者可见，当前执行身份不可读」，并跳过该轮技能同步。

- 改动很小（`prompt-engine` 一处 + 可选 system notice），避免误导模型反复撞沙箱；
- 但功能仍不可用，只改善可解释性，不能替代 A。

### 工作量与验收

- 方案 A 粗估：后端 5-8 个文件、约 0.5–1.5 人日（含单测），外加一次真实「双 docker 用户」群聊验证。
- 单测：`harness-service.spec`（同步目标与技能清单按 runtimeUserId）、`prompt-engine.spec`（技能路径与 executionUserId）、`tool-dispatcher.spec`（服务端/发送工具 userId）、`skill-sync-service.spec`（状态键）。
- 手工验证：群内 A（owner）先触发建会话，B、C 各触发一轮——`read_file` 技能文档成功、`deps/{B}/npm/bin` 出现 B 自己的 CLI、A 不受影响；web 侧 owner 打开会话仍正常；定时任务/崩溃恢复仍按 owner 运行。
- 回归：host 用户、私聊、LOCAL 模式零变化。

## 七、待决策（立项时确认）——已全部收敛（2026-11-04 定稿）

1. 群聊技能/CLI/凭据按发言者（推荐）——**已确认**：技能集合随发言者变化，可接受；
2. `generate_image`/`edit_image` 产物归属——**已确认**：归运行身份（D4），跨成员限制面见方案 §7.1；
3. MCP stdio 容器寻址——**已定**：保持 owner（已知差异，后续单独评审）；
4. 长期记忆注入归属——**已定**：注入与抽取同源，跟随运行身份（D5）；
5. 运行时镜像预装高频技能 CLI——**未定**：不属 V1，后续按首次安装成本评估。

## 八、复现与取证指引

1. 选择两个均跟随 docker 的绑定用户 A、B；A 在群内首次 @ 机器人建会话，确认 `session.user_id=A`；
2. B 在群内 @ 机器人触发任务，让 agent 读任一技能文档（`read_file('/opt/mao-data/runtime/{A}/{sid}/skills/{name}/SKILL.md')`）；
3. 取证：
   - `docker logs mao-user-{B} | grep "Path escape"`；
   - `ls /opt/mao-data/runtime/{A}/{sid}/skills`（存在）对照 `ls /opt/mao-data/runtime/{B}/{sid}/skills`（不存在）；
   - `ls /opt/mao-data/deps/{A}/npm/bin` 对照 `deps/{B}/npm/bin`；
   - `docker inspect mao-user-{B}` 确认只挂载 B 的 runtime / skill-views；
4. 切回 A 发言，同一会话恢复正常（可复现「按发言者切换环境」）。

---
（本调研基于线上容器日志、挂载事实、DB 记录与源码走查完成；未修改任何代码与配置。）
