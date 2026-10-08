# 工具审批规则技术方案：本会话总是允许 + 持久 allowlist

- 状态：已实施（2026-10-08；落地说明见 CHANGELOG 0.0.241。实施时主分支已占用 V135/V136 迁移编号，实际迁移为 V137__approval_rule.sql）
- 日期：2026-10-06
- 评审修订：2026-10-06（砍 PATH_PREFIX 死类型；补档位准入口径；修正决策 4 矛盾；迁移编号 V137→V135；补 hint 穿透链与幂等；denylist 切词口径；风险与验收同步）
- 提案来源：[docs/proposals/2026-10-06-approval-rules.md](../proposals/2026-10-06-approval-rules.md)
- 前置事实：审批门只存在于 LOCAL 执行边界（CLOUD 直接执行，仅 shell deny-list 硬拦截）；审批 UI 为 `ApprovalStack.vue` 两按钮（执行/拒绝）

## 1. 需求背景

1. **逐次审批、无记忆**：`ToolDispatcher.shouldRequireApproval`（tool-dispatcher.ts L396-472）按会话 `permission_level`（V027 列，每次工具调用从 DB 重读）判定，`ApprovalStack.vue` 只有"执行 / 拒绝"。全库无 always_allow / whitelist 逻辑。
2. **审批疲劳的出口只有降级**：频繁弹窗把用户逼向 FULL 档（`PermissionLevelSwitcher.vue` 一键切 FULL，安全性整体倒退）。逐次确认与 FULL 之间没有中间态。
3. **留痕缺口**：人工审批结果后端完全不落库（`handleToolApproval` 连 `approved` 布尔都不读，streaming-ws-handler.ts L860-868），只有 AI 审批（PROXY/SMART 的 Jev 与 LLM 代批）通过 `metadata.approvalMark` 留痕（agent-loop.ts `mergeApprovalMark` L697-713，前端 ToolCallCard 已有"AI 已批准/已拒绝/低风险放行"徽标）。

## 2. 需求描述

### 2.1 目标（全部要做）

1. 审批卡片第三个选项"本会话总是允许（限定匹配模式）"：模式由后端从当次参数归一化生成，用户确认后落会话级规则；后续命中请求静默放行。
2. 用户级持久规则：设置页 CRUD（shell 前缀/精确、MCP 工具三类），命中即放行，仅对创建者生效。
3. 留痕与治理：规则放行写 `metadata.approvalMark = { mode: 'rule', ... }`（复用现有徽标管线）；规则表维护命中次数与最近命中时间；admin 只读清单。

### 2.2 非目标（明确不做）

- 不改五档语义：READ_ONLY 档的写/shell/MCP 审批是边界本身，**任何规则不可放行**。
- 不做自由正则规则（只提供受控模式类型）。
- 不做 admin 下发 / 组织级策略（admin 只读）。
- 不做 CLOUD 边界的规则（CLOUD 无审批门；本方案全部作用在 LOCAL）。
- 不做文件路径类规则（PATH_PREFIX）：write_file/edit_file 仅在 READ_ONLY 档审批，而 READ_ONLY 档规则免疫（决策 1），路径前缀规则在任何档位都无法生效，保留即死类型（决策 10）。
- 不做 MCP 参数级模板（P1/P2 均只到工具级，见决策 6）。

## 3. 范围界定：做 / 不做清单

### 3.1 做什么

| 层 | 内容 |
|---|---|
| backend-ts | V135（`approval_rule` 表）；`ApprovalRuleService`（归一化生成、匹配、denylist 校验、命中计数）；`dispatchFullOutcome` LOCAL 分支接入规则短路（含档位准入判定）；`LocalToolExecutor.execute` 增 `approvalHint` 参数；`tool_execute` payload 增 `approvalHint`；`ToolApprovalMark.mode` 增 `'rule'`（backend 与 desktop 类型同步）；`tool_approval` 入站增 `alwaysAllow` 分支（服务端 hint 落规则，查重后建）；`/v1/approval-rules` 用户 CRUD；`/v1/admin/approval-rules` 只读；会话删除级联清理 |
| desktop | `ApprovalStack.vue` 第三按钮（"总是允许（以 npm run 开头）"）；preload.cjs `toolExecute` 增第 8 参 `approvalHint`、`respondToolApproval` 增第 3 参 `alwaysAllow`；`useChat.ts` 审批项透传 hint；设置页新 `ApprovalRulesView.vue` + 路由 + 导航 + API |
| admin | 只读规则清单页（挂"安全"分组，`approval-rule:read`） |
| 文档 | CHANGELOG；skills/mao-cli LOCAL 审批章节补规则说明 |

### 3.2 不做什么（与"做"同等明确）

- 不新增 Playwright 用例。
- 不改 `tool_execute` / `tool_result` / `tool_approval` 既有字段语义（只增量）。
- 不做规则的导入导出 / 批量授权。
- 不把规则放行写入 `audit_log` HTTP 审计（规则放行的事实落在 tool 消息 metadata，规则管理动作才走 service 级审计）。

## 4. 技术选型

零新增依赖。规则匹配是纯函数（单测覆盖）；denylist 种子进 `system_setting`（`approval.rule.denyTokens`，逗号分隔 token 清单，admin 可编辑，category=审批，对齐 V127 先例）。前端徽标复用 `approvalMark` 既有渲染管线（`ToolCallCard.vue` L92-99），只加一个 mode 分支。

## 5. 详细设计

### 5.1 V135 迁移

```sql
CREATE TABLE IF NOT EXISTS `approval_rule` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`     BIGINT      NOT NULL COMMENT '创建者（匹配时按执行用户过滤）',
    `scope`       VARCHAR(16) NOT NULL COMMENT 'SESSION/USER',
    `session_id`  BIGINT      NULL COMMENT 'SESSION 规则的所属会话',
    `rule_type`   VARCHAR(16) NOT NULL COMMENT 'SHELL_PREFIX/SHELL_EXACT/MCP_TOOL',
    `rule_value`  VARCHAR(512) NOT NULL COMMENT '模式值（归一化后）',
    `hit_count`   BIGINT      NOT NULL DEFAULT 0,
    `last_hit_at` DATETIME    NULL,
    `enabled`     TINYINT     NOT NULL DEFAULT 1,
    `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY `idx_rule_user` (`user_id`, `enabled`),
    KEY `idx_rule_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='LOCAL 工具审批放行规则';
```

- 无唯一键（同值重复创建允许，设置页提示去重）；会话删除时物理删 `session_id` 对应行。

### 5.2 规则类型与归一化

| rule_type | 适用工具 | rule_value 生成 | 匹配语义 |
|---|---|---|---|
| `SHELL_PREFIX` | shell | `args.command` 去除首部 env 赋值前缀（`FOO=bar ` 连续段）后取**前两个空白分隔 token** 以空格连接；单 token 命令取该 token | command 归一化后以 `rule_value` 开头且下一字符是空白/串尾（词边界） |
| `SHELL_EXACT` | shell | 归一化后的完整 command（截 512） | 全等 |
| `MCP_TOOL` | `mcp__<server>__<tool>` | 工具全名 | 全等 |

- **denylist 双重拦截**（内置种子 + `approval.rule.denyTokens` 可扩展）：① 生成拒绝——命令含任一 denylist token（按空白与命令结构标点 `; | & > <` 切词后比对；`-`、`/`、`=` 不参与切分，`rm-cache`、`docs/su/`、`--force-with-lease` 保持完整 token 不误伤）时，`approvalHint` 不生成、卡片无第三按钮；② 匹配拒绝——即使规则已存在，命中 denylist token 的请求规则失效、走正常审批。内置种子：`rm rmdir mkfs dd shutdown reboot kill pkill killall sudo su drop truncate --force -rf -fr`（首版清单，实施时可调；`rm` 作为独立 token 已覆盖 `rm -r -f` 等全部变体）。
- 归一化为 `ApprovalRuleService` 内纯函数，导出供单测。
- 已知边界（文档写明）：`SHELL_PREFIX` 的两 token 粒度下 `git push --force` 会命中 `git push` 规则，因此 denylist 含 `--force`，该场景必须依赖 ② 的全命令扫描兜底。

### 5.3 判门接入（`dispatchFullOutcome` LOCAL 分支）

**档位准入**：先做同步的"档位 × 工具类"判断，仅当该调用在当前档位下**本来需要审批**时才查规则——

- `READ_ONLY` 一律跳过：写/shell/MCP 审批是边界本身，规则免疫（决策 1）；
- `FULL` 一律跳过：无审批可放行，保持零查询、零徽标、零行为差异；
- `READ_WRITE/SMART/PROXY` 下仅 `shell` 与 MCP 工具查询：这三档的 write_file/edit_file 本来就不审批（`shouldRequireApproval` 中非 shell 非 MCP 直接放行），不查、不计数、不打标。

准入通过后在 `shouldRequireApproval` **之前**插入规则匹配：

```
match = approvalRuleService.match(executionUserId, sessionId, toolName, argumentsJson)
  → 查 enabled 规则（会话级优先于用户级），denylist 全命令扫描通过
  → 命中：fire-and-forget UPDATE hit_count+1, last_hit_at=now
  → 返回 { hit, ruleId, ruleValue }
```

- 命中 → `needApproval=false`，`result.approvalMark = { mode: 'rule', approved: true, reason: '规则放行：<ruleValue>', ruleId }`（`mergeApprovalMark` 同管线落 tool 消息 metadata，前端徽标自动生效，`ToolCallCard` 加 `rule → '规则放行'` 分支；`DispatchOutcome` 增 approvalMark 直通位，不经 `llmVerdict` 推导）。
- 未命中 → 走原五档判定链，**语义零变化**：SMART/PROXY 的 Jev 前置与 DangerAssessor/ProxyApprover 顺延（规则命中即短路，不再产生 `DANGER_ASSESS`/`PROXY_APPROVE` 的 llm_call，成本收益）。
- 规则命中时 PROXY 的代批 LLM 根本不会运行，也就不存在"AI 拒绝"——规则即用户明示意图，优先于模型推测（决策 4）；未命中时原链不变，AI 拒绝（`llmVerdict.approved=false`）照旧直接否决。

### 5.4 审批卡片第三按钮（会话级规则创建）

- **hint 生成在后端**：`dispatchFullOutcome` 判定 `needApproval=true` 且工具可规则化时，调用 `buildApprovalHint(toolName, argumentsJson)`（§5.2 归一化 + denylist 校验），产出 `approvalHint: { ruleType, ruleValue, label }`（如 `label: "本会话总是允许以 npm run 开头的命令"`；不使用 `*` 通配记法——实际匹配语义是"前缀 + 词边界"，展示措辞不得引入不存在的通配语义），经 `LocalToolExecutor.execute` 新增参数带入（executor 是 `ApprovalRegistry.register` 的实际调用方，dispatcher 不直接触达注册表），随 `local-tool-session-registry.ts` `sendToolRequest` payload 增量字段下发；shell 异步路径（`dispatchLocalShellAsync`）复用同一 `execute` 入口，自然透传。denylist 命中 → 无 hint，卡片两按钮不变。
- **desktop 链路**：preload.cjs `toolExecute` 增第 8 参 `approvalHint`、`respondToolApproval` 增第 3 参 `alwaysAllow`；`useStreamWS.ts` `tool_execute` 分支把 `approvalHint` 并入 IPC 参数；`main.cjs` `requestToolApproval` payload 透传到渲染层队列（`useChat.ts` `ApprovalItem` 加可选 `approvalHint`，`confirmApproval` 增 alwaysAllow 出参）；`ApprovalStack.vue` 顶层卡在 hint 存在时渲染第三个按钮"总是允许"（副标题显示 ruleValue 全文）。旧版 Electron 壳（preload 仍为 7 参/2 参签名）收不到 hint、传不出 alwaysAllow → 静默退化为两按钮、只执行不建规则，不会误放行（见 §8）。
- **落规则**：第三按钮 = 正常"执行"流程（`respondToolApproval` IPC + `sendToolApproval` WS）+ `tool_approval` 帧附 `alwaysAllow: true`。后端 `handleToolApproval` 增分支：`alwaysAllow=true` 时从 `ApprovalRegistry` 按 `(sessionId, requestId)` 取回**服务端存储的 hint**（registry 在 `register` 时随签存入 hint、`unregister` 时同步清除——`unregister` 有两处调用点：本 handler 与 `LocalToolExecutor` finally 的 900s 超时/断连路径，两处都必须清 hint，保证恰好一次消费），创建 `scope='SESSION'` 规则；创建前先按 `(session_id, rule_type, rule_value)` 查重，已存在则跳过——`tool_approval` 帧可能因断线重试重发，表无唯一键，靠应用层幂等。客户端只能开关布尔位，不能注入 pattern（决策 3）。
- deny 时永不带 `alwaysAllow`；hint 未命中缓存（重启/超时后旧帧）则忽略 alwaysAllow 只执行。

### 5.5 用户级规则管理

- 路由（登录用户，本人数据）：`GET /v1/approval-rules?scope=USER`、`POST /v1/approval-rules`（body: ruleType/ruleValue，服务端归一化校验 + denylist 拒绝；`SHELL_PREFIX` 对用户输入同样执行"前两 token"归一化并在响应中返回归一化值，设置页展示归一化后的结果——输入 `git push origin main` 存为 `git push`）、`PATCH /v1/approval-rules/:id`（enabled/编辑值，重过归一化与 denylist）、`DELETE /v1/approval-rules/:id`。SESSION 规则不经此路由创建，但 GET 可带 `?includeSession=1` 查看当前会话规则（可选）。
- desktop 设置页 `views/settings/ApprovalRulesView.vue`（参照 `MemoryView.vue` 卡片列表模式）：类型筛选、规则值、命中次数/最近命中、启停 switch、双击确认删除；按命中次数降序。`router/index.ts` 加 `/settings/approval-rules` child + `SettingsView.vue` 加导航项 + `api/index.ts` 加封装。
- 规则管理动作走 service 级审计：`auditService.record({ action: 'CREATE'|'UPDATE'|'DELETE', objectType: 'approval.rule', objectId, userId, ... })`（照 create-app.ts 云终端 / SSO 回调的装配先例）。

### 5.6 admin 只读清单

- `GET /v1/admin/approval-rules`（新权限码 `approval-rule:read`，V135 按 V121 目录模式注册并授 role 1）：分页返回全量规则（含用户名、会话标题 enrich、命中统计），支持按 user/type/enabled 筛选。
- admin 视图 `views/approval/ApprovalRuleView.vue` + 路由 + SideMenu"安全"分组项（现有分组为 能力/运行/安全/系统，规则清单与审计日志同级，不新造单项目分组）。只读，无操作列。

### 5.7 会话删除级联

- `session.service.ts` `deleteSession`（L483-519）在 `sessionRepo.logicalDelete(id)` 前加 `approvalRuleRepo.deleteBySessionId(id)`（物理删，照 `sessionCompactionService.deleteBySessionId` 模式）。`WAITING_APPROVAL` 拒删守卫天然保证审批挂起中的会话不会被删出悬空 pending。

## 6. 实施步骤

### P1：会话级总是允许（backend + desktop）

1. V135 + `ApprovalRuleService`（归一化纯函数 + denylist + 匹配）+ 单测。
2. `dispatchFullOutcome` 规则短路（含档位准入）+ `approvalMark mode:'rule'`（`ToolApprovalMark.mode` 与 `DispatchOutcome` 类型扩散）；`LocalToolExecutor.execute` hint 参数 + `tool_execute` hint 下发；`approval-registry` hint 存储与双 unregister 清理；`handleToolApproval` alwaysAllow 分支（查重后建）。
3. desktop：`ApprovalStack.vue` 第三按钮 + hint 透传链（preload → useStreamWS → main.cjs → useChat）。

### P2：用户级规则与治理（backend + desktop + admin）

1. `/v1/approval-rules` CRUD + 审计；`ApprovalRulesView.vue` + 路由/导航/API。
2. V135 权限码 + `/v1/admin/approval-rules` + admin 只读页。

## 7. 测试方案（全部 Vitest，desktop 逻辑以 vue-tsc + 组件测试为辅）

- 归一化：env 前缀剥离（`FOO=bar npm run build` → `npm run`）、单 token、多空格、超长截断。
- denylist：生成拒绝（hint 为空）、匹配拒绝（已存在规则仍弹审批）、admin 扩展 token 生效；切词口径固定用例：`cat docs/rm-cache/x`（连字符与斜杠不切分）不误伤、`git push --force-with-lease` 不命中 `--force`、`npm run build && rm x` 因含 `rm` 被拒。
- 匹配矩阵：SHELL_PREFIX/SHELL_EXACT/MCP_TOOL × 命中/不命中；词边界（`npm run` 不放行 `npm runx`）；会话级优先于用户级；他人会话/他人用户不命中。
- 档位准入：READ_ONLY 下规则完全不生效（shell 有规则仍弹卡）；READ_WRITE/SMART/PROXY 的 shell/MCP 命中放行；三档下 write_file/edit_file 不查规则（hit_count 不增、无徽标）；FULL 零查询、零行为差异。
- 短路收益：规则命中时 `llm_call` 无 `danger_assess`/`proxy_approve` 场景记录（scene 计数断言）。
- alwaysAllow：hint 服务端取回（伪造 pattern 的入站帧被忽略）；deny + alwaysAllow 不建规则；同一 requestId 重发 alwaysAllow 只建一条规则（应用层幂等）；同会话多张 pending 卡各自 hint 互不串；注册表无 hint（超时/重启）时忽略。
- 留痕：`metadata.approvalMark = { mode:'rule', ruleId, ... }` 落库；`hit_count/last_hit_at` 递增；规则禁用后立即弹审批。
- 级联：删除会话后 SESSION 规则消失；USER 规则不受影响。
- 越权：他人规则 PATCH/DELETE 404；admin 只读码越权 403。
- 回归：无规则时五档判定链行为逐字节不变（现有审批 spec 全绿）。

## 8. 风险与对策

- **规则过宽是本方案最大风险**：`SHELL_PREFIX` 两 token 粒度 + 全命令 denylist 扫描双保险；hint 的 `label` 永远展示 ruleValue 全文，用户看到的是将要记住的确切模式；设置页按命中次数排序暴露"养大了的规则"。
- **denylist 漏网**（tee/管道/间接执行等）：denylist 是缓解不是安全边界——产品语义上规则就是用户对自己环境的显式授权（与 FULL 档同级但更窄），文档定位为"便利性功能"而非"安全控制"；admin 清单提供事后可见性。
- **`git push` 类两 token 前缀**：`--force` 在 denylist，`git push` 本身放行属用户明确意图；如需更紧，用户自建 `SHELL_EXACT` 规则替代。
- **hint 与 pending 生命周期**：hint 存服务端 registry，桌面断连重连不丢；丢失场景是后端重启（内存 registry 清空）或 900s 审批超时——此时 alwaysAllow 静默降级为普通执行（不报错），可接受。
- **壳与 UI 版本错配**：桌面 UI 随服务端下发、Electron 壳（main.cjs/preload）随安装包走。新 UI + 旧壳时 preload 签名缺参 → hint/alwaysAllow 静默丢失，卡片退化为两按钮、只执行不建规则；方向安全（不会误放行），发版说明提示用户更新壳。
- **MCP_TOOL 规则 = 工具全量参数授权**：SMART 档现状是 MCP 一律人工审批（dispatcher 显式注释），规则命中即静默放行该 `mcp__server__tool` 的全部参数——这是工具级授权的预期行为，hint label 应让用户看清授权对象；server 配置变更后全名可能失配——规则静默失配（退回逐次审批），不误放行，方向安全。
- **触发人与会话 owner 不一致**：钉钉/定时任务触发的 LOCAL 会话 `executionUserId` 为触发人，会话 owner 创建的规则对其不生效（方向安全）；桌面普通会话两者恒一致。

## 9. 落地清单

- [ ] V135（表 + `approval-rule:read` 权限码 + denylist 设置种子）
- [ ] `ApprovalRuleService`（归一化 / denylist / 匹配 / 计数）
- [ ] 判门接入（档位准入）+ `approvalMark` rule 分支（backend/desktop 类型同步）+ ToolCallCard 徽标
- [ ] `LocalToolExecutor.execute` hint 参数 + `tool_execute.approvalHint` + registry hint 存储与双 unregister 清理 + `tool_approval.alwaysAllow`（查重后建）
- [ ] desktop 第三按钮 + preload 签名扩展 + 设置页 ApprovalRulesView
- [ ] `/v1/admin/approval-rules` + admin 只读页（挂"安全"分组）
- [ ] 会话删除级联 + 规则管理审计
- [ ] CHANGELOG + skills/mao-cli 同步 + proposals 状态更新

## 10. 决策记录（相对提案的修正与确认）

1. **READ_ONLY 档规则免疫**：提案只说"规则不可越过评险红线"；本方案把边界前移——READ_ONLY 的写/shell/MCP 审批是执行边界本身，规则在该档完全不参与判门。
2. **SHELL_PREFIX 定为"前两 token"**：单 token（`git`）过宽、完整命令粒度太碎；两 token（`git push`、`npm run`）是命令语义最小单元，配合 denylist 全命令扫描兜底。
3. **hint 服务端生成与存储，客户端只回传布尔**：`tool_approval` 帧若允许携带 pattern，等于把放行模式的决定权交给渲染层（可被篡改）；后端按 requestId 取回自己生成的 hint，alwaysAllow 只是确认位。
4. **规则优先于 Jev/DangerAssessor/ProxyApprover**：用户明示意图 > 模型推测；命中即短路，PROXY 的代批 LLM 不再运行，"AI 拒绝"在规则命中时不存在——此前"AI 拒绝优先于规则"的表述与短路收益互斥（二者不能同时成立，评审已修正，取短路）。拒绝优先于放行的不对称性由 denylist 承担：denylist 高于规则，命中 denylist 的请求规则失效、照常弹卡。
5. **`approvalMark.mode='rule'` 复用既有徽标管线**：metadata 键、ws 透传（`ws-streaming-event-listener.ts` L126）、ToolCallCard 渲染全部现成，只加 mode 分支，不新造留痕通道。配套类型扩散：backend `ToolApprovalMark.mode` 联合加 `'rule'`、desktop `types/chat.ts` 同步、`DispatchOutcome` 增 approvalMark 直通位（不经 `llmVerdict.via` 推导）。
6. **MCP 只做工具级**（提案的开放问题收口）：MCP 参数 schema 千差万别且 server 可变，参数模板的归一化不可靠；工具全名精确匹配是唯一无歧义粒度。
7. **规则放行不写 audit_log**：放行事实已随 tool 消息 metadata 持久化（会话内可查），audit_log 只记规则管理动作；避免双写不一致。
8. **`approved` 入站字段继续不读**：deny/execute 的真实事实由 `tool_result`/`tool_error` 承载（现有设计），本方案只增量消费 `alwaysAllow`，不重构审批确认链路。
9. **denylist 进 system_setting 而非硬编码**：admin 可按实例环境增删（如内网加 `kubectl`），种子迁移给默认值。admin 系统设置页按 category 兜底渲染，`审批` 分组已声明（V127 先例），`approval.rule.denyTokens` 无需新增管理界面。
10. **砍掉 PATH_PREFIX（评审修正）**：write_file/edit_file 仅在 READ_ONLY 档审批，而 READ_ONLY 档规则免疫（决策 1），路径前缀规则在任何档位都不可能生效，保留即死类型；文件类规则待未来出现"非 READ_ONLY 档审批写操作"的档位语义再引入。
11. **档位准入：仅对"本来需要审批"的调用查规则（评审补充）**：先做同步的档位×工具类判断再查库——READ_ONLY/FULL 完全跳过，READ_WRITE/SMART/PROXY 仅 shell/MCP。否则 FULL/READ_WRITE 下的写操作也会命中规则、打 `rule` 徽标并计数，与"FULL 无行为差异"矛盾且污染 hit_count 口径（口径 = 真实省掉的审批次数）。
12. **alwaysAllow 建规则做应用层幂等（评审补充）**：表无唯一键，`tool_approval` 帧断线重试可能重发，创建前按 `(session_id, rule_type, rule_value)` 查重，同值只建一条。

## 11. 验收口径

1. LOCAL + SMART 档下反复执行 `npm test`：第一次弹卡（含"总是允许以 npm run 开头的命令"第三按钮），点击后本轮执行；第二次起同前缀命令静默放行，ToolCallCard 显示"规则放行"徽标；`rm -rf x` 始终弹卡且无第三按钮。
2. 设置页可启停/删除规则；禁用后立即恢复弹卡；命中次数（= 真实省掉的审批次数）与最近命中时间正确。
3. READ_ONLY 档下 shell 即使有 SHELL_PREFIX 规则仍弹卡（规则免疫）；FULL 档无规则徽标、无规则查询。
4. admin"安全"分组可见全用户规则清单（只读）；普通用户访问 admin 端点 403。
5. 删除会话后其会话级规则消失；用户级规则跨会话持续生效。
6. 全量 `cd backend-ts && npm test` 通过，新增 spec 覆盖 §7 全部用例。
