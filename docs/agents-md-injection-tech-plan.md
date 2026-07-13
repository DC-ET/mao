# AGENTS.md 动态上下文注入 - 技术方案

## 1. 需求背景

当前 Agent 的系统提示词由 `PromptEngine` 动态构建，包含角色定义、工作环境、工具指南、技能目录等模块。为了支持用户自定义工作区级别的规则（如编码规范、项目约定、提交规范等），需要增加对 `AGENTS.md` 文件的读取和注入能力。

用户可以在项目工作区根目录下放置 `AGENTS.md` 文件，系统会自动将其内容作为"工作区规则"注入到系统提示词末尾，使 Agent 在执行任务时遵循这些自定义规则。

## 2. 需求描述

### 2.1 功能需求

| 编号 | 需求项 | 说明 |
|------|--------|------|
| F-1 | 读取 AGENTS.md | 当工作区根目录存在 `AGENTS.md` 文件时，读取其内容 |
| F-2 | 注入系统提示词 | 将文件内容追加到系统提示词末尾，标题为 `## 工作区规则` |
| F-3 | 文件不存在时不注入 | 如果工作区不存在 `AGENTS.md`，系统提示词保持不变 |
| F-4 | 内容截断 | 文件内容超过 200 行时，仅保留前 200 行，末尾追加提示：`当前仅展示前200行规则，读取AGENTS.md文件以了解更多规则。` |
| F-5 | CLOUD 模式支持 | 服务端直接读取云端工作区的 AGENTS.md 文件 |
| F-6 | LOCAL 模式支持 | 桌面客户端上报 AGENTS.md 内容，服务端缓存并注入 |

### 2.2 不做的内容

| 编号 | 排除项 | 说明 |
|------|--------|------|
| E-1 | 不支持自定义标题 | 固定使用 `## 工作区规则`，不提供配置项 |
| E-2 | 不支持子目录 AGENTS.md | 仅读取工作区根目录，不递归扫描子目录 |
| E-3 | 不做内容缓存 | 每次请求都重新读取，保证实时性 |
| E-4 | 不做文件格式校验 | 不校验 AGENTS.md 的 Markdown 语法，原样注入 |
| E-5 | 不支持其他文件名 | 仅支持 `AGENTS.md`，不支持 `AGENTS.txt` 等 |

## 3. 技术选型

### 3.1 现有架构分析

**核心组件**：
- `PromptEngine` - 系统提示词构建引擎，`buildSystemPrompt()` 方法组装完整提示词
- `HarnessService` - 会话执行服务，`buildContext()` 构建执行上下文
- `AgentExecutionContext` - 执行上下文，携带会话、Agent、工作区等信息
- `LocalSkillRegistry` - 本地 Skill 上报登记表（内存态），LOCAL 模式复用此模式

**系统提示词构建顺序**（`PromptEngine.buildSystemPrompt()`）：
1. Agent 角色定义（systemPrompt）
2. 最佳实践经验（experiences）
3. 工作环境信息（workspace、platform、shell 等）
4. 当前时间
5. 工具使用指南（TOOL_USAGE_GUIDANCE）
6. 技能目录（skill catalog）
7. 任务管理行为指令
8. 子代理委派行为指令
9. **→ [新增] 工作区规则（AGENTS.md）**

### 3.2 技术方案选型

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| A. 仅服务端读取 | 实现简单 | LOCAL 模式不支持 | ❌ 不采用 |
| B. 桌面端上报 + 服务端注入 | 两种模式统一支持 | 需要修改 WebSocket 协议 | ✅ 采用 |
| C. Agent 主动读取 | 无需修改后端 | 不满足"系统提示词一部分"的需求 | ❌ 不采用 |

**选择方案 B**：复用现有的 `LocalSkillRegistry` 上报模式，创建 `LocalAgentsMdRegistry` 存储桌面端上报的 AGENTS.md 内容。

## 4. 实现步骤

### 4.1 CLOUD 模式实现

#### 4.1.1 修改 PromptEngine

**文件**: `backend/src/main/java/cn/etarch/mao/harness/core/PromptEngine.java`

在 `buildSystemPrompt()` 方法末尾（`appendDelegateToolHints` 之后）添加 AGENTS.md 注入逻辑：

```java
// 工作区规则（AGENTS.md）
appendWorkspaceRules(sb, context, effectiveWorkspace);
```

新增方法：

```java
private static final int AGENTS_MD_MAX_LINES = 200;
private static final String AGENTS_MD_TRUNCATED_HINT = "\n> 当前仅展示前200行规则，读取AGENTS.md文件以了解更多规则。\n";

/**
 * 向 system prompt 注入工作区规则（AGENTS.md）
 * CLOUD 模式：服务端直接读取文件
 * LOCAL 模式：使用桌面端上报的内容
 */
private void appendWorkspaceRules(StringBuilder sb, AgentExecutionContext context, String effectiveWorkspace) {
    String content = null;
    
    if ("LOCAL".equalsIgnoreCase(context.getExecutionMode())) {
        // LOCAL 模式：使用桌面端上报的内容
        content = context.getAgentsMdContent();
    } else {
        // CLOUD 模式：服务端读取文件
        Path agentsMdPath = Path.of(effectiveWorkspace, "AGENTS.md");
        if (Files.exists(agentsMdPath) && Files.isRegularFile(agentsMdPath)) {
            try {
                content = Files.readString(agentsMdPath);
            } catch (IOException e) {
                log.warn("Failed to read AGENTS.md from workspace: {}", agentsMdPath, e);
            }
        }
    }
    
    if (content == null || content.isBlank()) {
        return;
    }
    
    // 截断处理
    String[] lines = content.split("\\R", -1); // 保留尾部空行
    boolean truncated = lines.length > AGENTS_MD_MAX_LINES;
    StringBuilder ruleContent = new StringBuilder();
    for (int i = 0; i < Math.min(lines.length, AGENTS_MD_MAX_LINES); i++) {
        ruleContent.append(lines[i]).append("\n");
    }
    if (truncated) {
        ruleContent.append(AGENTS_MD_TRUNCATED_HINT);
    }
    
    sb.append("## 工作区规则\n\n");
    sb.append(ruleContent);
    sb.append("\n");
}
```

### 4.2 LOCAL 模式实现

#### 4.2.1 创建 LocalAgentsMdRegistry

**新建文件**: `backend/src/main/java/cn/etarch/mao/harness/core/LocalAgentsMdRegistry.java`

```java
package cn.etarch.mao.harness.core;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 会话级 AGENTS.md 内容上报登记表（内存态，仅 LOCAL 模式使用）。
 * <p>
 * 桌面客户端在 LOCAL 模式下发送消息时，附带读取到的本地 AGENTS.md 内容。
 * 服务端缓存后在构建系统提示词时注入。
 */
@Slf4j
@Component
public class LocalAgentsMdRegistry {

    /** sessionId → 最近一次上报的 AGENTS.md 内容 */
    private final Map<Long, String> reported = new ConcurrentHashMap<>();

    /**
     * 上报（覆盖式）某会话当前的 AGENTS.md 内容。
     * @param sessionId 会话 ID
     * @param content   AGENTS.md 文件内容，null 或空白表示文件不存在
     */
    public void report(Long sessionId, String content) {
        if (sessionId == null) return;
        if (content == null || content.isBlank()) {
            reported.remove(sessionId);
        } else {
            reported.put(sessionId, content);
        }
    }

    /**
     * 获取某会话最近一次上报的 AGENTS.md 内容（可能为 null）。
     */
    public String get(Long sessionId) {
        if (sessionId == null) return null;
        return reported.get(sessionId);
    }

    /**
     * 会话结束时清理，避免内存无限增长。
     */
    public void clear(Long sessionId) {
        if (sessionId != null) {
            reported.remove(sessionId);
        }
    }
}
```

#### 4.2.2 修改 AgentExecutionContext

**文件**: `backend/src/main/java/cn/etarch/mao/harness/core/AgentExecutionContext.java`

添加字段：

```java
/** 桌面端上报的 AGENTS.md 内容（仅 LOCAL 模式） */
private String agentsMdContent;
```

#### 4.2.3 修改 HarnessService

**文件**: `backend/src/main/java/cn/etarch/mao/harness/core/HarnessService.java`

1. 注入依赖：

```java
private final LocalAgentsMdRegistry localAgentsMdRegistry;
```

2. 在 `buildContext()` 方法中，LOCAL 模式分支下获取上报内容：

```java
// LOCAL 模式：获取桌面端上报的 AGENTS.md 内容
if ("LOCAL".equalsIgnoreCase(context.getExecutionMode())) {
    String agentsMdContent = localAgentsMdRegistry.get(sessionId);
    context.setAgentsMdContent(agentsMdContent);
}
```

#### 4.2.4 修改 StreamingWsHandler

**文件**: `backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java`

1. 注入依赖：

```java
private final LocalAgentsMdRegistry localAgentsMdRegistry;
```

2. 在处理 `send_message` 和 `edit_and_resend` 消息时，解析 `agentsMdContent` 字段并上报：

```java
// 解析桌面端上报的 AGENTS.md 内容
String agentsMdContent = data.path("agentsMdContent").asText(null);
localAgentsMdRegistry.report(sessionId, agentsMdContent);
```

3. 会话结束时清理：

```java
localAgentsMdRegistry.clear(sessionId);
```

### 4.3 WebSocket 协议扩展

桌面客户端在 `send_message` 和 `edit_and_resend` 消息中新增可选字段：

```json
{
  "type": "send_message",
  "sessionId": 11,
  "data": {
    "content": "用户消息内容",
    "localSkills": [...],
    "agentsMdContent": "# 项目规则\n\n- 使用 TypeScript\n- 遵循 ESLint 规范\n..."
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| agentsMdContent | string | 否 | AGENTS.md 文件内容，文件不存在时传 null 或不传 |

## 5. 落地清单

### 5.1 后端开发任务

| 序号 | 任务 | 文件 | 优先级 |
|------|------|------|--------|
| 1 | 创建 LocalAgentsMdRegistry 类 | `backend/src/main/java/cn/etarch/mao/harness/core/LocalAgentsMdRegistry.java` | P0 |
| 2 | AgentExecutionContext 增加 agentsMdContent 字段 | `backend/src/main/java/cn/etarch/mao/harness/core/AgentExecutionContext.java` | P0 |
| 3 | PromptEngine 实现 appendWorkspaceRules 方法 | `backend/src/main/java/cn/etarch/mao/harness/core/PromptEngine.java` | P0 |
| 4 | HarnessService 注入 LocalAgentsMdRegistry 并在 buildContext 中使用 | `backend/src/main/java/cn/etarch/mao/harness/core/HarnessService.java` | P0 |
| 5 | StreamingWsHandler 解析并上报 agentsMdContent | `backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java` | P0 |
| 6 | 编写 LocalAgentsMdRegistry 单元测试 | `backend/src/test/java/cn/etarch/mao/harness/core/LocalAgentsMdRegistryTest.java` | P1 |
| 7 | 编写 PromptEngine 关于 AGENTS.md 注入的单元测试 | `backend/src/test/java/cn/etarch/mao/harness/core/PromptEngineTest.java` | P1 |
| 8 | 会话结束时清理 registry（StreamingWsHandler close 事件） | `backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java` | P1 |

### 5.2 桌面端开发任务

| 序号 | 任务 | 说明 | 优先级 |
|------|------|------|--------|
| 9 | 扫描工作区 AGENTS.md 文件 | 在用户选择的工作区根目录下查找 AGENTS.md | P0 |
| 10 | 读取文件内容 | 读取 AGENTS.md 内容，处理编码和异常 | P0 |
| 11 | 随消息上报 | 在 send_message / edit_and_resend 消息中附带 agentsMdContent 字段 | P0 |
| 12 | 文件监听（可选） | 监听 AGENTS.md 文件变化，实时更新上报内容 | P2 |

### 5.3 测试验证

| 序号 | 测试场景 | 预期结果 |
|------|----------|----------|
| T-1 | CLOUD 模式，工作区有 AGENTS.md | 系统提示词末尾包含 "## 工作区规则" 和文件内容 |
| T-2 | CLOUD 模式，工作区无 AGENTS.md | 系统提示词无变化 |
| T-3 | CLOUD 模式，AGENTS.md 超过 200 行 | 仅展示前 200 行，末尾有截断提示 |
| T-4 | CLOUD 模式，AGENTS.md 为空文件 | 系统提示词无变化 |
| T-5 | LOCAL 模式，桌面端上报 AGENTS.md | 系统提示词包含上报的内容 |
| T-6 | LOCAL 模式，桌面端未上报 | 系统提示词无变化 |
| T-7 | LOCAL 模式，上报内容超过 200 行 | 服务端截断并添加提示 |
| T-8 | 同一会话多次请求 | 每次都重新读取（CLOUD）或使用最新上报值（LOCAL） |

### 5.4 文档更新

| 序号 | 文档 | 更新内容 |
|------|------|----------|
| D-1 | WebSocket 协议文档 | 新增 agentsMdContent 字段说明 |
| D-2 | 用户使用手册 | 说明 AGENTS.md 的用途和使用方式 |
| D-3 | API 文档（如有） | 更新会话相关接口说明 |

## 6. 风险与注意事项

### 6.1 安全风险

| 风险 | 缓解措施 |
|------|----------|
| AGENTS.md 包含恶意指令（Prompt 注入） | 与系统提示词同等信任级别，用户对自己的工作区负责 |
| LOCAL 模式上报超大内容 | 服务端在截断逻辑前增加总字符数限制（建议 100KB） |

### 6.2 性能影响

| 场景 | 影响 | 说明 |
|------|------|------|
| CLOUD 模式文件读取 | 每次请求增加一次文件 IO | AGENTS.md 通常很小（<10KB），影响可忽略 |
| 系统提示词变长 | 增加 token 消耗 | 200 行约 2000-4000 tokens，需关注上下文窗口 |

### 6.3 兼容性

- 向后兼容：不传 agentsMdContent 字段时行为不变
- 桌面端需同步更新，否则 LOCAL 模式下此功能不生效

## 7. 后续扩展（不在本次范围）

| 扩展项 | 说明 |
|--------|------|
| 支持多级 AGENTS.md | 项目根目录 + 子目录，按优先级合并 |
| 支持 .mao/agents.md | 隐藏目录下的配置文件 |
| AGENTS.md 语法校验 | 检查 Markdown 格式，给出警告 |
| Web UI 编辑器 | 在界面上直接编辑 AGENTS.md |
