# Agent Skills 重构技术方案

> Note: The `bash` tool has been removed. `shell` is now the only command execution tool. See `shell-unification-design.md`.

> 将当前系统的可执行 Skill 重命名为 Tool，引入符合 Anthropic 规范的 Skill 知识文档系统。

## 背景

当前系统的 "Skill" 概念本质是**可执行的工具函数**（Java 接口 + `execute()` 方法），等同于 OpenAI function calling 中的 Tool。而 Anthropic 的 Agent Skills 规范将 Skill 定义为**按需加载的知识/指令文档**（SKILL.md 文件），通过两层加载机制注入 LLM 上下文，指导 Agent 如何完成特定领域任务。

两者职责不同：
- **Tool（工具）**：执行操作，返回结果（bash、read_file、http_request 等）
- **Skill（知识）**：注入领域知识，指导 Agent 行为（Git 工作流、代码审查规范等）

本次重构将当前的 "Skill" 重命名为 "Tool"，并引入符合 Anthropic 规范的 Skill 知识文档系统。

---

## 重构范围

### 概念映射

| 重构前 | 重构后 | 说明 |
|--------|--------|------|
| `Skill` 接口 | `Tool` 接口 | 可执行工具的统一抽象 |
| `SkillRegistry` | `ToolRegistry` | 工具注册中心 |
| `SkillDispatcher` | `ToolDispatcher` | 工具调度器 |
| `BashSkill` 等 7 个实现 | `BashTool` 等 | 重命名，逻辑不变 |
| `AgentExecutionContext.skills` | `AgentExecutionContext.tools` | 上下文中的工具列表 |
| `skill` 数据库表 | `tool` 数据库表 | 存储工具元数据 |
| `agent_skill` 关联表 | `agent_tool` 关联表 | Agent-Tool 多对多 |
| 无 | `SkillLoader`（新增） | 扫描加载 SKILL.md 文件 |
| 无 | `load_skill` 工具（新增） | LLM 按需加载 Skill 内容 |

### 不变的部分

- `McpTool` / `McpToolRegistry` / `McpClient` — MCP 工具系统不受影响
- `LocalToolExecutor` — LOCAL 执行模式不受影响（只是接收的 toolName 不变）
- `BackgroundTaskManager` / `PathSandbox` — 安全和异步基础设施不变
- AgentLoop 核心循环逻辑不变
- 前端 Agent 创建/编辑流程的交互模式不变

---

## 实施步骤

### 第一步：重命名 Skill → Tool（Java 后端）

**目标**：将当前的可执行 Skill 概念统一重命名为 Tool，消除命名歧义。

#### 1.1 接口重命名

`Skill.java` → `Tool.java`

```java
package com.agentworkbench.harness.tool;

public interface Tool {
    String getName();
    String getDescription();
    Map<String, Object> getInputSchema();
    Map<String, Object> getOutputSchema();
    String execute(String arguments);
}
```

路径：`backend/src/main/java/com/agentworkbench/harness/tool/Tool.java`

#### 1.2 实现类重命名

目录：`harness/skill/impl/` → `harness/tool/impl/`

| 原文件 | 新文件 |
|--------|--------|
| `BashSkill.java` | `BashTool.java` |
| `ReadFileSkill.java` | `ReadFileTool.java` |
| `WriteFileSkill.java` | `WriteFileTool.java` |
| `EditFileSkill.java` | `EditFileTool.java` |
| `HttpRequestSkill.java` | `HttpRequestTool.java` |
| `TodoSkill.java` | `TodoTool.java` |


每个文件内部：类名重命名，`implements Skill` → `implements Tool`，其余逻辑不变。

#### 1.3 注册中心重命名

`SkillRegistry.java` → `ToolRegistry.java`

路径：`backend/src/main/java/com/agentworkbench/harness/tool/ToolRegistry.java`

```java
@Component
public class ToolRegistry {
    private final Map<String, Tool> tools = new ConcurrentHashMap<>();
    // 构造器注入 List<Tool>，其余方法签名 skill → tool
}
```

#### 1.4 调度器重命名

`SkillDispatcher.java` → `ToolDispatcher.java`

路径：`backend/src/main/java/com/agentworkbench/harness/tool/ToolDispatcher.java`

- `SkillRegistry` → `ToolRegistry`
- `skillRegistry.getSkill()` → `toolRegistry.getTool()`

#### 1.5 上下文对象修改

`AgentExecutionContext.java`：

```java
// 改前
private List<Skill> skills = new ArrayList<>();
// 改后
private List<Tool> tools = new ArrayList<>();
private List<String> availableSkillNames = new ArrayList<>();  // 新增：可用的 Skill 名称列表
```

#### 1.6 HarnessService 修改

`HarnessService.java` 中 `buildContext()` 方法：

- `SkillRegistry` → `ToolRegistry`
- `skillRegistry.getSkillsByNames()` → `toolRegistry.getToolsByNames()`
- `context.setSkills()` → `context.setTools()`
- 移除 `SkillEntityMapper` 依赖，改用 `ToolEntityMapper`

#### 1.7 AgentLoop 修改

`AgentLoop.java`：

- `SkillDispatcher` → `ToolDispatcher`
- 变量名 `skillDispatcher` → `toolDispatcher`

#### 1.8 PromptEngine 修改

`PromptEngine.java`：

- `List<Skill> skills` → `List<Tool> tools`
- `context.getSkills()` → `context.getTools()`
- system prompt 中 `## Available Tools` 部分保持不变（只是数据来源变量名变了）

---

### 第二步：数据库迁移

#### 2.1 新增迁移脚本 `V008__rename_skill_to_tool.sql`

```sql
-- 1. 重命名 skill 表为 tool
RENAME TABLE `skill` TO `tool`;

-- 2. 重命名 agent_skill 表为 agent_tool
RENAME TABLE `agent_skill` TO `agent_tool`;

-- 3. 更新 agent_tool 外键列名
ALTER TABLE `agent_tool` CHANGE COLUMN `skill_id` `tool_id` BIGINT NOT NULL;

-- 4. 更新唯一键
ALTER TABLE `agent_tool` DROP KEY `uk_agent_skill`;
ALTER TABLE `agent_tool` ADD UNIQUE KEY `uk_agent_tool` (`agent_id`, `tool_id`);

-- 5. 更新 impl_class 中的类名（包路径变化）
UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, '.skill.impl.', '.tool.impl.');
UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'BashSkill', 'BashTool');
UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'ReadFileSkill', 'ReadFileTool');
UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'WriteFileSkill', 'WriteFileTool');
UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'EditFileSkill', 'EditFileTool');
UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'HttpRequestSkill', 'HttpRequestTool');
UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'TodoSkill', 'TodoTool');


-- 6. Agent 表新增 skill_names 字段
ALTER TABLE `agent` ADD COLUMN `skill_names` JSON DEFAULT NULL COMMENT '可用的 Skill 知识文档名称列表';
```

---

### 第三步：新增 Skill 知识文档系统

#### 3.1 Skill 文档目录结构

在后端项目中创建 Skill 文档目录：

```
backend/src/main/resources/skills/
  git-workflow/
    SKILL.md
  code-review/
    SKILL.md
```

每个 `SKILL.md` 格式：

```markdown
---
name: git-workflow
description: Git 工作流规范与最佳实践
---

# Git 工作流规范

## 分支策略
...

## Commit Message 规范
...
```

#### 3.2 SkillLoader 实现

新增文件：`backend/src/main/java/com/agentworkbench/harness/skill/SkillLoader.java`

```java
@Component
public class SkillLoader {

    private final Map<String, SkillDocument> skills = new LinkedHashMap<>();

    @Value("${app.harness.skills-dir:classpath:skills/}")
    private String skillsDir;

    @PostConstruct
    public void init() {
        // 扫描 skillsDir 下所有 SKILL.md 文件
        // 解析 YAML frontmatter（name, description）
        // 存储 body 内容
    }

    /** Layer 1: 返回所有 Skill 的名称+描述（~100 token/skill） */
    public String getDescriptions() { ... }

    /** Layer 1 (filtered): 返回指定名称的 Skill 描述 */
    public String getDescriptions(List<String> filterNames) { ... }

    /** Layer 2: 返回指定 Skill 的完整内容（~2000 token） */
    public String getContent(String name) { ... }

    /** 获取所有 Skill 文档列表 */
    public List<SkillDocument> getAllDocuments() { ... }

    /** 获取所有 Skill 名称 */
    public List<String> getAllNames() { ... }
}
```

`SkillDocument` 数据类：

```java
@Data
public class SkillDocument {
    private String name;
    private String description;
    private String body;        // SKILL.md 的正文（去掉 frontmatter）
    private String filePath;    // 源文件路径
}
```

#### 3.3 YAML Frontmatter 解析

Spring Boot 已自带 SnakeYAML，无需额外依赖。

解析逻辑：读取 SKILL.md，以 `---` 分隔 frontmatter 和 body，用 SnakeYAML 解析 frontmatter 部分。

#### 3.4 `load_skill` 工具实现

新增文件：`backend/src/main/java/com/agentworkbench/harness/tool/LoadSkillTool.java`

```java
@Component
@RequiredArgsConstructor
public class LoadSkillTool implements Tool {

    private final SkillLoader skillLoader;

    @Override
    public String getName() { return "load_skill"; }

    @Override
    public String getDescription() { return "加载指定 Skill 的完整知识内容"; }

    @Override
    public Map<String, Object> getInputSchema() {
        return Map.of(
            "type", "object",
            "properties", Map.of("name", Map.of("type", "string", "description", "Skill 名称")),
            "required", List.of("name")
        );
    }

    @Override
    public String execute(String arguments) {
        String name = extractName(arguments);
        String content = skillLoader.getContent(name);
        if (content == null) {
            return "{\"error\": \"Unknown skill: " + name + "\"}";
        }
        return "{\"content\": \"" + escapeJson(content) + "\"}";
    }
}
```

`load_skill` 是一个特殊的 Tool：它不执行外部操作，而是从文件系统读取 Skill 文档内容并返回给 LLM。它同时存在于两个体系中：
- 作为 Tool（可被 LLM function calling 调用）
- 作为 Skill 系统的入口（返回的是 Skill 知识内容）

---

### 第四步：PromptEngine 两层加载改造

修改 `PromptEngine.java`：

#### 4.1 Layer 1 — System Prompt 中注入 Skill 目录

```java
private String buildSystemPrompt(AgentExecutionContext context) {
    StringBuilder sb = new StringBuilder();

    // Agent 人格
    if (context.getSystemPrompt() != null) {
        sb.append(context.getSystemPrompt()).append("\n\n");
    }

    // Skill 目录（Layer 1）— 名称 + 描述，~100 token/skill
    String skillDescriptions = skillLoader.getDescriptions(context.getAvailableSkillNames());
    if (skillDescriptions != null && !skillDescriptions.isEmpty()) {
        sb.append("## Available Skills\n\n");
        sb.append(skillDescriptions).append("\n\n");
    }

    // Tool 描述（原 Available Tools 部分）
    List<Tool> tools = context.getTools();
    if (!tools.isEmpty()) {
        sb.append("## Available Tools\n\n");
        for (Tool tool : tools) {
            sb.append("- **").append(tool.getName()).append("**: ");
            sb.append(tool.getDescription()).append("\n");
        }
    }

    return sb.toString();
}
```

#### 4.2 Layer 2 — Tool 定义中包含 `load_skill`

```java
private List<ChatRequest.ToolDefinition> buildToolDefinitions(AgentExecutionContext context) {
    List<ChatRequest.ToolDefinition> tools = new ArrayList<>();

    // load_skill tool（Skill 系统入口）
    tools.add(ChatRequest.ToolDefinition.builder()
            .type("function")
            .function(ChatRequest.Function.builder()
                    .name("load_skill")
                    .description("加载指定 Skill 的完整知识内容。当需要某个领域的专业指导时调用。")
                    .parameters(Map.of(
                            "type", "object",
                            "properties", Map.of("name", Map.of("type", "string", "description", "Skill 名称")),
                            "required", List.of("name")))
                    .build())
            .build());

    // 原有 Tools（bash, read_file 等）
    for (Tool tool : context.getTools()) {
        tools.add(ChatRequest.ToolDefinition.builder()
                .type("function")
                .function(ChatRequest.Function.builder()
                        .name(tool.getName())
                        .description(tool.getDescription())
                        .parameters(tool.getInputSchema())
                        .build())
                .build());
    }

    // MCP tools
    for (McpTool mcpTool : context.getMcpTools()) {
        tools.add(ChatRequest.ToolDefinition.builder()
                .type("function")
                .function(ChatRequest.Function.builder()
                        .name(mcpTool.getName())
                        .description(mcpTool.getDescription())
                        .parameters(mcpTool.getInputSchema())
                        .build())
                .build());
    }

    return tools;
}
```

---

### 第五步：Agent-Skill 关联方式改造

#### 5.1 关联模型变化

当前：`agent_skill` 表存储 Agent 与可执行 Skill 的关联（通过数据库 ID）。

重构后：
- `agent_tool` 表：Agent 与可执行 Tool 的关联（数据库，不变逻辑）
- Agent 表新增 `skill_names` 字段：JSON 数组，指定该 Agent 可用的 Skill 知识文档名称列表，为空则加载全部

#### 5.2 HarnessService 上下文构建修改

```java
// 加载 Tool（原 Skill）
List<AgentTool> agentTools = agentToolMapper.selectList(
    new QueryWrapper<AgentTool>().eq("agent_id", agent.getId()));
if (!agentTools.isEmpty()) {
    List<Long> toolIds = agentTools.stream().map(AgentTool::getToolId).toList();
    List<ToolEntity> toolEntities = toolEntityMapper.selectBatchIds(toolIds);
    List<String> toolNames = toolEntities.stream().map(ToolEntity::getName).toList();
    context.setTools(toolRegistry.getToolsByNames(toolNames));
} else {
    context.setTools(toolRegistry.getAllTools());
}

// 加载 Skill 文档名称列表
List<String> agentSkillNames = parseSkillNames(agent.getSkillNames());
context.setAvailableSkillNames(
    agentSkillNames != null ? agentSkillNames : skillLoader.getAllNames()
);
```

---

### 第六步：前端改造

#### 6.1 管理后台 — Skill 管理页面重构

**SkillListView.vue** 重构方向：

- 移除 `inputSchema`、`outputSchema`、`implClass` 列
- 新增列：`name`、`description`、`filePath`（SKILL.md 路径）
- 操作：查看内容（弹窗展示 SKILL.md 全文）、编辑（内嵌 Markdown 编辑器）
- 数据来源：从 `GET /v1/skills` 改为 `GET /v1/skill-docs`（新增 API）

**SkillFormDialog.vue** 重构方向：

- 移除 `type`、`inputSchema`、`outputSchema`、`implClass` 字段
- 新增字段：`name`（必填）、`description`、`content`（Markdown 编辑器）
- 保存时将 frontmatter + body 写入文件系统

#### 6.2 管理后台 — Agent 表单修改

**AgentFormDialog.vue**：

- 原 `skillIds` 多选（选择可执行工具）→ 改为 `toolIds` 多选
- 新增 `skillNames` 多选（选择可用的 Skill 知识文档）

#### 6.3 桌面端 — Agent 创建修改

**CreateAgentView.vue**：

- 原 `el-transfer` 组件选择 Skills → 改为选择 Tools
- 新增区域：选择可用的 Skill 知识文档

---

### 第七步：新增后端 API

#### 7.1 Skill 文档 API

新增 `SkillDocController.java`：

```
GET  /v1/skill-docs          — 获取所有 Skill 文档列表（name, description, filePath）
GET  /v1/skill-docs/{name}   — 获取指定 Skill 文档详情（含 body 内容）
POST /v1/skill-docs          — 创建 Skill 文档（写入 SKILL.md 文件）
PUT  /v1/skill-docs/{name}   — 更新 Skill 文档内容
DELETE /v1/skill-docs/{name} — 删除 Skill 文档
```

#### 7.2 Tool API（原 Skill API 重命名）

```
GET    /v1/tools           — 获取所有 Tool 列表
GET    /v1/tools/{id}      — 获取单个 Tool
POST   /v1/tools           — 创建 Tool
PUT    /v1/tools/{id}      — 更新 Tool
DELETE /v1/tools/{id}      — 删除 Tool
```

---

### 第八步：更新 SkillDataInitializer → ToolDataInitializer

`SkillDataInitializer.java` → `ToolDataInitializer.java`

功能不变：启动时将内存中注册的 Tool 同步到 `tool` 数据库表。只是类名和变量名从 skill 改为 tool。

---

## 关键文件清单

### 需要重命名的文件（skill → tool）

| 原路径 | 新路径 |
|--------|--------|
| `harness/skill/Skill.java` | `harness/tool/Tool.java` |
| `harness/skill/SkillRegistry.java` | `harness/tool/ToolRegistry.java` |
| `harness/skill/SkillDispatcher.java` | `harness/tool/ToolDispatcher.java` |
| `harness/skill/impl/BashSkill.java` | `harness/tool/impl/BashTool.java` |
| `harness/skill/impl/ReadFileSkill.java` | `harness/tool/impl/ReadFileTool.java` |
| `harness/skill/impl/WriteFileSkill.java` | `harness/tool/impl/WriteFileTool.java` |
| `harness/skill/impl/EditFileSkill.java` | `harness/tool/impl/EditFileTool.java` |
| `harness/skill/impl/HttpRequestSkill.java` | `harness/tool/impl/HttpRequestTool.java` |
| `harness/skill/impl/TodoSkill.java` | `harness/tool/impl/TodoTool.java` |

| `harness/init/SkillDataInitializer.java` | `harness/init/ToolDataInitializer.java` |

### 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `harness/core/AgentExecutionContext.java` | `skills` → `tools`，新增 `availableSkillNames` |
| `harness/core/PromptEngine.java` | 引入 `SkillLoader`，两层加载逻辑 |
| `harness/core/AgentLoop.java` | `SkillDispatcher` → `ToolDispatcher` |
| `harness/core/HarnessService.java` | Skill→Tool 重命名 + Skill 加载逻辑 |
| `skill/entity/SkillEntity.java` | 重命名为 `ToolEntity`，包路径改为 `tool/` |
| `skill/service/SkillService.java` | 重命名为 `ToolService` |
| `skill/controller/SkillController.java` | 重命名为 `ToolController`，路径 `/v1/tools` |
| `skill/mapper/SkillEntityMapper.java` | 重命名为 `ToolEntityMapper` |
| `agent/service/AgentService.java` | `skillIds` → `toolIds`，`agent_skill` → `agent_tool` |
| `agent/controller/AgentController.java` | 同上 |
| `agent/entity/AgentSkill.java` | 重命名为 `AgentTool`，`skillId` → `toolId` |
| `agent/mapper/AgentSkillMapper.java` | 重命名为 `AgentToolMapper` |
| `admin/src/views/skill/SkillListView.vue` | 重构为 Skill 知识文档管理 |
| `admin/src/views/skill/SkillFormDialog.vue` | 重构为 Markdown 编辑器 |
| `admin/src/views/agent/AgentFormDialog.vue` | `skillIds` → `toolIds` + `skillNames` |
| `desktop/src/views/agent-create/CreateAgentView.vue` | 同上 |

### 新增的文件

| 文件 | 说明 |
|------|------|
| `harness/skill/SkillLoader.java` | Skill 文档扫描和加载器 |
| `harness/skill/SkillDocument.java` | Skill 文档数据类 |
| `harness/tool/LoadSkillTool.java` | `load_skill` 工具实现 |
| `skill/controller/SkillDocController.java` | Skill 文档 REST API |
| `backend/src/main/resources/skills/` | Skill 文档目录 |
| `backend/src/main/resources/skills/*/SKILL.md` | 示例 Skill 文档 |
| `V008__rename_skill_to_tool.sql` | 数据库迁移脚本 |

---

## 数据流对比

### 重构前

```
Agent 配置 skillIds → agent_skill 表 → SkillEntity → SkillRegistry.getSkillsByNames()
→ PromptEngine 将 Skill 的 name/description/inputSchema 转为 ToolDefinition
→ LLM 返回 tool_call → SkillDispatcher → Skill.execute()
```

### 重构后

```
Agent 配置 toolIds → agent_tool 表 → ToolEntity → ToolRegistry.getToolsByNames()
→ PromptEngine 将 Tool 的 name/description/inputSchema 转为 ToolDefinition
→ 同时将 SkillLoader.getDescriptions() 注入 system prompt（Layer 1）
→ LLM 返回 tool_call → ToolDispatcher → Tool.execute()
   ↳ 若 tool_call 是 load_skill(name) → LoadSkillTool → SkillLoader.getContent(name)
     → 返回 SKILL.md 全文注入上下文（Layer 2）
```

---

## 验证方案

1. **单元测试**：ToolRegistry、ToolDispatcher、SkillLoader 的基本功能测试
2. **集成测试**：
   - 启动后端，验证 ToolDataInitializer 将 7 个 Tool 正确同步到 `tool` 表
   - 调用 `GET /v1/tools` 确认返回正确的 Tool 列表
   - 调用 `GET /v1/skill-docs` 确认返回正确的 Skill 文档列表
   - 创建 Agent 时关联 Tool + Skill，验证上下文构建正确
3. **端到端测试**：
   - 启动管理后台，验证 Tool 管理和 Skill 文档管理页面正常
   - 创建 Agent，选择 Tool 和 Skill，发起对话
   - 验证 LLM 能看到 Skill 目录（Layer 1）
   - 验证 LLM 调用 `load_skill` 后能获取完整 Skill 内容（Layer 2）
   - 验证原有 Tool（bash、read_file 等）仍然正常工作
4. **前端验证**：
   - 管理后台 Skill 页面能展示 SKILL.md 内容
   - Agent 表单中 Tool 和 Skill 选择分离正确
