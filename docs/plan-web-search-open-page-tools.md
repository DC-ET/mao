# Agent 内置工具：web_search / open_web_page 技术方案

## 一、需求背景

当前 Agent 系统已具备文件操作（read_file、write_file、edit_file）、搜索（glob_search、grep_search）、Shell 执行（shell）、任务管理（task_*）、委派（delegate）等内置工具，但缺少对外部互联网信息的获取能力。Agent 在回答需要实时信息、最新文档或外部网页内容的问题时，只能依赖 LLM 自身的训练数据，无法获取最新信息。

新增 `web_search` 和 `open_web_page` 两个内置工具，使 Agent 具备全网搜索和网页抓取的能力，补齐"感知外部世界"的工具缺口。

## 二、需求描述

### 2.1 web_search

提供全网搜索能力，底层对接 Tavily Search API。

- **输入参数**：搜索关键词、最大结果数（默认 5）、搜索深度等
- **输出**：搜索结果列表，每条包含标题、URL、内容摘要
- **执行模式**：仅服务端执行（SERVER_ONLY），不委托给桌面客户端

### 2.2 open_web_page

根据 URL 打开网页并返回 Markdown 格式的内容，帮助 Agent 获取外部信息。

- **输入参数**：目标 URL
- **输出**：网页正文内容的 Markdown 格式文本
- **技术路线**：Boilerpipe 提取正文 → flexmark 转换为 Markdown
- **执行模式**：仅服务端执行（SERVER_ONLY），不委托给桌面客户端

## 三、技术选型

### 3.1 整体架构

两个工具均作为 Spring `@Component` Bean 实现 `Tool` 接口，通过 `ToolRegistry` 自动注册。在 `ToolDispatcher` 中将两个工具名加入 `SERVER_ONLY_TOOLS` 集合，确保始终在服务端执行。

```
┌──────────────────────────────────────────────────┐
│                   ToolDispatcher                  │
│  SERVER_ONLY_TOOLS: task_*, delegate,            │
│     web_search, open_web_page                    │
└──────────────────────┬───────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
   ┌──────▼──────┐          ┌──────▼──────┐
   │ WebSearch   │          │ OpenWebPage │
   │ Tool        │          │ Tool        │
   └──────┬──────┘          └──────┬──────┘
          │                         │
   ┌──────▼──────┐          ┌──────▼──────┐
   │ Tavily API  │          │ OkHttp GET  │
   │ (OkHttp)    │          │ + Boilerpipe│
   └─────────────┘          │ + flexmark  │
                            └─────────────┘
```

### 3.2 依赖选型

| 依赖 | 用途 | Maven Artifact |
|------|------|----------------|
| OkHttp 4.12.0 | HTTP 客户端（已有） | `com.squareup.okhttp3:okhttp` |
| Boilerpipe | 网页正文提取 | `de.l3s.boilerpipe:boilerpipe:1.1.0` |
| flexmark-html2md-converter | HTML → Markdown 转换 | `com.vladsch.flexmark:flexmark-html2md-converter:0.64.8` |
| xercesImpl | Boilerpipe 依赖（HTML 解析） | `xerces:xercesImpl:2.12.2` |

> Boilerpipe 的 `de.l3s.boilerpipe:boilerpipe:1.1.0` 传递依赖 `xerces:xercesImpl:2.9.1`（存在已知 CVE），显式声明 `2.12.2` 覆盖。

### 3.3 Tavily Search API

| 项目 | 说明 |
|------|------|
| 端点 | `POST https://api.tavily.com/search` |
| 认证 | `Content-Type: application/json`，body 中传 `api_key` |
| 关键参数 | `query`（必填）、`max_results`（默认 5）、`search_depth`（`"basic"` / `"advanced"`） |
| 响应字段 | `results[]` → `title`、`url`、`content`（摘要） |

### 3.4 配置项设计

在 `application.yml` 中新增：

```yaml
app:
  harness:
    tavily:
      api-key: ${TAVILY_API_KEY:}
      base-url: ${TAVILY_BASE_URL:https://api.tavily.com}
      connect-timeout: 10000
      read-timeout: 30000
      max-results: 5
    web-page:
      connect-timeout: 10000
      read-timeout: 30000
      max-content-length: 500000
      user-agent: "Mozilla/5.0 (compatible; AgentWorkbench/1.0)"
```

通过 `@ConfigurationProperties` 分别绑定为 `TavilyConfig` 和 `WebPageConfig` 配置类。

## 四、实现步骤

### 4.1 新增配置类

#### TavilyConfig

```
backend/src/main/java/cn/etarch/mao/config/TavilyConfig.java
```

- 使用 `@ConfigurationProperties(prefix = "app.harness.tavily")`
- 字段：`apiKey`、`baseUrl`、`connectTimeout`（默认 10000ms）、`readTimeout`（默认 30000ms）、`maxResults`（默认 5）

#### WebPageConfig

```
backend/src/main/java/cn/etarch/mao/config/WebPageConfig.java
```

- 使用 `@ConfigurationProperties(prefix = "app.harness.web-page")`
- 字段：`connectTimeout`（默认 10000ms）、`readTimeout`（默认 30000ms）、`maxContentLength`（默认 500000）、`userAgent`

### 4.2 新增 WebSearchTool

```
backend/src/main/java/cn/etarch/mao/harness/tool/impl/WebSearchTool.java
```

**接口实现**：

| 方法 | 值 |
|------|---|
| `getName()` | `"web_search"` |
| `getDescription()` | `"使用 Tavily 搜索引擎进行全网搜索。返回匹配的网页结果列表，包含标题、URL 和内容摘要。帮助 Agent 获取最新信息和外部知识。"` |
| `getToolPrompt()` | 需覆盖，返回搜索行为指南（见下方） |

**输入参数**：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 搜索关键词或问题 |
| `max_results` | integer | 否 | 5 | 返回的最大结果数（1-10） |
| `search_depth` | string | 否 | `"basic"` | 搜索深度，`"basic"` 或 `"advanced"` |

**输出 Schema**：

```json
{
  "type": "object",
  "properties": {
    "query": {"type": "string"},
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": {"type": "string"},
          "url": {"type": "string"},
          "content": {"type": "string"}
        }
      }
    },
    "total_results": {"type": "integer"},
    "search_time": {"type": "number"}
  }
}
```

**执行逻辑**（`execute(String arguments, Long sessionId, String workspace)`）：

1. 解析 JSON 参数，校验 `query` 必填
2. 构建 Tavily API 请求体：
   ```json
   {
     "api_key": "<从配置获取>",
     "query": "<用户搜索词>",
     "max_results": 5,
     "search_depth": "basic"
   }
   ```
3. 使用 OkHttp 发送 POST 请求到 `{baseUrl}/search`
4. 解析响应，提取 `results` 数组
5. 返回 JSON：`{"query": "...", "results": [...], "total_results": N, "search_time": ...}`
6. 异常处理：网络超时、API 错误、API Key 未配置等情况返回 `{"error": "..."}`

**Tool Prompt（行为指南注入）**：

```markdown
## web_search 工具使用指南

- web_search 用于搜索互联网获取最新信息，底层对接 Tavily 搜索引擎。
- 当需要实时信息、最新文档、近期事件时使用此工具。
- 搜索结果包含标题、URL 和内容摘要。摘要可能不完整，如需获取完整内容请使用 open_web_page 打开具体 URL。
- 搜索关键词应简洁精准，避免过长的自然语言问题。
- 搜索结果可能有噪声，请评估信息可靠性后再引用。
```

### 4.3 新增 OpenWebPageTool

```
backend/src/main/java/cn/etarch/mao/harness/tool/impl/OpenWebPageTool.java
```

**接口实现**：

| 方法 | 值 |
|------|---|
| `getName()` | `"open_web_page"` |
| `getDescription()` | `"打开指定 URL 对应的网页，提取正文内容并以 Markdown 格式返回。帮助 Agent 获取外部网页的详细内容。"` |
| `getToolPrompt()` | 需覆盖，返回使用指南（见下方） |

**输入参数**：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | string | 是 | — | 目标网页 URL（需包含协议，如 `https://...`） |

**输出 Schema**：

```json
{
  "type": "object",
  "properties": {
    "url": {"type": "string"},
    "title": {"type": "string"},
    "content": {"type": "string"},
    "content_length": {"type": "integer"},
    "truncated": {"type": "boolean"}
  }
}
```

**执行逻辑**（`execute(String arguments, Long sessionId, String workspace)`）：

1. 解析 JSON 参数，提取 `url`
2. 校验 URL：必须以 `http://` 或 `https://` 开头，不允许 `file://` 等本地协议
3. 使用 OkHttp 发送 GET 请求，设置 User-Agent、超时等
4. 限制响应体大小（读取最多 `maxContentLength` 字节）
5. 使用 Boilerpipe `ArticleExtractor` 提取网页正文（返回 HTML 字符串）
6. 使用 flexmark `HtmlConverter` 将正文 HTML 转换为 Markdown
7. 截断过长内容（默认 500000 字符）
8. 返回 JSON：`{"url": "...", "title": "...", "content": "...", "content_length": N, "truncated": true/false}`
9. 异常处理：DNS 解析失败、连接超时、HTTP 4xx/5xx、内容类型非 HTML 等，返回 `{"error": "...", "url": "..."}`

**Tool Prompt（行为指南注入）**：

```markdown
## open_web_page 工具使用指南

- open_web_page 用于打开指定 URL 并获取网页的 Markdown 格式正文内容。
- 当需要阅读某篇具体文章、文档页面、API 参考等网页的详细内容时使用。
- 网页内容会经过正文提取（去除导航栏、广告等干扰内容）后转为 Markdown。
- 如果页面需要 JavaScript 渲染（SPA 应用），提取的内容可能不完整。
- 建议配合 web_search 使用：先用 web_search 发现相关页面，再用 open_web_page 获取详情。
```

### 4.4 修改 ToolDispatcher

```
backend/src/main/java/cn/etarch/mao/harness/tool/ToolDispatcher.java
```

将 `web_search` 和 `open_web_page` 加入 `SERVER_ONLY_TOOLS` 集合：

```java
private static final Set<String> SERVER_ONLY_TOOLS = Set.of(
        "task_create", "task_update", "task_list", "task_delete", "delegate",
        "web_search", "open_web_page");
```

### 4.5 修改 ToolResultSummarizer

```
backend/src/main/java/cn/etarch/mao/session/util/ToolResultSummarizer.java
```

在 `summarize()` 的 switch 中新增两个 case：

```java
case "web_search" -> summarizeWebSearch(arguments, result);
case "open_web_page" -> summarizeOpenWebPage(arguments, result);
```

**summarizeWebSearch 实现**：

```java
private static String summarizeWebSearch(String arguments, String result) {
    String query = extractJsonString(arguments, "query");
    JsonNode node = parseJson(result);
    if (node == null) return "搜索 " + (query != null ? truncate(query, 30) : "");
    int count = node.has("total_results") ? node.get("total_results").asInt() : 0;
    return "搜索 " + truncate(query, 30) + " (" + count + " 条结果)";
}
```

**summarizeOpenWebPage 实现**：

```java
private static String summarizeOpenWebPage(String arguments, String result) {
    String url = extractJsonString(arguments, "url");
    JsonNode node = parseJson(result);
    if (node == null) return "打开网页 " + (url != null ? formatUrl(url) : "");
    String title = node.has("title") ? node.get("title").asText("") : "";
    boolean truncated = node.has("truncated") && node.get("truncated").asBoolean();
    return "打开网页" + (!title.isEmpty() ? " " + truncate(title, 30) : "") +
           (truncated ? " (内容已截断)" : "");
}
```

### 4.6 新增 application.yml 配置

在 `app.harness` 下新增两个配置段（同时更新 `application-example.yml`）：

```yaml
app:
  harness:
    # Tavily Search
    tavily:
      api-key: ${TAVILY_API_KEY:}
      base-url: ${TAVILY_BASE_URL:https://api.tavily.com}
      connect-timeout: 10000
      read-timeout: 30000
      max-results: 5

    # Web Page Fetching
    web-page:
      connect-timeout: 10000
      read-timeout: 30000
      max-content-length: 500000
      user-agent: "Mozilla/5.0 (compatible; AgentWorkbench/1.0)"
```

### 4.7 更新 pom.xml 依赖

新增 3 个依赖（OkHttp 已有）：

```xml
<!-- Boilerpipe: web page content extraction -->
<dependency>
    <groupId>de.l3s.boilerpipe</groupId>
    <artifactId>boilerpipe</artifactId>
    <version>1.1.0</version>
</dependency>

<!-- flexmark: HTML to Markdown conversion -->
<dependency>
    <groupId>com.vladsch.flexmark</groupId>
    <artifactId>flexmark-html2md-converter</artifactId>
    <version>0.64.8</version>
</dependency>

<!-- Override Boilerpipe's transitive xercesImpl for security -->
<dependency>
    <groupId>xerces</groupId>
    <artifactId>xercesImpl</artifactId>
    <version>2.12.2</version>
</dependency>
```

## 五、落地清单

### 5.1 新增文件

| # | 文件 | 说明 |
|---|------|------|
| 1 | `backend/src/main/java/cn/etarch/mao/config/TavilyConfig.java` | Tavily 配置类，绑定 `app.harness.tavily.*` |
| 2 | `backend/src/main/java/cn/etarch/mao/config/WebPageConfig.java` | 网页抓取配置类，绑定 `app.harness.web-page.*` |
| 3 | `backend/src/main/java/cn/etarch/mao/harness/tool/impl/WebSearchTool.java` | web_search 工具实现 |
| 4 | `backend/src/main/java/cn/etarch/mao/harness/tool/impl/OpenWebPageTool.java` | open_web_page 工具实现 |

### 5.2 修改文件

| # | 文件 | 修改内容 |
|---|------|----------|
| 5 | `backend/src/main/java/cn/etarch/mao/harness/tool/ToolDispatcher.java` | `SERVER_ONLY_TOOLS` 集合新增 `"web_search"`、`"open_web_page"` |
| 6 | `backend/src/main/java/cn/etarch/mao/session/util/ToolResultSummarizer.java` | 新增 `summarizeWebSearch()`、`summarizeOpenWebPage()` 方法及 switch case |
| 7 | `backend/pom.xml` | 新增 Boilerpipe、flexmark-html2md-converter、xercesImpl 依赖 |
| 8 | `backend/src/main/resources/application.yml` | 新增 `app.harness.tavily.*` 和 `app.harness.web-page.*` 配置 |
| 9 | `backend/src/main/resources/application-example.yml` | 同步新增上述配置段 |

### 5.3 不需要改动的文件

| 文件 | 原因 |
|------|------|
| `ToolRegistry` | Spring 自动注入 `List<Tool>`，新增 `@Component` 类自动注册 |
| `PromptEngine` | 自动从 `Tool.getInputSchema()` / `getDescription()` / `getToolPrompt()` 生成 LLM 工具定义和行为指令 |
| `HarnessService` | `toolRegistry.getAllTools()` 已包含新工具 |
| `Tool.java` | 接口不变 |
| 桌面端 `main.cjs` | SERVER_ONLY 工具不委托桌面端，无需修改 |
| 数据库 migration | 无需新增表或字段 |

## 六、不做的范围

以下内容明确不在本期范围内：

1. **不支持 LOCAL 模式执行**：两个工具均为 SERVER_ONLY，不委托桌面端。用户本地机器网络环境与云端不同，且桌面端需额外安装 Java 解析库，复杂度高且收益低。
2. **不支持搜索结果的 LLM 智能重排**：Tavily 返回的排序结果直接透传，不做二次 LLM 重排。
3. **不支持网页抓取的 JavaScript 渲染**：使用 OkHttp 直接 HTTP GET，不集成 headless browser。SPA 页面正文提取可能不完整，此限制在 tool prompt 中已注明。
4. **不支持图片/多媒体内容下载与转换**：open_web_page 只返回文本 Markdown，不处理图片、视频等多媒体资源。
5. **不做搜索缓存**：每次调用实时请求 Tavily，不引入缓存层。避免缓存失效策略的复杂度。
6. **不做 URL 安全扫描或域名白名单**：open_web_page 接受任意 http/https URL，不做 SSRF 防护域名白名单。安全约束依赖网络层或后续迭代补强。
7. **不做搜索结果的分页**：单次调用返回固定数量的结果，不支持 offset/page 翻页。
8. **不提供独立的 Tavily API 管理界面**：API Key 通过环境变量配置，不在管理后台做动态管理界面。

## 七、风险与注意事项

| 风险 | 应对措施 |
|------|----------|
| Tavily API Key 未配置 | 工具执行时检测空 Key，返回明确错误提示"Tavily API Key 未配置" |
| 目标网页响应过大 | OkHttp 读取时限制 `maxContentLength` 字节，超过截断并标记 `truncated: true` |
| 网页编码非 UTF-8 | Boilerpipe 内置编码检测（基于 `boilerpipe` 的 `HTMLFetcher`），同时从 HTTP Content-Type header 或 HTML meta charset 获取编码 |
| Boilerpipe 版本安全性 | 显式声明 `xercesImpl:2.12.2` 覆盖 Boilerpipe 传递依赖的旧版本 |
| 网络超时 | 可配置 connect/read timeout，超时后返回友好错误信息 |
| OkHttp Client 复用 | `WebSearchTool` 和 `OpenWebPageTool` 各自创建内部 OkHttpClient 实例，避免与 `OpenAiLlmAdapter` 的全局 client 超时配置冲突 |
