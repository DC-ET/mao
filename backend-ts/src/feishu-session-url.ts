import { feishuSessionDetailUrl } from './feishu/progress-card.js';
import type { SystemSettingService } from './settings/settings.service.js';

export interface FeishuSessionUrlDeps {
  settingService: SystemSettingService;
}

export function createFeishuSessionUrlHelper(deps: FeishuSessionUrlDeps) {
  const { settingService } = deps;

  /** 网页端会话详情深链：取 ECP desktopCallbackUrl 的 origin 拼 `/tasks/{id}`；配置异常时不渲染按钮。 */
  return async (sessionId: number): Promise<string | undefined> => {
    try {
      const ecp = await settingService.getEcpConfig();
      return feishuSessionDetailUrl(ecp.desktopCallbackUrl, sessionId);
    } catch {
      return undefined;
    }
  };
}
