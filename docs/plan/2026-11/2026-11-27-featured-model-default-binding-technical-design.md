# 特色工具模型：默认模型 + Agent 指定模型（技术方案）

> 2026-11-27。范围延续 [2026-11-27-agent-featured-tools-technical-design.md](./2026-11-27-agent-featured-tools-technical-design.md)；
> 本文只解决「图片 / 语音模型怎么选、默认怎么定」，不重复特色工具本身的配置与门控。

## 0. 结论（TL;DR）

1. **三类模型各自有默认**：`llm_model.is_default` 的含义从「全局唯一默认」改为「按 `model_type` 的唯一默认」；文本默认仍只影响新会话，图片 / 语音默认分别影响对应特色工具与微信语音回复。
2. **Agent 可绑定具体模型**：`agent` 增加 `image_model_id` / `audio_model_id` 两列（可空）。绑定后该 Agent 的 `generate_image` / `edit_image` / `text_to_speech` 使用绑定模型；未绑定则使用该类型的默认模型。
3. **默认解析链**：
   - 已绑定：只认绑定模型；绑定模型被停用 / 删除 / 类型不匹配 → 对应能力不可用（fail-closed，不偷偷换成别的模型）。
   - 未绑定：显式默认（`is_default=1` 且启用）→ 首个启用模型（兼容改造前行为）→ 无可用模型。
4. **运行时统一解析器**：新增 `FeaturedModelResolver`，同时服务「工具是否注入」和「工具执行时取哪个模型」，避免两道门各查一套、口径漂移。
5. **管理后台**：模型管理三页签都可设默认；Agent 特色工具行增加「跟随默认 / 指定模型」下拉。
6. **兼容**：存量 Agent 两列为 `NULL`，行为与当前一致；存量图片 / 语音模型由迁移把「当前实际会用的首个启用模型」标成默认，不改变现网调用结果。

---

## 1. 现状与问题

### 1.1 现状

| 消费方 | 当前取模型方式 | 问题 |
|---|---|---|
| `generate_image` / `edit_image` | `ModelService.findFirstActiveImageModel()` → `findFirstActiveByType('image')`，id 最小 | 无法指定；模型管理也不能标记默认 |
| `text_to_speech` | `findFirstActiveAudioModel()`，id 最小且协议 OpenAI 兼容 | 同上 |
| 微信语音回复 | `findFirstActiveAudioModel()` | 同上；改默认后应自动跟随 |
| 新建会话文本模型 | `findDefault()`，只认 `model_type='text'` + `is_default=1` | 文本默认机制已存在 |

当前 `llm_model.is_default` 在业务上等价于「全局唯一默认文本模型」：

- `ModelRepository.clearDefaultFlag()` 没有类型范围，会把所有类型的 `is_default` 清零；
- `findDefault()` 固定 `model_type='text'`；
- 管理后台模型表单对非 text 类型强制把 `isDefault` 归零（`ModelFormDialog.vue`），模型列表的「默认」筛选只出现在文本页签。

### 1.2 需求

1. 语音模型、文生图模型都要有默认机制。
2. Agent 配置里可选择指定语音模型 / 文生图模型；不选则走默认。
3. 不能破坏现有特色工具门控、调用流水、微信语音回复和文本默认模型逻辑。

---

## 2. 目标与非目标

### 2.1 目标

1. 图片 / 语音模型各有一个默认；设置图片默认不影响文本默认，设置文本默认也不影响图片 / 语音默认。
2. Agent 能指定图片模型和语音模型；未指定时跟随类型默认。
3. 指定模型被停用 / 删除时，对应工具在该 Agent 会话中自动消失，后台表单能看出「绑定的模型不可用」，不出现「表单显示可用、运行时用另一个模型」的错位。
4. 模型删除时清理 Agent 绑定，避免悬空 id。
5. 管理后台、契约、mao-cli 文档、changelog 同步。

### 2.2 非目标

- 不做「按会话覆盖模型」或「用户级模型偏好」；绑定点只在 Agent。
- 不做模型优先级排序 / 负载均衡；默认之外仍是「首个启用」。
- 不做图片 / 语音模型的分项计价、用量配额。
- 不做微信语音回复的 Agent 级模型绑定（本期微信语音只跟随**全局语音默认**；原因见 §8）。
- 不改桌面 / Web / 安卓的模型选择器：`/models/active?scope=client` 仍只返回文本模型。

---

## 3. 语义定义

### 3.1 默认模型

`is_default` 改为 **按 `model_type` 作用域**：

- 文本：`model_type='text'` 中最多一行 `is_default=1`，语义与现在完全一致（新会话默认模型）。
- 语音：`model_type='audio'` 中最多一行 `is_default=1`。
- 图片：`model_type='image'` 中最多一行 `is_default=1`。

约束在应用层保证（同现在的文本默认），暂不加数据库唯一索引：

- 新建 / 更新模型时，若 `isDefault=1`，只清空**同一 `model_type`** 的旧默认；
- 删除默认模型的守卫保留（任何类型默认都不允许直接删，先取消默认或改默认）；
- 停用默认模型：
  - 文本：保留现有「不能停用唯一启用的文本模型」守卫；
  - 图片 / 语音：允许停用。默认标记保留，但解析时要求 `status=1`，停用后自然回退到「首个启用模型」；后台列表仍可显示默认标记（可加「已停用」提示）。

### 3.2 默认解析链

对某个能力（image / audio）：

```
显式默认（is_default=1 且 status=1 且类型/协议匹配）
  → 首个启用模型（status=1，按 id ASC；audio 额外要求 OpenAI 兼容）
  → null
```

「首个启用」是改造前行为，保留它保证未设默认时行为不变。

### 3.3 Agent 绑定

`agent.image_model_id` / `agent.audio_model_id` 可空：

- `NULL` = 未指定，走 §3.2 默认解析链；
- 非空 = 只使用该模型：
  - 模型必须存在（未软删）、`model_type` 匹配；
  - audio 还必须协议为空 / `openai-compatible`；
  - **允许绑定停用模型**（保存不报错），但运行时解析为不可用，对应工具不注入；后台表单提示「已绑定模型不可用」；
  - 绑定模型被软删时，删除动作会主动把 Agent 绑定清成 `NULL`（见 §5.6）。
- 「特色工具未勾选」时绑定仍可保存但处于休眠状态；UI 中对应下拉禁用，保留用户已选值。
- 复制 Agent 时复制两个绑定 id。

### 3.4 显式绑定失效时是否回退默认？

**不回退，fail-closed。** 理由：

- 用户选择「指定模型」是明确意图，静默切换到默认模型可能产生费用、内容风格或协议差异；
- 与现有「模型停用 → 下一次执行自动隐藏工具」一致；
- 后台已在表单上给出「已绑定模型不可用」提示，用户可主动改绑或清空。

> 如果产品更希望「绑定失效自动跟默认」，只需把解析器的 `resolveBound` 分支改为 fallback；建议不要在本期引入该隐式行为。

---

## 4. 数据模型与迁移

### 4.1 `agent` 新增列

迁移 `backend-ts/db/migration/V214__agent_featured_model_binding.sql`：

```sql
ALTER TABLE `agent`
    ADD COLUMN `image_model_id` BIGINT NULL
        COMMENT '指定文生图模型 id；NULL=跟随图片默认模型'
        AFTER `featured_tools`,
    ADD COLUMN `audio_model_id` BIGINT NULL
        COMMENT '指定语音模型 id；NULL=跟随语音默认模型'
        AFTER `image_model_id`;
```

不建外键（与现有 `default_model_id` 口径一致，模型是软删）；可选加普通索引，便于模型删除时反查绑定，当前表规模可不加。

### 4.2 存量图片 / 语音默认回填

同一迁移中：

1. 找出当前「实际会被使用」的模型（保持现网结果不变）：
   - image：`status=1 AND deleted=0 ORDER BY id ASC LIMIT 1`
   - audio：`status=1 AND deleted=0 AND (api_protocol IS NULL OR api_protocol='' OR api_protocol='openai-compatible') ORDER BY id ASC LIMIT 1`
2. 仅当该类型当前没有 `is_default=1` 的行时，把上述行设为 `is_default=1`。
3. 不动文本默认行。

这样现网「模型管理」页签会直接显示一个默认图片 / 默认语音模型，且实际调用对象不变。

> 若担心脏数据已有多个同类型默认：迁移先把 image/audio 的多余默认归一为 id 最小的一个，再按上面回填。文本默认不参与归一。

### 4.3 是否需要生成列唯一索引？

可选，但不作为本期必做：

```sql
ALTER TABLE llm_model
  ADD COLUMN default_type VARCHAR(16)
    GENERATED ALWAYS AS (CASE WHEN is_default = 1 THEN model_type ELSE NULL END) STORED,
  ADD UNIQUE KEY uk_llm_model_default_type (default_type);
```

优点：数据库层保证「每类型最多一个默认」；缺点：软删默认行、类型变更、历史脏数据都可能让迁移失败。当前文本默认已经靠应用层保证多年，本期沿用应用层，风险可控。

---

## 5. 后端设计

### 5.1 ModelRepository / ModelService

**Repository 新增 / 调整**

| 方法 | 作用 |
|---|---|
| `findDefaultByType(modelType: string)` | `is_default=1 AND status=1 AND model_type=? AND deleted=0 LIMIT 1` |
| `clearDefaultFlag(modelType: string)` | `UPDATE ... SET is_default=0 WHERE is_default=1 AND model_type=? AND deleted=0` |
| `listActiveByType(modelType: string)` | 启用、未删的同类型模型，按 id ASC（与解析链兜底、availability「其余按 id」同口径）；用于 Agent 表单候选 |
| `findFirstActiveAudioModel()` | 保持现有 SQL（首个启用 + OpenAI 兼容），作为默认缺失时的兜底 |
| `findDefault()` | 保持文本口径不变 |

**ModelService 调整**

```ts
getDefaultModelByType(type: 'text' | 'image' | 'audio'): Promise<LlmModel | null>

// 默认优先，其次首个启用（保持改造前兜底）
findFirstActiveImageModel(): Promise<LlmModel | null>
findFirstActiveAudioModel(): Promise<LlmModel | null>

listFeaturedModelOptions(): Promise<{
  image: LlmModel[];
  audio: LlmModel[];
}>
```

图片 / 语音默认的协议校验：

- `image`：无额外协议要求（Images API）。
- `audio`：`api_protocol` 为空 / `openai-compatible`；否则不允许设为默认，返回 `PARAM_INVALID`（「语音模型协议需为 OpenAI 兼容」）。
- 类型校验：默认必须与模型自身 `model_type` 一致。

**createModel**

- 先确定最终 `modelTypeValue`（现有逻辑在清默认之后才计算，需要前移）。
- 若 `isDefaultValue=1`：
  1. 校验模型启用（新建默认 status=1，天然满足）；
  2. audio 校验协议；
  3. `clearDefaultFlag(modelTypeValue)`（只清同类型）；
  4. 保留 `requireDefaultModelVisible`：**仅 text 类型**要求 `client_visible=1`；image/audio 不参与客户端模型选择器，不校验该字段。
- 文本默认行为保持。

**updateModel**

- 先计算 `nextModelType`、`nextApiProtocol`、`nextIsDefault`，再校验 / 清默认：
  - 若最终是 text：沿用 `requireDefaultModelVisible`；
  - 若最终是 audio 且 `nextIsDefault=1`：协议必须兼容；
  - 若 `nextIsDefault=1`：`clearDefaultFlag(nextModelType)`；
- 类型变更（API 仍允许，UI 禁用）：
  - 若模型原本 `is_default=1` 且请求没有显式 `isDefault=1`，切换类型后强制 `is_default=0`，避免「文本默认模型改成图片后自动变成图片默认」；
  - 若模型被 Agent 绑定，类型变更会导致绑定失效：本期在 `updateModel` 里用 `AgentFeaturedModelBindingRepository.countBindingsByModelId(id)` 检查绑定数（端口见 §5.1 `deleteModel`），有绑定时拒绝类型变更（`PARAM_INVALID`），提示先解绑；无绑定则允许并清默认。
- 协议从兼容改成不兼容且当前是默认：拒绝（保证默认语音模型始终可用）。

**updateStatus**

- 现有「停用默认模型时不能停用唯一启用文本模型」的守卫改为仅 `model.modelType==='text'` 时生效。
- image/audio 默认可停用；解析器忽略停用默认并回退首个启用。
- 停用不清 `is_default`（与文本现有注释一致：默认指定是独立语义）。

**deleteModel**

- 保留「默认模型不可删除」守卫（任何类型）。
- 删除前清理 Agent 绑定。新增端口（实现放 `MysqlAgentRepository`）：

  ```ts
  export interface AgentFeaturedModelBindingRepository {
    /** 绑定该模型的 Agent 数（updateModel 类型变更守卫用） */
    countBindingsByModelId(modelId: number): Promise<number>;
    /** 两条 UPDATE 把 image_model_id / audio_model_id 等于该 id 的行置 NULL；返回清理行数 */
    clearByModelId(modelId: number): Promise<number>;
  }
  ```

  - 清理后 log「清理了 N 个 Agent 绑定」；
  - 再做软删。
- 若绑定清理失败：记录 warn，不阻断删除（软删后运行时解析也会因 `findById` 返回 null 而失效），但优先保证清理成功。

### 5.2 Agent 领域

**类型 / 仓储**

- `backend-ts/src/agent/types.ts`：`Agent` 增加 `imageModelId?: number|null`、`audioModelId?: number|null`。
- `harness/deps.ts` 的 `Agent` 同步加两字段（HarnessService 读取）。
- `MysqlAgentRepository.insert/updateById` 白名单加两列。**读取侧无需改 row mapper**：现有查询均 `SELECT *`，DB 助手自动 snake→camel（`featuredTools` 即此路径），新列读出即为 `imageModelId/audioModelId`。
- `agent/types.ts` 的 `AgentRepository` 接口继承 / 组合 `AgentFeaturedModelBindingRepository` 两方法，`model` 领域经该端口反查绑定（避免 model 直接依赖 agent 表 SQL）。
- `toVO` 输出两个字段（`?? null`）。
- `shared/contracts/src/agent.ts` 的 `AgentVO` 加：
  ```ts
  imageModelId?: number | null;
  audioModelId?: number | null;
  ```

**Service / Routes**

- `createAgent` / `updateAgent` 末尾追加 `imageModelId?`、`audioModelId?`（与 `featuredTools` 同款位置参数；更新接口按项目现有风格继续追加）。
- `POST /v1/agents` / `PUT /v1/agents/:id` 的请求体接收两字段：
  - `undefined` = 不修改（update）；
  - `null` = 清空绑定；
  - 正整数 = 绑定。
- 校验（`AgentService`，复用/扩展 `AgentModelLookup`）：
  ```ts
  interface AgentModelLookup {
    findById(id: number): Promise<{
      id?: number;
      status?: number | null;
      modelType?: string | null;
      apiProtocol?: string | null;
    } | null>;
  }
  ```
  - 模型不存在 / 已软删 → `PARAM_INVALID`「模型不存在」；
  - `modelType` 不匹配 → `PARAM_INVALID`「图片模型 / 语音模型类型不匹配」；
  - audio 协议非 OpenAI 兼容 → `PARAM_INVALID`；
  - **不校验 status**（允许先绑定后停用；运行时 fail-closed，表单提示）。
  - `modelLookup == null`（精简单测装配）时跳过，保持现有测试兼容。
- 创建时 `null` / 未提供都存 `NULL`；更新时只有 `!== undefined` 才改（`null` 清空）。
- 更新时既提交绑定又提交 `featuredTools`：两者独立，不要求绑定对应能力已勾选。

### 5.3 运行时解析器 `FeaturedModelResolver`

新增 `backend-ts/src/harness/tool/featured-model-resolver.ts`：

```ts
export interface FeaturedModelAgent {
  imageModelId?: number | null;
  audioModelId?: number | null;
}

export interface FeaturedModelResolver {
  /** 门控用：直接传已加载的 agent，避免重复查库 */
  resolveImageModel(agent: FeaturedModelAgent | null): Promise<LlmModel | null>;
  resolveAudioModel(agent: FeaturedModelAgent | null): Promise<LlmModel | null>;
  /** 工具执行用：按 agentId 重新加载 agent（Tool 只拿得到 id） */
  resolveImageModelForAgent(agentId: number | null): Promise<LlmModel | null>;
  resolveAudioModelForAgent(agentId: number | null): Promise<LlmModel | null>;
}
```

**解析规则**

```
resolveImageModel(agent):
  if agent?.imageModelId != null:
    model = modelRepo.findById(binding)
    return model && !deleted && model.status==1 && model.modelType=='image'
      ? model : null                     // 显式绑定失效：fail-closed
  return defaultImage()                  // 默认 → 首个启用

resolveAudioModel(agent):
  if agent?.audioModelId != null:
    model = modelRepo.findById(binding)
    return model && !deleted && model.status==1
      && model.modelType=='audio' && isOpenAiCompatibleAudio(model)
      ? model : null
  return defaultAudio()                  // 默认（兼容协议）→ 首个启用（兼容协议）
```

- `resolve*ForAgent(agentId)`：先 `agentMapper.selectById(agentId)`，再调用上面的方法；agent 不存在按未绑定处理（走默认）。
- `modelRepo.findById` 已带 `notDeleted()` 过滤（model.repository.ts），伪代码中的 `!deleted` 仅为防御性说明，实现时可省略，不必依赖 `LlmModel.deleted` 字段。
- 绑定失效 / 模型类型不匹配 / 协议不兼容：`harnessLog('warn', '[featured-model] agent=... kind=image bound=... reason=...')`，返回 null；**不回退默认**。
- 模型查询抛错：向上抛还是 null？与现有特色工具门控一致，逐能力 catch 后视为不可用；工具执行时返回明确错误（如 `no_model`），不把 DB 错误伪装成无模型更利于排查——建议 resolver 记录 warn 后返回 null，工具报 `no_model`，与现有 TTS 行为一致。

**依赖注入**

- `app-harness-engine.ts` 构造一个 `DefaultFeaturedModelResolver`（依赖 `d.agentRepo`、`d.modelRepo` / `d.modelService`）；
- 现有「modelService 未装配 → 特色工具闸口跳过过滤（fail-open）」告警（app-harness-engine.ts）的判空对象与文案同步换成 resolver；
- 同一个实例传给：
  - `createDefaultToolRegistry` 的 `imageModelLookup` / `audioModelLookup`；
  - `new HarnessService(...)` 的 `featuredToolModels`（类型改成 `FeaturedModelResolver` 的子集接口）；
- 单测可直接构造 resolver + fake repos，不依赖 HarnessService。

### 5.4 特色工具门控改造

`backend-ts/src/harness/tool/featured-tools.ts`：

```ts
export interface FeaturedToolModelLookup {
  resolveImageModel(agent: FeaturedModelAgent | null): Promise<unknown | null>;
  resolveAudioModel(agent: FeaturedModelAgent | null): Promise<unknown | null>;
}

resolveFeaturedToolNames(featured, lookup, agent)
```

- `HarnessService.buildContext()` 在现有过滤处传 `agent`：
  ```ts
  const allowed = await resolveFeaturedToolNames(featured, this.featuredToolModels ?? null, agent);
  ```
- 只查配置了的能力；每能力独立 catch；未注入 lookup 时保持 legacy（全部 gated 工具可见）不变。
- `Agent` 的 `imageModelId/audioModelId` 从 `agentMapper.selectById` 已返回，无需额外查询。

### 5.5 工具执行改造

| 工具 | 现在 | 改为 |
|---|---|---|
| `GenerateImageTool` | `ImageModelLookup.findFirstActiveImageModel()` | `ImageModelLookup.findImageModel(agentId?)`，传 `executeWithUser` 的 `agentId` |
| `EditImageTool` | 同上 | 同上 |
| `TextToSpeechTool` | `AudioModelLookup.findFirstActiveAudioModel()` | `AudioModelLookup.findAudioModel(agentId?)` |
| `WeixinVoiceSynthesisService` | `ModelService.findFirstActiveAudioModel()` | 不改调用；ModelService 内部变默认优先 |

- 三个工具的 lookup 接口从「findFirstActive*」改为「按 agentId 解析」，实现由 `FeaturedModelResolver` 适配（在 app-harness-engine 传入）。
- 保留工具内部 `no_model` / `invalid_model_config` / `unsupported_protocol` 早退；resolver 已过滤协议，工具侧仍做防御。
- 调用流水 `llm_call` / image recorder 记录实际使用的 `model.id`，与绑定模型一致。
- 测试里的 lookup stub 需从 `findFirstActiveImageModel` 改为 `findImageModel`（或新增兼容方法，见 §7 测试迁移）。

### 5.6 模型删除 / 停用 / 类型变更边界

| 场景 | 行为 |
|---|---|
| Agent 绑定的模型被停用 | 保存不报错；下一次 `buildContext` 该能力解析为 null → 工具不注入；表单提示「已绑定模型不可用」 |
| Agent 绑定的模型被删除 | `deleteModel` 清空所有 Agent 绑定 → 回退默认；若删除失败，运行时 `findById` null → 工具隐藏 |
| 默认图片 / 语音模型被停用 | 允许；解析回退首个启用；不自动清 `is_default` |
| 删除默认模型 | 拒绝（沿用现有守卫），先改默认或取消默认 |
| 模型类型变更（API） | 被 Agent 绑定时拒绝；无绑定但为默认时清默认后再改 |
| 绑定模型（非默认）协议改为不兼容 | 允许保存；运行时 resolver 协议过滤 → fail-closed 工具隐藏；表单因候选列表只含协议兼容模型而显示「已绑定模型不可用」。仅「默认语音模型」的协议劣化在保存侧拒绝（§5.1），保证默认始终可用 |
| 旧 Agent 未绑定 | 走默认 / 首个启用，行为与改造前一致 |
| 旧模型无默认 | 迁移回填首个启用；即使失败，解析链也回退首个启用 |

---

## 6. 管理后台

### 6.1 Agent 编辑表单

在现有「特色工具」每行 checkbox 右侧/下方增加模型下拉：

```
☑ 图片生成（文生图 / 改图）   [跟随默认模型（当前：GPT image 2） ▾]
☐ 语音合成（TTS）             [跟随默认模型（当前：mimo-v2.5-tts） ▾]
```

- 选项来源：`GET /v1/models/availability` 新增的 `image.models` / `audio.models`（只含启用且协议兼容的模型）。
- 选项文案：`模型名` + `默认` 标签（`isDefault`）。
- 空值选项 = 「跟随默认模型（当前：X）」；当前有效模型名取 availability 的 `modelName`。
- 未勾选对应特色工具时下拉禁用，但保留值。
- 绑定 id 不在候选列表（被停用 / 删除 / 协议变更）：显示一个禁用选项「模型 #id（当前不可用）」，并提示「已绑定模型不可用，请改选或清空」。
- `isFeaturedToolDisabled` 改为看候选列表是否为空，而不是单一 `available` 布尔：
  - 未勾选且候选为空 → 置灰；
  - 已勾选但绑定失效 → 保持可取消，同时显示警告。
- 表单提交增加 `imageModelId` / `audioModelId`（null = 跟随默认）。
- 复制 Agent 复制两个 id。

### 6.2 模型管理

**ModelFormDialog**

- 「默认模型」开关对所有类型显示：
  - text：`新会话默认使用此模型`
  - image：`未指定图片模型的 Agent 使用此模型生成 / 编辑图片`
  - audio：`未指定语音模型的 Agent 与微信语音回复使用此模型`
- 「客户端可选」开关只在 text 页签显示（image/audio 不参与客户端模型选择器）。
- 移除 `if (form.modelType !== 'text') payload.isDefault = 0`；仍保留非 text 的 `supportsVision=0`、价格/上下文归零逻辑。
- audio 默认开关：
  - 协议不是空 / `openai-compatible` 时禁用并提示「语音默认模型必须使用 OpenAI 兼容协议」；
  - 后端二次校验。
- 默认开关与 `clientVisible` 的联动仅 text 生效。

**ModelListView**

- 「默认」筛选从 text 页签扩到三个页签（`isDefault` 参数已有）。
- 默认标签三个页签都展示（现有 `row.isDefault` 标签已经是全类型，只是筛选隐藏）。
- 可选：停用的默认模型显示「默认（已停用）」提示，避免误解；不强制。

### 6.3 Agent 列表

- 本期不要求在列表展示绑定模型名，避免额外请求；后续可在能力概览中显示「出图：指定 / 默认」。
- 若实现成本低，可复用 availability 的模型字典，在 tooltip 中显示 `出图(模型名) / 语音(默认)`。

---

## 7. 契约 / CLI / 文档

### 7.1 `@mao/contracts`

- `shared/contracts/src/agent.ts`：`AgentVO.imageModelId/audioModelId`。
- `shared/contracts/src/model.ts` 新增（供管理后台与未来客户端复用）：
  ```ts
  export interface FeaturedModelOption {
    id: number;
    name: string;
    isDefault: boolean;
  }

  export interface FeaturedModelAvailability {
    /** 未绑定 Agent 时是否至少有一个可用模型 */
    available: boolean;
    /** 未绑定 Agent 时的实际模型名（默认 → 首个启用） */
    modelName: string | null;
    models: FeaturedModelOption[];
  }
  ```
  `index.ts` 导出。
- `AgentVO` 字段可选，旧客户端不受影响。

### 7.2 `GET /v1/models/availability`

响应扩展（保持旧字段）：

```json
{
  "image": {
    "available": true,
    "modelName": "GPT image 2",
    "models": [
      { "id": 12, "name": "GPT image 2", "isDefault": true },
      { "id": 18, "name": "Flux Pro", "isDefault": false }
    ]
  },
  "audio": {
    "available": true,
    "modelName": "mimo-v2.5-tts (plan)",
    "models": [
      { "id": 5, "name": "mimo-v2.5-tts (plan)", "isDefault": true }
    ]
  }
}
```

- `models` 只含 `status=1`、未软删、协议兼容的模型；顺序建议默认模型在前、其余按 id。
- `modelName` 仍表示「未绑定 Agent 时的实际模型」，旧管理后台只读这两个字段也不会坏。
- 接口仍只要求登录（不要求 `model:read`），返回内容不含 key / baseUrl。

### 7.3 mao-cli / mao-agent

- `skills/mao-cli/reference/model.md`：
  - 说明 `isDefault` 现在是按 `modelType` 作用域，文本 / 语音 / 图片各一个；
  - `create/update --is-default` 对 audio/image 同样生效；
  - `/models/availability` 增加 `models` 数组的说明。
- `skills/mao-cli/reference/agent.md`：
  - CLI 的 `agent create/update` 仍不支持 `featuredTools`，也不支持 `imageModelId/audioModelId`；管理后台配置，CLI 新建默认不绑定、更新不改动。
- `skills/mao-cli/reference/tool.md`：
  - 补充工具实际使用「Agent 指定模型 → 默认模型 → 首个启用模型」。
- `changelog/unreleased/2026-11-27-featured-model-default-binding.md`：
  - 后端：图片 / 语音默认模型、Agent 指定模型、删除模型清理绑定
  - 管理后台：模型默认开关、Agent 模型下拉

### 7.4 文档

- 本文档。
- 不改 README / DEPLOY（无新环境变量、无部署步骤）。
- `mao-cli` 文档同步更新。

---

## 8. 微信语音回复的口径

本期 **微信语音回复只跟随全局语音默认模型，不使用 Agent 绑定**。

原因：

- 微信渠道链路 `WeixinInboundHandler.onMessage() → WeixinVoiceReplyService.sendVoiceReply()` 当前只传文本与账号用户 id，`WeixinReply` 不携带 agent/session 上下文；
- 若要让微信语音按 Agent 绑定，需要扩展 `WeixinReply.agentId`、`sendVoiceReply`、`synthesizeWav` 三处签名，并把 session.agentId 透传；这是渠道链路的独立改造。

建议后续增强（不在本期）：

```
WeixinReply { text; agentId?: number|null }
  → sendVoiceReply(..., agentId)
  → synthesizeWav(text, userId, agentId)
  → FeaturedModelResolver.resolveAudioModelForAgent(agentId)
```

本期保证：语音默认模型变化后，微信语音回复立即跟随（因为 `findFirstActiveAudioModel()` 已改为默认优先）。

---

## 9. 测试计划

### 9.1 后端单测

1. `model.repository.spec.ts`
   - `clearDefaultFlag('image')` 只清 image，不动 text/audio；
   - `findDefaultByType` 按类型 + status + deleted；
   - `listActiveByType` 的过滤与排序；audio 协议过滤。
2. `model.service.spec.ts`
   - 设置 image 默认不清 text 默认；设置 text 默认不清 image 默认；
   - audio 默认协议不兼容 → `PARAM_INVALID`；
   - 停用默认 image/audio 允许，且不触发文本「唯一启用」守卫；
   - 删除默认模型仍拒绝；
   - `findFirstActiveImageModel` / `findFirstActiveAudioModel` 默认优先、缺失回退首个启用；
   - 类型变更 + 默认标记的处理。
3. `agent.repository.spec.ts` / `agent.service.spec.ts` / `agent.routes.spec.ts`
   - 两字段往返、null 清空、undefined 不改；
   - 错误类型 / 不存在 / audio 协议不兼容 → `PARAM_INVALID`；
   - `toVO` 输出；
   - 位置参数追加后现有用例的 `.at(-n)` 调整。
4. 新增 `featured-model-resolver.spec.ts`
   - 绑定 active image → 用绑定；
   - 绑定 disabled / 删除 / 类型错 → null（不回退）；
   - 未绑定 → 显式默认；无默认 → 首个启用；
   - audio 协议过滤；
   - agent 不存在 → 默认链；
   - agentId 版本与 agent 对象版本结果一致。
5. `featured-tools.spec.ts` / `harness-service.spec.ts`
   - 配置 + 绑定可用 → 工具在；
   - 配置 + 绑定不可用 → 工具不在（即使默认可用）；
   - 未配置 → 不在；
   - 未注入 resolver → legacy 行为不变；
   - 某个能力查询抛错 → 仅该能力隐藏。
6. 工具测试
   - `generate-image-tool.spec.ts` / `edit-image-tool.spec.ts`：lookup 收到当前 agentId，选中的模型用于请求；
   - `text-to-speech-tool.spec.ts`：同上；
   - 绑定失效时返回 `no_model`，不调用 adapter。
7. `model.routes.spec.ts`
   - `/models/availability` 返回 `models` 数组、默认标记、协议过滤；
   - 未登录仍 `UNAUTHORIZED`；
   - 不返回 apiKey/baseUrl。
8. 模型删除清理绑定
   - `deleteModel` 调用 binding repo，Agent 两列置 NULL；
   - 清理失败不阻断删除但记录日志（可选）。

### 9.2 前端

- `cd admin && npm run build`（`vue-tsc -b && vite build`，禁止 `vue-tsc --noEmit`）。
- 管理后台人工 / Playwright：
  - 文本/语音/图片三个页签都能设默认，标签只有一个；
  - 设置图片默认不影响文本默认；
  - Agent 表单：未绑定显示「跟随默认（当前：X）」；选择模型后提交 `imageModelId/audioModelId`；清空后提交 null；复制 Agent 保留绑定；
  - 绑定模型停用后重新打开表单显示「不可用」。
- 现有 `tests/admin-agent-avatar.spec.ts` 精确 payload 需补 `imageModelId: null, audioModelId: null`。

### 9.3 全量回归

- backend-ts `npm test`
- admin / desktop build + 单测
- sdk/embed 如无改动可不跑；若契约影响则跑
- agent-cli `npm test`
- 根 `npm test` Playwright（隔离 `mao_e2e`，不连 9080）

---

## 10. 兼容与发布顺序

1. **后端先上**：V214 + ModelService 默认作用域 + resolver + Agent 字段。旧管理后台不传绑定 → null，行为不变；旧客户端不读新字段。
2. **管理后台紧跟着上**：模型默认开关 + Agent 模型下拉。注意混合版本窗口（新后端 + 旧管理后台）：旧 `ModelFormDialog` 对非 text 类型强制提交 `isDefault=0`，窗口内编辑任意图片 / 语音模型会清掉该类型的默认标记（运行时回退首个启用；若默认≠首个启用则行为静默变化）——两端间隔尽量短，或在窗口内避免编辑图片 / 语音模型。反向窗口（新管理后台 + 旧后端）下，Agent 表单的「无可用模型」置灰退化为 `available` 布尔判断，不误锁。
3. 桌面 / Web / 安卓无需改；嵌入 SDK 无需改。
4. 无需 OTA / `build-apk.sh`；无新环境变量。

回滚策略：

- 代码回滚后新列保留（NULL 无影响）；`is_default` 若被图片 / 语音置 1，旧代码的 `findDefault()` 只认 text，不受影响；旧 `clearDefaultFlag()` 会把所有类型默认清零——若回滚后编辑文本默认，可能清掉图片/语音默认标记，但运行时仍按「首个启用」兜底，不会中断。
- 若需彻底回滚，V214 的列可保留，不要求 down migration。

---

## 11. 风险与待确认

| # | 风险 / 决策 | 建议 |
|---|---|---|
| 1 | 绑定模型失效时是否回退默认 | **不回退，fail-closed**；工具隐藏，表单提示 |
| 2 | 是否允许绑定停用模型 | 允许保存（避免编辑其他字段被阻塞），运行时不可用 |
| 3 | 无显式默认时是否继续用首个启用 | 是，保持现网行为 |
| 4 | 微信语音是否使用 Agent 绑定 | 本期否，只跟随全局默认；后续可扩展 |
| 5 | 模型删除时绑定清理 vs 拒绝删除 | 清理绑定并回退默认；不因绑定而禁止删除 |
| 6 | 每类型默认的唯一性 | 应用层保证；数据库唯一索引作为后续加固 |
| 7 | 模型类型变更 | UI 禁用；API 有 Agent 绑定 / 是默认时拒绝或清默认，避免配置漂移 |
| 8 | 绑定模型的协议劣化（兼容→不兼容） | 不阻断保存；运行时 fail-closed + 表单提示「已绑定模型不可用」，用户主动改绑或清空 |

## 12. 实施清单

**后端**

- [ ] `backend-ts/db/migration/V214__agent_featured_model_binding.sql`
- [ ] `backend-ts/src/model/types.ts` / `model.repository.ts` / `model.service.ts`
- [ ] `backend-ts/src/agent/types.ts` / `agent.repository.ts` / `agent.service.ts` / `agent.routes.ts`
- [ ] `backend-ts/src/harness/deps.ts`
- [ ] `backend-ts/src/harness/tool/featured-model-resolver.ts`（新增）
- [ ] `backend-ts/src/harness/tool/featured-tools.ts`
- [ ] `backend-ts/src/harness/core/harness-service.ts`
- [ ] `backend-ts/src/harness/tool/impl/generate-image-tool.ts` / `edit-image-tool.ts` / `text-to-speech-tool.ts`
- [ ] `backend-ts/src/harness/tool/tool-registry.ts`
- [ ] `backend-ts/src/app-harness-engine.ts`
- [ ] `backend-ts/src/model/model.routes.ts`（availability 扩展）
- [ ] 单测：`model.*.spec.ts`、`agent.*.spec.ts`、`featured-model-resolver.spec.ts`、`featured-tools.spec.ts`、`harness-service.spec.ts`、三个工具 spec

**管理后台**

- [ ] `admin/src/views/model/ModelFormDialog.vue`
- [ ] `admin/src/views/model/ModelListView.vue`
- [ ] `admin/src/views/agent/AgentFormDialog.vue`
- [ ] `admin/src/views/agent/AgentListView.vue`（可选展示绑定）

**契约 / 文档**

- [ ] `shared/contracts/src/agent.ts` / `model.ts` / `index.ts`
- [ ] `skills/mao-cli/reference/model.md` / `agent.md` / `tool.md`
- [ ] `changelog/unreleased/2026-11-27-featured-model-default-binding.md`
- [ ] 本文档

**测试**

- [ ] backend full
- [ ] admin build + 单测
- [ ] desktop build + 单测（无改动也跑）
- [ ] agent-cli build + test
- [ ] 根 Playwright 全量（更新 Agent payload 断言）