# 代码审查（续三）：CLOUD 工作区文件管理

已修过的问题不再重复。本轮只记录新的、测试已经失败的功能问题。产品代码未改。

## 经符号链接把目录复制进自己会不断嵌套

**现象：** `link` 指向 `dir/sub` 时，把 `dir` 复制到 `link/nested` 不会被拒绝。复制会在源目录里面一层层造出 `dir/sub/nested/sub/nested/...`，并把 `dir/a.txt` 重复拷进去，直到路径长到文件系统拒绝为止。

**复现：**

1. 建好 `dir/sub` 和 `dir/a.txt`。
2. `link` → `dir/sub`。
3. 调用复制：`dir` → `link/nested`。

**失败测试：**

- 文件：`backend-ts/src/file/workspace-write.service.spec.ts`
- 用例：`rejects copying a directory into itself through a symlink`
- 断言：不应在源目录里出现 `dir/sub/nested/sub`
- 实际：该目录被创建出来（复制进程在嵌套变深后被测试杀掉）

**为什么是功能错误：** 「不能复制到自身内部」只比较了逻辑路径。`link/nested` 在字符串上不像 `dir` 的子路径，但真实位置是 `dir/sub/nested`。`copyDirectory` 先建好这个目标，再遍历源目录时会把刚建出来的副本再抄一遍，源目录被越复制越大。直接移进子目录的情况会返回「不能移进自己」；这条符号链接路径没有走同一条判断。
