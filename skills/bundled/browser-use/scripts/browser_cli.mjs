#!/usr/bin/env node
/**
 * browser_cli.mjs —— browser-use 技能的 node 单文件入口（browser_cli.sh 的跨平台等价实现）。
 *
 * 为什么存在：Windows LOCAL 的 shell 宿主是 PowerShell（desktop/electron/localShell.cjs 无 bash），
 * bash wrapper 跑不起来；node 本来就是本技能硬前置（npx + sidecar 全局 WebSocket）。
 * SKILL.md 按 `node -e "console.log(process.platform)"` 分流：win32 → 本脚本；POSIX M1 仍走
 * browser_cli.sh（零回归面），M2 收敛后全平台切本脚本并删除 .sh。
 * 方案：docs/plan/2026-11/2026-11-21-browser-use-windows-local-technical-design.md（D1/D4/D5）。
 *
 * 职责 = browser_cli.sh 头注释的四件事：
 *   1. CLI 解析：优先已有 playwright-cli，否则 npx 拉取 @playwright/cli（PWCLI_PACKAGE 固定版本）；
 *   2. live 环境准备（尽力而为，任一环节失败即纯透传 CLI）；
 *   3. sidecar 确保存活（detached spawn + host.pid + host.ready 轮询；windowsHide 防 Windows 闪窗）；
 *   4. `open` 注入：按 CLI 会话名挑 CDP 端口 + 组装 config；末尾透传退出码。
 *
 * Windows shim spawn 策略（D1，.cmd shim 在 Node ≥18 下无 shell 直 spawn 报 EINVAL）：
 *   a. npm prefix -g 定位 @playwright/cli 包的 JS bin，用 node 直跑（绕开 shim 与 shell 引号坑）；
 *   b. 兜底 npx-cli.js 直 spawn（官方 node 布局 <nodeDir>/node_modules/npm/bin/npx-cli.js，零转义）；
 *   c. 末位 npx shell:true——cmd.exe 元字符下 URL 的 & / % 会破参（排障文档已记录残留风险）。
 */
import { execSync, spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOpenConfigJson,
  chromiumBinRelPath,
  chromiumCacheRoot,
  cliBinFromPackageJson,
  parseArgs,
  safeSessionName,
  systemChromeCandidates,
} from './browser_cli_lib.mjs';

// SCRIPT_DIR 从调用路径（process.argv[1]）推导，保留 symlink——与 bash 的 BASH_SOURCE 同语义：
// CLOUD 技能目录是 symlink 挂载（skill-sync-service symlinkSync('dir')），import.meta.url 会被 node
// 解析为真实路径，导致「上跳两级 = 会话运行时根」落到技能源目录（评审 P1-1）。argv[1] 缺失才回退。
const SCRIPT_DIR = process.argv[1]
  ? path.dirname(path.resolve(process.argv[1]))
  : path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const TEMPLATE_CONFIG = path.join(SCRIPT_DIR, 'cli.config.json');
const HOST_SCRIPT = path.join(SCRIPT_DIR, 'browser-live-host.mjs');
const PACKAGE = process.env.PWCLI_PACKAGE || '@playwright/cli@latest';
const IS_WIN32 = process.platform === 'win32';

// ---------- 文件/命令探测小件 ----------

function isExecutableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
    if (!IS_WIN32) accessSync(p, constants.X_OK); // Windows 上 X_OK 语义等于存在性，stat 即可
    return true;
  } catch { return false; }
}

/** `command -v` 等价（仅 POSIX 候选命令名会走到这里） */
function isCommandOnPath(name) {
  if (name.includes('/') || name.includes('\\')) return isExecutableFile(name);
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => isExecutableFile(path.join(dir, name)));
}

// ---------- 1. CLI 解析与 spawn 策略 ----------

function resolveWin32GlobalCliBin() {
  let prefix = '';
  try {
    // execSync 默认走 shell：npm 是 .cmd shim 也能跑；输出含 CRLF 需 trim
    prefix = execSync('npm prefix -g', { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
  } catch { return null; }
  if (!prefix) return null;
  const pkgDir = path.join(prefix, 'node_modules', '@playwright', 'cli');
  let binRel = null;
  try {
    binRel = cliBinFromPackageJson(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch { return null; }
  if (!binRel) return null;
  const binPath = path.join(pkgDir, binRel);
  return existsSync(binPath) ? binPath : null;
}

function resolveWin32NpxCliJs() {
  const p = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return existsSync(p) ? p : null;
}

/** cmd.exe 参数加引号（方案 D1 口径：所有参数统一双引号包裹）；% 无法转义（环境变量展开为已记录的残留风险） */
function quoteForCmd(args) {
  return args.map((a) => `"${a.replace(/"/g, '""')}"`);
}

function runCli(cliArgs) {
  if (!IS_WIN32) {
    // POSIX：PATH 命中直接跑（shebang bin，execvp 可执行）；否则 npx 拉取——与 bash 版一致
    if (isCommandOnPath('playwright-cli')) {
      return spawnSync('playwright-cli', cliArgs, { stdio: 'inherit' });
    }
    return spawnSync('npx', ['--yes', '--package', PACKAGE, 'playwright-cli', ...cliArgs], { stdio: 'inherit' });
  }
  const globalBin = resolveWin32GlobalCliBin();
  if (globalBin) {
    return spawnSync(process.execPath, [globalBin, ...cliArgs], { stdio: 'inherit', windowsHide: true });
  }
  const npxCliJs = resolveWin32NpxCliJs();
  if (npxCliJs) {
    return spawnSync(process.execPath, [npxCliJs, '--yes', '--package', PACKAGE, 'playwright-cli', ...cliArgs],
      { stdio: 'inherit', windowsHide: true });
  }
  return spawnSync('npx', ['--yes', '--package', PACKAGE, 'playwright-cli', ...quoteForCmd(cliArgs)],
    { stdio: 'inherit', windowsHide: true, shell: true });
}

// ---------- 2/3/4. live 环境准备（尽力而为） ----------

const { subcommand, cliSession, userConfig } = parseArgs(process.argv.slice(2), process.env.PLAYWRIGHT_CLI_SESSION);

const cliArgs = [...process.argv.slice(2)];
let liveReady = false;
let liveDir = '';
let runtimeDir = '';

if (subcommand && !userConfig && typeof WebSocket === 'function') { // Node >= 22 才有全局 WebSocket
  runtimeDir = path.resolve(SKILL_DIR, '..', '..'); // 技能目录上跳两级 = 会话运行时根
  try {
    if (statSync(runtimeDir).isDirectory()) {
      liveDir = path.join(runtimeDir, '.mao-browser');
      for (const d of ['cdp', 'config', 'logs']) mkdirSync(path.join(liveDir, d), { recursive: true });
      liveReady = true;
    }
  } catch { /* 运行时目录不可用 → 纯透传 */ }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 不支持则跳过等待 */ }
}

/** host.pid + host.ready 都在且 pid 进程存活（process.kill(pid, 0)） */
function hostAlive() {
  try {
    const pidFile = path.join(liveDir, 'host.pid');
    if (!existsSync(pidFile) || !existsSync(path.join(liveDir, 'host.ready'))) return false;
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

if (liveReady && !hostAlive()) {
  try { rmSync(path.join(liveDir, 'host.pid'), { force: true }); } catch { /* ignore */ }
  try { rmSync(path.join(liveDir, 'host.ready'), { force: true }); } catch { /* ignore */ }
  // 模式判定：桌面 LOCAL shell 会注入 MAO_BASE_URL/MAO_TOKEN（mao / mao-agent CLI 便利），
  // 会误触 cloud 启发式——sidecar 以 access token 握手 runner 被后端拒（要求 shell token 且仅
  // CLOUD 会话），直播全灭。桌面端经 MAO_BROWSER_LIVE_MODE=local 显式钉死本地 SSE 出口
  // （browserLive.cjs 枢纽按 live.json 直连），CLOUD 服务端不设此 env，维持原启发式
  // （2026-11-21 Windows 真机 smoke 发现，LOCAL / CLOUD 双模式方案 2026-11-20 v2 D10）。
  const mode = process.env.MAO_BROWSER_LIVE_MODE === 'local'
    || !(process.env.MAO_BASE_URL && process.env.MAO_TOKEN)
    ? 'local'
    : 'cloud';
  try {
    const child = spawn(process.execPath, [HOST_SCRIPT, '--live-dir', liveDir, '--mode', mode, '--session', path.basename(runtimeDir)],
      { detached: true, stdio: 'ignore', windowsHide: true });
    writeFileSync(path.join(liveDir, 'host.pid'), String(child.pid));
    child.unref();
  } catch { /* 拉不起 sidecar → 纯透传，下条命令重试 */ }
  for (let i = 0; i < 6 && !existsSync(path.join(liveDir, 'host.ready')); i++) sleepSync(500);
}

// ---------- open：按 CLI 会话名挑 CDP 端口并生成 config（浏览器启动时才需要注入） ----------

async function probeCdpPort(portFile) {
  let raw = '';
  try { raw = readFileSync(portFile, 'utf8').trim(); } catch { return null; }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? port : null;
  } catch { return null; }
}

function findFreePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', () => resolve(null));
  });
}

function detectSystemChrome() {
  return systemChromeCandidates(process.platform, process.env, os.homedir())
    .some((c) => isCommandOnPath(c));
}

function detectPlaywrightChromium() {
  const root = chromiumCacheRoot(process.platform, process.env, os.homedir());
  if (!root) return false;
  let entries;
  try { entries = readdirSync(root).filter((n) => n.startsWith('chromium-')).sort().reverse(); } catch { return false; }
  for (const entry of entries) {
    let children;
    try { children = readdirSync(path.join(root, entry)); } catch { continue; }
    const rel = chromiumBinRelPath(process.platform, children);
    if (!rel) continue;
    if (isExecutableFile(path.join(root, entry, rel))) return true;
  }
  return false;
}

/** 仅 Linux root 注 --no-sandbox（方案 D1：Windows/macOS 不注；与 deps 服务降级口径一致） */
function noSandboxArgs() {
  return process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
    ? '--no-sandbox'
    : '';
}

if (liveReady && subcommand === 'open') {
  const safe = safeSessionName(cliSession);
  const portFile = path.join(liveDir, 'cdp', `${safe}.port`);
  const cfgFile = path.join(liveDir, 'config', `${safe}.json`);
  let port = await probeCdpPort(portFile);
  if (port === null) {
    const fresh = await findFreePort();
    if (fresh !== null) {
      try { writeFileSync(portFile, String(fresh)); } catch { /* 端口文件写失败 → 本次无直播 */ }
      port = fresh;
    }
  }
  if (port !== null) {
    const chromeOk = detectSystemChrome();
    const chromiumOk = detectPlaywrightChromium();
    if (!chromeOk && !chromiumOk) {
      console.error('[browser-use] 浏览器内核未安装：请管理员在 管理后台 → Skills 管理 对 browser-use 执行「安装依赖」（或在服务器预装系统 Chrome）。');
    }
    try {
      writeFileSync(cfgFile, buildOpenConfigJson(readFileSync(TEMPLATE_CONFIG, 'utf8'), port, noSandboxArgs(), chromeOk, chromiumOk));
      cliArgs.push(`--config=${cfgFile}`);
    } catch { /* config 写失败 → 本次无直播，CLI 原生报错照常出现 */ }
  }
}

// ---------- 透传 CLI 与退出码 ----------

const result = runCli(cliArgs);
if (result.error) {
  console.error(`[browser-use] CLI 启动失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
