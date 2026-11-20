# 代码审查：CLOUD 工作区文件管理

审查范围：worktree `feat/workspace-file-manager` 的未提交改动（文件写入、路径沙箱、与 Agent 写锁冲突、上传）。只记录已用失败测试复现的功能问题。产品代码未改。

验证命令（在 `backend-ts`）：

```bash
npx vitest run src/file/workspace-write.service.spec.ts src/harness/tool/impl/file-write-lock.spec.ts
```

结果：6 failed | 14 passed。下面 4 个问题对应这 6 条新增失败用例（其中两个问题各有一条服务级用例和一条锁级用例）。

## 1. 同一次上传里的同名文件会静默覆盖

**现象：** `overwrite` 未打开时，一次上传里两个 `relativePath` 相同的文件不会返回「目标已存在」。接口成功，后一个内容盖掉前一个。桌面端多选或拖入同名文件时，`relativePath` 用的是文件名，会走到这条路径。

**复现：** 对同一目录上传两份 `a.txt`（内容分别是 `first`、`second`），且不传 `overwrite`。

**失败测试：**

- 文件：`backend-ts/src/file/workspace-write.service.spec.ts`
- 用例：`rejects an upload batch that names the same file twice when overwrite is off`
- 断言：应抛出 `BusinessException`（3044）
- 实际：返回 `{ path: 'in' }`

**为什么是功能错误：** 存在性检查在真正写入之前一次性做完。此时磁盘上还没有第一份文件，第二份也判为「不存在」。随后两份都写入，第二次 `rename` 覆盖第一次。调用方得到成功，第一份内容丢失，也没有覆盖确认。

## 2. 指向工作区外的符号链接删不掉

**现象：** 文件树会列出符号链接（`lstat`，不跟随）。链接目标在工作区内时可以删除链接本身。目标在工作区外时，删除直接「路径访问被拒绝」，链接还在。工作区外的文件不会被改动，但用户无法从文件管理里清掉这个条目。重命名、移动走的是同一套路径解析，同样过不了。

**复现：** 在工作区放一个指向外部文件的符号链接，调用删除。

**失败测试：**

- 文件：`backend-ts/src/file/workspace-write.service.spec.ts`
- 用例：`deletes a symlink entry without touching an outside target`
- 实际：`WorkspaceWriteService.delete` → `resolveWritable` 抛出 `路径访问被拒绝`（`ErrorCode.FORBIDDEN`），链接仍在

**为什么是功能错误：** 沙箱应拒绝「顺着链接写到工作区外」。删除这个链接条目本身不跟随目标，现有用例也要求删除工作区内链接时保留目标文件。对外链接却在解析阶段用 `realpath` 判定整条路径越界，导致可见条目无法删除。

## 3. 排队中的 Agent 写入不算冲突，目录删除会成功

**现象：** 两个 `write_file` / `edit_file` 先后抢同一文件时，前一个结束后，后一个已经在执行，但冲突查询是空的。此时用户删除父目录不会得到 3043，目录会被删掉。后一个写入和删除叠在一起，删除结束后写入还可能把文件写回去。

**复现：**

1. Agent 持有 `src/a.txt` 的写锁并停在回调里。
2. 再来一个对同一文件的写锁，等在队列里。
3. 放开第一把锁，在第二把锁的回调里删除 `src`。

**失败测试：**

- `backend-ts/src/file/workspace-write.service.spec.ts` → `rejects deleting a directory while a queued agent write of a file inside it is running`
  - 断言：删除应返回 3043，且 `src/a.txt` 仍是 `v1`
  - 实际：删除返回 `{ path: 'src' }`
- `backend-ts/src/harness/tool/impl/file-write-lock.spec.ts` → `keeps a queued write visible after the previous holder releases the path`
  - 断言：第二个回调执行期间 `conflictingWritePaths` 仍包含该文件
  - 实际：为 `false`

**为什么是功能错误：** `inFlight` 是 `Set`，没有引用计数。排队的写入在等待前就已经 `add` 过同一条路径；前一个写入的 `finally` 会把这条路径 `delete` 掉。目录删除只看 `inFlight` / `heldDirs`，看不到这把还在执行的文件锁，于是不会报「Agent 正在写入」。

## 4. 经符号链接写入时，目录删除锁拦不住

**现象：** 用户删除真实目录 `src` 期间，目录锁是持有的。Agent 若写的是 `link/a.txt`（`link` → `src`），这次写入不会等待，回调会立刻执行。删除和写入可以同时进行。直接写 `src/a.txt` 时会等待，现有用例已覆盖这条；缺口只在符号链接别名上。

**复现：** 持有 `src` 的目录锁（或让删除停在活动记录、锁尚未释放），再对 `link/a.txt` 调用 `withFileLock`。

**失败测试：**

- `backend-ts/src/file/workspace-write.service.spec.ts` → `blocks an agent write through a symlink while the user is deleting the real directory`
  - 断言：删除尚未释放目录锁时，经 `link/a.txt` 的写入不应开始
  - 实际：`wrote === true`
- `backend-ts/src/harness/tool/impl/file-write-lock.spec.ts` → `blocks a new write through a symlink while the real directory is held`
  - 断言：`holdDirectories([src])` 之后，`withFileLock(link/a.txt)` 在释放前不应运行
  - 实际：20ms 内已经运行

**为什么是功能错误：** 注释要求删除目录期间拦住新的 `write_file` / `edit_file`。`ancestorHeld` 只用逻辑路径做前缀比较，没有把文件路径 `realpath` 到真实目录下。`link/a.txt` 和被持有的 `src` 字符串对不上，等待被跳过。
