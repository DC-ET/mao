# 代码审查（续四）：CLOUD 工作区文件管理

已修过的问题不再重复。本轮只记录新的、测试已经失败的功能问题。产品代码未改。

## 强制上传不会等 Agent 写完同一个文件

**现象：** Agent 还拿着 `src/a.txt` 的写锁时，用户对同一文件做强制上传（`overwrite` + `force`），文件内容会立刻被换成上传内容。普通的强制 `write` 会先排队，等 Agent 释放后再写；上传这条路径没有排队。

**复现：**

1. 写入 `src/a.txt`，内容 `v1`。
2. Agent 对这个文件持有写锁并停住。
3. 向目录 `src` 强制上传 `a.txt`，内容 `forced`。
4. 在 Agent 释放锁之前读文件。

**失败测试：**

- 文件：`backend-ts/src/file/workspace-write.service.spec.ts`
- 用例：`queues a forced upload behind an agent write of the same file`
- 断言：锁还没释放时内容应仍是 `v1`，上传结束后才是 `forced`
- 实际：锁还握着时内容已经是 `forced`

**为什么是功能错误：** `force` 只应跳过「Agent 正在写入」的拒绝，仍然要和正在进行的写入串行，避免两边同时改同一文件。文件写入走 `withUserFileLocks`，强制时也会排队。上传走 `holdDirectories`，`force` 为真时直接跳过冲突并马上写盘，所以会盖掉 Agent 还没写完的内容。
