# 代码审查（续六）：CLOUD 工作区文件管理

已修过的问题不再重复。本轮只记录新的、测试已经失败的功能问题。产品代码未改。

## 同一次上传里，文件和它下面的路径会写到一半并抛出文件系统错误

**现象：** 一次上传同时包含 `sub`（文件）和 `sub/a.txt` 时，不会在写入前拒绝。`sub` 会先被写成文件，接着为 `sub/a.txt` 建父目录失败，抛出 `EEXIST: file already exists, mkdir`。请求没有记成成功活动，但 `in/sub` 已经留在工作区。调用方看到的是内部错误，不是「目标不合法」这类业务错误，而且磁盘上多了一个只写了一半的文件。

**复现：** 向目录 `in` 上传两段内容：`sub` = `file`，`sub/a.txt` = `child`。不传 `overwrite`。

**失败测试：**

- 文件：`backend-ts/src/file/workspace-write.service.spec.ts`
- 用例：`rejects an upload that names a file and a path under that file`
- 断言：不应留下 `in/sub`，并且应返回 `BusinessException`
- 实际：`in/sub` 已存在（断言 `left === false` 失败）

**为什么是功能错误：** 存在性检查在任何写入之前做完。这时 `sub` 还不存在，`sub/a.txt` 的父路径也被当成「还没有」，两条都通过。真正写入时先把 `sub` 写成文件，再对这个文件做 `mkdir`，文件系统报 `EEXIST`。同一次上传应当整批拒绝或整批回滚，而不是留下半成品并抛出未转换成业务错误的异常。
