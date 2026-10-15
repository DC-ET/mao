# 图片产物「按用户隔离 + 容器可见」改造方案

> 日期：2026-10-15 · 状态：**已批准实施**（本文为落地依据）
> 关联分支：`feature/user-runtime-container-isolation`
> 前置结论（评审后确认）：① 新版本未上线，**不做存量迁移**，历史平坦目录文件原样保留；② `image_url` 404 中的 nginx 层问题已在部署侧解决，本方案只修后端 URL 拼装；③ 产物必须继续能通过 `https://<域名>/uploads/...` 直接访问（静态 URL 方案保留）。

---

## 一、背景：问题是怎么暴露出来的

容器隔离分支收口"宿主机侧越界读写"时，外部发送类工具（`feishu_send_file/image`、`send_wechat_file/image`、`dingtalk_send_file/image`）读取本地文件的路径口径从"任意绝对路径"改成"白名单根之内"：

```ts
// backend-ts/src/harness/tool/impl/send-file-bytes.ts
export async function loadSendFileBytes(src, pathSandbox, support, ctx, maxBytes) {
  if (src.startsWith('http://') || src.startsWith('https://')) return fetchBytesWithLimits(src, maxBytes); // URL 分支不受影响
  if (support) { const fromContainer = await support.readBytes({ ...ctx, path: src, maxBytes }); if (fromContainer != null) return fromContainer; }
  return readLocalBytes(src, pathSandbox, support?.extraRoots(ctx.userId) ?? [], ctx.workspace, maxBytes);
}
```

host 模式 `extraRoots`（`read-bytes-bridge.ts`）固定三个根：`/tmp`、`runtime/{uid}`、`HOME=users/{uid}`。**允许集 = 会话工作区 + 本人 runtime + 本人 HOME + /tmp**，而 `FILE_UPLOAD_DIR`（线上 `/opt/mao-data/uploads`）不在其中——它正是 `generate_image` / `edit_image` 的落盘目录。

实测影响面（近 30 天生产库统计）：发送类工具带本地路径 392 次，其中确定被拒 **2 次**（会话 499 / 用户 2 / `feishu_send_image`，入参为 `/opt/mao-data/uploads/gen|edit-*.png`）。量很小，但链路是必断的：见根因 1。

## 二、根因

### 根因 1（最关键）：`image_url` 少了一整段 `/uploads/`，模型只能用 `image_path`

`materializeImageApiResult`（`generate-image-tool.ts:37-57`，`edit_image` 复用）拼的是：

```ts
image_url: base ? `${base}/${fileName}` : filePath,   // base = upload.baseUrl = https://<域名>/api
image_path: filePath,                                  // /opt/mao-data/uploads/gen-<uuid>.png
```

得到 `https://<域名>/api/gen-<uuid>.png`——后端静态托管只注册了 `/uploads/` 与 `/api/uploads/` 两个前缀（`create-app.ts` `registerUploadStatic`），该 URL **必然 404**（纯代码级缺陷，与网关无关）。模型拿到打不开的 URL，唯一可用的是绝对路径 `image_path` → 发送工具一收紧，这条链路就断。

**把 `image_url` 修对是消除风险最有效的一步**：URL 走 http 分支，完全不经过沙箱判定，两种运行时模式都通。

### 根因 2：工具描述与实现不一致

三个渠道的工具 schema 都承诺"绝对路径或工作区相对路径"可用（`feishu-tools.ts`、`wechat-tools.ts`、`dingtalk-tools.ts`），模型照描述用绝对路径；实现只认白名单根 → 偶发踩坑，且报错是 `Path escape attempt`（不是"文件不存在"），语义上误导模型。

### 根因 3：`uploads` 是全局平坦目录，"用户级产物"没有天然归属

图片工具把文件直接写在 uploads 根下（`gen-<uuid>.png` / `edit-<uuid>.png`）。所有用户的产物混在一层，既不属于任何会话工作区，也不在"每用户一个根"的容器挂载清单里 → 天然落在所有允许集之外。

### 补充事实（决定改造点）

| 事实 | 位置 |
|---|---|
| `generate_image` / `edit_image` / 发送类工具**都在宿主机执行**（不在 `DOCKER_ONLY_TOOLS`） | `docker-tool-router.ts:16` |
| 容器内允许根 = `runtime/{uid}`、`HOME=users/{uid}`、`userSkills/{uid}`、`/tmp`（primary 为 `workspace/{uid}`） | `container-tool-executor.ts:51-57` |
| 容器每用户挂载（rw）：`users/{uid}`、`workspace/{uid}`、`runtime/{uid}`、`deps/{uid}`、`channels/{uid}`、`userskills/{uid}`；另挂 `dist`(ro)、`skills`(ro) | `container-mount-planner.ts:62-70` |
| nginx 静态出口 `location ^~ /uploads/ { alias /opt/mao-data/uploads/; }`，**子目录天然可用**；后端亦注册 `/uploads/` 与 `/api/uploads/` 两个 fastify-static 前缀 | `create-app.ts` `registerUploadStatic` |
| `GenerateImageTool` 只覆写 `executeWithSession(argumentsJson)`，**拿不到 userId**；`EditImageTool` 已用 `executeWithUser`（但忽略了 userId） | `generate-image-tool.ts:134` / `edit-image-tool.ts:178` |
| `generate_image` / `edit_image` 属 `SERVER_ONLY_TOOLS`，经 `callTool` 四参调用 → 改覆写 `executeWithUser` 即可拿到 userId | `tool-dispatcher.ts:61` / `tool.ts:96` |
| `edit_image` 的**输入**路径早已是严格解析 `pathSandbox.resolve(rawPath, workspace)`（早于本分支），main 上同样无法编辑 uploads 下的图 | `edit-image-tool.ts:49` |
| `PathSandbox.allowedRoots` 是**进程级全局 Set**（跨用户累积），不能用来表达"按用户放行" | `path-sandbox.ts` |
| docker 模式下容器读不到文件时 `DockerToolRouter.readBytes` **直接抛错、不回退宿主机**（防"文件不存在"被误导为可本地重试） | `docker-tool-router.ts:124-126` |
| `upload.storageMode=oss` 只经 `/v1/config/upload` 暴露给前端；后端 `FileService` **永远写本地** `uploadDir` | `settings.service.ts:297` / `file.service.ts:86` |
| 挂载清单在 `docker run` 时定型：`docker start` 复用创建时的清单，**planner 变更不会让既有容器重建**（stopped 分支只对"新通道工作区"重建） | `container-registry.ts` `ensureRunningLocked` |

---

## 三、目标

1. 生成/编辑的图片产物按用户隔离，落到 `{FILE_UPLOAD_DIR}/{uid}/`；
2. **保留** `/uploads/` 静态 URL：`https://<域名>/uploads/{uid}/<gen|edit>-<uuid>.<ext>` 可直接访问；
3. 产物在下游都可用：**发送类工具（host 与 docker）**、**`edit_image` 作为输入**、**`read_file` 读图（host 与容器内）**；
4. 不改动全局上传目录语义（用户上传 / 头像仍写平坦根）、不动 nginx、不新增服务、不加数据库迁移；
5. 存量文件原样保留在平坦目录，不做迁移（新版本未上线）；随本方案上线后新产物全部走 `{uid}` 子目录。

---

## 四、方案设计

### 4.1 目录与 URL

```
宿主机 / 容器内路径：{FILE_UPLOAD_DIR}/{uid}/gen-<uuid>.png
公开 URL：           {静态 origin}/uploads/{uid}/gen-<uuid>.png
```

- 容器内路径与宿主机**逐字节一致**（决策 15，不做路径翻译），挂载 `{FILE_UPLOAD_DIR}/{uid}` → 同路径即可；
- nginx alias 指向 uploads 根，加一层 `{uid}` 无需任何 nginx 改动；无 autoindex，只有拿到确切 UUID 文件名才可达，与现状等价；
- 静态 origin **从 `upload.baseUrl` 派生，不新增配置项**：去掉尾部 `/api`（servlet contextPath 段）即得。当前线上 `https://<域名>/api` → `https://<域名>`。baseUrl 未配置时维持现状（`image_url` 回落为绝对路径）。选派生而非新配置项的理由：避免 settings-bootstrap / admin 设置页的一整条链路改动，且对现有部署即正确；若将来要接 CDN/OSS 域名，再单独立项加 `upload.staticBaseUrl`。

### 4.2 改动清单（按两个批次，依赖序）

#### 第一批：宿主机侧 + URL（无容器影响、无重建风险）

**① 图片工具拿 userId 并落用户子目录** — `generate-image-tool.ts`

- `GenerateImageTool` 由覆写 `executeWithSession(argumentsJson)` 改为覆写 `executeWithUser(argumentsJson, sessionId, userId, workspace)`（`BaseTool.execute` 的所有参数个数都汇入 `executeWithUser`，不存在漏接调用方；`EditImageTool` 有现成写法）；
- `materializeImageApiResult` 增补 `userId: number | null` 参数：落盘目录 `userId != null ? join(uploadDir, String(userId)) : uploadDir`（userId 为空时退平坦目录，保证单测/内部调用不炸）；
- `image_url` 修为 `${stripApi(baseUrl)}/uploads/{userId ? uid + '/' : ''}${fileName}`；`image_path` 与 URL 同源。

**② `edit_image` 同样落子目录 + 输入按用户放行** — `edit-image-tool.ts`

- 落盘（调 `materializeImageApiResult`）传入 userId；
- **输入读取改走发送工具同款桥接**（评审结论：不新加 `extraRootsProvider`，直接复用 `SendBytesSupport`）：`EditImageTool` 构造参数增补 `sendBytesSupport?: SendBytesSupport | null`（`tool-registry` 装配处传入，与微信/飞书/钉钉工具同源）；
  - docker 模式：先 `support.readBytes(...)` 向容器取字节（宿主不可见的容器内 `/tmp` 产物也能编辑，顺带修掉一个既有缺口）；
  - host 模式 / 降级：`StrictPathResolver(primaryRoot=会话工作区, extraRoots=[{uploadDir}/{uid}, {runtimeDir}/{uid}, {HOME}/{uid}, '/tmp']).resolve(rawPath)`，与 `readLocalBytes` 同口径；
  - `mask_path` 同路径；
- 魔数校验、大小上限、`fileName`/`mime` 推导逻辑不变。

**③ host 模式发送工具允许根** — `read-bytes-bridge.ts`

- `DockerSendBytesBridge` 构造参数新增 `uploadDir`，`extraRoots(userId)` 追加 `path.join(path.resolve(uploadDir), String(userId))`；
- 注意：docker 用户读不到未挂载文件时容器**直接抛错**（不回退宿主机），所以本步只修 host 模式与"URL 之外"的路径形态；docker 模式必须等第二批挂载。

**④ 装配** — `create-app.ts`

- `DockerSendBytesBridge` 传 `uploadDir: resolve(expandHome(cfg.app.file.uploadDir))`（create-app 内已有解析值）；
- `EditImageTool` 传 `sendBytesSupport`（tool-registry 的 `deps.sendBytesSupport`）。

> 第一批完成即消除：文档实测的 2 次被拒 + `image_url` 404（URL 发送两种模式都通；host 模式绝对路径发送、`edit_image` 输入、`read_file` host 读图全部打通）。

#### 第二批：容器可见 + 挂载漂移自愈

**⑤ 容器每用户挂载** — `container-mount-planner.ts`

- `PlanRoots`（MountPlannerRoots）新增 `uploadDir: string`；
- `plan()` 新增一条 `{ hostPath: '{uploadDir}/{uid}', containerPath: 同, mode: 'rw', purpose: 'uploads' }`；
- `assertSafe()` 的 `registeredRoots` 加入 `uploadDir`；rw 段校验 `containsUserSegment('7','7')` 天然通过。

**⑥ 容器内允许根** — `container-tool-executor.ts`

- `ContainerRoots` 新增 `uploadDir`；构造里 `addAllowedRoot(path.join(roots.uploadDir, u))`（容器内进程只服务一个用户，无跨用户问题）。

**⑦ 挂载计划指纹漂移重建** — `container-registry.ts`（评审补强项）

- 问题：挂载清单在 `docker run` 时定型，既有容器（running 或 idle-stopped）不会因为 planner 变更而重建 → 上线后老容器最长 72h（强制重建周期）内仍缺 uploads 挂载；
- 方案：`ContainerEntry` 新增 `mountFingerprint`（标准挂载计划的 hash，不含动态会话工作区）；`createAndStart` 成功时写入；`ensureRunningLocked` 的 running / stopped 分支与 freshly desired 计划比对，漂移即走 `rebuildEntry` 重建（stopped 分支在 `dockerStart` 之前判定，避免"先 start 再立刻重建"的一次无用启动）；
- 语义与现有的"新通道工作区触发 recycle"一致（`ensureWorkspaceMounted` 已在做同类事），代价是一次性重建；日志明确标注原因便于运维归因；
- 未记录指纹的旧条目（升级过渡）视为漂移， naturally 自愈一次。

**⑧ 装配** — `create-app.ts`

- `ContainerRegistry` 的 opts 增补 `uploadDir`（构造内传入 planner roots）；
- `ContainerToolExecutor` 的 roots（经 `runtime-agent.ts` 的 `resolveRoots()`，数据来自容器 env `MAO_*`）增补 `uploadDir`：runtime-agent 启动参数/env 增加 `MAO_UPLOAD_DIR`，宿主机 `docker run` 命令（`container-registry.createAndStart` 的 args）同步注入。

---

## 五、改造后各消费方行为矩阵

| 消费方 | 路径形态 | 改造前（分支当前状态） | 改造后 |
|---|---|---|---|
| `feishu/dingtalk/wechat_send_*`（host） | 绝对路径 `{uploadDir}/{uid}/gen-x.png` | ❌ 拒绝（不在允许集） | ✅ extraRoots 新增（第一批③） |
| 同上 | URL（`image_url`） | ❌ URL 本身 404（少 `/uploads/`） | ✅ URL 修对 + nginx 已修（第一批①） |
| `feishu/dingtalk/wechat_send_*`（docker） | 绝对路径 | ❌ 容器无此文件 → 抛错（无静默降级） | ✅ 挂载可见 + 容器 allowedRoots（第二批⑤⑥） |
| `edit_image` 输入 | `{uploadDir}/{uid}/gen-x.png` | ❌ `resolve()` 拒绝（main 亦如此） | ✅ 桥接 + 按 uid extraRoots（第一批②） |
| `edit_image` 输入 | 容器内 `/tmp` 产物 | ❌ 宿主机 resolve 看不到 | ✅ readBytes 桥（第一批②，顺带修复） |
| `read_file`（host） | 同上 | ✅（host 走 `resolveLenient`） | ✅ |
| `read_file`（docker） | 同上 | ❌ 容器无此文件 | ✅ 挂载 + allowedRoots（第二批⑤⑥） |
| 前端 / 模型展示 | URL | ❌ `image_url` 404 | ✅ `{origin}/uploads/{uid}/gen-x.png` |
| 跨用户目录 | `{uploadDir}/{otherUid}/…` | ❌ | ❌（host 按调用方 uid 现算 extraRoots，容器靠挂载天然隔离） |
| 用户上传 / 头像（`/v1/files/upload`、头像接口） | 平坦根 | ✅（不在本次范围） | ✅ 不变 |

---

## 六、测试与验收清单

**单测（新增/修改）**

1. `materializeImageApiResult`：userId 非空 → 路径含 `{uid}`、`image_url` 为 `${origin}/uploads/{uid}/${name}`、`image_path` 与 URL 同源；userId 为空 → 平坦目录 + 平坦 URL，不抛错；baseUrl 带/不带尾部 `/api` 两种派生都正确；
2. `GenerateImageTool`：4 参调用（带 userId）落到 `{uploadDir}/{uid}`；2/3 参调用（无 userId）退平坦目录；
3. `EditImageTool`：输入 `{uploadDir}/{own}/x.png` 放行、`{uploadDir}/{other}/x.png` 拒绝、会话工作区内相对路径照旧；docker 桥模式下输入走 `readBytes`；输出落 `{uploadDir}/{uid}`；
4. `DockerSendBytesBridge.extraRoots(uid)`：含 `{uploadDir}/{uid}`，不含 `{uploadDir}` 本身，不含他人 uid；
5. `container-mount-planner.spec.ts`：挂载清单新增 `uploads` 一项、模式 rw、容器内路径 == 宿主机路径；`assertSafe` 对 uploads 非法挂载仍拒绝；指纹随 roots 变化；
6. `container-tool-executor.spec.ts`：容器内 allowedRoots 含 `{uploadDir}/{uid}`，跨 uid 拒绝；
7. `container-registry.spec.ts`：stopped 条目指纹漂移 → `dockerStart` 前重建（ops 序 `rm -f` → `run -d`，无多余 start）；running 条目指纹漂移 → recycle 一次后恢复；指纹一致 → 不重建（无额外 docker 动作）。

**手工验收（测试/预发各一轮）**

1. `generate_image` 生成图 → 模型拿 `image_url`；浏览器打开 200 且是图片本体；
2. `feishu_send_image` 传**绝对路径**发送成功；再传 `image_url` 发送成功（host 用户 + docker 灰度用户各一遍）；
3. `edit_image` 以上一张 gen 图为输入，改图成功；
4. docker 用户确认执行类工具仍正常、容器未被反复重建（日志有且仅有一次因挂载漂移的重建）；
5. 反向用例：手工让模型传 `{uploadDir}/{otherUid}/x.png` → 两个模式都必须报错；
6. 观察日志：无 `Path escape attempt`（针对 uploads 路径）。

---

## 七、风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| 挂载变更触发既有容器重建 | 上线后每个 docker 用户的下一次工具调用触发一次 recycle（在途 shell/pty 任务丢失） | 一次性行为；灰度期避开长任务；指纹机制保证只重建一次；日志标注原因 |
| 派生 origin 取错 | 若 `upload.baseUrl` 尾部不是 `/api`（自定义 contextPath），派生结果可能不符预期 | 单测覆盖带/不带尾部两种形态；上线后按验收 1 实测 URL 200 |
| 目录权限/属主 | `{uploadDir}/{uid}` 需递归创建（`mkdirSync(recursive)` 已有，改拼子目录即可） | 代码内 mkdir；验收确认 nginx 可读 |
| 磁盘增长 | 每用户一个目录，总量不变 | 无实质影响 |

**回滚**：不涉及数据库迁移、不搬迁文件，revert 代码 + 重新部署即可；已写入 `{uid}` 子目录的新文件旧代码读不到（可接受）。

---

## 八、改动文件清单

| 文件 | 改动 |
|---|---|
| `backend-ts/src/harness/tool/impl/generate-image-tool.ts` | `executeWithSession` → `executeWithUser`；`materializeImageApiResult` 加 userId 与 URL 修对 |
| `backend-ts/src/harness/tool/impl/edit-image-tool.ts` | 输入改桥接 + 按 uid 严格解析；落盘加 `{uid}` |
| `backend-ts/src/harness/tool/tool-registry.ts` | `EditImageTool` 传 `sendBytesSupport` |
| `backend-ts/src/harness/container/read-bytes-bridge.ts` | `extraRoots` 加 `{uploadDir}/{uid}`（构造参数加 `uploadDir`） |
| `backend-ts/src/harness/container/container-mount-planner.ts` | roots 加 `uploadDir`；挂载清单 + `assertSafe` + 指纹方法 |
| `backend-ts/src/harness/container/container-tool-executor.ts` | `ContainerRoots` 加 `uploadDir`；容器 allowedRoots |
| `backend-ts/src/harness/container/runtime-agent.ts` | `resolveRoots()` 增补 `MAO_UPLOAD_DIR` |
| `backend-ts/src/harness/container/container-registry.ts` | entry 加 `mountFingerprint`；`docker run` env 注入 `MAO_UPLOAD_DIR`；漂移重建 |
| `backend-ts/src/create-app.ts` | 装配传 `uploadDir`（send bridge / registry / 图片工具） |
| 单测：`generate-image-tool.spec.ts`、`edit-image-tool.spec.ts`、`read-bytes-bridge.spec.ts`、`container-mount-planner.spec.ts`、`container-tool-executor.spec.ts`、`container-registry.spec.ts` | 见第六节 |
| 文档：`CHANGELOG.md`（0.0.297）、`docs/plan/2026-10-14-user-runtime-container-isolation-design.md`（允许根表补 uploads）、`skills/mao-cli`（如涉图片工具说明） | 同步 |
