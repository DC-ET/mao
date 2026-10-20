# 提案：自定义 HTTP 工具（懒加载集成）—— 填个表单连内部系统，按需展开不进上下文

- 状态：**已确认**（2026-10-19 评审通过，决策记录 6 条于 2026-10-19 逐条确认；2026-10-20 方案二修订执行位置与审批口径——`http_call` 进 `SERVER_ONLY_TOOLS`，全模式无审批门。技术方案见 [../plan/2026-10-19-custom-http-tools-technical-design.md](../plan/2026-10-19-custom-http-tools-technical-design.md)）
- 日期：2026-10-19
- 提案总览：见 `docs/proposals/README.md`

> 设计说明：本提案初版把自定义工具作为全量 schema 注入 `tools` 数组的一等工具；按 2026-10-19 评审意见重写为 **MCP 工作集同款懒加载形态**——提示词里只放紧凑目录，参数 schema 按需 describe，调用经单一通用入口。初版全文存档于 git 历史，勿按初版实施。
>
> 2026-10-20 修订：执行位置与审批口径改为**方案二**——`http_call` 进 `SERVER_ONLY_TOOLS`，全模式后端直连、无审批门，与 `web_search` / `send_wechat_image` 同口径；原目标 3 的审批门与「总是允许」规则作废。详见技术方案 §9.3。

## 1. 背景与现状

「让 Agent 连我的内部系统」今天只有一个答案：**跑一个 MCP server**。

MCP 接入本身做得不浅——0.0.309 落地了工作集模式：会话不再把每台 server 的全部工具 JSON Schema 注入 `tools` 数组，改为系统提示新增「MCP 工作集」分节只列 server 名、用途、工具名与只读标记，模型不确定参数时先调 `mcp_describe(server, tool)` 取 schema、再调 `mcp_call(server, tool, arguments)` 执行。**这套懒加载模式已经受过生产检验**，但它服务的是「有 MCP server」的用户。

对自托管平台的典型用户，门槛在 MCP 之外：

1. **要有一个常驻进程**。MCP server 要么 stdio（平台侧管理进程生命周期）、要么 HTTP（用户先要找台机器跑着）。「我就想让公司的工单 API 能被 Agent 查」这个需求，今天的答案是「你先写个 server、部署、配到平台」——对非开发用户是一堵墙，对开发用户是一下午。
2. **数据库里没有任何「工具定义」**。对照：渠道有 binding 表、模型有价格配置、审批有规则表、哨兵有 watcher 表——**唯一不能由用户数据定义的，恰恰是工具本身**。
3. **但全量注入确实是死路**：一个用户十几个自定义工具，每个 JSON Schema 数百 token，直接撑爆上下文——这正是 MCP 工作集当初要解决的问题。懒加载不是可选项，是前提。

相邻方向的边界：

- **不是替代 MCP**：MCP 是协议与生态（状态、资源、订阅、双向），自定义工具是「零基础设施的声明式 HTTP 包装」。产品文案：先试自定义工具，不够再上 MCP。若评审认为必须二选一，本提案让位。
- **不是全量注入的 Agent tool**（初版方向，已否决）：不进 `tools`` 数组、不生成 per-tool JSON Schema 注入——这是本提案与初版的根本分界。
- **不是低代码集成平台**（不是 Zapier / 集简云）：一个定义 = 一次 HTTP 调用，无可视化编排、多步流、数据映射画布。
- **不是出网边界方案**（已否决）：不管「Agent 能访问什么」，只管「用户声明的工具怎么被安全地调用」；SSRF 做最小基线（见风险）。
- **不是技能（skill）**：技能教模型怎么做（提示词 + 参考文件），工具替模型做（执行能力），prompt 里不同分节。

## 2. 目标 / 非目标

**目标**

1. **工具定义（用户级）**：设置页「我的工具」声明——名称、描述（给模型看的用途）、HTTP 端点（URL + method）、参数（名 / 类型 / 必填 / 说明 / 默认值）、请求头（含密钥，AES-GCM 加密 + 掩码回显，对齐 MCP env 口径）、请求体模板（`{{参数名}}` 占位）、超时。落表 `user_tool` + `user_tool_param`，属主隔离，per-tool 启停（对齐 `user_mcp_preference` 模式）。
2. **工作集式懒加载（宪法）**：
   - 系统提示词新增「自定义 HTTP 工具」分节——**只列名称 + 用途描述 + 方法 + 只读标记**，形态对齐既有「MCP 工作集」分节，不列参数 schema；
   - 条件注册两个通用工具：`http_describe(tool)`（返回该工具的参数 schema，模型不确定参数时调用）与 `http_call(tool, arguments)`（执行，参数为 JSON 对象）——**与 `mcp_describe` / `mcp_call` 同款分工**；
   - 单用户启用数上限（默认 20，可配），分节紧凑 → 上下文增量有界。
3. **治理三件套对齐 SERVER_ONLY 内置工具**：执行位置（`http_call` 进 `SERVER_ONLY_TOOLS`，后端直连、无审批门，与 `web_search` / `send_wechat_image` 同口径——2026-10-20 方案二修订，技术方案 §9.3；原「审批门 + 总是允许规则」设计作废）；展示层还原（工具卡片显示自定义工具中文名与 `tool` 参数预览，对齐 `mcp_call` 显示 `server.tool` 的模式）；结果摘要（`tool-result-summarizer.ts` 新增 `http_call` / `http_describe` 分支，失败可见，对齐 0.0.308 起「摘要可见失败态」口径）。
4. **执行内核**：超时 / 响应截断（默认 64KB + `truncated` 标记）/ 错误归一化（非 2xx → `{ error }`，对齐 `normalizeToolResult` 判定，失败在轨迹可聚合）；body 模板渲染（纯函数替换，不递归）；headers 解密合并。
5. **安全基线**：URL 仅 http/https；默认禁环回 / 私网 / 云元数据 IP（复用哨兵提案同款 SSRF 判定），管理员可在系统设置显式放行内网段（审计留痕）——自托管访问内网 API 是刚需，默认禁 + 放行是唯一务实解。
6. **试运行**：定义保存前可填参实调一次，看原始响应与截断效果（对齐管理后台模型连通性 / LDAP 测试交互）。

**非目标**

- **不做全量 schema 注入 `tools` 数组**（宪法，评审定调）。
- 不做 OAuth2 授权流（三方登录拿 token）——P1 仅静态密钥头；OAuth 类集成走 MCP server。
- 不做响应 → 结构化数据的映射语言（JSONPath / jq）——P1 原样返回（截断）。
- 不做工具市场 / 社区分享目录——P3 只做文件级导出导入（对齐 skill-bundle 文件搬运）。
- 不做服务端定时抓取（哨兵的领域）。
- 不改 MCP 任何现有行为。

## 3. 方案要点

### 3.1 数据模型（迁移号顺延，当前已到 V160）

```sql
CREATE TABLE IF NOT EXISTS `user_tool` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`      BIGINT NOT NULL COMMENT '属主',
    `name`         VARCHAR(64) NOT NULL COMMENT '工具名（slug：小写字母数字下划线，避开内置与 mcp 命名空间）',
    `display_name` VARCHAR(128) NOT NULL COMMENT '中文展示名',
    `description`  VARCHAR(1000) NOT NULL COMMENT '给模型的用途说明（目录分节展示）',
    `method`       VARCHAR(8) NOT NULL DEFAULT 'GET' COMMENT 'GET/POST/PUT/PATCH/DELETE/HEAD',
    `url`          VARCHAR(1024) NOT NULL COMMENT '端点 URL',
    `headers_json` TEXT NULL COMMENT '固定请求头（敏感值加密存储，脱敏回显）',
    `body_template` TEXT NULL COMMENT '请求体模板，{{参数名}} 占位',
    `timeout_ms`   INT NOT NULL DEFAULT 15000,
    `enabled`      TINYINT NOT NULL DEFAULT 1,
    `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_user_tool_name` (`user_id`, `name`),
    INDEX `idx_user_tool_user` (`user_id`, `enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户自定义 HTTP 工具定义';

CREATE TABLE IF NOT EXISTS `user_tool_param` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `tool_id`     BIGINT NOT NULL,
    `name`        VARCHAR(64) NOT NULL COMMENT '参数名（slug）',
    `label`       VARCHAR(128) NOT NULL COMMENT '参数中文说明',
    `type`        VARCHAR(16) NOT NULL DEFAULT 'string' COMMENT 'string/number/boolean',
    `required`    TINYINT NOT NULL DEFAULT 0,
    `default_value` VARCHAR(500) NULL,
    `sort_order`  INT NOT NULL DEFAULT 0,
    INDEX `idx_user_tool_param_tpl` (`tool_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='自定义工具参数定义';
```

### 3.2 目录分节与两个通用工具

- **目录分节**（prompt-engine，紧邻「MCP 工作集」分节之后，形态对齐）：每行 = `名称（中文名）— 用途描述 [METHOD, 只读|可写]`。空列表不产生分节（对齐记忆分节「为空不渲染」纪律）。
- **`http_describe(tool)`**：返回该工具的完整参数 schema（名 / 类型 / 必填 / 默认值 / 说明）——数据来自 `user_tool_param`，无需模型猜。工具不存在时返回可读错误（对齐 `mcp_describe` 的错误文案风格）。
- **`http_call(tool, arguments)`**：按定义发请求；`arguments` 为 JSON 对象（模型经 describe 或目录描述组装）；参数缺失 / 类型错误返回可读错误引导重试（对齐 `mcp-call-tool.ts` 的「请重新生成参数后重试」口径）；执行记录进活动流与运行轨迹，内层工具名可聚合（复用 admin 运行轨迹的失败率聚合）。
- **执行位置（2026-10-20 方案二修订）**：`http_call` 进 `SERVER_ONLY_TOOLS`（`tool-dispatcher.ts:60-68`），在 LOCAL 委托分支之前短路、后端直连；**无审批门**，与 `web_search` / `send_wechat_image` 同口径，全模式（LOCAL / CLOUD / 渠道 / docker）行为一致。原「审批门 + 展示粒度开放问题」随之作废。

### 3.3 前端

- 设置页「我的工具」卡片（与 MCP 服务器并列）：列表（中文名 / 方法 / 启停）、新建 / 编辑 / 删除 / 试运行 / 导出导入（P2）。
- 定义编辑器：端点 + 请求头键值对（敏感值打码占位）+ 参数动态行 + body 模板 + 超时；试运行抽屉（参数表单 → 实调 → 原始响应 + 截断预览）。
- 管理后台：全站自定义工具只读清单 + 调用统计（按工具聚合次数 / 失败率，复用开放接口调用中心 / 运行轨迹的统计模式）。

### 3.4 权限

- 用户级 CRUD：`/v1/user-tools`（登录态，本人数据）。
- 执行不新增开放暴露面（工具仅会话内被 Agent 调用；开放 API 运行携带用户上下文时语义上「随用户走」，P1 仅交互会话验证，P2 放开——开放问题）。
- 管理侧 `user_tool:read` 只读统计。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 两表 + 定义 CRUD + 目录分节 + `http_describe` / `http_call` 两工具 + 执行内核（截断 / 错误归一化 / SSRF 基线）+ `SERVER_ONLY_TOOLS` 执行位置（无审批门）+ summarizer / toolDisplay / 回归测试 | 中 |
| P2 | 试运行调试台 + 导出导入（原「总是允许」细粒度规则随 2026-10-20 方案二撤销） | 中 |
| P3 | 开放 API / 定时 / 哨兵上下文放开；响应提取语法评估；OAuth 类集成评估 | 小~中 |

## 5. 风险与开放问题

- **与 MCP 的定位混淆**（评审最可能问）：答案写进宪法——MCP「有状态、有生态、要部署」；自定义工具「无状态、零部署、声明式」。
- **SSRF 是真实攻击面**：用户配 URL = 服务端代发请求。基线 = 哨兵同款私网段禁令 + 管理员放行 + 审计。注意 CLOUD 会话本就可经 shell / `open_web_page` 触达网络，本提案不扩大总面，但把「代发」产品化了，安全评审要过一遍（与邮件通知提案无涉——SMTP 是实例级管理员配置，非用户面）。
- **目录分节膨胀**：20 个工具 × 100 字描述 ≈ 2KB，可接受；超限工具描述裁剪 + 启用数上限双保险。前缀缓存影响与 MCP 工作集同类（用户级分节，已被 0.0.309 接受的语义），非新问题类。
- **模型误用**：参数组装错误、或对可写工具的误调用（2026-10-20 方案二后无审批托底）。缓解：describe 按需取 schema + 错误可读 + 目录分节只读标记 + 试运行调试台 + 危险工具保持停用。
- **密钥泄露**：请求头 token 若明文落库 / 回显即泄露。缓解：AES-GCM 加密 + 掩码回显 + 审计不记明文（对齐 MCP env 口径）。
- **开放问题**：审批弹窗的展示粒度——【2026-10-20 随方案二作废，无审批门即无弹窗】。
- **开放问题**：`http_call` 在 LOCAL 会话的执行位置——已定（2026-10-20 方案二）：进 `SERVER_ONLY_TOOLS` 后端直连，与 `web_search` / `open_web_page` 同款，无审批门；LOCAL 不影响执行位置。
- **开放问题**：非交互上下文（定时 / 哨兵 / 开放 API 触发）是否开放自定义工具——P1 只开交互会话。

## 6. 测试要点

- 模型层：CRUD 与属主隔离；slug 唯一与命名空间避让（`mcp__` 前缀保留）；启停。
- 目录分节：启用工具进分节、停用不进；空列表无分节；分节文本稳定性（指纹回归）。
- 工具执行：`http_describe` 返回正确 schema、不存在工具有可读错误；`http_call` GET / POST 路径、body 模板渲染（含参数值自带 `{{` 边界）、headers 解密合并、超时生效、非 2xx → `{ error }` 且摘要可见失败、响应截断与 `truncated` 标记。
- 执行位置：`http_describe` / `http_call` 在 LOCAL / CLOUD 均走 `SERVER_ONLY_TOOLS` 后端直连，不进桌面委托分支、无审批帧（2026-10-20 方案二）。
- 安全：环回 / 私网 / 云元数据 IP 被拒；管理员放行后可访问内网；密钥掩码回显、库内加密、审计无明文。
- 展示链路：summarizer 的 `http_call` / `http_describe` 分支（成功显示中文名 + 关键参数，失败显示 error）；toolDisplay 中文名与参数预览；运行轨迹聚合内层工具名。
- 前端：编辑器保存校验（URL 格式、参数名 slug、body 模板引用未定义参数拒绝）；试运行全链路；导出导入 round-trip（P2）。
- 回归：MCP 与内置工具行为零改动；`llm_call` 计量口径不变；`tools` 数组不含自定义工具全量 schema（断言防回归——宪法级约束的机械保障）。
