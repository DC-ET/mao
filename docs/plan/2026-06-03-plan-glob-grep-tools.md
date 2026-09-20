# 实现计划：添加 glob_search / grep_search 内置工具

## 目标

在 Agent harness 层新增两个文件搜索工具 `glob_search` 和 `grep_search`，作为与 `read_file`/`write_file`/`edit_file` 同级的内置工具，支持 CLOUD 和 LOCAL 双执行模式。

## 涉及文件

| 操作 | 文件 |
|------|------|
| 新增 | `backend/src/main/java/cn/etarch/mao/harness/tool/impl/GlobSearchTool.java` |
| 新增 | `backend/src/main/java/cn/etarch/mao/harness/tool/impl/GrepSearchTool.java` |
| 修改 | `backend/src/main/java/cn/etarch/mao/session/util/ToolResultSummarizer.java` |
| 修改 | `desktop/electron/main.cjs` — `executeToolByName` 增加两个 case + 对应 handler |

**不需要改动**：ToolRegistry、ToolDispatcher、PromptEngine、HarnessService — 自动注册 + 自动路由。

---

## 一、GlobSearchTool

**路径**：`backend/src/main/java/cn/etarch/mao/harness/tool/impl/GlobSearchTool.java`

### 类结构

```java
@Slf4j
@Component
public class GlobSearchTool implements Tool {

    private final ObjectMapper objectMapper;
    private final PathSandbox pathSandbox;

    public GlobSearchTool(ObjectMapper objectMapper, PathSandbox pathSandbox) { ... }
}
```

### 接口实现

| 方法 | 值 |
|------|---|
| `getName()` | `"glob_search"` |
| `getDescription()` | `"Search files by glob pattern. Returns matching file paths, search root, and whether results are truncated."` |
| `getInputSchema()` | 见下方参数表 |
| `getOutputSchema()` | `{"type":"object","properties":{"files":{"type":"array","items":{"type":"string"}},"search_root":{"type":"string"},"truncated":{"type":"boolean"},"total_matched":{"type":"integer"}}}` |
| `getToolPrompt()` | 不覆盖（返回 null） |

### 输入参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `pattern` | string | 是 | — | glob 模式，如 `*.java`、`src/**/*.xml` |
| `path` | string | 否 | workspace 根目录 | 搜索起始目录 |
| `head_limit` | integer | 否 | 100 | 最大返回文件数 |

### execute 逻辑（覆盖 `execute(String arguments, String workspace)`）

1. 解析 JSON 参数，提取 `pattern`、`path`、`head_limit`
2. 调用 `pathSandbox.resolve(path, workspace)` 获取搜索根目录 `searchRoot`；`path` 为空时用 `pathSandbox.getEffectiveWorkspaceRoot(workspace)`
3. **判断 ripgrep 可用性**：`isRgAvailable()` — 执行 `rg --version`，成功则用 rg，失败则用纯 Java
4. **rg 路径**：`rg --files --glob <pattern> <searchRoot>`，收集 stdout 行，截取前 `head_limit` 条
5. **纯 Java 路径**：`Files.walk(searchRoot)` + `PathMatcher("glob:" + pattern)` 匹配，收集前 `head_limit` 条
6. 结果路径转为相对于 `searchRoot` 的相对路径（若搜索根为 workspace）或绝对路径
7. 返回 JSON：`{"files": [...], "search_root": "...", "truncated": true/false, "total_matched": N}`
8. 异常时返回 `{"files": [], "error": "..."}`

### rg 可用性检测

```java
private volatile Boolean rgAvailable;

private boolean isRgAvailable() {
    if (rgAvailable != null) return rgAvailable;
    try {
        Process p = new ProcessBuilder("rg", "--version").redirectErrorStream(true).start();
        boolean ok = p.waitFor(5, TimeUnit.SECONDS) && p.exitValue() == 0;
        rgAvailable = ok;
    } catch (Exception e) {
        rgAvailable = false;
    }
    return rgAvailable;
}
```

用 `volatile` 缓存结果，进程启动后只检测一次。

---

## 二、GrepSearchTool

**路径**：`backend/src/main/java/cn/etarch/mao/harness/tool/impl/GrepSearchTool.java`

### 类结构

同 GlobSearchTool，注入 `ObjectMapper` + `PathSandbox`。

### 接口实现

| 方法 | 值 |
|------|---|
| `getName()` | `"grep_search"` |
| `getDescription()` | `"Search file contents by text or regex pattern. Returns matching lines with file paths and line numbers."` |
| `getInputSchema()` | 见下方参数表 |
| `getOutputSchema()` | `{"type":"object","properties":{"matches":{"type":"array"},"truncated":{"type":"boolean"},"total_matches":{"type":"integer"}}}` |
| `getToolPrompt()` | 不覆盖（返回 null） |

### 输入参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `pattern` | string | 是 | — | 搜索文本或正则 |
| `path` | string | 否 | workspace 根目录 | 搜索目录或文件 |
| `glob` | string | 否 | — | 文件过滤，如 `*.java` |
| `ignore_case` | boolean | 否 | false | 忽略大小写 |
| `context_lines` | integer | 否 | 0 | 上下文行数 |
| `max_output_chars` | integer | 否 | 10000 | 最大输出字符数 |

### execute 逻辑（覆盖 `execute(String arguments, String workspace)`）

1. 解析 JSON 参数
2. `pathSandbox.resolve(path, workspace)` 或 `getEffectiveWorkspaceRoot(workspace)` 获取搜索根
3. **rg 可用时**：
   ```
   rg [--ignore-case] [--context N] [--glob <glob>] --line-number --no-heading <pattern> <searchRoot>
   ```
   收集 stdout，按 `max_output_chars` 截断
4. **纯 Java 时**：
   - `Files.walk` 枚举文件，`glob` 非空时用 `PathMatcher` 过滤
   - 每个文件逐行 `BufferedReader` 读取，`Pattern.compile(pattern, flags)` 匹配
   - 收集匹配行：`{"file": "相对路径", "line": 行号, "content": "行内容", "context_before": [...], "context_after": [...]}`
   - 字符数累加到 `max_output_chars` 后停止
5. 返回 JSON：`{"matches": [...], "truncated": true/false, "total_matches": N}`
6. 异常时返回 `{"matches": [], "error": "..."}`

### rg 可用性

与 GlobSearchTool 共用同一检测逻辑。两个类各自维护一个 `volatile Boolean rgAvailable` 字段（逻辑相同，不抽取公共类，保持简单）。

---

## 三、ToolResultSummarizer 修改

在 `summarize()` 的 switch 中增加两个 case，替换已有的 `case "glob", "list"` （注意 `list` 是 Shell 的 list action，不应走 glob 摘要，这是一个已有小 bug）：

```java
case "glob_search" -> summarizeGlobSearch(arguments, result);
case "grep_search" -> summarizeGrepSearch(arguments, result);
```

原有的 `case "glob", "list"` → `case "list"` 改为走 `summarizeGeneric`（或保留现有逻辑但仅用于 `"list"`）。

### summarizeGlobSearch

```java
private static String summarizeGlobSearch(String arguments, String result) {
    String pattern = extractJsonString(arguments, "pattern");
    JsonNode node = parseJson(result);
    if (node == null) return "搜索 " + (pattern != null ? pattern : "文件");
    int count = node.has("files") ? node.get("files").size() : 0;
    boolean truncated = node.has("truncated") && node.get("truncated").asBoolean();
    return "搜索 " + (pattern != null ? pattern : "文件") + " (" + count + " 个文件" + (truncated ? ", 已截断" : "") + ")";
}
```

### summarizeGrepSearch

```java
private static String summarizeGrepSearch(String arguments, String result) {
    String pattern = extractJsonString(arguments, "pattern");
    JsonNode node = parseJson(result);
    if (node == null) return "搜索内容 " + (pattern != null ? truncate(pattern, 30) : "");
    int count = node.has("total_matches") ? node.get("total_matches").asInt() : 0;
    boolean truncated = node.has("truncated") && node.get("truncated").asBoolean();
    return "搜索内容 " + truncate(pattern, 30) + " (" + count + " 处匹配" + (truncated ? ", 已截断" : "") + ")";
}
```

---

## 四、桌面端 main.cjs 改动

**文件**：`desktop/electron/main.cjs`

### 4.1 executeToolByName 增加路由

当前 `executeToolByName`（第 256 行）是一个 switch-case，每个工具需手动添加：

```javascript
case 'glob_search':
  return await handleLocalGlobSearch(parsedArgs, workspace)
case 'grep_search':
  return await handleLocalGrepSearch(parsedArgs, workspace)
```

### 4.2 handleLocalGlobSearch

逻辑与服务端 GlobSearchTool 一致：
1. 解析参数：`pattern`、`path`（默认 workspace）、`head_limit`（默认 100）
2. rg 可用时：`child_process.execFile('rg', ['--files', '--glob', pattern, searchRoot])`，收集 stdout 行
3. rg 不可用时：Node.js `fs.readdirSync` 递归 + `minimatch` 或手写 glob 匹配（项目已有 `minimatch` 依赖则复用，否则用 `path.match` + picomatch）
4. 截取前 `head_limit` 条，返回 `{ files, search_root, truncated, total_matched }`

### 4.3 handleLocalGrepSearch

逻辑与服务端 GrepSearchTool 一致：
1. 解析参数：`pattern`、`path`、`glob`、`ignore_case`、`context_lines`、`max_output_chars`（默认 10000）
2. rg 可用时：构建 `rg` 命令行参数，执行并收集 stdout
3. rg 不可用时：`fs.readFileSync` + `readline` 逐行匹配 `new RegExp(pattern, flags)`
4. 按 `max_output_chars` 截断，返回 `{ matches, truncated, total_matches }`

### 4.4 rg 可用性检测

在模块顶层缓存，与服务端相同策略：

```javascript
let rgAvailable = null
async function isRgAvailable() {
  if (rgAvailable !== null) return rgAvailable
  try {
    await execFile('rg', ['--version'])
    rgAvailable = true
  } catch {
    rgAvailable = false
  }
  return rgAvailable
}
```

---

## 五、不改动的部分（及原因）

| 文件 | 原因 |
|------|------|
| `ToolRegistry` | Spring 自动注入 `List<Tool>`，新 `@Component` 类自动注册 |
| `ToolDispatcher` | glob/grep 走通用路由（非 SERVER_ONLY），CLOUD 在服务端执行 rg/Java，LOCAL 委托给桌面端 |
| `PromptEngine` | 自动从 `getInputSchema()` 生成 ToolDefinition |
| `HarnessService` | `toolRegistry.getAllTools()` 已包含新工具 |
| `Tool.java` | 接口不变 |
| `PathSandbox` | 现有 `resolve()` 和 `getEffectiveWorkspaceRoot()` 满足需求 |
