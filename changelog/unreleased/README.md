# 未发布的发版说明

每个需求新增一个本目录下的 Markdown 文件，不要改根目录 `CHANGELOG.md`，也不要改 `changelog/YYYY/MM.md`。

文件名用 `YYYY-MM-DD-短名.md`，例如 `2026-11-12-runtime-socket.md`。短名用英文小写和短横线。一次需求涉及多端时写在同一个文件里。

不要写版本号，也不要写 `## ` 标题。只写小节和条目：

```markdown
### 后端

- **修复通道 socket 被删后无法自愈**：……

### 前端（桌面 / Web / 安卓）

- **审批卡片上标出 Y / N**：……
```

小节名用下面这套，顺序不用管，汇合时会排好：

- 后端
- 前端（桌面 / Web / 安卓）
- 桌面 Electron
- 管理后台
- 安卓原生
- 终端 CLI（mao-agent）
- 终端 CLI（mao-cli）

打包、发版或 OTA 之前，在 main 上跑一次：

```bash
./scripts/changelog-cut.sh
```

并行分支不要跑这条命令。它会把本目录里除本说明外的碎片合成下一个版本，写进当月归档，然后删掉已收录的碎片。先看结果可以加 `--dry-run`。
