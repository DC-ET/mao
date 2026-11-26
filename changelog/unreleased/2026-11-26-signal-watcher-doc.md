### 终端 CLI（mao-cli）

- **信号哨兵文档补清三处易错点**：脚本探针路径以 `{workspaceRoot}/{userId}/projects` 为解析根、必须带项目 slug（只写项目内的相对路径会报「脚本文件不存在」）；会话内用 `create_signal_watcher` 创建时默认指定当前会话，与 CLI `--trigger-mode` 缺省的 `NEW_SESSION` 不同；「变化后回到当前对话」用 `SPECIFIED_SESSION`，`REUSE_SESSION` 是哨兵首次触发自建的专属会话。