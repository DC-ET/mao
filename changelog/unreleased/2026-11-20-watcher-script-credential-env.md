### 后端

- **信号哨兵 Shell 脚本执行注入 Agent Shell 同款凭据环境变量**：脚本探针每次执行现取 `MAO_TOKEN` / `ECP_TOKEN` / `GIT_TOKEN_<域名>`（按哨兵绑定 Agent 的允许域交集 + 系统默认兜底，配 git 凭据时另注入 `GIT_ASKPASS` / `GIT_TERMINAL_PROMPT=0`，https 远端免密）/ `MAO_BASE_URL` / Lark CLI 凭据 / 三级环境变量（系统 < 用户 < 哨兵脚本项目层）；单项凭据不可用时只跳过该项，探针照常执行。Docker 模式凭据经运行时通道随探针帧下发（旧容器运行时按无凭据降级，部署后随构建漂移自动升级）。基础白名单（`PATH` / `HOME` / `TZ` / `MAO_WATCHER_ID` / `MAO_WATCHER_NAME`）与「不继承后端进程全量 env」不变；此调整推翻 2026-11-10 脚本哨兵方案「凭据占位符机制不扩展到脚本」的非目标决策。
