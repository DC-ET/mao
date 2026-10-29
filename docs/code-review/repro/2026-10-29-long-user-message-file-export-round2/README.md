# 复现脚本 · 2026-10-29 长文本用户消息「文件化」第 2 轮审查（复核修复）

复核对象：第 1 轮两个问题（`docs/code-review/2026-10-29-long-user-message-file-export-round1.md`）的修复，
以及修复是否引入新问题。**本轮未发现新的功能缺陷**（故无 `-round2.md` 报告），本目录只保留验证脚本与实测输出。

## 三个待确认问题的验证结论

| # | 待确认 | 结论 | 依据 |
|---|---|---|---|
| Q1 | 修复后的 LOCAL 两段粘贴是否还会互相覆盖（组件重建 / 页面刷新两种场景） | **不会**。组件重建：粘贴序号已提升为模块级（`pasted-text-file.ts:24-30`），跨实例连续；页面刷新：序号归零后重名，由 `dedupe`（缺省 true）追加 `-1/-2` 副本，历史引用不被改写 | `dedupe-semantics.test.cjs` A1/A2/A3 + `chatinput-paste.round2.test.ts` 用例 1 |
| Q2 | `dedupe` 两种语义是否与 `dump_user_messages` 的幂等要求一致 | **一致**。工具委托路径（`main.cjs:2405-2407` 显式 `dedupe:false`）同名覆盖同一文件、不产生副本，真实 `DumpUserMessagesTool` 连跑两次仍是单文件且内容为最新；渲染层路径（`main.cjs:1413-1416` 显式 `dedupe:true`）改名为 `-1/-2`；不传参时默认避重（fail-safe） | `dedupe-semantics.test.cjs` B1/B2/A3 |
| Q3 | 浏览器 LOCAL 场景是否已不丢文本 | **是**。`ChatInput.vue:620-631` 在 `preventDefault` 之前先判 `LOCAL && !isElectronClient`，命中时只提示、回落普通粘贴；实测 2500 字符全部插入编辑器、无附件、无拦截 | `chatinput-paste.round2.local-web.test.ts` |

## 文件与运行方式

| 文件 | 复现内容 | 运行方式 |
|---|---|---|
| `dedupe-semantics.test.cjs` | 渲染层避重（A1/A2/A3）、dump 幂等（B1/B2） | `node --test docs/code-review/repro/2026-10-29-long-user-message-file-export-round2/dedupe-semantics.test.cjs`（仓库根目录；需先 `npm run build` 过 backend-ts，B2 读 `backend-ts/dist`） |
| `chatinput-paste.round2.test.ts` | 组件重建后序号连续（不再同名）+ CLOUD 对照 | 见下 jsdom 步骤（需 electronAPI：文件内已注入） |
| `chatinput-paste.round2.local-web.test.ts` | 浏览器 LOCAL 不丢文本（必须独立进程：`isElectronClient` 是模块级常量，且需无 electronAPI） | 同上 |

### jsdom 用例运行步骤（与第 1 轮相同套路，不触碰仓库配置与源码）

```bash
cd <仓库根>/mao
mkdir -p desktop/.tmp-test
cp docs/code-review/repro/2026-10-29-long-user-message-file-export-round2/chatinput-paste.round2*.test.ts \
   docs/code-review/repro/2026-10-29-long-user-message-file-export-round2/vitest.config.ts \
   desktop/.tmp-test/
cd desktop
NODE_OPTIONS="--require $(cd ..; pwd)/docs/code-review/repro/2026-10-29-long-user-message-file-export-round2/zstd-stub.cjs" \
  npx vitest run --config .tmp-test/vitest.config.ts
cd .. && rm -rf desktop/.tmp-test
```

`zstd-stub.cjs` 仅规避本机 Node 22.14 缺 `zlib.createZstdDecompress`（jsdom worker 起不来，与本次改动无关）。

## 本机实测输出（节选）

```
$ node --test .../dedupe-semantics.test.cjs
ok 1 - A1. 渲染层同名粘贴附件两次写入：产生 -1 副本，第一份内容与引用不被改写
ok 2 - A2. 页面刷新（序号归零，再次出现 pasted-text-1.txt）：继续追加 -2，历史引用均不被改写
ok 3 - A3. 防回归：不传 dedupe 时默认避重（不覆盖）
ok 4 - B1. dump 路径（dedupe=false）：同消息重复写入覆盖同文件，不产生副本
ok 5 - B2. 端到端：真实 DumpUserMessagesTool(LOCAL) 连跑两次 → 同路径、单文件、内容为最新
# pass 5 / fail 0

$ NODE_OPTIONS="--require .../zstd-stub.cjs" npx vitest run --config .tmp-test/vitest.config.ts
[round2] chips = [] | 文本已插入编辑器 = true | defaultPrevented = true   ← 浏览器 LOCAL 不丢文本
[round2] 第一次 = [ 'pasted-text-1.txt' ] 第二次 = [ 'pasted-text-2.txt' ]  ← 组件重建后序号连续
 ✓ .tmp-test/chatinput-paste.round2.local-web.test.ts (1 test)
 ✓ .tmp-test/chatinput-paste.round2.test.ts (2 tests)
 Tests  3 passed (3)
```

（`defaultPrevented = true` 由 ProseMirror 默认粘贴处理内部置位，不代表本层拦截；判断依据是文本确实进入了编辑器。）

## 全量回归（本轮实跑）

- `desktop`：`npx vitest run` → 133 文件 / 1355 用例通过 + 20 个既有 jsdom 环境错误；
  加 `zstd-stub` 后 → **153 文件 / 1487 用例全部通过**（证明 20 个错误纯环境问题）。
- `desktop`：`node --test electron/*.test.cjs` 中 `chatAttachment.test.cjs` → 32/32 通过。
- 第 1 轮复现脚本（`../2026-10-29-long-user-message-file-export/`）已同步 `dedupe` 语义，2/2 通过。
