/**
 * browser_cli_lib —— browser_cli.mjs 的纯函数层（方案 2026-11-21 §5.1）。
 * 约定：不做 IO / 不 spawn，入参即世界；`node --test browser_cli_lib.test.mjs` 直接可测。
 * 平台口径与 backend-ts/src/browser-deps/browser-deps.service.ts 的 win32 分支保持一致。
 */

/**
 * CLI 参数解析：子命令 + CLI 会话名（-s=NAME / -s NAME / PLAYWRIGHT_CLI_SESSION）+ 自带 config 检测。
 * 与 browser_cli.sh 的 case 分支逐条等价（含 -s 后跟位置参数吞掉作会话名的边角语义）。
 */
export function parseArgs(argv, envSession = '') {
  let subcommand = '';
  let cliSession = envSession || 'default';
  let userConfig = false;
  let prevS = false;
  for (const arg of argv) {
    if (arg === '--config' || arg.startsWith('--config=')) { userConfig = true; continue; }
    if (arg.startsWith('-s=')) { cliSession = arg.slice(3); continue; }
    if (arg === '-s') { prevS = true; continue; }
    if (arg.startsWith('-')) { prevS = false; continue; }
    if (prevS) { cliSession = arg; prevS = false; continue; }
    if (!subcommand) subcommand = arg;
  }
  return { subcommand, cliSession, userConfig };
}

/** CLI 会话名 → 端口/配置文件名。bash 版为 `tr -c 'A-Za-z0-9._-' '_'`（按字节，中文会多替换几个 _），
 * node 版按字符替换——同一会话名在两端产物文件名不同但各自内部确定，不跨端共享。 */
export function safeSessionName(name) {
  const safe = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return safe || 'default';
}

/**
 * playwright chromium 缓存根（平台判定）：
 * win32 → PLAYWRIGHT_BROWSERS_PATH ?? %LOCALAPPDATA%\ms-playwright（无该环境变量回退 homedir/AppData/Local）；
 * 其余（darwin/Linux，现 bash 行为）→ ~/.cache/ms-playwright。
 */
export function chromiumCacheRoot(platform, env = {}, home = '') {
  if (platform === 'win32') {
    if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
    const localAppData = env.LOCALAPPDATA || (home ? `${home}/AppData/Local` : '');
    return localAppData ? `${localAppData}/ms-playwright` : '';
  }
  return `${home}/.cache/ms-playwright`;
}

/**
 * 系统 Chrome 候选（与 browser-deps.service 同口径）：
 * darwin 应用包真实路径（bash 版沿用 linux 候选在 darwin 必然落空、只多打一次缺内核提示；node 版
 * 改为真实路径——config 结果不变：macOS 无 playwright 缓存，channel 均保留，仅消除误导性 stderr）；
 * win32 三候选；linux 命令名 + 绝对路径（bash 原样，命令名由调用方做 PATH 解析）。
 */
export function systemChromeCandidates(platform, env = {}, home = '') {
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA || (home ? `${home}/AppData/Local` : '');
    const candidates = [
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    if (localAppData) candidates.push(`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`);
    return candidates;
  }
  return ['google-chrome', 'google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/google-chrome'];
}

/**
 * playwright 缓存条目目录的子项 → 二进制相对路径。
 * win32 前缀目录 chrome-win 加 chrome.exe（chrome-win / chrome-win64 都命中）；darwin/Linux 现行为 chrome-linux/chrome
 * （darwin 实际装在 ~/Library/Caches，此探测基本恒空，与 bash 一致：channel 保留，chromium 不参与降级）。
 */
export function chromiumBinRelPath(platform, entryChildren) {
  if (platform === 'win32') {
    const dir = entryChildren.find((n) => n.startsWith('chrome-win'));
    return dir ? `${dir}/chrome.exe` : null;
  }
  return entryChildren.includes('chrome-linux') ? 'chrome-linux/chrome' : null;
}

/** @playwright/cli package.json 的 bin 字段 → 相对 bin 路径（string / object 两形态），解析不出返回 null。 */
export function cliBinFromPackageJson(pkgJsonText, cliName = 'playwright-cli') {
  let pkg;
  try { pkg = JSON.parse(pkgJsonText); } catch { return null; }
  const bin = pkg?.bin;
  if (typeof bin === 'string') return bin;
  if (bin && typeof bin === 'object') {
    if (typeof bin[cliName] === 'string') return bin[cliName];
    return Object.values(bin).find((v) => typeof v === 'string') ?? null;
  }
  return null;
}

/**
 * open config 组装（bash 版 node -e 片段的等价实现）：
 * 注入 --remote-debugging-port=N；root 参数按空格拆开追加；系统 Chrome 缺失且 playwright chromium
 * 就位时去掉 channel 走默认 chromium。返回 JSON 文本（写盘由入口负责）。
 */
export function buildOpenConfigJson(templateText, port, rootArgs, chromeOk, chromiumOk) {
  const cfg = JSON.parse(templateText);
  const args = Array.isArray(cfg.browser?.launchOptions?.args) ? cfg.browser.launchOptions.args.slice() : [];
  args.push(`--remote-debugging-port=${port}`);
  for (const a of String(rootArgs || '').split(' ')) if (a) args.push(a);
  const launchOptions = { ...(cfg.browser?.launchOptions ?? {}), args };
  if (!chromeOk && chromiumOk) delete launchOptions.channel;
  cfg.browser = { ...(cfg.browser ?? {}), launchOptions };
  return JSON.stringify(cfg, null, 2);
}
