#!/usr/bin/env bash
# 兜底回收异常容器（技术方案 §6 部署）：宿主机 cron / systemd timer 周期执行。
#
# 职责：
# 1. 清理已退出（exited/dead）的 mao-user-* 容器（Registry 正常回收只 stop 不 rm，
#    异常退出残骸由本脚本兜底，挂载数据在宿主机目录不受影响）；
# 2. 清理无容器对接的残留 socket 文件（容器被 rm 后 socket 已无意义）。
set -euo pipefail

CHANNEL_DIR="${MAO_CONTAINER_CHANNEL_DIR:-/opt/mao-data/runtime/channels}"

if ! command -v docker >/dev/null 2>&1; then
  echo "container-gc: docker 不可用，跳过" >&2
  exit 0
fi

# 1. 退出态容器清理
EXITED="$(docker ps -a --filter 'name=mao-user-' --filter 'status=exited' --filter 'status=dead' -q || true)"
if [ -n "$EXITED" ]; then
  # shellcheck disable=SC2086
  docker rm $EXITED >/dev/null
  echo "container-gc: removed exited containers: $(echo "$EXITED" | wc -l | tr -d ' ')"
fi

# 2. 残留 socket 清理：目录下没有 running 状态容器对应 socket 时移除 runtime.sock
if [ -d "$CHANNEL_DIR" ]; then
  for user_dir in "$CHANNEL_DIR"/*/; do
    [ -d "$user_dir" ] || continue
    sock="${user_dir}runtime.sock"
    [ -S "$sock" ] || continue
    # socket 有活跃连接（lsof 可见）则跳过；lsof 缺失时保守跳过清理
    if command -v lsof >/dev/null 2>&1; then
      if lsof "$sock" >/dev/null 2>&1; then
        continue
      fi
      rm -f "$sock"
    fi
  done
fi

echo "container-gc: done"
