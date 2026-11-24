import { BROWSER_DEPS_SKILL_NAME, type BrowserDepsService, type BrowserDepsStatus } from '../../browser-deps/browser-deps.service.js';
import type { SkillDepsItem, SkillDepsProvider } from '../skill-deps.types.js';

export const BROWSER_DEPS_INSTALL_CONFIRM =
  '将在服务器上自动安装浏览器依赖（Chrome/chromium + playwright-cli，可能需要数分钟），确认开始？';

/** 存量 detail 缺失时按实况拼装；chromium 降级标注进 detail（前端不再按 chrome.kind 特判）。 */
export function browserDepsDetail(status: BrowserDepsStatus): string | null {
  const chromium = status.chrome.kind === 'chromium';
  if (status.detail != null && status.detail !== '') {
    return chromium && !status.detail.includes('chromium') ? `${status.detail}（chromium）` : status.detail;
  }
  const parts: string[] = [];
  if (status.chrome.present) {
    parts.push(`${chromium ? 'chromium' : 'Chrome'}${status.chrome.version ? ` ${status.chrome.version}` : ''}`);
  }
  if (status.cli.present) {
    parts.push(`playwright-cli${status.cli.version ? ` ${status.cli.version}` : ''}`);
  }
  return parts.length > 0 ? parts.join(' + ') : null;
}

export function toBrowserDepsItem(status: BrowserDepsStatus): SkillDepsItem {
  return {
    id: 'browser',
    label: '浏览器依赖',
    kind: 'install',
    phase: status.phase,
    detail: browserDepsDetail(status),
    installConfirm: BROWSER_DEPS_INSTALL_CONFIRM,
  };
}

/** browser-use 的 install provider：包装 BrowserDepsService，安装链与状态机原样保留。 */
export function createBrowserDepsProvider(
  service: Pick<BrowserDepsService, 'getStatus' | 'install' | 'ensureForSkills'>,
): SkillDepsProvider {
  return {
    skillName: BROWSER_DEPS_SKILL_NAME,
    async status() {
      return [toBrowserDepsItem(await service.getStatus())];
    },
    async install() {
      const { started } = await service.install();
      return { started };
    },
    ensureForSkills(skillNames) {
      service.ensureForSkills(skillNames);
    },
  };
}
