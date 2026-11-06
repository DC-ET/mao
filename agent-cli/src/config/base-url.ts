import { normalizeBaseUrl } from '../args';
import { promptVisible } from '../ui/hidden-prompt';
import { CliError } from '../util/exit-codes';
import { CONFIG_FILE, loadUserConfig, saveUserConfig } from './config-store';

/**
 * baseUrl 不再有内置默认值。这段提示用于 login 交互取消、非 TTY 登录，
 * 以及其它需要连接服务器的命令（ls / resume / logout / chat）。
 */
export const BASE_URL_SETUP_HINT = [
  '未配置站点地址（baseUrl），无法连接服务器。请先设置后重试：',
  '  mao-agent login --base-url https://mao.example.com   # 仅本次使用',
  '  export MAO_BASE_URL=https://mao.example.com          # 当前 shell 生效',
  `  或写入 ${CONFIG_FILE}：{"baseUrl": "https://mao.example.com"}`,
].join('\n');

const INPUT_FORMAT_ERROR =
  '地址格式不正确：需以 https:// 或 http:// 开头，只填站点根（可带 /api 或 /api/v1），不要带其它路径。\n';

/**
 * 校验并归一化交互输入的站点地址：只接受 http(s)、站点根或 /api、/api/v1 结尾。
 * 返回 null 表示非法（空串也返回 null，由调用方区分「取消」）。
 */
export function parseSiteUrlInput(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname !== '' && pathname !== '/api' && pathname !== '/api/v1') return null;
  return normalizeBaseUrl(s);
}

export interface BaseUrlSetupIo {
  /** 交互输入（默认 readline + stderr，不影响 stdout 的机器可读输出）。 */
  prompt?: (query: string) => Promise<string>;
  /** 结果落盘（默认写入 ~/.mao/agent-cli/config.json）。 */
  save?: (patch: { baseUrl: string }) => unknown;
  /** 提示输出（默认 stderr）。 */
  out?: (message: string) => void;
}

/**
 * 首次登录且未配置站点地址时的交互设置：提示输入 → 校验 → 保存到用户配置。
 * 仅调用方确认 TTY 后调用；空输入视为取消，并给出手动设置指引。
 */
export async function setupBaseUrlInteractive(io: BaseUrlSetupIo = {}): Promise<string> {
  const prompt = io.prompt ?? promptVisible;
  const save = io.save ?? ((patch: { baseUrl: string }) => saveUserConfig(patch));
  const out = io.out ?? ((message: string) => process.stderr.write(message));
  out('未配置站点地址（baseUrl）。\n');
  for (;;) {
    const input = (await prompt('请输入 Mao 站点地址（如 https://mao.example.com，直接回车取消）: ')).trim();
    if (!input) {
      out('\n' + BASE_URL_SETUP_HINT + '\n');
      throw new CliError('已取消：未设置站点地址。');
    }
    const normalized = parseSiteUrlInput(input);
    if (!normalized) {
      out(INPUT_FORMAT_ERROR);
      continue;
    }
    save({ baseUrl: input.replace(/\/+$/, '') });
    out(`✔ 站点地址已保存到 ${CONFIG_FILE}\n`);
    return normalized;
  }
}

/** 登录成功后的地址持久化：仅当本次地址只来自 --base-url / MAO_BASE_URL 且用户配置里还没有时写入。 */
export interface PersistBaseUrlIo {
  /** 结果落盘（默认写入 ~/.mao/agent-cli/config.json）。 */
  save?: (patch: { baseUrl: string }) => unknown;
  /** 提示输出（默认 stderr）。 */
  out?: (message: string) => void;
}

/**
 * 登录成功后记住本次使用的站点地址：
 * - 地址只来自 `--base-url` / `MAO_BASE_URL`（fromCliOrEnv 有值）且用户配置里还没有 baseUrl 时写入用户配置，
 *   避免「带 --base-url 登录成功后，下次裸跑仍提示未配置」；
 * - 已有用户配置不覆盖（临时连其它环境不会改写长期默认）；项目配置不参与判断（只对对应项目生效）；
 * - 保存失败不影响本次登录结果，只提示手动设置方式。
 * 返回是否写入。
 */
export function persistTransientBaseUrl(fromCliOrEnv: string | undefined, io: PersistBaseUrlIo = {}): boolean {
  const raw = (fromCliOrEnv ?? '').trim().replace(/\/+$/, '');
  if (!raw) return false;
  if (loadUserConfig().baseUrl) return false;
  const save = io.save ?? ((patch: { baseUrl: string }) => saveUserConfig(patch));
  const out = io.out ?? ((message: string) => process.stderr.write(message));
  try {
    save({ baseUrl: raw });
    out(`✔ 站点地址已保存到 ${CONFIG_FILE}，下次可直接运行 mao-agent。\n`);
    return true;
  } catch (e) {
    out(`⚠ 站点地址保存失败（${(e as Error).message}）；可手动写入 ${CONFIG_FILE} 或设置 MAO_BASE_URL。\n`);
    return false;
  }
}
