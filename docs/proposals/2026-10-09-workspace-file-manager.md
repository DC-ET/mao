# 提案：工作区文件直管（Workspace File Manager）—— 不只让 Agent 碰文件，人也能管

- 状态：待评审
- 日期：2026-10-09
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

CLOUD 工作区的文件能力今天是**读 + Git 写**半边天：

- **读侧齐全**：`file/file.routes.ts` 有 `workspace-list` / `workspace-directory` / `workspace-search` / `workspace-read` / `workspace-preview` / `workspace-download` / `workspace-download-zip`，桌面文件树（`desktop/src/components/file-browser/`）浏览、预览、单文件/目录下载、加入对话都已具备。
- **写侧只有 Git**：`workspace-git-commit` / `pull` / `push`（配合 `git-write-operation.service.ts` 与 AI 生成 commit message）——前提是工作区本身是 Git 仓库。
- **没有任何普通文件写操作**：不能上传文件进工作区、不能新建/重命名/删除/移动文件或目录。桌面文件树右键菜单（`FileTreeContextMenu.vue`）只有"复制绝对/相对路径、在文件夹中打开、加入对话、下载"。

结果是用户在 CLOUD 工作区里想直接管文件时只能**派 Agent 去干**：传个参考资料要开个会话说"帮我把这个文件放到 X 目录"，改个工作区文件名要 Agent 动手，甚至 Agent 跑完产生的中间文件想让用户自己清理，也得再派一轮对话。这与产品主张的"Agent 是一等公民"形成有趣的反讽——**人的文件操作反而降级成了二等公民**。

几个典型场景今天很别扭：

1. **任务前喂料**：想把一份本地文档/数据放进云端工作区让 Agent 处理，现在只能作为会话附件上传到 runtime 的 incoming 目录（`file.routes.ts:55-60` 注明 incoming 在 runtime 而非工作区），Agent 要额外搬运，且用户对"文件最终在哪"没有掌控。
2. **任务后收拾**：Agent 生成的一堆中间产物，用户想快速删掉/归档/改名，要么手动派对话，要么（非 Git 工作区）完全束手无策。
3. **非 Git 工作区**：`git-write-operation.service.ts` 的整套提交能力以 Git 仓库为前提，普通目录工作区连版本化手段都没有，更凸显基础文件管理的缺失。

与已否决的"任务检查点与工作区回滚"（`2026-10-06-task-checkpoint-rollback.md`）边界清晰：那是在轮次边界做快照与回退，本提案只做**用户主动的文件增删改**，不引入任何快照/回滚语义。LOCAL 模式不涉及——本地工作区就在用户自己磁盘上，用系统文件管理器即可。

## 2. 目标 / 非目标

**目标**

1. **完整文件管理操作**：上传（文件/目录，拖拽进文件树）、新建文件/文件夹、重命名、删除（进回收站而非直接物理删除）、移动（拖拽或剪切粘贴）、复制。
2. **安全边界**：所有写操作复用 `harness/safety/path-sandbox.ts` 的路径沙箱，拒绝越出工作区根、拒绝符号链接逃逸；删除进 `.mao-trash/`（工作区内回收站目录），可恢复、可清空。
3. **与 Agent 并发写共存**：写操作感知 `harness/tool/impl/file-write-lock.ts` 的锁语义——Agent 正在写某文件时用户重命名/删除该文件给明确冲突提示而非静默损坏；用户改动后 Agent 侧的目录缓存失效（文件树刷新机制已有，需保证写后即时刷新）。
4. **权限一致性**：写操作走现有 `@RequirePermission` 体系；LOCAL 会话的文件树不显示写操作（那是用户自己的磁盘，本就该用系统工具管）。
5. **可观测**：用户的文件操作记入会话活动流（`session_activity`），与 Agent 的文件变更并列展示——"这个文件是谁动的"在同一个视图里回答。

**非目标**

- 不做在线富文本/代码编辑器（编辑内容仍走现有 `FileViewer` 只读预览 + "加入对话让 Agent 改"或本地下载编辑；内嵌编辑器列入开放问题）。
- 不做快照/回滚/版本对比（检查点提案已否决，不重启）。
- 不做跨工作区文件传输（A 工作区文件直接复制到 B 工作区；P1 靠下载-上传两步）。
- 不做 Git 暂存/分支管理等高级 Git 操作（现有 commit/pull/push 够用，Git 深度管理留给用户本地客户端）。

## 3. 技术方案

### 3.1 后端：写操作族（V142 无新表，仅活动记录）

在 `file/` 域新增一组受同一 `path-sandbox` 保护的写端点（全部限定 CLOUD 工作区、`@RequirePermission` 与工作区读一致或提一档，评审时定）：

- `POST /v1/files/workspace-mkdir`、`POST /v1/files/workspace-write`（新建文件，内容可选）、`POST /v1/files/workspace-rename`、`POST /v1/files/workspace-move`、`DELETE /v1/files/workspace-delete`（移入 `.mao-trash/`）、`POST /v1/files/workspace-upload`（multipart，落工作区指定目录）、`GET /v1/files/workspace-trash`（回收站列表）、`POST /v1/files/workspace-restore`、`DELETE /v1/files/workspace-trash`（清空）。
- 实现要点：
  - 复用 `workspace-browse.service.ts` 的路径解析与校验入口，写操作前统一过 `path-sandbox`；`realpath` 校验防符号链接逃逸（`git-write-operation.service.ts` 已有 `realpathSync` 用法可抄）。
  - 删除即移动：`rename` 到 `.mao-trash/<uuid>__<原名>`，同时写一条 `.mao-trash/index.json` 记录原路径供恢复；清空才物理删。避免误删不可逆，也避开"真删除"的审计难题。
  - 上传沿用 `@fastify/multipart`（现有 `/v1/files/upload` 同款），大小/类型限制复用文件上传现有常量。
  - 每个写操作经 `activity.service.ts` 记一条 `session_activity`（type=`file_user_write`，target=路径，summary=操作类型），桌面活动流与 Agent 变更同框展示。
  - 写锁协同：rename/delete/move 前查 `file-write-lock` 对应路径是否有进行中的 Agent 写，有则返回 409 与冲突文件清单，前端提示"Agent 正在处理该文件"。

### 3.2 前端：文件树升级为文件管理器

- `FileTree.vue` / `FileTreeContextMenu.vue` 扩展菜单项：新建文件、新建文件夹、上传、重命名、删除、剪切、复制、粘贴；支持拖拽（拖入上传、拖拽移动，跨目录移动用 shift 或菜单引导）。
- 上传：拖文件到文件树即上传到当前目录，带进度条（multipart + XHR 进度事件）；大文件走现有分片/大小限制口径。
- 删除确认 + 回收站入口（文件树底部"回收站"节点，支持恢复/彻底删除/清空）。
- 冲突：409 响应弹冲突面板，列出 Agent 正在写的文件，提供"强制操作（Agent 侧可能出错）"与"取消"两档，默认取消。
- LOCAL 会话文件树保持只读菜单不变（`isLocal` 守卫，同现有 `showOpenInFinder` 的条件渲染模式）。

### 3.3 与既有能力的衔接

- "加入对话"语义不变：用户上传/新建的文件可直接 `@路径@` 引用（现有 `@{绝对路径}@` 注入机制），喂料场景从"附件进 runtime"变成"文件进工作区 + 引用"。
- Git 工作区下，用户的写操作自然进入 `git status`，现有 diff 视图直接可见"人改的 vs Agent 改的"。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 写操作端点族（沙箱/锁校验/回收站/活动记录）+ 文件树菜单（新建/重命名/删除/移动/复制） | 中 |
| P2 | 上传（拖拽 + 进度）+ 回收站 UI + 409 冲突面板 | 小~中 |
| P3 | 拖拽移动、批量操作、与"加入对话"的衔接优化 | 小 |

## 5. 风险与开放问题

- **与 Agent 并发写的竞态**：本提案只做"操作前查锁"的粗粒度防护，无法做到文件级事务。缓解：冲突默认取消；活动流让"谁动过"可追溯。真正可靠的方案（Agent 写期间锁整个目录）成本高，列为开放问题。
- **回收站语义**：`.mao-trash/` 对 Agent 可见可能造成困惑（Agent 看到垃圾文件）。缓解：目录名带 `.mao-` 前缀，PromptEngine 的系统提示中说明该目录用途；或评估是否对 Agent 工具隐藏（改工具层过滤，P1 先做提示词说明）。
- **大文件/大目录上传**：multipart 落工作区与现有 runtime 附件目录的磁盘配额关系需明确（工作区在数据目录下，配额口径统一）。
- **开放问题**：是否提供工作区内嵌文本编辑器（只读预览 → 可编辑保存），成本不低但场景顺；建议 P3 后单独评估。
- **开放问题**：非 Git 工作区是否需要轻量版本化（如改动前自动复制 `.mao-backup/`）——与检查点提案的边界需评审再确认，P1 不做。

## 6. 测试要点

- 沙箱：`../` 逃逸、绝对路径越界、符号链接指向工作区外，全部拒绝且不产生任何写副作用。
- 回收站：删除后文件从树消失、回收站可见可恢复；恢复后原路径内容一致；清空后物理删除。
- 锁冲突：Agent 持锁写某文件时用户删除/重命名返回 409 与文件清单；锁释放后同样操作成功。
- 上传：拖拽上传到指定目录、进度事件、大小限制拒绝、与 `@{路径}@` 引用打通。
- 活动记录：每个用户写操作产生 `session_activity` 行，桌面活动流与 Agent 变更同框且可区分来源。
- LOCAL 会话文件树不出现写操作菜单；权限不足用户调用写端点被 403。
