# 提案：业务词典（Business Glossary）—— 让「推单 / 佣金 / 出货额」有定义、有口径、有数据源

> 用户说的不是术语，是团队的黑话；Agent 缺的不是智力，是一本共同的词典。
>
> 这里的「团队」不需要新建组织模型：同一个实例里的所有 Agent 共用一本业务词典，一次校准对所有人同时生效。

- 状态：已否决（2026-10-24），存档勿再评审
- 日期：2026-10-24
- 提案总览：见 [docs/proposals/README.md](README.md)
- 规模：中（新域 + 管理后台词典页 + 一个查询工具 + 消息侧注入）
- 关联：`harness-service` 上下文装配、`PromptEngine`、`ascm-cli` / `vtn-biz-cli` / `bigdata-cli` 业务技能、`ask_user_questions`

## 1. 背景与现状

### 1.1 用户的指令是模糊的，但模糊里带着业务关键词

团队真实输入很少是「查询 access_cdm 表里本月按渠道的 pmt_gmv」，而是：

- 「看下这个月**出货额**」
- 「帮我查下**佣金**」
- 「这批订单**推单**了吗」
- 「**推单**一下这几个 W 单」

这些词在团队里有明确含义，但对 Agent 不是：

- **推单** 既可能是「查推单状态 / 推单号」，也可能是「执行在仓订单提前创建推单」——后者是 `ascm-cli` 里**唯一的写操作**，有货权转移、拦截/风控/冻结等前置条件，猜错代价很大。
- **佣金** 可能是经销商佣金计算（`vtn-biz-cli finance calculate`）、推广佣金流水（`revenue money`）、代理服务费（`revenue grow`）、虚拟币收益（`revenue ntx`），也可能是腾炬服务商的市场补贴/出货返点（`tengju provider jump-points`）。
- **出货额** 在 `bigdata-cli` 里对应不同指标：`pmt_gmv`（支付金额）与 `act_pmt_gmv`（实际成交销售额，受指标权限管控）；同义问题落到不同表，数字会对不上。`bigdata-cli` 的 SKILL.md 自己就记录了这个教训：「各渠道本周成交金额」和「按渠道看本周 GMV」取了两张不同的表。

### 1.2 今天 Agent 靠什么理解这些词

- **技能文档**：`ascm-cli` / `vtn-biz-cli` / `bigdata-cli` 的 SKILL.md 写得非常细，但它是「命令手册」，不是「术语表」；模型要读完大段文档才知道「推单」有几种含义、默认口径是什么。
- **Agent 经验**：`agent_experiences` 是 300 字以内的自然语言提示，可以写「推单默认指提前推单」，但它不可检索、不可结构化、不能绑定数据源与默认参数，也无法驱动澄清。
- **长期记忆**：记的是用户偏好与项目事实，不是团队共用的业务术语；同一个词在不同用户那里可能是不同意思。
- **模型常识**：对「GMV」「佣金」有通用理解，但对「VTN 推单」「腾炬出货返点」这种内部黑话没有。

结果是：同一个词，不同 Agent、不同用户、不同时间会得到不同解释；用户要反复补充「不是这个推单」「按含税」「按渠道」，Agent 才慢慢对齐。

### 1.3 为什么现在做

- 业务技能已经足够多（ASCM、VTN、大数据、DAMA 等），Agent 的瓶颈从「没有工具」变成「不知道用户指的是哪个工具/口径」。
- 这些术语是**稳定的、可枚举的、有明确数据源的**，适合做成结构化词典；不需要向量库、不需要把整个知识库灌进提示词。
- 词典是「越用越懂」的地基：没有它，解析和澄清学习都没有可对齐的锚点。

## 2. 目标 / 非目标

**目标**

1. 新增一等对象 **业务术语（Business Term）**：标准名、别名、定义、口径/公式、单位、数据源、默认参数、必填槽位、澄清选项、读写属性、负责人、状态。
2. 一个术语可以有多条**含义（Meaning）**，每条含义独立绑定数据源与默认值，解决「推单」「佣金」这类一词多义。
3. 管理后台提供**词典管理页**：增删改查、别名、含义、预览检测、导入导出、启停、负责人。
4. Agent 侧提供 `business_term_lookup` 工具；消息进入执行前，按别名**只注入命中的术语卡**，不把整本词典塞进系统提示词。
5. 术语卡明确标注「数据源 / 读或写 / 默认口径 / 必填槽位」，让模型在选命令前先对齐语义。
6. 词典可版本化、可审计；所有修改走管理员权限与既有审计。

**非目标**

- 不做团队共享记忆 / 知识库：不存自由文本记忆、不做用户经验提案、不做文档切片；只存结构化术语。
- 不做 RAG / 向量检索：检测是别名精确匹配 + 简单归一化，不建 embedding 设施。
- 不自动生成技能或命令：词典只指向已有技能/CLI/工具，不产出 `SKILL.md`、不改技能目录。
- 不做自动学习：P1 只支持人工维护；从追问/纠错中学习放到[术语学习](2026-10-24-term-learning.md)。
- 不做意图解析与澄清策略：P1 只把「这个词可能是什么」摆给模型；选哪个含义、问不问，放到[模糊指令解析](2026-10-24-intent-resolution.md)。
- 不做业务口径的自动校验（数字对账、报表核验）；那是另一个方向。

## 3. 与已否决方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 团队知识层（2026-10-19 否决） | 不新增 TEAM 记忆 scope、不存自由文本、不做用户提案；词典是管理员维护的结构化配置，字段固定、可审计 |
| RAG / 知识库（2026-10-02、10-05 否决） | 不建文档库、不切块、不做向量检索；只按别名匹配结构化术语记录 |
| 技能蒸馏（2026-10-11 否决） | 不生成可执行技能、不改文件、不做试跑；最多在 `data_source_json` 里引用已有技能命令 |
| 任务模板 / Runbook（2026-10-19 否决） | 不保存提示词模板、不做一键建任务；只定义术语含义与默认参数 |
| 经验资产化（本日已驳回） | 经验是自由文本提示；词典是结构化契约，字段固定、可被程序读取、可绑定数据源 |

## 4. 技术方案

### 4.1 数据模型（迁移按实施顺序顺延，当前最新 V168）

```sql
CREATE TABLE `business_term` (
  `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
  `canonical`   VARCHAR(64)  NOT NULL COMMENT '标准名，如 出货额',
  `normalized`  VARCHAR(64)  NOT NULL COMMENT '归一化名（去空格/全半角/大小写），唯一',
  `definition`  VARCHAR(512) NULL COMMENT '一句话定义',
  `examples_json` JSON       NULL COMMENT '模糊指令示例，如 ["看下这个月出货额"]',
  `status`      VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE/DEPRECATED',
  `owner_id`    BIGINT       NULL,
  `version`     INT          NOT NULL DEFAULT 1,
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_term_norm` (`normalized`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='业务术语';

CREATE TABLE `business_term_alias` (
  `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
  `term_id`    BIGINT NOT NULL,
  `alias`      VARCHAR(64) NOT NULL COMMENT '别名/黑话/缩写/常见错写',
  `normalized` VARCHAR(64) NOT NULL,
  `weight`     INT NOT NULL DEFAULT 100 COMMENT '命中权重，处理别名冲突',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_alias_norm` (`normalized`),
  KEY `idx_alias_term` (`term_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='业务术语别名';

CREATE TABLE `business_term_meaning` (
  `id`                  BIGINT PRIMARY KEY AUTO_INCREMENT,
  `term_id`             BIGINT NOT NULL,
  `label`               VARCHAR(64)  NOT NULL COMMENT '含义名，如 提前推单 / 查推单状态',
  `definition`          VARCHAR(512) NULL,
  `formula`             VARCHAR(512) NULL COMMENT '口径/公式，如 含税出货金额',
  `unit`                VARCHAR(32)  NULL COMMENT '元 / 单 / 件',
  `mode`                VARCHAR(16)  NOT NULL DEFAULT 'READ' COMMENT 'READ/WRITE，写操作必须显式确认',
  `data_source_json`    JSON         NULL COMMENT '{skill,command,reference,tool,table}',
  `defaults_json`       JSON         NULL COMMENT '{timeRange,tax,dimension,...}',
  `required_slots_json` JSON         NULL COMMENT '["timeRange","dimension"]',
  `clarify_options_json` JSON        NULL COMMENT '每个槽位的候选选项',
  `priority`            INT          NOT NULL DEFAULT 100 COMMENT '同词多义时的默认排序，越小越优先',
  `status`              VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  `created_at`          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY `idx_meaning_term` (`term_id`, `status`, `priority`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='业务术语含义（一词多义）';
```

**样例（推单）**

```json
{
  "canonical": "推单",
  "aliases": ["推单", "推仓", "提前推单", "提前推仓", "推单号"],
  "meanings": [
    {
      "label": "执行提前推单",
      "definition": "对在仓订单执行 ASCM「在仓订单-提前创建推单」，触发货权转移并生成 P 单",
      "mode": "WRITE",
      "priority": 20,
      "data_source": { "skill": "ascm-cli", "command": "push early-push plan|execute", "reference": "reference/push-order.md" },
      "required_slots": ["orderNos", "confirm"],
      "clarify_options": { "confirm": ["先预检", "确认执行"] }
    },
    {
      "label": "查推单状态",
      "definition": "按 W 单/推单号查询推单是否生成、推单号、货权转移与物流状态",
      "mode": "READ",
      "priority": 10,
      "data_source": { "skill": "ascm-cli", "command": "push early-push status / order push-order-2c" },
      "defaults": { "timeRange": "LAST_7_DAYS" },
      "required_slots": ["orderNos"],
      "clarify_options": { "orderNos": ["提供 W 单号", "查最近 7 天推单"] }
    }
  ]
}
```

**样例（出货额）**

```json
{
  "canonical": "出货额",
  "aliases": ["出货额", "出货金额", "出库额", "发货额", "GMV"],
  "meanings": [
    {
      "label": "支付金额口径",
      "definition": "按订单支付时间统计的 GMV（pmt_gmv）",
      "unit": "元",
      "mode": "READ",
      "data_source": { "skill": "bigdata-cli", "table": "access_cdm.dmd_index_managerial_report_goods_dd_f", "metric": "pmt_gmv" },
      "defaults": { "timeRange": "THIS_MONTH", "timeField": "order_paid_at" },
      "required_slots": ["timeRange"],
      "clarify_options": { "timeRange": ["本月", "上周", "近 7 天"] }
    },
    {
      "label": "实际成交销售额口径",
      "definition": "act_pmt_gmv，受指标权限管控；无权限时需说明并改用可用口径",
      "unit": "元",
      "mode": "READ",
      "data_source": { "skill": "bigdata-cli", "table": "access_cdm.dmd_index_managerial_report_goods_dd_f", "metric": "act_pmt_gmv" },
      "defaults": { "timeRange": "THIS_MONTH" }
    }
  ]
}
```

### 4.2 词典索引与消息侧注入

**不在系统提示词里放整本词典**：术语会持续增长，全量注入会让每个 Agent 的提示词变长、缓存失效、注意力被稀释。采用「按消息命中注入」：

1. 后端启动时把 `business_term` + `alias` + `meaning` 装进进程内索引（别名归一化 → term ids），按 `version/updated_at` 或 60s TTL 刷新。
2. `HarnessService.buildContext` 装载完历史后，取**最新一条真实用户消息**的可见文本（多模态消息用现有 `extractVisibleText`），做别名匹配。
3. 命中术语时，拼一张紧凑的 `<business-terms>` 卡片，作为**不落库的 ephemeral system message** 追加到本次上下文；不命中则零注入、零额外 token。
4. 卡片上限：最多 5 个术语 / 1.5KB；超出按命中权重截断，并在卡片里标注「其余术语可用 `business_term_lookup` 查询」。
5. 术语卡只给「候选含义 + 定义 + 默认值 + 数据源 + 读写属性」，不替模型做最终选择；选择与澄清由[模糊指令解析](2026-10-24-intent-resolution.md)负责。
6. **旁路调用跳过**：压缩、标题生成、记忆抽取等非用户执行的 `buildContext` 不注入；只处理真实用户消息触发的主执行与边路任务。

卡片示例：

```
<business-terms>
命中业务术语（来自团队词典）：
- 推单：可能含义
  1) 执行提前推单（WRITE，ascm-cli push early-push；需 orderNos + 明确确认；先预检再执行）
  2) 查推单状态（READ，ascm-cli push early-push status；默认近 7 天）
- 出货额：可能含义
  1) 支付金额 pmt_gmv（默认本月；bigdata-cli）
  2) 实际成交销售额 act_pmt_gmv（受权限管控）
使用要求：涉及 WRITE 含义时，先向用户确认订单范围与执行意图，不要直接执行。
</business-terms>
```

**前缀缓存**：卡片追加在用户消息之后、历史前缀不变；同一会话内不同消息的卡片可能不同，但只影响尾部，不影响系统提示与工具目录的缓存。卡片不落库，刷新后不重放；需要复现时看 `business_term_lookup` 的调用记录与解析日志。

### 4.3 `business_term_lookup` 工具

```ts
business_term_lookup({ term: string })
```

- 按标准名/别名精确或归一化匹配，返回完整术语卡（全部含义、口径、默认值、数据源、澄清选项、示例）。
- 卡片里未展开的术语、或用户追问「这个词到底怎么定义」时使用。
- 返回结果带 `termId / meaningId / version`，便于[术语学习](2026-10-24-term-learning.md)做归因。
- 工具接入按 `AGENTS.md` 同改：`tool-result-summarizer.ts`、`desktop/src/utils/toolDisplay.ts`、`no-progress-notice.ts` 的 `VOLATILE_RESULT_KEYS`（termId/version 属易变字段），并补成功/未命中/缺参回归测试。

### 4.4 管理后台

- 新页面「业务词典」（`/admin/glossary`）：
  - 列表：标准名、别名数、含义数、读/写、负责人、状态、更新时间；按名称/别名/技能搜索。
  - 编辑：基本信息、别名标签、含义列表（label/定义/口径/单位/读写/数据源/默认值/必填槽位/澄清选项/优先级）、示例。
  - **预览检测**：输入一段用户话术（如「这批 W 单推单了吗」），实时显示命中的术语、含义与卡片渲染结果，保存前就能验证。
  - 导入/导出 JSON；启停/废弃；修改走既有审计拦截器。
- 权限：新增 `glossary:read` / `glossary:write`（迁移写权限表，默认授系统管理员）；Agent 运行时只读。
- 版本：P1 用 `version` 自增 + 审计日志；P2 增加术语历史与回滚（复用 `agent_prompt_versions` 的交互形态，不新建复杂版本链）。

### 4.5 隐私与安全

- 词典不存用户对话，只存术语定义与示例；示例由管理员编写或脱敏后录入。
- `data_source_json` 只做指引，不存凭据；Agent 仍走既有技能/CLI 的权限与审批，词典不会绕过任何审批。
- `mode=WRITE` 的含义必须在卡片里显式标注；P2 由解析器对写操作做语义确认（见下一份提案），P1 至少让模型看到「这是写操作」。
- 别名可能包含内部黑话/客户名；`glossary:read` 控制可见范围，管理后台不对外暴露。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | 三表 + 管理后台 CRUD + 别名/含义编辑 + 预览检测 + 进程内索引 + 消息侧注入 + `business_term_lookup` | 8-10 人日 |
| P2 | 导入/导出、术语历史与回滚、按 Agent 绑定/覆盖、命中统计（哪个词最常被问） | 5-7 人日 |
| P3 | 从业务技能文档草拟术语候选（人工确认）、别名冲突检测、按团队/渠道的词典视图 | 4-6 人日 |

**改动面（P1）**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 后端 | 新域 `backend-ts/src/glossary/`（repository / service / routes / catalog / resolver-lite） | 术语 CRUD、索引、消息匹配、卡片渲染 |
| 后端 | `harness/core/harness-service.ts` | 历史装载后调用 resolver-lite，追加 ephemeral system message |
| 后端 | `harness/tool/impl/business-term-lookup-tool.ts` + 工具注册/摘要/展示 | 查询工具 |
| 管理后台 | 新 `views/glossary/GlossaryView.vue` + router + 权限 | 词典管理、预览、导入导出 |
| 迁移 | `V169__business_glossary.sql` | 三表 + 权限码 |
| 文档 | `CHANGELOG.md` / `skills/mao-cli/` / `USER_GUIDE.md` | 词典使用与维护说明 |

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| 别名冲突（同一个词指多个术语） | 中 | 检测返回多个候选，按 weight/优先级排序；不在词典层强行裁决 |
| 词典膨胀导致卡片过大 | 中 | 单次最多 5 个术语 / 1.5KB；超出只给摘要 + lookup |
| 管理员维护成本 | 中 | P1 只录高频词（推单/佣金/出货额等）；预览检测降低录入错误；P3 草拟候选 |
| 卡片被模型忽略 | 中 | 卡片放在用户消息之后、带明确「使用要求」；解析器（提案二）再做一次强制对齐 |
| 术语口径变化 | 中 | 版本 + 审计；P2 历史回滚；解析日志可追到 version |
| 内部黑话泄露 | 中 | `glossary:read` 控制；示例脱敏；不存用户原文 |
| 写操作被误触发 | 高 | `mode=WRITE` 显式标注 + 卡片要求确认；既有工具审批/权限仍然生效，词典不绕过 |
| 多实例索引不一致 | 低 | 按 version/TTL 刷新；P2 加版本号校验 |

**待确认决策**

1. 词典是全局一份，还是按 Agent 绑定不同子集？建议 P1 全局一份、按命中注入；P2 再支持 Agent 覆盖。
2. 是否允许普通用户查看词典？建议 P1 仅管理员 + `glossary:read`；普通用户通过 Agent 的回答感知。
3. 术语示例是否允许粘贴真实用户原话？建议默认脱敏/改写，不存原话。
4. `mode=WRITE` 的术语是否必须配置确认选项？建议是，缺少确认选项不允许保存。
5. 是否把「业务词典」放进 mao-cli/管理后台的哪个导航？建议管理后台一级菜单「业务词典」，与 Agent 管理并列。

## 7. 测试要点

- 迁移与权限：三表创建、默认值、唯一键；`glossary:read/write` 种子与角色绑定；重复迁移幂等。
- 索引：别名归一化（全半角/空格/大小写）；别名冲突返回多个术语；词条更新后索引刷新；删除/废弃后不再命中。
- 注入：命中 1/3/8 个术语时的卡片内容与截断；无命中零注入；多模态消息只取可见文本；卡片不改写历史消息。
- 工具：精确/归一化命中、未命中、缺参、超长 term；`termId/meaningId/version` 返回正确；结果摘要与前端展示。
- 管理后台：CRUD、别名/含义保存校验、`mode=WRITE` 必须有确认选项、预览检测结果与运行时一致、导入导出往返一致。
- 安全：无 `glossary:write` 不能改；Agent 运行时不因词典绕过工具审批；WRITE 卡片必须出现「写操作/需确认」。
- 回归：系统提示词字节在无命中时不变；有命中时只多一条 ephemeral message；前缀缓存与工具目录不受影响。

## 8. 验收标准与观察指标

**验收**

1. 录入「推单」「佣金」「出货额」三条术语（含一词多义），在管理后台预览「这批 W 单推单了吗」能命中「查推单状态」而非「执行提前推单」的候选，卡片正确渲染。
2. 用户发「看下这个月出货额」，Agent 上下文中出现 `pmt_gmv` 与 `act_pmt_gmv` 两个候选、默认本月、来源 `bigdata-cli`；Agent 不再直接猜一张表。
3. 用户发「推单一下这几个 W 单」，卡片标注 WRITE、要求确认；Agent 先预检/确认，不直接执行。
4. 无命中消息的请求体与改动前逐字节一致（除时间戳等既有差异）。
5. 无 `glossary:write` 的账号看不到编辑入口、接口 403。

**指标（上线后 8 周）**

- 高频术语（推单/佣金/出货额等）的命中率与 lookup 调用次数；
- 含术语消息的首次回答接受率、追问次数；
- 因「理解错术语」导致的失败/点踩占比；
- 词典条目数、别名数、管理员维护时长（定性）。
