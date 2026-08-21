import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../util/exit-codes';
import { getCliVersion } from '../util/version';

export const INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/DC-ET/mao/main/scripts/install-mao-agent.sh';
export const DEFAULT_UPDATE_REPO = 'https://github.com/DC-ET/mao.git';
export const DEFAULT_UPDATE_REF = 'main';
export const DEFAULT_SRC_DIR = join(homedir(), '.mao', 'agent-cli', 'src');

export interface UpdateOptions {
  ref?: string;
  repo?: string;
  srcDir?: string;
  check?: boolean;
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  quiet?: boolean;
  tolerate?: boolean;
}

function run(cmd: string, args: string[], opts: RunOptions = {}): void {
  const res = spawnSync(cmd, args, {
    stdio: opts.quiet ? 'ignore' : 'inherit',
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
  if (res.error) {
    if (opts.tolerate) return;
    throw new CliError(`执行 ${cmd} 失败: ${res.error.message}`);
  }
  if (res.status !== 0 && !opts.tolerate) {
    throw new CliError(`${cmd} ${args.join(' ')} 失败（退出码 ${res.status}）`);
  }
}

/** 比较点分版本号；a<b 返回 -1，a>b 返回 1，相等返回 0。非数字段按 0 处理。 */
export function compareVersions(a: string, b: string): number {
  const as = String(a).split('.');
  const bs = String(b).split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const na = Number.parseInt(as[i], 10) || 0;
    const nb = Number.parseInt(bs[i], 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

function readPkgVersion(pkgDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** fetch 远端 ref 并从 FETCH_HEAD 读 agent-cli 版本号（不动工作区）。 */
function fetchRemoteVersion(srcDir: string, ref: string): string {
  run('git', ['-C', srcDir, 'fetch', '--depth', '1', 'origin', ref]);
  const res = spawnSync('git', ['-C', srcDir, 'show', 'FETCH_HEAD:agent-cli/package.json'], {
    encoding: 'utf8',
  });
  if (res.status !== 0 || !res.stdout) throw new CliError('无法读取远端 agent-cli 版本号');
  const pkg = JSON.parse(res.stdout) as { version?: string };
  return pkg.version ?? '0.0.0';
}

export async function cmdUpdate(opts: UpdateOptions = {}): Promise<void> {
  const ref = opts.ref ?? process.env.MAO_AGENT_REF ?? DEFAULT_UPDATE_REF;
  const repo = opts.repo ?? process.env.MAO_AGENT_REPO ?? DEFAULT_UPDATE_REPO;
  const srcDir = opts.srcDir ?? DEFAULT_SRC_DIR;
  const pkgDir = join(srcDir, 'agent-cli');
  const current = getCliVersion();
  const out = (line: string) => process.stdout.write(line + '\n');

  if (opts.check) {
    if (!existsSync(join(srcDir, '.git'))) {
      out(`未找到脚本安装的源码目录 ${srcDir}，无法检查远端版本。`);
      out('请直接运行 mao-agent update 完成安装/升级。');
      return;
    }
    const latest = fetchRemoteVersion(srcDir, ref);
    if (compareVersions(latest, current) > 0) {
      out(`有新版本: ${current} → ${latest}，运行 mao-agent update 升级`);
    } else {
      out(`已是最新版本 ${current}`);
    }
    return;
  }

  out(`mao-agent 当前版本 ${current}（源 ${repo}@${ref}）`);
  if (existsSync(join(srcDir, '.git'))) {
    out(`拉取最新源码 ${srcDir} ...`);
    run('git', ['-C', srcDir, 'fetch', '--depth', '1', 'origin', ref]);
    run('git', ['-C', srcDir, 'checkout', '--force', 'FETCH_HEAD']);
    run('git', ['-C', srcDir, 'sparse-checkout', 'set', 'agent-cli'], { quiet: true, tolerate: true });
  } else {
    out('未找到本地源码目录，改用官方安装脚本 ...');
    run('bash', ['-c', `curl -fsSL '${INSTALL_SCRIPT_URL}' | bash`], {
      env: { MAO_AGENT_REPO: repo, MAO_AGENT_REF: ref },
    });
    return;
  }

  if (!existsSync(join(pkgDir, 'package.json'))) {
    throw new CliError(
      `${pkgDir} 下没有 agent-cli 源码，请改用安装脚本: curl -fsSL ${INSTALL_SCRIPT_URL} | bash`,
    );
  }

  out('安装依赖并构建 ...');
  const useCi = existsSync(join(pkgDir, 'package-lock.json'));
  run('npm', [useCi ? 'ci' : 'install'], { cwd: pkgDir });
  run('npm', ['run', 'build'], { cwd: pkgDir });
  run('npm', ['install', '-g', '.', '--force'], { cwd: pkgDir });

  const latest = readPkgVersion(pkgDir);
  if (compareVersions(latest, current) > 0) out(`✔ 已升级: ${current} → ${latest}`);
  else if (compareVersions(latest, current) < 0) out(`✔ 已安装 ${latest}（低于当前版本，可能来自旧目录或自定义源）`);
  else out(`✔ 已重装 ${latest}（版本无变化）`);
  out('重新运行 mao-agent 生效。');
}
