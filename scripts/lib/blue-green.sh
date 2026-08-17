#!/bin/bash
# Blue-green backend deploy helpers. Sourced by backend-ts/restart.sh and scripts/restart-backend.sh.

set -euo pipefail

: "${MAO_BLUE_GREEN_PORT_A:=9080}"
: "${MAO_BLUE_GREEN_PORT_B:=9081}"
: "${MAO_RUNTIME_DIR:=/opt/mao-data/runtime}"
: "${MAO_NGINX_UPSTREAM_CONF:=/etc/nginx/conf.d/mao-upstream.conf}"
: "${MAO_BLUE_GREEN_DRAIN_SEC:=60}"
: "${MAO_BLUE_GREEN_HEALTH_RETRIES:=60}"
: "${MAO_BLUE_GREEN_HEALTH_INTERVAL_SEC:=1}"
: "${MAO_BLUE_GREEN_STALE_LOCK_SEC:=600}"

bg_active_port_file() {
  echo "${MAO_RUNTIME_DIR}/active-backend-port"
}

bg_deploy_lock_file() {
  echo "${MAO_RUNTIME_DIR}/deploy.lock"
}

bg_pid_file_for_port() {
  local app_dir="$1"
  local port="$2"
  echo "${app_dir}/mao-server-ts-${port}.pid"
}

bg_legacy_pid_file() {
  local app_dir="$1"
  echo "${app_dir}/mao-server-ts.pid"
}

bg_ensure_runtime_dir() {
  mkdir -p "${MAO_RUNTIME_DIR}"
}

bg_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti ":${port}" >/dev/null 2>&1
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -tln | grep -q ":${port} "
    return $?
  fi
  return 1
}

bg_read_active_port() {
  local file
  file="$(bg_active_port_file)"
  if [ -f "$file" ]; then
    local port
    port="$(tr -d '[:space:]' < "$file")"
    if [ "$port" = "$MAO_BLUE_GREEN_PORT_A" ] || [ "$port" = "$MAO_BLUE_GREEN_PORT_B" ]; then
      echo "$port"
      return 0
    fi
  fi
  if bg_port_in_use "$MAO_BLUE_GREEN_PORT_A"; then
    echo "$MAO_BLUE_GREEN_PORT_A"
  elif bg_port_in_use "$MAO_BLUE_GREEN_PORT_B"; then
    echo "$MAO_BLUE_GREEN_PORT_B"
  else
    echo "$MAO_BLUE_GREEN_PORT_A"
  fi
}

bg_write_active_port() {
  bg_ensure_runtime_dir
  echo "$1" > "$(bg_active_port_file)"
}

bg_write_deploy_lock() {
  local started_at="$1"
  local old_port="$2"
  local new_port="$3"
  local status="$4"
  bg_ensure_runtime_dir
  cat > "$(bg_deploy_lock_file)" <<EOF
{"startedAt":${started_at},"oldPort":${old_port},"newPort":${new_port},"status":"${status}","drainSec":${MAO_BLUE_GREEN_DRAIN_SEC}}
EOF
}

bg_clear_stale_deploy_lock() {
  local lock_file
  lock_file="$(bg_deploy_lock_file)"
  [ -f "$lock_file" ] || return 0
  local started_at now age
  started_at=$(python3 -c "import json; print(json.load(open('${lock_file}')).get('startedAt',0))" 2>/dev/null || echo 0)
  now=$(date +%s)
  age=$((now - started_at))
  if [ "$age" -gt "$MAO_BLUE_GREEN_STALE_LOCK_SEC" ]; then
    echo "WARN: clearing stale deploy.lock (age=${age}s)"
    rm -f "$lock_file"
  fi
}

bg_rotate_log() {
  local log_file="$1"
  if [ -f "$log_file" ]; then
    local size
    size=$(stat -c%s "$log_file" 2>/dev/null || stat -f%z "$log_file" 2>/dev/null || echo 0)
    local max_bytes=$((100 * 1024 * 1024))
    if [ "$size" -gt "$max_bytes" ] 2>/dev/null; then
      mv "$log_file" "$log_file.$(date +%Y%m%d%H%M%S)"
      ls -t "$log_file".* 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
    fi
  fi
}

bg_stop_port() {
  local app_dir="$1"
  local port="$2"
  local pid_file
  pid_file="$(bg_pid_file_for_port "$app_dir" "$port")"
  if [ -f "$pid_file" ]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping mao-server-ts on port ${port} (PID: ${pid})..."
      kill "$pid" 2>/dev/null || true
      sleep 2
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  fi
  if bg_port_in_use "$port"; then
    if command -v lsof >/dev/null 2>&1; then
      lsof -ti ":${port}" | xargs kill 2>/dev/null || true
      sleep 1
      lsof -ti ":${port}" | xargs kill -9 2>/dev/null || true
    fi
  fi
}

bg_migrate_legacy_pid() {
  local app_dir="$1"
  local port="$2"
  local legacy
  legacy="$(bg_legacy_pid_file "$app_dir")"
  local target
  target="$(bg_pid_file_for_port "$app_dir" "$port")"
  if [ -f "$legacy" ] && [ ! -f "$target" ]; then
    mv "$legacy" "$target"
  fi
}

# Start backend without inheriting deploy flock or other stray FDs from the parent shell.
bg_start_port() {
  local app_dir="$1"
  local port="$2"
  local log_dir="$3"
  local log_file="${log_dir}/backend-ts-${port}.log"
  local pid_file
  pid_file="$(bg_pid_file_for_port "$app_dir" "$port")"

  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "Backend already running on port ${port} (PID: $(cat "$pid_file"))"
    return 0
  fi

  echo "Starting mao-server-ts on port ${port}..."
  bg_rotate_log "$log_file"
  mkdir -p "$log_dir"
  cd "$app_dir"
  export MAO_TS_PORT="$port"
  if [ -f dist/main.js ]; then
    setsid nohup node dist/main.js >> "$log_file" 2>&1 </dev/null &
  else
    setsid nohup npx tsx src/main.ts >> "$log_file" 2>&1 </dev/null &
  fi
  echo $! > "$pid_file"
  disown 2>/dev/null || true
  echo "Started on port ${port} (PID: $(cat "$pid_file"))"
}

bg_wait_healthy() {
  local port="$1"
  local i code
  for i in $(seq 1 "$MAO_BLUE_GREEN_HEALTH_RETRIES"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/swagger-ui.html" 2>/dev/null || echo 000)
    if [ "$code" = "200" ] || [ "$code" = "301" ] || [ "$code" = "302" ]; then
      echo "Health check passed on port ${port} (HTTP ${code})"
      return 0
    fi
    sleep "$MAO_BLUE_GREEN_HEALTH_INTERVAL_SEC"
  done
  echo "Health check failed on port ${port} after ${MAO_BLUE_GREEN_HEALTH_RETRIES} attempts" >&2
  return 1
}

bg_switch_nginx_upstream() {
  local port="$1"
  if [ ! -d "$(dirname "$MAO_NGINX_UPSTREAM_CONF")" ]; then
    echo "WARN: nginx conf dir missing, skip upstream switch (port ${port})"
    return 0
  fi
  local tmp="${MAO_NGINX_UPSTREAM_CONF}.tmp.$$"
  cat > "$tmp" <<EOF
upstream mao_backend {
    server 127.0.0.1:${port};
}
EOF
  if [ "$(id -u)" -eq 0 ]; then
    mv "$tmp" "$MAO_NGINX_UPSTREAM_CONF"
    nginx -t
    systemctl reload nginx
  else
    sudo mv "$tmp" "$MAO_NGINX_UPSTREAM_CONF"
    sudo nginx -t
    sudo systemctl reload nginx
  fi
  echo "Nginx upstream switched to port ${port}"
}

bg_schedule_stop_old() {
  local app_dir="$1"
  local old_port="$2"
  local new_port="$3"
  local drain="$4"
  local log_dir="$5"
  local script="${MAO_RUNTIME_DIR}/stop-old-backend.sh"
  cat > "$script" <<EOS
#!/bin/bash
set -euo pipefail
echo "[\$(date -Iseconds)] drain: will stop port ${old_port} in ${drain}s if active stays ${new_port}"
sleep ${drain}
export BG_LIB_PATH="${BG_LIB_PATH}"
# shellcheck source=/dev/null
source "\$BG_LIB_PATH"
active="\$(bg_read_active_port)"
if [ "\$active" != "${new_port}" ]; then
  echo "Skip drain stop on ${old_port}: active port is \$active (expected ${new_port})"
  exit 0
fi
bg_stop_port "${app_dir}" "${old_port}"
bg_write_deploy_lock \$(date +%s) "${old_port}" "${new_port}" "drained"
EOS
  chmod +x "$script"
  setsid nohup bash "$script" >> "${log_dir}/blue-green-drain.log" 2>&1 </dev/null &
  disown 2>/dev/null || true
  echo "Scheduled stop of old instance on port ${old_port} in ${drain}s (log: ${log_dir}/blue-green-drain.log)"
}

# Main entry: blue-green deploy for backend-ts directory.
# Usage: BG_LIB_PATH=/path/to/blue-green.sh bg_deploy /opt/mao/backend-ts
bg_deploy() {
  local app_dir="$1"
  BG_LIB_PATH="${BG_LIB_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/blue-green.sh}"
  bg_ensure_runtime_dir
  bg_clear_stale_deploy_lock

  local flock_file="${MAO_RUNTIME_DIR}/deploy.flock"
  # Short-lived mutex only — must release before starting Node (FD inheritance bug).
  exec 9>"$flock_file"
  if ! flock -n 9; then
    echo "Another blue-green deploy is already in progress" >&2
    echo "If this is stale, remove ${flock_file} after confirming no restart.sh is running." >&2
    exit 1
  fi

  local env_file="${app_dir}/.env"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck source=/dev/null
    source "$env_file"
    set +a
  fi

  local log_dir="${MAO_LOG_DIR:-${app_dir}/logs}"
  mkdir -p "$log_dir"

  local current_port new_port started_at
  current_port="$(bg_read_active_port)"
  if [ "$current_port" = "$MAO_BLUE_GREEN_PORT_A" ]; then
    new_port="$MAO_BLUE_GREEN_PORT_B"
  else
    new_port="$MAO_BLUE_GREEN_PORT_A"
  fi

  bg_migrate_legacy_pid "$app_dir" "$current_port"
  started_at=$(date +%s)
  bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "starting"

  # Release flock before any long-running / child backend process.
  exec 9>&-

  if bg_port_in_use "$current_port"; then
    echo "Current active port: ${current_port}"
    echo "Deploying new instance on port: ${new_port}"
    bg_start_port "$app_dir" "$new_port" "$log_dir"
    if ! bg_wait_healthy "$new_port"; then
      bg_stop_port "$app_dir" "$new_port"
      bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "failed"
      exit 1
    fi
    bg_switch_nginx_upstream "$new_port" || {
      bg_stop_port "$app_dir" "$new_port"
      bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "failed"
      exit 1
    }
    bg_write_active_port "$new_port"
    bg_write_deploy_lock "$started_at" "$current_port" "$new_port" "switched"
    bg_schedule_stop_old "$app_dir" "$current_port" "$new_port" "$MAO_BLUE_GREEN_DRAIN_SEC" "$log_dir"
    echo "Blue-green deploy complete: traffic on ${new_port}, old instance on ${current_port} draining"
  else
    echo "No backend listening on ${current_port}; starting fresh on ${current_port}"
    if bg_port_in_use "$new_port"; then
      echo "Stopping orphan instance on alternate port ${new_port} (active port ${current_port} was down)"
      bg_stop_port "$app_dir" "$new_port"
    fi
    bg_start_port "$app_dir" "$current_port" "$log_dir"
    if ! bg_wait_healthy "$current_port"; then
      bg_stop_port "$app_dir" "$current_port"
      bg_write_deploy_lock "$started_at" "$current_port" "$current_port" "failed"
      exit 1
    fi
    bg_switch_nginx_upstream "$current_port" || true
    bg_write_active_port "$current_port"
    bg_write_deploy_lock "$started_at" "$current_port" "$current_port" "started"
    echo "Backend started on port ${current_port}"
  fi
}
