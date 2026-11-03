# 技能视图（Skill View）代码审查报告 · Round 3（§12 修订增量）

- 审查日期：2026-11-03
- 需求方案：`docs/plan/2026-11-03-skill-view-container-isolation-technical-design.md`（含 `f8aa3223` 新增 §12 评审修订记录 10 项）
- 审查范围：提交 `fe903535` **相对 R2 工作区快照的代码增量**（用 `git archive 2646f052` + 重放 R2 diff 重建 R2 树后逐文件比对确认：增量为 4 个当时已跟踪文件 `container-mount-planner.ts` / `container-mount-planner.spec.ts` / `container-registry.spec.ts` / `skill-sync-service.spec.ts`，+ 3 个当时未跟踪文件 `skill-view.service.ts`（`.meta` 位置 + 竞态容忍）/ `skill-view.service.spec.ts` / 新增 `runtime-cleanup-scheduler.spec.ts`；R2 已复验内容不重审）
- 结论：**有 bug（1 项 · 重要）**；本轮其余修订项复验通过（含新增反例/边界探针）
- 验证方式：临时 vitest 探针（`vi.mock('node:fs')` 包裹 `renameSync` 注入双实例竞态，确定性复现，验证后已删除）+ 只读核对 + 增量涉及的 5 个 spec（83 用例）全绿

---

## 一、重要（1 项）

### I-1 竞态②「按成功继续」只做了一半：败者丢弃了自己的 stage，却仍写自己的 meta → 指纹短路把胜者的旧内容钉死

- 位置：
  - `backend-ts/src/harness/skill/skill-view.service.ts:146-156`（ENOTEMPTY/EEXIST 容忍分支：148 丢 stage、149-156 丢 `.old`）
  - `backend-ts/src/harness/skill/skill-view.service.ts:169-184`（步骤 4 / **步骤 5**：180-181 落盘 meta）
  - 受害点：`backend-ts/src/harness/skill/skill-view.service.ts:92-97`（96 行 `meta?.fingerprint === fingerprint` 即短路返回，**信任 meta 描述视图内容**）
- 问题描述：
  竞态②命中时，`viewDir` 里躺着的是**胜者**的完整视图（另一实例的 stage），实现正确地丢弃了自己的 stage 与 `.old`（清理无残留、无误删，见验证），但**没有放弃 meta 的写入权**：随后步骤 5 仍以 `fingerprint`（= 败者自己那份 stage 对应的源状态指纹）覆盖 `{views}/.meta/{u}/{name}.json`。
  于是 meta 与视图内容解耦：下一轮 `ensureView` 走到 92-97 行，看到 `meta.fingerprint === 当前源指纹` 便短路返回，**视图不会被刷新**——源不再变化时该技能对容器内是“陈旧但看似最新”的副本（正是方案 §4.9 决策 1 要避免的幽灵视图），且此场景下没有任何自愈路径（胜者刚写入的、与视图内容匹配的 meta 已被败者覆盖）。步骤 4（`hadOld=false` 跳过）本身没有问题。
- 触发条件（如实列出，便于判级）：
  1. 跨实例并发物化（蓝绿 drain 窗口内新旧后端对同一 `{u}:{name}` 同时物化——本分支就是为它加的，方案 §8/§13 也把该并发列为现实风险）；
  2. 两实例物化期间**源状态不一致**（部署 rsync 落在两次拷贝之间：旧实例拷到旧内容、新实例拷到新内容）；
  3. 方向为「败者拿到较新内容、胜者拿到较旧内容」且当前源即败者那份（给定源分叉时约 1/2）。
  方案 §4.2 的表述前提是“内容同源”（代码注释 145 行也这样写）；该前提成立时本写入无害，**前提不成立时**即上述后果。
- 复现 / 验证（临时探针，确定性注入，实测输出）：
  ```ts
  // 用 vi.mock('node:fs') 在 renameSync 前挂钩，注入「胜者先到」：
  //   stage→view 之前把 view 建为旧内容（v1），并按胜者身份写回它自己的 meta（= 源更新前的指纹）
  vi.mock('node:fs', async (io) => { const a = await io(); return { ...a, renameSync: (f, t) => { hook?.(String(f), String(t)); return a.renameSync(f, t); } }; });
  // 1) 源 v1 物化 → 记下胜者指纹（= 首轮 meta.fingerprint）
  // 2) 源更新为 v2（新指纹）→ 注入胜者视图（内容 v1）+ 胜者 meta → 调 ensureView（败者路径）
  // 3) 断言：.tmp/{u} 为空（无残留）；view 内容仍是 v1；meta 被改成败者指纹；再调 ensureView 仍返回 view 且内容不变
  ```
  实测输出：
  ```
  [probe R3-1] view content contains v1(old)? true | winner fp: 1793705720808-1-39 | final meta fp: 1793705725815-1-39
  [probe R3-1] after next ensureView, view still old? true | entries: []
  ```
  → 胜者的正确 meta 被败者覆盖；下一轮指纹短路，视图停留在旧内容；`.tmp/{u}` 无残留（清理语义正确）。
  对照组（竞态①，`view → .old` 前视图被他人搬走）：按「无需搬」继续 → 换入成功、内容 = v2、meta 与内容一致、无残留（R3-2 通过）。
- 影响面：容器内该技能长期使用旧副本（`SKILL.md` / 脚本 / `npm install . -g` 的 CLI 目录），且**静默**（无告警可循、无自愈），排查成本高；只影响 docker 模式下的这一个技能（视图 ro 只读，不会污染源）。
- 修复建议（供后续 worker 执行）：命中该分支即视为「本轮物化未生效」，**跳过步骤 5**（例如分支末尾 `return`，或置 `skipMeta` 标志后跳过 177-184），保留胜者写入的 meta：胜者 meta 与其视图内容天然配对；若胜者 meta 缺失，下一轮按「meta 缺失/不一致」自然重建，代价仅一次重复拷贝。步骤 4 的现状（`hadOld=false`）保持。

---

## 二、复验通过（本轮修订项，逐条）

- 修订 1（`.meta` 移出挂载根）：`skill-view.service.ts:214` 落在 `{views}/.meta/{u}/{name}.json`，`removeView`（:188）同时清 view + meta；`grep` 确认源码内无旧路径（`{views}/{u}/.meta`）残留引用；新增单测断言视图目录内无 `.meta`、`{views}/{u}` readdir 只有技能；独立探针 R3-b1：容器侧允许根为 `{views}/{u}` 时 `read_file` 读 `{views}/.meta/{u}/{name}.json` **被拒**、读 `{views}/{u}/{name}/SKILL.md` 通过（元数据既不在挂载清单内、也不在允许根内）。
- 修订 3（源删除被动清理 / ghost 用例）：`skill-sync-service.spec.ts` 新用例断言 `ensureView` 只为 `agent.skillNames` 内的技能调用（`['java']`）且 `{views}/7` 只有 `java`；与方案 §4.6「被动清理」表述一致。
- 修订 6（`skillViewsDir` 与 `shareDir` 互不包含）：`container-mount-planner.ts:196-200` 反向断言（views ⊂ share / 相等）fail-fast，正向（share ⊂ views）由既有 `assertShareDirIndependent` 拦截；探针 R3-b2 验证同前缀不同目录（`share` vs `shareX`）**不误报**，两方向均正确拒绝；生产配置（share=`/opt/mao-data/share`、views=`/opt/mao-data/skill-views`）无冲突。
- 修订：registry 升级路径：`container-registry.spec.ts` 新用例（无指纹旧条目 → 恰好一次 `stop -t`/`rm -f`/`run -d`，`-e MAO_SKILL_VIEWS_DIR` 生效且无 `MAO_SKILLS_DIR`，指纹一致后零 docker 动作）——与「env 不在挂载指纹内、靠挂载指纹变化重建一次」的说明自洽。
- 修订 8（清理不误删活跃视图）：`runtime-cleanup-scheduler.spec.ts` 断言视图目录 mtime 48h 仍保留、只清 `.tmp`；实现侧 `RuntimeCleanupScheduler` 本轮无代码改动（只清 `{views}/.tmp/{数字 uid}`）。
- 修订 7（CHANGELOG 去掉「ECP 下发」）：文档，按规则不细审。
- §6 的「删除系统技能时按 users 表批量清理各用户视图」：方案 §4.6/§6 明确标注**可选**（“列为可选项（§6）”“（可选）…不做则靠二期 GC”）→ 未实现不构成遗漏，不作为 bug。
- 竞态①（ENOENT 容忍，:130-138）：逻辑正确——仅在 `rename` 目标消失时按「无需搬」继续，否则照常抛出；探针 R3-2 验证后续换入、meta、清理均正确。

## 三、备注

- 同类既有路径（**未计入本次 bug**，供修复时一并考虑）：非竞态路径下，两实例各自完成 swap 后，先完成一方的 meta 写入可能晚于后完成方的 swap（其步骤 4 要递归删除整份旧拷贝，窗口毫秒级），同样得到「meta = 较新指纹 + 视图 = 较旧内容」并可把视图钉死。该路径在 R2 之前的代码即存在（非本轮引入），故不列为本次 bug；建议把「meta 写入权」收敛为「只有把 stage 换入成功的一方写 meta」，一次覆盖两条路径。
- 本轮新增的两个竞态分支在提交单测中**无用例覆盖**（`skill-view.service.spec.ts` 只有并发幂等、`.meta` 位置等用例），是本项未被发现的原因之一；修复时建议用本报告的 rename 注入法补一条分支用例（含「败者不写 meta」的断言）。
- 覆盖范围：仅审本轮代码增量（4 个已跟踪文件 + 3 个 R3 新增文件），R2 已复验内容未重审；临时探针（`zz-review-r3-probe.spec.ts`、`zz-review-r3b-probe.spec.ts`）已删除，未改动产品代码。
- 未覆盖（环境限制）：真实 Docker/MySQL 与真实蓝绿双实例并发（本报告用 fs 注入做确定性模拟）；真实容器内元数据不可见性只验到「挂载清单不含 `.meta` + 允许根拒绝」这一层。
