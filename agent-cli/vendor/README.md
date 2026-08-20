`localShell.cjs` 与仓库 `desktop/electron/localShell.cjs` 保持字节一致，供 `npm` / 一键脚本独立安装时使用。

改动 shell 运行时请先改 desktop 侧，再执行：

```bash
cd agent-cli && npm run sync:shell
```

CI 会 `cmp` 两份文件，防止分叉。
