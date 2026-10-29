# 复现脚本 · 2026-10-29 长文本用户消息「文件化」第 1 轮审查

被审对象：工作区未提交改动（`dump_user_messages` 工具 + 粘贴超长文本转附件 + Electron `write_local_text_file`）。
对应报告：`docs/code-review/2026-10-29-long-user-message-file-export-round1.md`。

三个脚本都**不修改仓库源码**，只读取现有实现：

| 文件 | 复现内容 | 运行方式 |
|---|---|---|
| `overwrite-and-local-chain.test.cjs` | ① `dump_user_messages`(LOCAL) ↔ `chatAttachment.writeLocalTextFileAsync` 契约一致（正向确认）；② 同名粘贴附件第二次落盘覆盖第一次（问题 1 的落盘机理） | `node --test docs/code-review/repro/2026-10-29-long-user-message-file-export/overwrite-and-local-chain.test.cjs`（仓库根目录，需先 `npm run build` 过 backend-ts，脚本读 `backend-ts/dist`） |
| `chatinput-paste.behavior.test.ts` | 问题 1 的 UI 侧前提：新建态粘贴 → 发送后输入框切换实例 → 再粘贴仍是 `pasted-text-1.txt`；外加 CLOUD 正向对照 3 例 | 见下「jsdom 用例运行步骤」 |
| `chatinput-paste.local-web.test.ts` | 问题 2：LOCAL 模式 + 非 Electron（浏览器）粘贴超长文本被吞（附件 0 个、编辑器 0 字、默认粘贴被 preventDefault） | 同上（必须与上一个文件分开跑：`isElectronClient` 是 ChatInput 模块级常量，两文件需不同进程模块状态） |

## jsdom 用例运行步骤

ChatInput 需要的 `isElectronClient` 在模块加载时求值，且仓库既有 `desktop/vitest.config.ts` 只收 `src/**/*.test.ts`，
因此按下面方式用一份临时配置跑（不触碰仓库配置与源码）：

```bash
cd <仓库根>/mao                       # 工作区根（含 desktop/ backend-ts/）
mkdir -p desktop/.tmp-test
cp docs/code-review/repro/2026-10-29-long-user-message-file-export/chatinput-paste.*.test.ts \
   docs/code-review/repro/2026-10-29-long-user-message-file-export/vitest.config.ts \
   desktop/.tmp-test/
cd desktop
NODE_OPTIONS="--require $(cd ..; pwd)/docs/code-review/repro/2026-10-29-long-user-message-file-export/zstd-stub.cjs" \
  npx vitest run --config .tmp-test/vitest.config.ts
# 结果：2 文件 / 5 用例全部通过（通过 = 当前实现确实复现了上述行为）
cd .. && rm -rf desktop/.tmp-test       # 清理临时目录
```

`zstd-stub.cjs` 与本次改动无关：本机 Node 22.14 的 `zlib` 没有 `createZstdDecompress`，jsdom → undici 装载即抛错，
导致 jsdom 环境 worker 起不来（仓库内 20 个既有 jsdom 用例同样受影响）。Node ≥ 22.15 可省略该 `--require`。

## 本机实测输出（节选）

```
$ node --test docs/code-review/repro/2026-10-29-long-user-message-file-export/overwrite-and-local-chain.test.cjs
ok 1 - 契约：dump_user_messages(LOCAL) 委托 write_local_text_file，返回桌面端本机绝对路径
ok 2 - 同名粘贴附件在 dedupe=false（dump 委托语义）下第二次落盘覆盖第一次：历史消息引用被改写
# pass 2 / fail 0

$ npx vitest run --config .tmp-test/vitest.config.ts
 ✓ .tmp-test/chatinput-paste.local-web.test.ts (1 test)
 ✓ .tmp-test/chatinput-paste.behavior.test.ts (4 tests)
 Tests  5 passed (5)
```

> 第 2 轮（2026-10-29）说明：`writeLocalTextFileAsync` 新增 `dedupe` 参数（缺省 true = 同名避重），
> 本目录第 2 个用例因此显式传 `dedupe: false` 以继续固化 dump 委托的「按消息 id 幂等覆盖」；
> 渲染层避重与修复后行为的复核见 `../2026-10-29-long-user-message-file-export-round2/`。
