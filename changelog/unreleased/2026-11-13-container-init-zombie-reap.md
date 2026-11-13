### 后端

- **容器增加 `--init`（docker-init/tini）回收僵尸进程**：Node 作为容器 PID 1 只回收自己 spawn 的子进程，Chrome/Playwright 等孙进程被 reparent 到 PID 1 后会永久残留为僵尸，长期占用 `--pids-limit`（默认 512）配额；配额耗尽后新 shell 一律 `spawn EAGAIN`（工具侧曾显示为 `exit_code: -11`，形似 SIGSEGV）。改为 `docker run --init`，由 tini 作 PID 1 统一回收孤儿，并顺带让 `docker stop` 的 SIGTERM 能真正送达 node（停止耗时从等满超时降为即时）。存量容器需重建一次（`--init` 为 create-time 参数，`docker restart` 不会补）。
