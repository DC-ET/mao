# 云端项目名支持中文（Unicode 字母数字）技术方案

- 状态：草案（2026-11-05；D2 / D3 / emoji / D9 已于 2026-11-05 评审定案，其余待确认项见 §9）
- 日期：2026-11-05
- 关联方案：
  - [2026-07-01-cloud-workspace-project-design.md](./2026-07-01-cloud-workspace-project-design.md)（`cloudProjectKey → {userId}/projects/{slug}` 原设计；本方案**只改 slug 字符规则**，路径结构、接口、默认行为均不变）
  - [2026-07-03-cloud-workspace-git-init.md](./2026-07-03-cloud-workspace-git-init.md)（git clone 进 `projects/{slug}`，与用户输入共用同一校验，自动跟随本方案）
  - [2026-10-14-user-runtime-container-isolation-design.md](./2026-10-14-user-runtime-container-isolation-design.md)（用户容器挂载/运行时：中文目录名经 `-v` 进入容器）
  - [2026-10-29-workspace-overview-lifecycle-technical-design.md](./2026-10-29-workspace-overview-lifecycle-technical-design.md)（工作区总览对 `projects/` 一级子目录的删除守卫，中文项目名走同一规则）
- 前置条件（**已落地**）：运行时容器 locale 统一 `C.UTF-8`（0.0.435，commit `a90a3223`，`backend-ts/src/harness/container/container-registry.ts:740` 注入 `-e LANG=C.UTF-8`，`container-registry.spec.ts:111` 断言）。修复前容器 libc 回落 POSIX/C，`wc -m` 把「中文abc」计成 9、`grep -i` 非 ASCII 不匹配——**这是中文项目名进入容器执行层的最大风险项，已消除**；存量容器需重建后生效（env 随 docker run 固化）。

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 项目名 / projectKey / slug | 用户输入的云端项目标识，三者同义：请求字段 `cloudProjectKey`，落库 `session.project_key`，落盘 `{root}/{userId}/projects/{slug}` |
| 白名单校验（现行） | `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/`，仅放行 ASCII 子集，天然免疫路径穿越 |
| 类白名单校验（本方案） | 仍只放行封闭字符集合（Unicode 字母 `\p{L}` / 数字 `\p{N}` / `-` `_`），**不是「禁几个危险字符」的纯黑名单**；集合从 ASCII 扩到 Unicode 字母数字 |

## 1. 需求背景

### 1.1 现状：报错复现链路

| 步骤 | 位置 | 行为 |
|---|---|---|
| ① 用户输入 | `desktop/src/components/chat/WorkspaceConfigFields.vue:46-54`（placeholder `项目名（留空=临时工作区）`，`:49`）、`ChatInput.vue:389` | 原样透传，**前端零校验** |
| ② 提交建会话 | `desktop/src/stores/session/list.ts:521`、`:551-552` 组装 `cloudProjectKey` → `POST /v1/sessions`（`backend-ts/src/session/session.routes.ts:154-171`） | 路由层不校验，透传 service |
| ③ 服务端解析 | `session.service.ts:217-266` `initializeCloudWorkspace()`：existing 模式 `:244`、new 模式 `:253` 调 `CloudWorkspaceResolver.normalizeAndValidate()` | 正则不符 → 抛错 |
| ④ 报错出口 | `backend-ts/src/harness/safety/cloud-workspace-resolver.ts:18-23` | 「项目名称仅允许字母、数字、下划线和连字符，长度 1-64，且必须以字母或数字开头」 |
| ⑤ 前端展示 | `desktop/src/composables/workspace-file-provider.ts:367-430`（错误经 `apiErrorMessage` 透传） | 提交后弹红条 |

即截图中该报错的唯一来源；git 模式（`session.service.ts:230` → `git-url-parser.ts:61` `extractSlug`）与文件域四个只读端点（`file.routes.ts:553`、`:576` `resolveUserProjectWorkspace`，被 `:587/:598/:613/:624` 复用）共用同一校验。

### 1.2 问题

1. **中文用户无法用母语命名项目**：项目名是任务列表分组标签与工作区目录名，ASCII-only 对中文用户不友好（报错即由此产生）。
2. **规则后置到提交才生效**：前端无即时校验，用户填完一整条消息发送才被拒，体验差（本方案顺带修）。
3. **规则口径单一来源缺失**：正则只存在于后端一处，前端无法预校验；一旦放宽字符集，两端必须同源，否则「前端放过、后端拒绝」。

### 1.3 机会

- 容器 locale 风险已消除（0.0.435）；URL / DB / 日志 / 展示四类消费面经核查均对中文无障碍（§2）。
- 校验逻辑集中在 `CloudWorkspaceResolver` 单文件，改动面小；`contracts` 包已有运行时导出先例（`signal.ts` 的 `formatSignalChangeValue` 等，`shared/contracts/src/index.ts:26`），前后端同源有现成模式。
- 存量项目名全部是 ASCII，放宽后**无一失效**，无迁移、无回填。

## 2. 影响评估：放开中文逐项分析

### 2.1 总览

| 层 | 影响点（代码位置） | 中文引入的风险 | 定级 | 处置 |
|---|---|---|---|---|
| 文件系统 | `projects/{slug}` 创建/枚举/删除：`cloud-workspace-resolver.ts:39-43`、`session.service.ts:1665-1682`（`ensureWorkspaceDirectory` / `deleteWorkspaceDirectory`，`rmSync` 整目录）、`workspace-overview.service.ts:98-112` | 255 字节文件名上限；NFC/NFD 双形态 | **中** | 双限长 + 强制 NFC（§2.2） |
| 执行层·容器 | docker `-v` 挂载：`container-registry.ts:349/386/441` 收集工作区、`:450-455` `isMounted`、`container-mount-planner.ts` 生成挂载参数 | 容器 locale（**已修复 0.0.435**）；挂载机制本身对 UTF-8 路径无碍 | 低 | 已落地，无需改动 |
| 执行层·git | clone 目标目录：`git-operation.service.ts:41-45`（`spawn` argv 数组，不过 shell） | git 完整支持 UTF-8 路径；`core.quotepath` 仅影响 `git status` 显示转义 | 低 | 无需处置 |
| 安全 | `normalizeAndValidate`（`cloud-workspace-resolver.ts:10-28`） | 校验模型从 ASCII 白名单扩到 Unicode 类白名单，需穷尽分析放行集合 | **高（设计上）** | 类白名单 + 三层兜底复核（§2.4） |
| 数据 | `session.project_key VARCHAR(256)`（`V009__session_task_fields.sql:27-28`）、`memory_item.project_key VARCHAR(128)` + `dedup_hash=SHA1(scope\|project_key\|content)`（`V129__memory_item.sql`、`memory.service.ts:42-43`）、查询 `session.repository.ts:243-246/251-255` | utf8mb4 容量无虞；`ai_ci` 排序规则下拼音声调变体在查询中相等（已知限制，§2.5） | 低 | 无需处置 |
| URL | 仅 query 参数：`desktop/src/composables/workspace-file-provider.ts:377/393/413/427`（全 `encodeURIComponent`），**无任何地方把项目名用作 URL 路径段或路由参数** | 无 | 无 | 无需处置 |
| 展示 / 日志 | 分组标签 `session-group-key.ts:106-114/138-151`（取 `projects/` 后一段）；日志 `git-operation.service.ts:48/58/62`、`session.service.ts:1669/1680`、`file.routes.ts:191` | 中文标签与日志正常显示，反而更友好 | 无 | 无需处置 |
| 兼容·git | `GitUrlParser.extractSlug`（`git-url-parser.ts:39-62`，`:61` 过同一校验） | 自建 GitLab 中文仓库名（URL percent-encoded，`new URL().pathname` 解码后为中文）自动受益 | 低 | 无需处置，补测试 |
| 兼容·skill | 技能名同款正则 `skill-md.ts:11-13`（注释明确「同时用作同步目标目录名」） | **不同域**，本期不动 | 无 | 明确不改（§4.5） |
| 兼容·系统值 | `weixin-bot`（`weixin/types.ts:119`）、`feishu-{accountId}-private-{userId}` / `feishu-chat-*`（`app-feishu-messaging.ts:78`）、钉钉（`dingtalk/workspace.ts:27/31`） | 与用户项目名共存，集合不重叠（保留字 `projects/sessions` 已防撞） | 无 | 无需处置 |

### 2.2 文件系统层（主要风险，逐项）

1. **单文件名 255 字节上限**（ext4 / APFS 一致）。现行 ASCII 最坏 64 字节无感；中文 3 字节/字 × 64 = 192 字节仍安全；但 CJK 扩展区汉字（U+20000–U+2FFFF，4 字节）与 emoji（4 字节）下「64 个字符」= 256 字节，直接越过上限，`mkdirSync` 抛 `ENAMETOOLONG`，**建会话直接失败**。→ 双限长：码点 ≤ 64（产品口径）且 UTF-8 字节 ≤ 128（§3-D3）。
2. **NFC/NFD 双形态**。macOS 用户从别处复制可能得到 NFD 组合序列（如 `a` +  U+0301）；服务端 ext4 按字节原样存储，两种形态会生成**两个目录、两条 projectKey**（同一视觉项目被劈开）。→ 校验与入库前统一 `raw.normalize('NFC')`，双形态收敛为同一 key（§3-D4）。常用汉字（CJK 统一表意，无分解形式）不受影响，该处置主要覆盖拉丁扩展与用户粘贴场景。
3. **尾随点/空白（Windows 剥离歧义）**。`abc.` / `abc ` 在 Windows 上被静默剥离，跨端同一名字两种目录。现行正则不含 `.` 与空格天然无此问题；新规则继续全局禁 `.`（标点不在放行类），并禁尾随空白（§3-D6）。Windows 保留设备名（CON/PRN/COM1…）是纯 ASCII 且服务端为 Linux，不扩大风险。
4. **大小写不敏感 FS（存量问题，已定不处理）**。macOS APFS 默认大小写不敏感：`MyApp` 与 `myapp` 是两个 projectKey、同一目录——现行规则已允许该组合。CJK 无大小写、简繁体（`台`/`臺`）是不同码点不同目录，中文不引入新问题。→ 已知限制，记录不处理（§9-5）。

### 2.3 执行层（容器 / git）

- **容器 locale**：已修复（0.0.435，`container-registry.ts:740`）。修复前 `wc -m` / `grep -i` / `[[:alpha:]]` 对多字节字符按字节处理；修复后 Bookworm 镜像自带 `C.utf8`，容器 shell 工具链与宿主机（en_US.UTF-8）语义对齐。**注意存量容器需重建才生效**（env 随 docker run 固化，不影响本方案代码路径）。
- **docker `-v` 挂载**：`container-registry.ts` / `container-mount-planner.ts` 把 `{root}/{userId}/projects/{slug}` 原样拼进挂载参数；Docker daemon 对 UTF-8 路径无限制，挂载机制无风险。
- **git clone**：`git-operation.service.ts:41-45` 以 argv 数组 `spawn`（不过 shell，无注入面），git 本身支持 UTF-8 工作树路径。
- **容器内工具链**：Node/Python 等对 UTF-8 路径原生支持；风险集中在 shell 工具的 locale 敏感行为，已由前置修复覆盖。回归测试需覆盖「容器内对中文路径文件执行 `wc -m` / `grep`」（§7-12）。

### 2.4 安全层：校验模型切换（核心设计约束）

- 现行白名单 `[a-zA-Z0-9_-]` 天然排除 `/`、`..`、NUL、控制字符等全部危险输入。
- 新规则**仍保持封闭放行集合**（类白名单）：仅放行 `\p{L}`（Unicode 字母，含 CJK）/ `\p{N}`（Unicode 数字）/ `-` `_`，首字符限字母或数字。路径分隔符 `/` `\`（标点类）、控制字符（Cc）、格式字符（Cf：零宽 U+200B–U+200F、RTL override U+202E、BOM U+FEFF）、符号与 emoji（S 类）、空白（Z 类）**全部不在放行类，天然被拒**。明确**不采用**「枚举禁用危险字符」的纯黑名单，避免穷举遗漏。
- **三层路径兜底不变**（即使项目名校验被绕过也逃不出用户沙箱）：① `assertUnderUserSandbox`（`cloud-workspace-resolver.ts:30-37`）；② `file.routes.ts:554-556` 的 `isUnder` 双保险；③ `workspace-overview.service.ts:307-330` `resolvePersonalPath` 的 segments 白名单（仅一级目录或 `projects/` 一级子目录可操作，`projects` 容器硬拒 `:318-320`）。
- **视觉混淆字符**：零宽 / RTL / BOM 均在 Cf 类被排除（trojan source 面消除）；全角字母（`Ａ` U+FF21，属 Lu）会被放行——与半角是不同的文件名字符串，不构成路径混淆，仅展示层形近，接受（§9-2）。

### 2.5 数据层（无障碍，附一已知限制）

- `session.project_key VARCHAR(256)`：utf8mb4 下 256 字符列容量 = 1024 字节，低于 InnoDB 3072 字节索引上限；64 码点项目名（最坏 4 字节/字 = 256 字符）远小于容量。
- `memory_item.project_key VARCHAR(128)` + `dedup_hash`：同上无虞；SHA1 拼接对中文无差别。
- 等值查询（`WHERE user_id=? AND project_key=?`）：utf8mb4 下中文等值匹配正常。
- **已知限制**：表默认 `utf8mb4_0900_ai_ci`（MySQL 8 默认，accent/case insensitive）下，`café` 与 `cafe` 这类**拉丁声调变体在 DB 查询中相等、在磁盘上是两个目录**——`findActiveByUserAndProjectKey` 理论上可串。对纯中文（无声调折叠）无影响；处置需改列排序规则（`_bin` / `_as_cs`），成本高于收益，本期记录不处理（§9）。

### 2.6 结论

放开中文**可控**：执行层最大风险（容器 locale）已消除；文件系统层两个真实风险（字节上限、NFD）各有一条低成本确定解；安全模型不退化（仍是封闭放行集合 + 三层兜底）；数据/URL/展示层无障碍。主体工作量 = 校验规则重写 + contracts 同源 + 前端即时校验 + 全链路测试，**无 schema 变更、无数据迁移**。

## 3. 技术选型

> D2 / D3 / emoji / D9 已于 2026-11-05 定案（标注「已定」）；其余为默认口径，无异议即随定案执行，有异议走 §9。

| # | 决策点 | 拟定 | 理由 / 备选 |
|---|---|---|---|
| D1 | 总体路线 | **原地放宽字符集**（项目名即目录名，维持一名一目录） | 备选「显示名/目录名分离」（目录仍用 ASCII slug，中文仅展示）最稳但改动大（新增字段、重命名、迁移）；用户诉求是命名自由，原地放宽性价比最高 |
| D2 | 允许字符（**已定**：宽口径） | Unicode 字母/数字 `\p{L}\p{N}` + `-_`；emoji、标点、符号、格式符、空白天然排除 | 放行集合仍是封闭枚举（类白名单，§2.4）。备选「窄口径」仅放行 CJK + 拉丁（排除西里尔/阿拉伯/泰文等），混淆面更小但歧视其他语言用户——已否决 |
| D3 | 长度口径（**已定**） | **双限：码点 ≤ 64 且 UTF-8 字节 ≤ 128** | 码点满足产品「1-64」口径；字节上限兜底 4 字节字符（CJK 扩展区/emoji），128 字节 = CJK 约 42 字、4 字节字 32 个，距 255 上限余量充足。备选 192/200 字节（中文满 64 字）已否决 |
| D4 | 归一化 | 校验与入库前统一 `normalize('NFC')`（trim → NFC → 校验） | 消除 NFD 双形态双目录（§2.2-2）； contracts 与后端共用同一函数，前端提示同源 |
| D5 | 首字符 | 必须是字母或数字（中文开头即合法）；禁止 `-` `_` 开头 | 延续现行「以字母或数字开头」精神，避免 `-x` 被误当命令行参数/隐藏文件风格 |
| D6 | 尾字符 | 禁止尾随 `.` 与空白 | Windows 剥离歧义（§2.2-3）；`.` 本就全局禁止（标点不放行） |
| D7 | 保留字 | `projects` / `sessions` 不变（大小写不敏感比对） | 与目录结构冲突防护，与字符集无关 |
| D8 | 前后端同源 | 校验规则下沉 `shared/contracts/src/project-name.ts`（正则 + normalize + isAvailable + 规则文案常量），后端 `CloudWorkspaceResolver` 与桌面/Web 即时校验共用 | contracts 已有运行时导出先例（`index.ts:26` signal 函数；桌面经 `tsconfig.app.json` paths + `vite.config.ts:34` alias 导入，`SignalWatchersView.vue:298` 为运行时导入先例）；避免两套口径漂移 |
| D9 | `updateProjectKey` 缺口（**已定**：本期修） | `session.service.ts:1495-1498` 补 `normalizeAndValidate`（`PATCH /v1/sessions/:id` 的 `projectKey`，`session.routes.ts:92/378`）；**大小写冲突不处理**，记录为已知限制 | 现状完全不过校验，可写任意字符串入 DB（如 `../evil`），虽被后续文件端点拦截但污染分组键与 memory 键；已 grep 确认桌面/管理后台**无调用点**，补校验零影响。大小写冲突（§2.2-4）为存量问题，本期只记录不处理 |
| D10 | 存量数据 | 无迁移、无回填；已有 ASCII 项目名全部合法 | 新规则是超集；DB 列容量无虞（§2.5） |
| D11 | skill 名正则 | **不动**（`skill-md.ts:11-13` 保持 ASCII slug） | 不同域（技能同步目录名），本期不扩大范围；如未来也要中文需独立评估 |
| D12 | GitUrlParser | 自动跟随（`extractSlug` 复用同一校验），仅补测试 | 自建 GitLab 中文仓库名自动受益；`new URL().pathname` 对 percent-encoded 中文会解码，链路天然打通 |

## 4. 实现步骤

### 4.1 契约（shared/contracts，新增）

`shared/contracts/src/project-name.ts`（新增）+ `index.ts` 导出（照 `signal.ts` 模式导出运行时值）：

```ts
/** 云端项目名（cloudProjectKey / projectKey）校验契约：后端 CloudWorkspaceResolver 与桌面/Web 即时校验共用。 */
/** 类白名单：仅 Unicode 字母/数字 + -_ ；首字符必须字母或数字。路径分隔/控制/格式/符号/emoji 天然排除。 */
export const PROJECT_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;
export const PROJECT_NAME_MAX_CODEPOINTS = 64;
/** UTF-8 字节上限：ext4/APFS 单文件名 255 字节内留余量（兜底 4 字节字符）。 */
export const PROJECT_NAME_MAX_UTF8_BYTES = 128;
export const PROJECT_NAME_RESERVED = ['projects', 'sessions'];
/** 规则文案：后端错误信息与前端即时提示共用同一文本。 */
export const PROJECT_NAME_RULE_TEXT =
  '项目名称仅允许字母、数字、下划线和连字符（含中文），长度 1-64，必须以字母或数字开头，不能以点或空格结尾';

/** trim + NFC 归一化（调用方拿它做展示值与提交值）。 */
export function normalizeProjectName(raw: string): string {
  return raw.trim().normalize('NFC');
}

/** 归一化后是否合法（不含保留字；保留字由使用方按需判断）。 */
export function isValidProjectName(name: string): boolean {
  if (name.length === 0) return false;
  if (!PROJECT_NAME_PATTERN.test(name)) return false;
  if (/[.\s]$/.test(name)) return false; // 尾随点/空白：Windows 静默剥离，跨端目录歧义
  if (new TextEncoder().encode(name).length > PROJECT_NAME_MAX_UTF8_BYTES) return false;
  return true;
}
```

> 保留字判断放后端 `normalizeAndValidate`（前端提示可顺带展示「不能使用保留字 projects/sessions」，不同源也不影响正确性）。

### 4.2 后端：`cloud-workspace-resolver.ts` 重写校验

`normalizeAndValidate` 新流程（L6-L7 常量删除，改 import contracts）：

```ts
normalizeAndValidate(raw: string | null | undefined): string {
  if (raw == null || raw.trim() === '') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '项目名称不能为空');
  }
  const slug = normalizeProjectName(raw);
  if (slug === '.' || slug === '..') {           // 防御性保留：`.` 已不在放行类
    throw new BusinessException(ErrorCode.PARAM_INVALID, '项目名称非法');
  }
  if (!isValidProjectName(slug)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, PROJECT_NAME_RULE_TEXT);
  }
  if (PROJECT_NAME_RESERVED.includes(slug.toLowerCase())) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '项目名称不能使用保留字: ' + slug);
  }
  return slug;
}
```

- 错误码不变（`PARAM_INVALID`），调用方（`session.service.ts:230/244/253`、`git-url-parser.ts:61`、`file.routes.ts:553/576`）零改动。
- `assertUnderUserSandbox` / `resolveProjectWorkspace` 不动。

### 4.3 后端：`updateProjectKey` 补校验（D9）

`session.service.ts:1495-1498`：先过 `normalizeAndValidate` 再落库；语义不变（仍只改 key，不动 `workspace`），仅堵脏值写入。

### 4.4 桌面 / Web 前端：即时校验 + 文案

1. `components/chat/WorkspaceConfigFields.vue:46-54`：输入即时校验（`normalizeProjectName` + `isValidProjectName`，import contracts），非法时红框 + `PROJECT_NAME_RULE_TEXT` 行内提示；placeholder 补「支持中文」。**提交仍放行**（后端是唯一真相，防两端规则漂移时误拦；后端错误照现有 `apiErrorMessage` 透传）。
2. `components/chat/ChatInput.vue:389`：placeholder 同步。
3. 移动端配置行 `ChatMobileConfigRow.vue` 如有同款输入，同步（落地时确认）。

### 4.5 明确不做

- 不做显示名/目录名分离（D1 备选，记录为后续演进方向）。
- 不改技能名正则（`skill-md.ts:11-13`，D11）。
- 不做项目重命名 API / 存量目录迁移工具。
- 不做 Windows 保留设备名兼容层（禁尾随点即可，D6）。
- 无 DB 迁移（D10）；admin 只展示 `projectKey`（`MemoryAuditView.vue:63/114`、`SessionDetailView.vue:88`），不改。

## 5. 落地清单

| 端 / 文档 | 项 |
|---|---|
| contracts | `shared/contracts/src/project-name.ts`（新增：pattern / 限长 / 保留字 / 规则文案 / normalize / isValid）、`shared/contracts/src/index.ts`（运行时导出） |
| backend-ts | `harness/safety/cloud-workspace-resolver.ts`（重写 `normalizeAndValidate`，删本地正则常量）、`session/session.service.ts:1495-1498`（`updateProjectKey` 补校验） |
| desktop | `components/chat/WorkspaceConfigFields.vue`（即时校验 + placeholder）、`components/chat/ChatInput.vue:389`（placeholder）、`ChatMobileConfigRow.vue`（如有同款输入，同步） |
| 测试 | 见 §7 |
| 文档 | 根 `CHANGELOG.md`（后端 / 前端（桌面 / Web）小节）；`skills/mao-cli/SKILL.md`（若文档提及云端项目名规则则同步，当前未提及） |

## 6. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| 放宽字符集意外放行危险字符 | 类白名单（封闭放行集合，§2.4）：`/` `\` NUL 控制符 Cf 格式符 S 符号 Z 空白全部不在 `\p{L}\p{N}` 内；spec 逐类断言拒绝 |
| 4 字节字符击穿 255 字节文件名上限 | 双限长（码点 ≤64 + 字节 ≤128，D3）；spec 断言 4 字节扩展汉字在超限时被拒 |
| NFD/NFD 双形态生成双目录 | 强制 NFC（D4）；spec 断言组合序列与预组合字符归一为同一 key |
| 尾随点/空白跨端歧义 | 全局禁 `.` + 禁尾随空白（D6）；spec 断言 `项目.` / `项目 ` 被拒 |
| 大小写不敏感 FS 上两个 key 一个目录 | 存量问题（§2.2-4），本期不处理；记录于 §9-5，CHANGELOG 不承诺 |
| 两端规则漂移（前端放过/后端拒） | contracts 同源（D8）；提交仍放行、后端兜底，漂移只影响提示不影响正确性 |
| 存量项目名/系统 projectKey 被误伤 | 新规则是超集；spec 回归断言 `my-app` / `agent_workbench` / `weixin-bot` 等仍合法（后者不走该校验，仅防正则劣化） |
| `updateProjectKey` 补校验打断调用方 | 已 grep 确认桌面/管理后台无调用点；spec 补「非法值 400、合法中文落库」 |
| 存量容器 locale 未生效 | 0.0.435 已发布并随 docker run 固化；容器漂移自动重启机制（`container-registry` 既有）会重建容器；联调用新容器验证 |
| git 中文仓库名链路 | `extractSlug` 复用同一校验；spec 补 percent-encoded 中文 URL 用例 |
| 发布顺序 | 纯后端+前端同步改动，无兼容窗口（新规则超集，旧项目名全部合法）；回滚 = 代码回滚，无数据逆运算 |

## 7. 测试要点

**后端（`cd backend-ts && npm test`）**

1. `harness/tool/file-change-diff-util.spec.ts:110-136`（`CloudWorkspaceResolver` describe）扩充：
   - 接受：`我的项目`、`项目-2026`、`项目_01`、`日本語プロジェクト`、`한국어`、`Ünïcödé`、`my-app`、`agent_workbench`（存量回归）；
   - 拒绝：`项目/名`、`a\\b`、`../etc`、`项目.`、`项目 `（尾随空格）、`项\u200B目`（零宽）、`项\u202E名`（RTL）、`项目🎉`（emoji）、`-项目` / `_项目`（首字符）、空串、65 码点、字节 >128（如 33 个 CJK 扩展区汉字 `𠮷`×33）、保留字 `projects` / `PROJECTS`；
   - NFC：组合序列 `'e\u0301'` 与预组合 `'é'` 归一化后为同一 slug、同一目录；
   - `resolveProjectWorkspace` 中文 slug 落在 `/{userId}/projects/{中文}` 且 `assertUnderUserSandbox` 通过。
2. `session/util/session-utils.spec.ts:136-161`（GitUrlParser）：`https://git.example.com/a/%E4%B8%AD%E6%96%87.git` → slug `中文`；`projects.git` 仍拒。
3. `file/file.routes.spec.ts:114-136`：中文 projectKey 的 project-directory/read/search/preview happy path + 非法中文（含 `/`）被拒 + 跨用户 403 不回退。
4. `session.service` spec（新增或扩充）：`updateProjectKey` 合法中文落库；`../evil` / 空串 400；`initializeCloudWorkspace` 中文 slug 建目录成功（现有 new/existing/git 三分支均覆盖）。
5. Flyway：无迁移（确认不新增 V 号；当前最新 V185）。

**前端**

6. desktop 单测（Vitest）：import contracts 测 `normalizeProjectName` / `isValidProjectName`（与服务端同源，边界用例同 §7-1 子集）；`WorkspaceConfigFields` 行内提示显隐（组件测试或 util 测试）。
7. `cd desktop && npm run build`（vue-tsc 验证 contracts 运行时导入与模板改动；勿用 `npx vue-tsc --noEmit` 单文件假通过）。

**手工联调（必须）**

8. 中文项目名建会话 → 目录创建 → 容器内 `ls`/读写/Shell 执行 → 文件树/文件预览 → 分组标签显示中文。
9. 容器内对中文路径文件执行 `wc -m`（计数正确）、`grep -i`（多字节匹配）——locale 回归确认。
10. git 模式 clone 中文仓库名（自建 GitLab 或 mock HTTPS）→ 目标目录为 `projects/{中文}`。
11. 工作区总览删除「项目」条目（`resolvePersonalPath` 删除守卫）对中文项目目录行为不变；`projects` 容器仍硬拒。
12. 非法中文项目名（含 `/`、emoji、超长）在前端即时提示 + 提交后端 400 双口径一致。

**回归**

13. 现有 ASCII 项目名全链路（建会话/文件/容器/git/分组）行为不变；`session-workspace-clone.bugcheck.spec.ts`（clone 失败不删既有项目目录）不回退。

## 8. 发布与文档

1. **CHANGELOG**（根 `CHANGELOG.md` 顶部新建版本小节，版本号取落地时的下一个）：
   - 后端：云端项目名支持中文等 Unicode 字母数字（仅字母/数字/下划线/连字符，长度 1-64，必须以字母或数字开头，不能以点或空格结尾）；`PATCH /v1/sessions/:id` 的 projectKey 补校验。
   - 前端（桌面 / Web）：新建云端任务时项目名行内即时校验与规则提示；placeholder 注明支持中文。
2. **mao-cli**：`skills/mao-cli/SKILL.md` 当前未提及项目名规则，不强制改；如补写，规则文案用 `PROJECT_NAME_RULE_TEXT` 同源。
3. **回滚**：纯代码回滚；无数据变更；已创建的中文目录保留无害（旧版后端拒绝新建但可读旧会话）。

## 9. 开放问题（待讨论，不阻塞主链路）

1. **首/尾字符规则确认（D5/D6）**：「必须以字母或数字开头（中文开头合法）、禁止 `-` `_` 开头、禁止尾随点与空白」——默认认可，无异议即定案。
2. **全角字母放行（形近字符）**：`Ａ`（U+FF21）、`１`（U+FF11）等全角字符属 Lu/N 类会被放行——与半角是不同的文件名字符串，不构成路径混淆，仅展示层形近。是否接受（默认接受）？
3. **`ai_ci` 声调变体**：`café`/`cafe` 在 DB 查询（默认 `utf8mb4_0900_ai_ci`）中相等、磁盘是两个目录（§2.5）。是否改列排序规则（`_bin`/`_as_cs`）？默认不处理。
4. **mao-agent CLI（Windows）**：中文项目名经终端参数/配置文件传递的代码页（936 vs UTF-8）问题是否本期验证（服务端在 Linux，风险仅在本地 CLI 传参）。
5. **大小写冲突**：macOS 大小写不敏感 FS 上 `MyApp`/`myapp` 两 key 一目录——**已定：本期不处理**，仅记录为已知限制，CHANGELOG 不承诺；后续如需处理，最小方案是建目录前 `readdir` 大小写不敏感比对、冲突即拒。
6. **后续演进**：显示名/目录名分离（D1 备选）是否作为独立方案排期。
