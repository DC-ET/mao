# 代码审查（续）：CLOUD 工作区文件管理

上一轮已修的 4 个问题不再重复。本轮只记录新的、并且测试已经失败的功能问题。产品代码未改。

验证命令（在 `backend-ts`）：

```bash
npx vitest run src/file/workspace-write.service.spec.ts src/harness/tool/impl/file-write-lock.spec.ts -t "writes through a symlink|alias one file|chain of symlinks|forced write when the agent"
```

结果：4 failed。

## 1. 上传可以顺着符号链接写进 Agent 正在创建的文件

**现象：** 上传目录只锁自己的路径。若相对路径中间有符号链接指向工作区里的另一个目录，文件会写到真实路径上，且不会返回 3043。Agent 正持有该真实路径的写锁时，上传已经把文件建出来。

**复现：** `inbox/link` → `src`。Agent 对尚不存在的 `src/sub/a.txt` 持有写锁。再向 `inbox` 上传 `link/sub/a.txt`。

**失败测试：**

- 文件：`backend-ts/src/file/workspace-write.service.spec.ts`
- 用例：`rejects an upload that writes through a symlink into a file an agent is creating`
- 断言：应返回写冲突（3043），锁释放前文件不应出现
- 实际：上传成功，返回 `{ path: 'inbox' }`

**为什么是功能错误：** 冲突判断看的是上传目录 `inbox`，真实写入点在 `src`。`mkdir` / `writeFile` 会跟随中间的符号链接，所以用户上传和 Agent 的 `write_file` 同时写同一个文件。

## 2. 一次上传里两条不同相对路径可以写到同一个文件

**现象：** 同名 `relativePath` 已会报「目标已存在」。两条相对路径不同、但经符号链接落到同一真实文件时，不会报错。`overwrite` 关闭，后一份仍盖掉前一份，接口成功。

**复现：** `inbox/link1` 和 `inbox/link2` 都指向 `src`。同一次上传 `link1/sub/a.txt`（`first`）和 `link2/sub/a.txt`（`second`）。

**失败测试：**

- 文件：`backend-ts/src/file/workspace-write.service.spec.ts`
- 用例：`rejects an upload batch whose different relative paths alias one file`
- 断言：应返回 3044，且不能只留下 `second`
- 实际：上传成功，返回 `{ path: 'inbox' }`

**为什么是功能错误：** 去重只比较逻辑相对路径字符串。两份内容都写到 `src/sub/a.txt`，第二次覆盖第一次，调用方看不到覆盖失败。

## 3. 两级符号链接仍然绕过目录删除锁

**现象：** 直接符号链接（`link` → `src`）在目录锁期间会等待。再套一层（`link` → `mid` → `src`）时，新建文件 `link/new.txt` 不会等待，回调马上执行。用户删除 `src` 期间，这次写入进得去。

**复现：** 持有真实目录 `src` 的目录锁，再对 `link/new.txt` 加文件锁。`new.txt` 尚不存在。

**失败测试：**

- 文件：`backend-ts/src/harness/tool/impl/file-write-lock.spec.ts`
- 用例：`blocks a new file through a chain of symlinks while the real directory is held`
- 断言：释放目录锁之前回调不应运行
- 实际：20ms 内已经运行

**为什么是功能错误：** 别名只 `readlink` 一次，停在 `mid/new.txt`，对不上被持有的 `src`。删除目录时拦不住这条新的 `write_file`。

## 4. 强制写入不会和符号链接上的 Agent 写排队

**现象：** 同一条路径上，`force` 仍会等 Agent 写完再写。Agent 锁的是 `link/a.txt`（`link` → `src`），用户强制写 `src/a.txt` 时不会等，两边同时写。

**复现：** Agent 持有 `link/a.txt`。用户以 `force: true` 锁 `src/a.txt`。

**失败测试：**

- 文件：`backend-ts/src/harness/tool/impl/file-write-lock.spec.ts`
- 用例：`still queues a forced write when the agent holds the same file via a symlink`
- 断言：Agent 释放前用户回调不应运行
- 实际：20ms 内已经运行

**为什么是功能错误：** 强制操作只跳过冲突提示，仍应排进同一把锁，避免和正在写的 Agent 交错覆盖。排队键用的是各自的逻辑路径，符号链接和真实路径对不上，强制写会直接覆盖 Agent 正在写的文件。
