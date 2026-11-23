import { execFile as execFileCb } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SystemSettingRepository } from '../settings/types.js';
import { harnessLog } from '../harness/log.js';

const execFile = promisify(execFileCb);

/**
 * 浏览器依赖按需安装（browser-use 技能，方案 2026-11-20 v2 D7 的按需化）：
 * CLOUD 服务器的 Chrome + @playwright/cli 不再强制预装——管理员明确启用
 * （Agent 勾选保存 / 系统技能页「安装依赖」）时自动安装；无人使用零安装；
 * 预装保留为推荐路径（检测秒过、直接 ready）。
 *
 * 状态机（system_setting `browser_deps.status`，JSON）：not_installed → installing → ready / failed。
 * host 模式安装链：npm i -g @playwright/cli → 系统 Chrome（Linux: deb 下载 + apt，源可配；
 *   Windows: winget 尝试，失败静默降级）→ 失败免 root/免管理员降级：playwright-cli install-browser
 *   （npmmirror 镜像源）下载 chromium。win32 的 npm/playwright-cli/npx 是 .cmd shim，exec 走 shell 化
 *   （needsWin32Shell），chrome.exe / winget 维持 execFile。
 * docker 模式：chrome 烧在镜像里，运行中容器装了会丢 → 触发 build-runtime-image.sh
 *   重建镜像（仓库内首例代码调 build 脚本）+ docker run 验证；状态与安装前都先探测
 *   镜像内依赖（一次性容器），镜像已就绪直接 ready，不再重建。
 *
 * 单飞守卫在进程内存内（蓝绿重叠窗口的并发重复安装可接受：apt/npm 幂等）。
 */

export const BROWSER_DEPS_SKILL_NAME = 'browser-use';
const BROWSER_DEPS_SETTING_KEY = 'browser_deps.status';
const STATUS_VALUE_MAX = 1000;
const DETAIL_MAX = 600;
/** installing 状态超过该时长视为中断（进程重启 / 迟到写入），读取时降级为 failed。 */
const INSTALL_STALE_MS = 30 * 60_000;

export type BrowserDepsPhase = 'not_installed' | 'installing' | 'ready' | 'failed';

export interface BrowserDepsStatus {
  phase: BrowserDepsPhase;
  mode: 'host' | 'docker';
  detail: string | null;
  chrome: { present: boolean; kind: 'system' | 'chromium' | null; version: string | null };
  cli: { present: boolean; version: string | null };
  updatedAt: string;
}

export interface BrowserDepsServiceDeps {
  settingRepo: SystemSettingRepository;
  /** 全局运行时模式（runtime.mode resolver）：docker 模式走镜像重建分支。 */
  getRuntimeMode: () => Promise<'host' | 'docker'>;
  /** 仓库根（build-runtime-image.sh 定位）：来自内置技能根的上一级。 */
  repoRoot: string;
  /** 运行时镜像名（docker 分支构建产物与验证目标）。 */
  image: string;
  /** 命令执行缝（测试注入）；缺省真实 execFile。 */
  execImpl?: (cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<{ ok: boolean; output: string }>;
  /** 平台覆盖（测试注入，固定 chrome 候选路径清单）；缺省 process.platform。 */
  platform?: NodeJS.Platform;
  /** chromium 缓存根覆盖（测试注入）；缺省 ~/.cache/ms-playwright。 */
  chromiumCacheRoot?: string;
}

interface ExecResult {
  ok: boolean;
  output: string;
}

/** docker 模式镜像探测结果（见 probeImage）。 */
interface ImageProbe {
  reachable: boolean;
  chrome: BrowserDepsStatus['chrome'];
  cli: BrowserDepsStatus['cli'];
}

/** 镜像内探测命令：标记前缀输出，缺依赖时 echo missing（始终 exit 0，避免把「缺依赖」误判成 docker 不可用）。 */
const IMAGE_PROBE_COMMAND =
  'printf "CHROME="; (google-chrome --version || echo missing); printf "CLI="; (playwright-cli --version || echo missing)';

function truncate(text: string, max = DETAIL_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// ---------- 平台口径（与 skills/bundled/browser-use/scripts/browser_cli_lib.mjs 保持一致，方案 2026-11-21 D2） ----------

/**
 * playwright chromium 缓存根：win32 → PLAYWRIGHT_BROWSERS_PATH ?? %LOCALAPPDATA%\ms-playwright
 * （无该环境变量回退 homedir/AppData/Local，服务上下文可能缺失）；其余维持 ~/.cache/ms-playwright。
 */
export function resolveChromiumCacheRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === 'win32') {
    if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
    return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright');
  }
  return path.join(home, '.cache', 'ms-playwright');
}

/** win32 系统 Chrome 候选（ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA，缺省回退常规安装根）。 */
export function win32ChromeCandidates(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  return [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
}

/**
 * win32 下 npm / npx / playwright-cli 是 `.cmd` shim，Node ≥18 无 shell 直 spawn 报 EINVAL——
 * 这类固定命令走 shell 化执行（命令表固定、无空格参数）；winget / chrome.exe 是真 `.exe`，维持 execFile。
 */
export function needsWin32Shell(platform: NodeJS.Platform, cmd: string): boolean {
  if (platform !== 'win32') return false;
  return ['npm', 'npx', 'playwright-cli'].includes(cmd.replace(/\.cmd$/i, ''));
}

export class BrowserDepsService {
  private readonly deps: BrowserDepsServiceDeps;
  /** 进程内单飞：同一时刻至多一个安装任务（getStatus 据此判定 installing 是否孤儿）。 */
  private inFlight: Promise<void> | null = null;

  constructor(deps: BrowserDepsServiceDeps) {
    this.deps = deps;
  }

  // ---------- 状态读写 ----------

  private normalizeStatus(raw: unknown): BrowserDepsStatus | null {
    if (raw == null) return null;
    let parsed: unknown;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
    const phase = (parsed as { phase?: unknown }).phase;
    const known: BrowserDepsPhase[] = ['not_installed', 'installing', 'ready', 'failed'];
    if (typeof phase !== 'string' || !known.includes(phase as BrowserDepsPhase)) return null;
    const data = parsed as Partial<BrowserDepsStatus>;
    return {
      phase: phase as BrowserDepsPhase,
      mode: data.mode === 'docker' ? 'docker' : 'host',
      detail: typeof data.detail === 'string' ? data.detail : null,
      chrome: {
        present: data.chrome?.present === true,
        kind: data.chrome?.kind === 'system' || data.chrome?.kind === 'chromium' ? data.chrome.kind : null,
        version: typeof data.chrome?.version === 'string' ? data.chrome.version : null,
      },
      cli: { present: data.cli?.present === true, version: typeof data.cli?.version === 'string' ? data.cli.version : null },
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    };
  }

  private async writeStatus(status: BrowserDepsStatus): Promise<void> {
    const compact: BrowserDepsStatus = {
      ...status,
      detail: status.detail != null ? truncate(status.detail) : null,
      updatedAt: new Date().toISOString(),
    };
    let json = JSON.stringify(compact);
    if (json.length > STATUS_VALUE_MAX) {
      json = JSON.stringify({ ...compact, detail: truncate(compact.detail ?? '', 200) });
    }
    const setting = await this.deps.settingRepo.findByKey(BROWSER_DEPS_SETTING_KEY);
    if (setting == null) {
      harnessLog('warn', `[browser-deps] status row missing (${BROWSER_DEPS_SETTING_KEY})，跳过状态写入`);
      return;
    }
    setting.value = json;
    await this.deps.settingRepo.updateById(setting);
  }

  /** 依赖检测（只读、快）：chrome/chromium 二进制 + playwright-cli。每次调用现查，不做缓存。 */
  async detect(): Promise<Pick<BrowserDepsStatus, 'chrome' | 'cli'>> {
    const chrome = await this.detectChrome();
    const cli = await this.detectCli();
    return { chrome, cli };
  }

  /**
   * docker 模式依赖探测：以镜像内容为准（容器内系统 Chrome + playwright-cli）。
   * 运行中的用户容器可能尚未创建，镜像才是依赖事实来源；用一次性容器跑版本命令，
   * `--network none` 不引入网络面。镜像名来自配置、命令固定，无拼接输入。
   * reachable=false 表示 docker/镜像本身不可用，此时 chrome/cli 不代表镜像实况。
   */
  private async probeImage(): Promise<ImageProbe> {
    const result = await this.exec(
      'docker',
      ['run', '--rm', '--network', 'none', this.deps.image, 'bash', '-c', IMAGE_PROBE_COMMAND],
      20_000,
    );
    const absent: ImageProbe = {
      reachable: false,
      chrome: { present: false, kind: null, version: null },
      cli: { present: false, version: null },
    };
    if (!result.ok) return absent;
    const read = (prefix: string): string | null => {
      const line = result.output.split('\n').map((s) => s.trim()).find((s) => s.startsWith(prefix));
      const value = line?.slice(prefix.length).trim() ?? '';
      return value === '' || value === 'missing' ? null : truncate(value, 120);
    };
    const chromeVersion = read('CHROME=');
    const cliVersion = read('CLI=');
    return {
      reachable: true,
      chrome: chromeVersion != null
        ? { present: true, kind: 'system', version: chromeVersion }
        : { present: false, kind: null, version: null },
      cli: cliVersion != null ? { present: true, version: cliVersion } : { present: false, version: null },
    };
  }

  private async exec(cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<ExecResult> {
    if (this.deps.execImpl != null) {
      return this.deps.execImpl(cmd, args, timeoutMs, env);
    }
    try {
      const { stdout, stderr } = await execFile(cmd, args, {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8' as BufferEncoding,
        ...(needsWin32Shell(this.deps.platform ?? process.platform, cmd) ? { shell: true } : {}),
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return { ok: true, output: `${stdout ?? ''}${stderr ?? ''}`.trim() };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string; code?: string };
      if (err.code === 'ENOENT') return { ok: false, output: `${cmd} not found` };
      return { ok: false, output: truncate(`${err.stderr ?? ''} ${err.stdout ?? ''} ${err.message ?? ''}`) };
    }
  }

  /** win32 chromium 缓存条目内的二进制：chrome-win 前缀目录（chrome-win / chrome-win64）+ chrome.exe。 */
  private win32ChromiumBin(entryDir: string): string | null {
    try {
      const dir = readdirSync(entryDir).find((n) => n.startsWith('chrome-win'));
      if (!dir) return null;
      return path.join(entryDir, dir, 'chrome.exe');
    } catch { return null; }
  }

  private async detectChrome(): Promise<BrowserDepsStatus['chrome']> {
    const platform = this.deps.platform ?? process.platform;
    const candidates = platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : platform === 'win32'
        ? win32ChromeCandidates()
        : ['google-chrome', 'google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/google-chrome'];
    for (const bin of candidates) {
      const result = await this.exec(bin, ['--version'], 8_000);
      if (result.ok) return { present: true, kind: 'system', version: truncate(result.output, 120) };
    }
    // playwright 下载的 chromium（免 root 降级产物）：POSIX ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome；
    // win32 %LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win*\chrome.exe
    const cacheRoot = this.deps.chromiumCacheRoot ?? resolveChromiumCacheRoot(platform);
    try {
      const entries = readdirSync(cacheRoot).filter((n) => n.startsWith('chromium-')).sort().reverse();
      for (const entry of entries) {
        const bin = platform === 'win32' ? this.win32ChromiumBin(path.join(cacheRoot, entry)) : path.join(cacheRoot, entry, 'chrome-linux', 'chrome');
        if (!bin) continue;
        const result = await this.exec(bin, ['--version'], 8_000);
        if (result.ok) return { present: true, kind: 'chromium', version: truncate(result.output, 120) };
      }
    } catch { /* 缓存目录不存在 */ }
    return { present: false, kind: null, version: null };
  }

  private async detectCli(): Promise<BrowserDepsStatus['cli']> {
    const result = await this.exec('playwright-cli', ['--version'], 8_000);
    if (result.ok) return { present: true, version: truncate(result.output, 120) };
    return { present: false, version: null };
  }

  /** 读取状态：合并实时检测；installing 孤儿（超时无归主）降级 failed 并落库。 */
  async getStatus(): Promise<BrowserDepsStatus> {
    const stored = this.normalizeStatus(await this.deps.settingRepo.findByKey(BROWSER_DEPS_SETTING_KEY).then((s) => s?.value ?? null));
    const mode = await this.safeRuntimeMode();
    let phase: BrowserDepsPhase = stored?.phase ?? 'not_installed';
    let detail = stored?.detail ?? null;
    if (phase === 'installing' && this.inFlight == null) {
      const updatedAtMs = stored ? Date.parse(stored.updatedAt) : NaN;
      const stale = !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > INSTALL_STALE_MS;
      if (stale) {
        phase = 'failed';
        detail = '安装中断（后端进程重启或超时），请重新安装';
      }
    }
    const installing = phase === 'installing' && this.inFlight != null;
    // docker 模式以镜像为准：宿主机没有 Chrome/CLI 不代表容器内不可用。安装中跳过探测，避免拖慢轮询。
    const probe = mode === 'docker' && !installing ? await this.probeImage() : null;
    const detected = probe?.reachable ? { chrome: probe.chrome, cli: probe.cli } : await this.detect();
    if (probe?.reachable) {
      const imageReady = probe.chrome.present && probe.cli.present;
      if (imageReady && !installing) {
        phase = 'ready';
        detail = `镜像 ${this.deps.image} 已含浏览器依赖`;
      } else if (!imageReady) {
        if (phase === 'ready') phase = 'not_installed';
        if (phase === 'not_installed' && detail == null) detail = `镜像 ${this.deps.image} 缺少浏览器依赖`;
      }
    } else if (mode === 'host' && phase === 'ready' && !detected.chrome.present && !detected.cli.present) {
      // 状态说 ready 但实况全没了（被卸载）：以实况为准；docker 模式探测不可用时保留存量状态
      phase = 'not_installed';
      detail = '检测到依赖已不存在（可能被卸载）';
    }
    return {
      phase, mode, detail,
      chrome: detected.chrome,
      cli: detected.cli,
      updatedAt: new Date().toISOString(),
    };
  }

  private async safeRuntimeMode(): Promise<'host' | 'docker'> {
    try {
      return await this.deps.getRuntimeMode();
    } catch {
      return 'host';
    }
  }

  // ---------- 安装 ----------

  /** 管理端显式安装；返回是否真正启动（installing/ready 时拒绝重复启动）。 */
  async install(): Promise<{ started: boolean; status: BrowserDepsStatus }> {
    if (this.inFlight != null) {
      return { started: false, status: await this.getStatus() };
    }
    const current = await this.getStatus();
    if (current.phase === 'installing' || current.phase === 'ready') {
      // docker 模式下 ready 由镜像探测得出：镜像已就绪就不该重建
      return { started: false, status: current };
    }
    const mode = await this.safeRuntimeMode();
    this.inFlight = this.runInstall(mode)
      .catch((e) => {
        harnessLog('error', `[browser-deps] install failed: ${(e as Error).message}`);
        return this.writeStatus({
          phase: 'failed', mode, detail: `安装异常：${truncate((e as Error).message)}`,
          chrome: current.chrome, cli: current.cli, updatedAt: new Date().toISOString(),
        });
      })
      .finally(() => {
        this.inFlight = null;
      });
    return { started: true, status: { ...current, phase: 'installing', mode, detail: '安装任务已启动' } };
  }

  /**
   * Agent 勾选 browser-use 保存时的 ensure 入口（fire-and-forget，绝不阻塞保存）：
   * ready / installing 时 no-op；未安装 / 失败时自动补装。
   */
  ensureForSkills(skillNames: readonly string[] | null | undefined): void {
    if (!skillNames?.includes(BROWSER_DEPS_SKILL_NAME)) return;
    void (async () => {
      try {
        const status = await this.getStatus();
        if (status.phase === 'ready' || status.phase === 'installing') return;
        harnessLog('info', `[browser-deps] agent 启用 ${BROWSER_DEPS_SKILL_NAME}，依赖未就绪（${status.phase}），自动安装`);
        await this.install();
      } catch (e) {
        harnessLog('warn', `[browser-deps] ensureForSkills failed: ${(e as Error).message}`);
      }
    })();
  }

  private async runInstall(mode: 'host' | 'docker'): Promise<void> {
    await this.writeStatus({
      phase: 'installing', mode, detail: mode === 'docker' ? '重建运行时镜像（含 Chrome）' : '开始安装',
      chrome: { present: false, kind: null, version: null }, cli: { present: false, version: null },
      updatedAt: new Date().toISOString(),
    });
    if (mode === 'docker') {
      await this.installDocker();
      return;
    }
    await this.installHost();
  }

  private async setDetail(detail: string): Promise<void> {
    const status = await this.getStatus();
    await this.writeStatus({ ...status, phase: 'installing', detail });
  }

  // ---------- host 安装链 ----------

  private async installHost(): Promise<void> {
    const platform = this.deps.platform ?? process.platform;
    // 1. CLI（chromium 降级路径也依赖它；幂等，已装时 npm 秒过；win32 下 exec 自动 shell 化适配 .cmd shim）
    await this.setDetail('安装 @playwright/cli（npm 全局）');
    const cliInstall = await this.exec('npm', ['i', '-g', '--no-audit', '--no-fund', '@playwright/cli@latest'], 5 * 60_000);
    if (!cliInstall.ok) {
      await this.finishFailed(`@playwright/cli 安装失败：${cliInstall.output}`);
      return;
    }

    // 2. 系统 Chrome（Linux：x86_64 + apt 可用时走 deb，源可经 MAO_BROWSER_CHROME_DEB_URL 覆盖；
    //    win32：winget 尝试，用户级 npm + chromium 兜底全程免管理员权限）
    let chrome = await this.detectChrome();
    if (!chrome.present) {
      if (platform === 'win32') {
        await this.setDetail('尝试 winget 安装系统 Chrome');
        // Google.Chrome 默认 machine scope，可能触发 UAC 提权弹窗：被拒即非零退出，静默降级 chromium
        const winget = await this.exec('winget', ['install', '--id', 'Google.Chrome', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], 15 * 60_000);
        if (winget.ok) chrome = await this.detectChrome();
        if (!chrome.present) {
          await this.setDetail(`winget ${winget.ok ? '安装后未检出 Chrome' : '不可用或被拒'}，改用 chromium`);
        }
      } else {
        const [arch, aptPath] = await Promise.all([
          this.exec('uname', ['-m'], 5_000),
          this.exec('which', ['apt-get'], 5_000),
        ]);
        const debUrl = process.env.MAO_BROWSER_CHROME_DEB_URL
          ?? 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';
        if (arch.ok && arch.output.trim() === 'x86_64' && aptPath.ok && aptPath.output.trim() !== '') {
          await this.setDetail(`下载 Chrome deb（${debUrl}）`);
          const debFile = path.join(tmpdir(), `google-chrome-stable-${Date.now()}.deb`);
          const download = await this.exec('curl', ['-fsSL', '-o', debFile, debUrl], 10 * 60_000);
          if (download.ok) {
            await this.setDetail('apt 安装 Chrome');
            await this.exec('apt-get', ['update'], 5 * 60_000); // 刷新依赖索引；失败不阻断（deb 依赖可能已满足）
            const install = await this.exec('apt-get', ['install', '-y', '--no-install-recommends', debFile], 10 * 60_000);
            if (install.ok) chrome = await this.detectChrome();
          } else {
            harnessLog('warn', `[browser-deps] chrome deb download failed: ${download.output}`);
          }
        } else {
          await this.setDetail(`跳过系统 Chrome 安装（${arch.ok ? `架构 ${arch.output.trim()}` : '架构未知'} / apt ${aptPath.ok ? '可用' : '不可用'}），改用 chromium`);
        }
      }
    }

    // 3. 免 root 降级：playwright chromium（npmmirror 镜像源，国内可达）
    if (!chrome.present) {
      await this.setDetail('下载 chromium（npmmirror 镜像）');
      const downloadHost = process.env.MAO_PLAYWRIGHT_DOWNLOAD_HOST ?? 'https://cdn.npmmirror.com/binaries/playwright';
      const chromium = await this.exec('playwright-cli', ['install-browser'], 15 * 60_000, {
        PLAYWRIGHT_DOWNLOAD_HOST: downloadHost,
      });
      if (!chromium.ok) {
        await this.finishFailed(`浏览器内核下载失败（系统 Chrome 与 chromium 均未就绪）：${chromium.output}`);
        return;
      }
      chrome = await this.detectChrome();
      if (!chrome.present) {
        await this.finishFailed('chromium 下载完成但未检测到可用二进制');
        return;
      }
    }

    // 4. 终验
    const cli = await this.detectCli();
    if (!cli.present) {
      await this.finishFailed('playwright-cli 安装后不可用');
      return;
    }
    await this.writeStatus({
      phase: 'ready', mode: 'host', detail: `就绪：${chrome.kind === 'system' ? '系统 Chrome' : 'chromium（playwright 缓存）'} + playwright-cli`,
      chrome, cli, updatedAt: new Date().toISOString(),
    });
    harnessLog('info', '[browser-deps] host install finished: ready');
  }

  // ---------- docker 安装链（镜像重建） ----------

  private async installDocker(): Promise<void> {
    const script = path.join(this.deps.repoRoot, 'scripts', 'build-runtime-image.sh');
    await this.setDetail(`重建运行时镜像 ${this.deps.image}（含 Chrome，可能需要数分钟）`);
    const build = await this.exec('bash', [script], 20 * 60_000, { INSTALL_CHROME: '1' });
    if (!build.ok) {
      await this.finishFailed(`镜像构建失败（可手动执行 bash scripts/build-runtime-image.sh）：${build.output}`);
      return;
    }
    await this.setDetail('验证镜像内浏览器依赖');
    const verify = await this.exec('docker', ['run', '--rm', this.deps.image, 'bash', '-c', 'google-chrome --version && playwright-cli --version'], 90_000);
    if (!verify.ok) {
      await this.finishFailed(`镜像内验证失败：${verify.output}`);
      return;
    }
    await this.writeStatus({
      phase: 'ready', mode: 'docker', detail: `镜像 ${this.deps.image} 已含浏览器依赖`,
      chrome: { present: true, kind: 'system', version: null },
      cli: { present: true, version: null },
      updatedAt: new Date().toISOString(),
    });
    harnessLog('info', '[browser-deps] docker image rebuild finished: ready');
  }

  private async finishFailed(detail: string): Promise<void> {
    const detected = await this.detect();
    await this.writeStatus({
      phase: 'failed', mode: await this.safeRuntimeMode(), detail,
      chrome: detected.chrome, cli: detected.cli, updatedAt: new Date().toISOString(),
    });
    harnessLog('warn', `[browser-deps] install failed: ${detail}`);
  }
}
