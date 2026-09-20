# 云端模式 Git 初始化工作区方案

## 一、背景

当前云端模式创建会话时，用户只能输入一个项目名称（`cloudProjectKey`），后端创建一个空目录作为工作区。用户希望在云端模式下也能通过 Git 地址（`git clone`）来初始化工作区，从而快速从已有仓库开始工作。

---

## 二、现有架构分析

### 2.1 当前 CLOUD 模式创建流程

```
用户 → ChatInput/NewTaskDialog → createSession API
  → SessionService.createSession()
     ├─ 有 cloudProjectKey → 创建 /workspace-root/{userId}/projects/{slug}
     └─ 无 cloudProjectKey → 创建 /workspace-root/{userId}/{sessionId}
  → environmentInfoProvider.detect() 检测环境信息
```

### 2.2 关键现有字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `cloudProjectKey` | String | 用户输入的项目名（slug），对应 `projects/{slug}` 目录 |
| `isGit` | Boolean | 标记工作区是否处于 Git 仓库中 |
| `projectKey` | String | 存储到 session 表的项目标识 |

---

## 三、方案总览

在创建工作区时，**不增加并行输入框**，而是采用**先选择模式、再输入对应内容**的交互方式：

```
用户选择工作区来源：
  ┌───────────────────────────────────────┐
  │ ○ 选择已有工作区     （已有工作区时默认）  │
  │ ○ 创建新工作区       （无已有工作区时默认） │
  │ ○ 初始化 Git 工作区                    │
  └───────────────────────────────────────┘
        ↓ 根据选择，展示不同输入
  ┌───────────────────────────────────────┐
  │ 选择已有工作区 → 下拉列表选择项目名       │
  │ 创建新工作区   → 输入项目名（可选）       │
  │ 初始化 Git    → 输入 Git 地址 + 分支名   │
  └───────────────────────────────────────┘
```

**关键原则**：
- 三个选项互斥，同一时间只展示一个输入区域
- 如果当前已存在工作区，默认选中"选择已有工作区"
- 如果当前不存在工作区，默认选中"创建新工作区"

---

## 四、后端改动

### 4.1 SessionController — 新增请求参数

**文件**: `backend/src/main/java/cn/etarch/mao/session/controller/SessionController.java`

`CreateSessionRequest` DTO 新增字段：

```java
@Data
public static class CreateSessionRequest {
    // ... 现有字段 ...
    private String cloudProjectKey;   // 已有：项目名（slug）
    private String workspaceMode;     // 新增：existing | new | git
    private String gitCloneUrl;       // 新增：Git 仓库地址（支持 https 和 ssh）
    private String gitBranch;         // 新增：指定分支（可选，默认使用默认分支）
}
```

### 4.2 SessionService — 核心逻辑

**文件**: `backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`

修改 `createSession()` 中 CLOUD 模式分支：

```java
if ("CLOUD".equals(session.getExecutionMode())) {
    if ("git".equals(workspaceMode) && gitCloneUrl != null && !gitCloneUrl.isBlank()) {
        // === Git 初始化工作区 ===
        String slug = GitUrlParser.extractSlug(gitCloneUrl);
        String projectPath = CloudWorkspaceResolver.resolveProjectWorkspace(
                pathSandbox, userId, slug);
        ensureWorkspaceDirectory(projectPath);
        // 执行 git clone（同步，带超时）
        GitCloneResult result = gitClone(gitCloneUrl, gitBranch, projectPath);
        if (!result.success) {
            // 清理已创建目录
            deleteWorkspaceDirectory(projectPath);
            throw new BusinessException(ErrorCode.GIT_CLONE_FAILED, result.error);
        }
        session.setWorkspace(projectPath);
        session.setProjectKey(slug);
        session.setIsGit(true);
    } else if ("existing".equals(workspaceMode) && cloudProjectKey != null) {
        // === 选择已有工作区 ===
        String slug = CloudWorkspaceResolver.normalizeAndValidate(cloudProjectKey);
        String projectPath = CloudWorkspaceResolver.resolveProjectWorkspace(
                pathSandbox, userId, slug);
        if (!Files.exists(Paths.get(projectPath))) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "工作区不存在");
        }
        session.setWorkspace(projectPath);
        session.setProjectKey(slug);
    } else {
        // === 新建工作区（现有逻辑） ===
        if (cloudProjectKey != null && !cloudProjectKey.isBlank()) {
            String slug = CloudWorkspaceResolver.normalizeAndValidate(cloudProjectKey);
            String projectPath = CloudWorkspaceResolver.resolveProjectWorkspace(
                    pathSandbox, userId, slug);
            ensureWorkspaceDirectory(projectPath);
            session.setWorkspace(projectPath);
            session.setProjectKey(slug);
        } else {
            // 临时工作区（无项目名）
            String autoPath = pathSandbox.getWorkspaceRoot()
                    .resolve(String.valueOf(userId))
                    .resolve(String.valueOf(session.getId()))
                    .toString();
            ensureWorkspaceDirectory(autoPath);
            session.setWorkspace(autoPath);
            session.setProjectKey(deriveProjectKey(autoPath));
        }
    }
    sessionMapper.updateById(session);
}
```

### 4.3 Git Clone 实现

**新增文件**: `backend/src/main/java/cn/etarch/mao/session/service/GitOperationService.java`

```java
@Service
@Slf4j
public class GitOperationService {

    private static final long CLONE_TIMEOUT_SECONDS = 120;

    /**
     * Execute git clone synchronously.
     * Supports both HTTPS and SSH protocols.
     * SSH keys are assumed to be pre-configured on the server.
     */
    public GitCloneResult clone(String url, String branch, Path targetDir) {
        List<String> command = new ArrayList<>();
        command.add("git");
        command.add("clone");
        if (branch != null && !branch.isBlank()) {
            command.add("--branch");
            command.add(branch);
        }
        command.add(url);
        command.add(targetDir.toString());

        try {
            ProcessBuilder pb = new ProcessBuilder(command);
            pb.redirectErrorStream(true);
            Process process = pb.start();

            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                    log.debug("git clone [{}]: {}", url, line);
                }
            }

            boolean finished = process.waitFor(CLONE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return GitCloneResult.fail("Git clone timeout (>" +
                        CLONE_TIMEOUT_SECONDS + "s)");
            }

            int exitCode = process.exitValue();
            if (exitCode == 0) {
                log.info("git clone success: {} → {}", url, targetDir);
                return GitCloneResult.success();
            } else {
                log.warn("git clone failed: exit={}, output={}", exitCode, output);
                return GitCloneResult.fail("Git clone failed: " + output.toString());
            }
        } catch (IOException e) {
            log.error("git clone IO error for {}: {}", url, e.getMessage());
            return GitCloneResult.fail("Git clone error: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            return GitCloneResult.fail("Git clone interrupted");
        }
    }

    public record GitCloneResult(boolean success, String error) {
        public static GitCloneResult success() {
            return new GitCloneResult(true, null);
        }
        public static GitCloneResult fail(String error) {
            return new GitCloneResult(false, error);
        }
    }
}
```

### 4.4 Git URL 解析与校验

**新增文件**: `backend/src/main/java/cn/etarch/mao/session/util/GitUrlParser.java`

```java
public final class GitUrlParser {

    // HTTPS: https://github.com/user/repo.git  or  https://github.com/user/repo
    private static final Pattern HTTPS_PATTERN =
            Pattern.compile("^https://[\\w.-]+(/[\\w.-]+)*\\.git$",
                    Pattern.CASE_INSENSITIVE);

    // SSH: git@github.com:user/repo.git
    private static final Pattern SSH_PATTERN =
            Pattern.compile("^git@[\\w.-]+:[\\w.-]+(/[\\w.-]+)*\\.git$");

    /**
     * Extract repository name from Git URL.
     * https://github.com/user/my-repo.git → my-repo
     * git@github.com:user/my-repo.git      → my-repo
     */
    public static String extractSlug(String url) {
        if (url == null || url.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Git URL 不能为空");
        }

        String path;
        if (url.startsWith("https://") || url.startsWith("http://")) {
            if (!url.startsWith("https://")) {
                throw new BusinessException(ErrorCode.PARAM_INVALID,
                        "仅支持 HTTPS 协议的 Git 地址");
            }
            // Extract path part after host
            try {
                URI uri = new URI(url);
                path = uri.getPath();
            } catch (URISyntaxException e) {
                throw new BusinessException(ErrorCode.PARAM_INVALID,
                        "Git URL 格式无效");
            }
        } else if (url.startsWith("git@")) {
            // SSH format: git@host:path → extract path after ':'
            int colonIdx = url.indexOf(':');
            if (colonIdx < 0) {
                throw new BusinessException(ErrorCode.PARAM_INVALID,
                        "SSH Git 地址格式无效");
            }
            path = url.substring(colonIdx + 1);
        } else {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "不支持的 Git 地址协议，请使用 HTTPS 或 SSH");
        }

        // Extract repo name: strip leading / and trailing .git
        if (path.startsWith("/")) path = path.substring(1);
        if (path.endsWith(".git")) path = path.substring(0, path.length() - 4);

        // Take last segment as repo name
        int lastSlash = path.lastIndexOf('/');
        String name = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;

        if (name.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "无法从 Git URL 提取仓库名");
        }

        // Reuse existing slug validation
        return CloudWorkspaceResolver.normalizeAndValidate(name);
    }

    /**
     * Validate git URL format (HTTPS or SSH).
     */
    public static void validate(String url) {
        if (url == null || url.isBlank()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "Git URL 不能为空");
        }
        if (url.startsWith("https://")) {
            // basic sanity: must contain a host and path
            if (!url.matches("^https://[^\\s]+/[^\\s]+")) {
                throw new BusinessException(ErrorCode.PARAM_INVALID,
                        "Git URL 格式无效，示例: https://github.com/user/repo.git");
            }
        } else if (url.startsWith("git@")) {
            if (!url.matches("^git@[^\\s]+:[^\\s]+")) {
                throw new BusinessException(ErrorCode.PARAM_INVALID,
                        "SSH Git 地址格式无效，示例: git@github.com:user/repo.git");
            }
        } else {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "不支持的协议，仅支持 HTTPS 和 SSH");
        }
    }
}
```

### 4.5 获取已有工作区列表 API

**新增 API**: `GET /v1/sessions/cloud-projects`

**文件**: `SessionController.java`

```java
@GetMapping("/cloud-projects")
public Result<List<CloudProjectVO>> listCloudProjects(
        @AuthenticationPrincipal Long userId) {
    Path userRoot = pathSandbox.getWorkspaceRoot().resolve(String.valueOf(userId));
    Path projectsDir = userRoot.resolve("projects");
    List<CloudProjectVO> projects = new ArrayList<>();

    if (Files.exists(projectsDir)) {
        try (var stream = Files.list(projectsDir)) {
            stream.filter(Files::isDirectory)
                  .map(dir -> {
                      CloudProjectVO vo = new CloudProjectVO();
                      vo.setName(dir.getFileName().toString());
                      vo.setPath(dir.toString());
                      // Check if contains .git
                      vo.setIsGit(Files.exists(dir.resolve(".git")));
                      return vo;
                  })
                  .sorted(Comparator.comparing(CloudProjectVO::getName))
                  .forEach(projects::add);
        } catch (IOException e) {
            log.warn("Failed to list cloud projects for user {}: {}", userId, e.getMessage());
        }
    }
    return Result.ok(projects);
}
```

### 4.6 安全考量

| 约束 | 说明 |
|------|------|
| SSH Key | 由运维在服务器端预配置（`~/.ssh/config` 或 `ssh-agent`），不在代码中管理 |
| 协议白名单 | 仅允许 `https://` 和 `git@`（SSH）开头 |
| 路径隔离 | 目标路径始终在 `PathSandbox` 沙箱内，由 `assertUnderUserSandbox` 保证 |
| 超时控制 | 默认 120 秒超时，防止资源占用 |
| 错误清理 | Clone 失败时自动清理已创建的目录 |
| 命令注入防护 | 使用 `ProcessBuilder` + 参数列表（非 shell 拼接），Git URL 作为单独参数传入 |

---

## 五、前端改动

### 5.1 交互设计

核心思路：**先选择模式，再展示对应输入内容**——一个始终只有一个主输入区域的表单。

```
┌──────────────────────────────────────────────┐
│  新建任务                                  ✕  │
├──────────────────────────────────────────────┤
│                                              │
│  ○ 云端模式    ○ 本地模式                     │
│                                              │
│  ── 工作区来源 ─────────────────────────────  │
│                                              │
│  ┌─ 选择已有工作区 ──────────────────────┐    │
│  │ ┌──────────────────────────────────┐ │    │
│  │ │ my-project                 ▼    │ │    │
│  │ └──────────────────────────────────┘ │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌─ 创建新工作区 ────────────────────────┐    │
│  │ 输入项目名（可留空，留空=临时工作区）    │    │
│  │ ┌──────────────────────────────────┐ │    │
│  │ │ new-project                      │ │    │
│  │ └──────────────────────────────────┘ │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌─ 初始化 Git 工作区 ───────────────────┐   │
│  │ ┌──────────────────────────────────┐ │    │
│  │ │ https://github.com/user/repo.git │ │    │
│  │ └──────────────────────────────────┘ │    │
│  │ 分支（可选，默认使用默认分支）          │    │
│  │ ┌──────────────────────────────────┐ │    │
│  │ │ main                             │ │    │
│  │ └──────────────────────────────────┘ │    │
│  └──────────────────────────────────────┘    │
│                                              │
│                    [取消]  [开始（克隆中...）]  │
└──────────────────────────────────────────────┘
```

**交互规则**：

| 规则 | 说明 |
|------|------|
| 默认选中 | 有已有工作区 → 选中"选择已有工作区"；无已有工作区 → 选中"创建新工作区" |
| 互斥展开 | 三个选项是 radio 行为，选中一个时自动折叠另外两个 |
| 单个输入区 | 同一时间只有一个输入区域可见 |
| Loading 状态 | 点击"开始"后，按钮变为 loading 态，显示"正在克隆仓库..."或"正在初始化..." |
| Git URL 格式化 | 用户输入时实时校验格式，自动 trim、补全 `.git` 后缀 |

### 5.2 NewTaskDialog 改动

**文件**: `desktop/src/components/task/NewTaskDialog.vue`

新增状态：

```typescript
// 工作区来源模式
type WorkspaceMode = 'existing' | 'new' | 'git'
const workspaceMode = ref<WorkspaceMode>('new')

// 已有工作区列表
interface CloudProject {
  name: string
  path: string
  isGit: boolean
}
const cloudProjects = ref<CloudProject[]>([])

// Git 相关
const gitCloneUrl = ref('')
const gitBranch = ref('')

// Loading 状态
const isCreating = ref(false)
const createLoadingText = ref('')
```

关键逻辑：

```typescript
async function onOpen() {
  // ... 现有初始化逻辑 ...
  // 加载已有云端工作区列表
  cloudProjects.value = await sessionStore.fetchCloudProjects()
  // 默认选中逻辑
  workspaceMode.value = cloudProjects.value.length > 0 ? 'existing' : 'new'
}

async function confirm() {
  isCreating.value = true

  if (workspaceMode.value === 'git') {
    createLoadingText.value = '正在克隆仓库...'
  } else {
    createLoadingText.value = '正在初始化工作区...'
  }

  try {
    const session = await sessionStore.createSession(
      selectedAgent.value!.id,
      selectedMode.value,
      /* workspace */ undefined,
      /* environmentInfo */ undefined,
      /* modelId */ undefined,
      /* permissionLevel */ undefined,
      /* cloudProjectKey */ getCloudProjectKey(),
      /* gitCloneUrl */ workspaceMode.value === 'git' ? gitCloneUrl.value : undefined,
      /* gitBranch */ workspaceMode.value === 'git' ? gitBranch.value || undefined : undefined,
      /* workspaceMode */ workspaceMode.value,
    )
    if (session) emit('created', session)
  } finally {
    isCreating.value = false
    createLoadingText.value = ''
  }
}

function getCloudProjectKey(): string | undefined {
  if (workspaceMode.value === 'existing') {
    return selectedCloudProject.value
  }
  if (workspaceMode.value === 'new') {
    return newProjectName.value || undefined
  }
  return undefined // git mode — 后端从 URL 提取
}
```

### 5.3 sessionStore 改动

**文件**: `desktop/src/stores/session.ts`

```typescript
async function createSession(
    agentId: string,
    executionMode: string,
    workspace?: string,
    environmentInfo?: SessionEnvironmentInfo,
    modelId?: number,
    permissionLevel?: string,
    cloudProjectKey?: string,
    gitCloneUrl?: string,          // 新增
    gitBranch?: string,            // 新增
    workspaceMode?: string,        // 新增: 'existing' | 'new' | 'git'
) {
    const payload: Record<string, unknown> = {
        agentId,
        executionMode,
        modelId: modelId || undefined,
        permissionLevel: permissionLevel || undefined,
        // ...
    }
    if (executionMode === 'CLOUD') {
        payload.workspaceMode = workspaceMode || 'new'
        if (workspaceMode === 'git' && gitCloneUrl) {
            payload.gitCloneUrl = gitCloneUrl
            if (gitBranch) payload.gitBranch = gitBranch
        } else if (cloudProjectKey) {
            payload.cloudProjectKey = cloudProjectKey
        }
    }
    // ...
}

async function fetchCloudProjects(): Promise<CloudProject[]> {
    const { data } = await api.get('/sessions/cloud-projects')
    return data || []
}
```

### 5.4 useChat 改动

**文件**: `desktop/src/composables/useChat.ts`

新增状态：

```typescript
const workspaceMode = ref<'existing' | 'new' | 'git'>('new')
const gitCloneUrl = ref('')
const gitBranch = ref('')
```

创建 session 时传递：

```typescript
const sessionData = await sessionStore.createSession(
    agentId.value,
    executionMode.value,
    executionMode.value === 'LOCAL' ? workspace.value || undefined : undefined,
    environmentInfo,
    selectedModelId?.value,
    permissionLevel?.value,
    executionMode.value === 'CLOUD' ? cloudProjectKey.value || undefined : undefined,
    executionMode.value === 'CLOUD' ? gitCloneUrl.value || undefined : undefined,
    executionMode.value === 'CLOUD' ? gitBranch.value || undefined : undefined,
    executionMode.value === 'CLOUD' ? workspaceMode.value : undefined,
)
```

### 5.5 ChatInput 改动

**文件**: `desktop/src/components/chat/ChatInput.vue`

当前 ChatInput 中已有 `el-autocomplete` 用于输入项目名。改造为与 NewTaskDialog 一致的三选一交互。

新增 props:

```typescript
const props = defineProps<{
    // ... 现有 props ...
    workspaceMode?: 'existing' | 'new' | 'git'
    gitCloneUrl?: string
    gitBranch?: string
    cloudProjects?: CloudProject[]
}>()

const emit = defineEmits<{
    // ... 现有 emits ...
    'update:workspaceMode': [mode: string]
    'update:gitCloneUrl': [url: string]
    'update:gitBranch': [branch: string]
}>()
```

### 5.6 Loading 提示

在整个创建流程中（从点击"开始"到获得 session 响应），前端需要显示 loading 状态：

```
场景 A：新建空工作区
  → 按钮显示 "正在初始化..."，约 1-2 秒

场景 B：Git Clone 工作区
  → 按钮显示 "正在克隆仓库...（可能需要 1-2 分钟）"
  → 后端同步 clone，前端等待 API 响应
  → 超时/失败时显示错误 toast："克隆失败：xxx"
```

实现方式：在 `NewTaskDialog.confirm()` 和 `ChatInput` 发送流程中，创建 session 前设置 `isCreating = true`，并在确认按钮上展示 loading spinner + 状态文字。

---

## 六、数据库改动

**无需新增表或字段**。现有 `session` 表已有足够字段支撑：

| 字段 | 用途 |
|------|------|
| `workspace` | 存储工作区路径（clone 目标路径） |
| `project_key` | 存储从 Git URL 提取的项目名 |
| `is_git` | Git Clone 成功后自动设为 `true` |

---

## 七、接口汇总

| 方法 | 路径 | 说明 | 新增/修改 |
|------|------|------|-----------|
| POST | `/v1/sessions` | 创建会话 | 修改：新增 `workspaceMode`、`gitCloneUrl`、`gitBranch` |
| GET | `/v1/sessions/cloud-projects` | 获取已有云端工作区列表 | **新增** |

---

## 八、实施步骤

| 步骤 | 内容 | 涉及文件 |
|------|------|----------|
| **1** | 新建 `GitUrlParser` 工具类 | `backend/.../session/util/GitUrlParser.java`（新增） |
| **2** | 新建 `GitOperationService` | `backend/.../session/service/GitOperationService.java`（新增） |
| **3** | `CreateSessionRequest` 新增字段 | `SessionController.java` |
| **4** | `SessionService.createSession()` 增加三模式分支 | `SessionService.java` |
| **5** | 新增 `GET /cloud-projects` 接口 | `SessionController.java` |
| **6** | `sessionStore.createSession()` 传递新参数 | `desktop/src/stores/session.ts` |
| **7** | `sessionStore.fetchCloudProjects()` | `desktop/src/stores/session.ts` |
| **8** | `NewTaskDialog` 增加三选一 + loading | `desktop/src/components/task/NewTaskDialog.vue` |
| **9** | `ChatInput` 改造为三选一交互 | `desktop/src/components/chat/ChatInput.vue` |
| **10** | `useChat` 传递新参数 | `desktop/src/composables/useChat.ts` |

---

## 九、边界情况与风险

| 场景 | 处理策略 |
|------|----------|
| 项目名与已有项目冲突 | `projects/{slug}` 目录已存在时，复用 `normalizeAndValidate` 报错，提示用户项目名已被占用 |
| Git URL 格式无效 | 前端实时校验 + 后端 `GitUrlParser.validate()`，返回明确错误信息 |
| Clone 超时（>120s） | 返回超时错误，清理已创建目录 |
| 私有仓库无权限（SSH Key 未配置） | Git 返回认证错误，透传给前端："Authentication failed. Please check SSH key configuration." |
| 克隆大仓库 | 120 秒超时适用于大多数仓库；超大仓库可后续改为异步模式 |
| 工作区目录安全 | 目标路径始终在 `PathSandbox` 沙箱内，由 `assertUnderUserSandbox` 保证 |
| 命令注入 | 使用 `ProcessBuilder` + 参数列表，Git URL 作为单独参数，不拼接 shell 命令 |
| 字符编码 | Git clone 输出使用 UTF-8 读取，兼容中英文仓库名 |

---

## 十、后续增强（可选 Phase 2）

### 10.1 异步 Clone

对于大型仓库，可将 clone 改为异步：

```
1. createSession 快速返回（workspace 目录已创建但为空）
2. 后台异步 clone，WebSocket 推送 workspace_init 事件
3. 前端显示 "正在克隆仓库..." 进度
4. clone 完成后，前端收到通知，刷新文件树
```

新增 WebSocket 事件：`workspace_init`

```json
{
  "status": "CLONING" | "READY" | "FAILED",
  "progress": "Cloning repository...",
  "error": "Authentication failed"
}
```

### 10.2 Clone 进度输出

后端在执行 clone 时，通过 WebSocket 实时推送 git clone 的标准输出，让前端展示进度条或日志行。

### 10.3 支持直接打开已有工作区

在 ChatInput 中，当前"项目名输入"已支持 autocomplete 建议。可进一步增强：输入已有项目名时直接复用该工作区，无需重新创建 session，而是直接在该项目下新建一个会话。
