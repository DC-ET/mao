# 代码审查（续二）：CLOUD 工作区文件管理

已修过的问题不再重复。本轮只记录新的、测试已经失败的功能问题。产品代码未改。

## 上传进行中时，Agent 仍能写穿符号链接目标

**现象：** 向 `inbox` 上传 `link/sub/a.txt`（`inbox/link` → `src`）时，文件会写到 `src/sub/a.txt`。上传请求还没结束（目录锁还握着）时，Agent 的 `write_file` 不会等待，直接把刚上传的内容盖掉。

**复现：**

1. `inbox/link` 指向 `src`。
2. 开始上传 `link/sub/a.txt`，内容是 `user`，并停在活动记录（写入已完成，锁未释放）。
3. 此时对 `src/sub/a.txt` 调用 `withFileLock` 并写入 `agent`。

**失败测试：**

- 文件：`backend-ts/src/file/workspace-write.service.spec.ts`
- 用例：`blocks a new agent write while an upload through a symlink still holds the target`
- 断言：锁释放前文件内容仍是 `user`，Agent 回调不应运行
- 实际：内容已变成 `agent`

**为什么是功能错误：** 上传把真实文件路径放进 `holdDirectories`，指望挡住后续的 `write_file`。`withFileLock` 只等待「祖先目录」被持有，路径完全相同不算祖先，也不会去抢那把文件锁。符号链接的真实路径又不在上传目录 `inbox` 下面，所以 Agent 在上传的临界区内就能覆盖文件。Agent 先持有锁时上传会被 3043 拒绝；方向反过来则盖写成功。
