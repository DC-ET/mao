# 提案：结构化回复卡片（Structured Reply Cards）—— 让 Agent 的输出从「一段文字」变成「一个界面」

- 状态：**已否决**（2026-10-19 评审：不做，存档勿再评审）
- 日期：2026-10-19
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

今天 Agent 的回复只有一种形态：**markdown 文本**（外加图片 URL 与引用来源区）。

代码事实：

1. **消息内容模型已为多形态预留、但只用了文本和图片**。`common/multimodal-content.ts` 的 `isMultimodalContentParts` 判定 `type` 为 `text` / `image_url` 的 part 数组，LLM 上下文装配（`session-history-loader`）与接口 VO（`session-vo`）共用同一判定——**加第三种 part 类型的管道是现的，只是从来没有第三种**。
2. **「结构化出口」在别的形态里早已成熟，唯独主对话没有**。飞书 / 钉钉出站有 interactive 卡片（进度卡、队列卡、告警卡）；引用溯源（0.0.282）已经证明「模型在文本里埋标记 → 后端校验 → 三端渲染富组件」这条链路走得通；卡片按钮回调（`feishu/card-action.service.ts`）证明「回复里的可点击元素 → 触发动作」也有成熟先例。**这三样能力今天全都锁在 IM 渠道侧**，桌面 / Web / 安卓的主对话反而只有纯文本。
3. **后果是表达力天花板**。Agent 说「三个方案各有利弊」只能写三段文字；说「这是本月开销」只能贴一段 markdown 表格；说「要不要我执行」只能等用户打字。同样内容在 IM 渠道里是卡片 + 按钮，在主对话里退化为文字——**平台自己证明了卡片形态更好，却没给主对话用**。

相邻方向的边界：

- **不是富文本编辑器**：不做用户侧编辑，只做模型输出的结构化渲染。
- **不是低代码页面生成**（不是 Dify / n8n）：卡片是消息内的组件，不是可发布页面；不引入画布与状态管理。
- **不是 Agent 自建 UI 框架**：块类型是平台定义的封闭集合（表格 / 图表 / 文件 / 表单 / 按钮组），模型只能填数据，不能发明新组件——封闭集是可控性与前缀缓存的前提。
- **不是模型对照台**（已否决）：与多模型并排作答无关，是单次回复的富形态。
- **不是 Evals**（已否决）：不评估卡片质量，是用户可见功能。

## 2. 目标 / 非目标

**目标**

1. **块协议（封闭集 v1）**：模型在回复里用围栏代码块声明结构化数据——` ```mao:table `（数据表：列定义 + 行）、` ```mao:chart `（图表：type=bar/line/pie + series，前端 `BaseChart` 渲染）、` ```mao:file `（文件卡片：工作区路径 + 说明）、` ```mao:choices `（选项组：标题 + 选项列表，用户点选后作为下一条消息发送）。每种块的 schema 由后端定义与校验。
2. ** citations 式校验管线**：回复落库前，后端扫描围栏块——schema 合法 → 转成正统 content part（`type: 'table' | 'chart' | 'file' | 'choices'`，扩展 `isMultimodalContentParts` 判定与 VO 序列化）；**不合法 → 降级为纯文本代码块展示**（对齐引用溯源「伪造 URL 一律剥标」的兜底哲学：宁降级不坏渲染）。
3. **三端 + CLI + 分享全渲染**：桌面 / Web / 安卓渲染原生组件（表格、图表复用 `BaseChart`、文件卡片跳文件查看器、选项组点击即发送）；CLI 降级为等宽文本表格；分享快照渲染只读形态（对齐分享视图的既有渲染路径）。历史消息无块即无渲染，零迁移。
4. **交互块（P2）**：`mao:actions` 按钮组——按钮声明一个「建议动作」（如「执行修复」「查看详情」），点击后经既有工具调用链路发起（**走审批门，与用户手动发起完全同权**，对齐卡片回调在飞书的做法：回调只带意图，执行照常受治理）。
5. **提示词契约与预算**：系统提示词增加「结构化输出」分节（何时用哪种块、schema 说明、禁止滥用——默认优先纯文本，数据密集 / 需决策场景才用块）；上下文透视 manifest 的块计数（对齐既有分节统计）。

**非目标**

- 不做开放块类型 / 模型自定义组件（封闭集是宪法）。
- 不做块内交互状态保持（刷新即重渲染，不做前端状态机）。
- 不做图表数据实时刷新 / 下钻。
- 不做表单提交后端直写（P2 的 choices 也只走「作为消息发送」，不直接调工具——actions 按钮才调工具，且受审批）。
- 不改消息编辑 / 分叉 / 分享的既有语义。

## 3. 方案要点

### 3.1 契约扩展（`shared/contracts`）

```ts
// message content part 联合扩展（对齐现有 text / image_url）
export type StructuredBlockType = 'table' | 'chart' | 'file' | 'choices' | 'actions';
export interface StructuredBlockPart {
  type: StructuredBlockType;
  // table: { columns: string[], rows: (string|number)[][] }
  // chart:  { chartType: 'bar'|'line'|'pie', title?: string, labels: string[], series: { name: string, data: number[] }[] }
  // file:   { path: string, label?: string }
  // choices:{ title: string, options: { id: string, label: string }[] }
  // actions:{ buttons: { id: string, label: string, intent: string }[] }  // intent = 建议下一条用户消息
  [k: string]: unknown;
}
```

`isMultimodalContentParts` 的 type 判定扩入五种新 type（LLM 侧装配与 VO 侧共用同一函数，避免 0.0.312 修过的那类口径漂移）。

### 3.2 解析与校验（新模块 `backend-ts/src/session/structured-block.ts`）

- 扫描助手消息文本中的 ` ```mao:<type> ` 围栏（围栏语言精确匹配，模型普通代码块不受影响）。
- 每种 type 一个 schema 校验器（列数一致、数值类型、枚举值、路径存在性——`mao:file` 校验工作区内路径，防越权引用）。
- 合法块从文本中剥出、转为 part；文本剩余部分照常。**全部非法则整条按纯文本**（含原始围栏展示，便于用户发现模型用法错误）。
- 降级路径单测覆盖（对齐 citations 的白名单剥标用例）。

### 3.3 提示词契约（prompt-engine）

「结构化输出」分节（对齐既有「引用契约」分节的做法）：

- 使用场景：≥3 行 × ≥3 列的数据、趋势对比、需要用户在有限选项里决策。
- 默认纪律：优先纯文本；块是补充不是替代；一次回复块数 ≤3（防刷屏）。
- schema 精确定义（放进分节，模型按例填充）。
- **前缀缓存注意**：分节位置固定、内容稳定（schema 不变则指纹不变），对齐既有前缀纪律。

### 3.4 交互（P2）

- `mao:choices`：点击选项 → 该选项 label 作为用户消息发送（零新链路，复用现有发送管道）。
- `mao:actions`：点击按钮 → 以 `intent` 为用户消息发起新回合（等价于用户自己打字发起，**不绕过任何审批与预算**）——这是刻意的保守设计：卡片按钮不构成特权通道， IM 卡片回调「取消 / 重试」那套直接执行动作的模式**不**搬到主对话（那需要额外的授权模型，超出本提案）。

### 3.5 前端

- `MessageBubble` 渲染分支：part 类型分派到四个新组件（`StructuredTable` / `StructuredChart` / `StructuredFileCard` / `StructuredChoices`）；图表复用 `components/common/BaseChart`。
- 分享视图（`ShareView.vue`）：只读渲染全部块类型。
- CLI（`agent-cli`）：ink 渲染器降级——table → 等宽对齐文本，chart → 数据表，choices/actions → 编号列表 + 输入编号选择。
- 上下文透视：块计数入 manifest（「结构化块 N」一行）。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 契约扩展 + 解析校验器（table/chart/file/choices 四种）+ 提示词分节 + 三端 + CLI + 分享渲染 + 降级单测 | 中~大 |
| P2 | `actions` 交互按钮 + 上下文透视计数 + 使用情况统计（哪种块被模型采用最多，管理后台） | 小~中 |
| P3 | 新块类型评估（如 status/timeline/kanban）；图表下钻；块的使用反馈（点踩归因到块类型） | 小 |

## 5. 风险与开放问题

- **模型合规性**：模型可能不用块、或用了不合 schema。缓解：降级兜底保证不坏渲染；提示词分节给正反例；P3 的统计观察采用率再调契约。**这是本提案最大的产品风险**——若采用率低，价值大打折扣；建议 P1 后按采用率数据决定加码或收缩。
- **提示词与指纹**：新分节改变所有会话的系统提示词 → 一次性前缀指纹变化（既有观测会点名，之后稳定）。分节文案定稿后冻结。
- **上下文膨胀**：块数据进上下文（表格 JSON 比文字长）。缓解：块数 ≤3 纪律 + manifest 可见占用；压缩时块 part 按文本截断（对齐既有 8KB 护栏思路）。
- **契约扩散**：五种新 part 类型进入 `isMultimodalContentParts` 共用判定——任何消费方（LLM 装配 / VO / 导出 / 分享）都要认新类型。缓解：共用同一函数 + 每个消费方补用例；导出 JSONL 时原样序列化（结构化数据本就该结构化导出）。
- **与引用源区的重叠**：来源区（citations）是消息尾部的既有组件；块是行内组件，两者位置不冲突，但视觉规范要统一（设计评审一次）。
- **开放问题**：块里的数据是否允许「可编辑表格」（用户改数后重算）——P2 不做，P3 评估（那已接近 mini-app，需谨慎）。
- **开放问题**：CLI 的 choices 交互在 `--print` 非交互模式下降级为文本列表，语义上无歧义，实现时确认即可。

## 6. 测试要点

- 解析：四种块各一组合法样本转 part；schema 各类非法（列数不齐 / 类型错 / 枚举越界 / 路径越权）降级为文本；围栏语言非 `mao:` 的普通代码块不受影响；一条消息多块混合文本。
- 契约：`isMultimodalContentParts` 对新 type 的判定；LLM 装配与 VO 共用口径（对齐 0.0.312 的 bugcheck 思路补回归）。
- 渲染：三端 + CLI + 分享五处渲染；空数据 / 超多行（表格滚动）、图表空 series、文件不存在降级。
- 提示词：分节在系统提示词中的位置与内容稳定（指纹回归）；manifest 块计数。
- 交互（P2）：choices 点击发送；actions 点击发起回合且走审批 / 预算（构造 BLOCK 场景验证不绕过）。
- 回归：无块消息的渲染 / 导出 / 分享零变化；既有 citations 与图片 part 不受影响。
