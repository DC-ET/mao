#!/bin/bash
# Blue-green restart for the TypeScript backend (9080 <-> 9081).
# Used by GET /v1/admin/runtime/restart and manual deploys.
# Deploy to ${app.root-dir}/backend-ts/restart.sh (default /opt/mao/backend-ts/restart.sh).

set -euo pipefail

# Cloud shell sessions SIGKILL their process group on close; re-exec under setsid
# so blue-green deploy (health check, nginx switch, drain scheduling) can finish.
if [ -z "${MAO_RESTART_DETACHED:-}" ]; then
  export MAO_RESTART_DETACHED=1
  exec setsid "$0" "$@"
fi

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$APP_DIR")"
BG_LIB_PATH="${ROOT_DIR}/scripts/lib/blue-green.sh"

if [ ! -f "$BG_LIB_PATH" ]; then
  echo "Blue-green library not found: $BG_LIB_PATH" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$BG_LIB_PATH"
export BG_LIB_PATH
bg_deploy "$APP_DIR"
