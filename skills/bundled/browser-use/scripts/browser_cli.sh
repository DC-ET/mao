#!/usr/bin/env bash
#
# browser-use CLI wrapper（playwright-cli 包装）
#
# 与原 playwright 技能 wrapper 一致的两件事：
#   1. playwright-cli 未全局安装时，通过 npx 拉取 @playwright/cli 运行。
#   2. 以 root 运行时 Chromium 会因 sandbox 拒绝启动，生成的 config 自动注入 --no-sandbox。
#
# 本技能新增的两件事（对 agent 透明，见 docs/plan/2026-11/2026-11-20-browser-live-pip-technical-design.md）：
#   3. 为 open 注入 --remote-debugging-port（按 CLI 会话名各一个空闲端口），画面直播用；
#   4. 以 node spawn(detached) 拉起直播采集 sidecar（自成进程组，逃逸 shell 工具的整组击杀）；
#      每条命令都顺带确保 sidecar 存活——sidecar 崩溃后由下一条命令自动恢复续播。
#
# 直播是尽力而为：Node / 运行时目录 / sidecar 任一环节不可用时，wrapper 原样透传 CLI，
# 自动化不受影响。agent 不需要（也不应该）传自定义 --config。
#
# 用法与 playwright-cli 完全一致，参数原样透传：
#   "$PWCLI" open https://example.com
#   "$PWCLI" snapshot
#   "$PWCLI" click e6
#   "$PWCLI" close
#
# 可通过 PWCLI_PACKAGE 固定包版本：PWCLI_PACKAGE=@playwright/cli@1.2.3 "$PWCLI" --help
set -euo pipefail

SKILL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_CONFIG="$SKILL_DIR/scripts/cli.config.json"
HOST_SCRIPT="$SKILL_DIR/scripts/browser-live-host.mjs"
PACKAGE="${PWCLI_PACKAGE:-@playwright/cli@latest}"

if command -v playwright-cli >/dev/null 2>&1; then
  CLI=(playwright-cli)
else
  CLI=(npx --yes --package "$PACKAGE" playwright-cli)
fi

# ---------- 参数解析：子命令 + CLI 会话名（-s=NAME / -s NAME / PLAYWRIGHT_CLI_SESSION）+ 自带 config ----------
subcommand=""
cli_session="${PLAYWRIGHT_CLI_SESSION:-default}"
user_config=0
prev_s=0
for arg in "$@"; do
  case "$arg" in
    --config | --config=*) user_config=1 ;;
    -s=*) cli_session="${arg#-s=}" ;;
    -s) prev_s=1 ;;
    -*)
      prev_s=0
      ;;
    *)
      if [ "$prev_s" -eq 1 ]; then cli_session="$arg"; prev_s=0; continue; fi
      if [ -z "$subcommand" ]; then subcommand="$arg"; fi
      ;;
  esac
done

# ---------- 直播环境准备（尽力而为，任一环节失败即纯透传） ----------
live_ready=0
if [ -n "$subcommand" ] && [ "$user_config" -eq 0 ] && command -v node >/dev/null 2>&1; then
  # 会话运行时根：技能经软链挂载在 <runtime>/skills/<name>，上跳两级
  # CLOUD: <runtimeRoot>/<uid>/<sid>/   LOCAL: ~/.mao/runtime/<hostKey>/<sid>/
  if RUNTIME_DIR="$(cd -- "$SKILL_DIR/../.." 2>/dev/null && pwd)" && [ -n "$RUNTIME_DIR" ]; then
    # Node >= 22 才有全局 WebSocket（sidecar 的 CDP 客户端依赖）
    if node -e 'if (typeof WebSocket !== "function") process.exit(1)' 2>/dev/null; then
      LIVE_DIR="$RUNTIME_DIR/.mao-browser"
      if mkdir -p "$LIVE_DIR/cdp" "$LIVE_DIR/config" "$LIVE_DIR/logs" 2>/dev/null; then
        live_ready=1
      fi
    fi
  fi
fi

if [ "$live_ready" -eq 1 ]; then
  HOST_PID_FILE="$LIVE_DIR/host.pid"
  HOST_READY_FILE="$LIVE_DIR/host.ready"

  host_alive() {
    [ -f "$HOST_PID_FILE" ] && [ -f "$HOST_READY_FILE" ] \
      && kill -0 "$(cat "$HOST_PID_FILE" 2>/dev/null)" 2>/dev/null
  }

  # ---- 确保采集 sidecar 在跑（每条命令都查；detached spawn 自成进程组；双宿竞争由 sidecar 自检收敛） ----
  if ! host_alive; then
    rm -f "$HOST_PID_FILE" "$HOST_READY_FILE"
    MODE=local
    if [ -n "${MAO_BASE_URL:-}" ] && [ -n "${MAO_TOKEN:-}" ]; then
      MODE=cloud
    fi
    MAO_SESSION="$(basename "$RUNTIME_DIR")"
    node -e '
      const { spawn } = require("child_process");
      const { writeFileSync } = require("fs");
      const [script, liveDir, mode, sid] = process.argv.slice(1);
      const child = spawn(process.execPath, [script, "--live-dir", liveDir, "--mode", mode, "--session", sid], {
        detached: true, stdio: "ignore",
      });
      writeFileSync(liveDir + "/host.pid", String(child.pid));
      child.unref();
    ' "$HOST_SCRIPT" "$LIVE_DIR" "$MODE" "$MAO_SESSION" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6; do
      [ -f "$HOST_READY_FILE" ] && break
      sleep 0.5
    done
  fi

  # ---- open：按 CLI 会话名挑 CDP 端口并生成 config（浏览器启动时才需要注入） ----
  if [ "$subcommand" = "open" ]; then
    SAFE_SESSION="$(printf '%s' "$cli_session" | tr -c 'A-Za-z0-9._-' '_')"
    [ -n "$SAFE_SESSION" ] || SAFE_SESSION="default"
    PORT_FILE="$LIVE_DIR/cdp/$SAFE_SESSION.port"
    CFG_FILE="$LIVE_DIR/config/$SAFE_SESSION.json"
    port_ok() {
      [ -s "$PORT_FILE" ] && node -e '
        const port = Number(require("fs").readFileSync(process.argv[1], "utf8").trim());
        if (!Number.isInteger(port) || port <= 0) process.exit(1);
        fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1500) })
          .then((r) => process.exit(r.ok ? 0 : 1))
          .catch(() => process.exit(1));
      ' "$PORT_FILE" 2>/dev/null
    }
    if ! port_ok; then
      NEW_PORT="$(node -e '
        const s = require("net").createServer();
        s.listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); s.close(); });
      ' 2>/dev/null || true)"
      if [ -n "$NEW_PORT" ]; then
        printf '%s' "$NEW_PORT" > "$PORT_FILE"
      fi
    fi
    if [ -s "$PORT_FILE" ]; then
      ROOT_ARGS=""
      if [ "$(id -u)" -eq 0 ]; then ROOT_ARGS="--no-sandbox"; fi
      node -e '
        const { readFileSync, writeFileSync } = require("fs");
        const [template, out, port, rootArgs] = process.argv.slice(1);
        const cfg = JSON.parse(readFileSync(template, "utf8"));
        const args = Array.isArray(cfg.browser?.launchOptions?.args) ? cfg.browser.launchOptions.args.slice() : [];
        args.push("--remote-debugging-port=" + port);
        for (const a of (rootArgs || "").split(" ")) if (a) args.push(a);
        cfg.browser = { ...(cfg.browser ?? {}), launchOptions: { ...(cfg.browser?.launchOptions ?? {}), args } };
        writeFileSync(out, JSON.stringify(cfg, null, 2));
      ' "$TEMPLATE_CONFIG" "$CFG_FILE" "$(cat "$PORT_FILE")" "$ROOT_ARGS" || CFG_FILE=""
      if [ -n "$CFG_FILE" ] && [ -f "$CFG_FILE" ]; then
        set -- "$@" "--config=$CFG_FILE"
      fi
    fi
  fi
fi

exec "${CLI[@]}" "$@"
