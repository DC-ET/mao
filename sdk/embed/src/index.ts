import type { MaoChatInitOptions, MaoChatInstance } from './types';
import { EmbedController, createUiState, mountApp, type UiState } from './controller';
import { applyTheme } from './ui/theme';

export type { MaoChatInitOptions, MaoChatInstance, MaoChatEvent, MaoChatPageOptions } from './types';
export type {
  PageSnapshot, PageElement, PageAction, PageActionResult, PageScreenshot,
  PageAuthorizationLevel, PageConfirmRequest, PageActionLogEntry, PageObserveResult, PageBatchResult,
} from './page';

interface EmbeddedInstance extends MaoChatInstance {
  /** 内部 state（仅测试用） */
  __ui?: UiState;
}

function createInstance(options: MaoChatInitOptions): MaoChatInstance {
  if (typeof window === 'undefined') {
    throw new Error('MaoChat only runs in browser');
  }
  if (!options?.serverUrl) throw new Error('MaoChat.init: serverUrl is required');
  if (!options?.agentId) throw new Error('MaoChat.init: agentId is required');
  const mao = typeof options.getToken === 'function' && options.auth === undefined;
  const sso = options.getToken === undefined && options.auth?.type === 'company-sso'
    && typeof options.auth.getSsoToken === 'function';
  if (!mao && !sso) throw new Error('MaoChat.init: choose exactly one of getToken or company-sso auth');
  if (sso && new URL(options.serverUrl).protocol !== 'https:') {
    throw new Error('MaoChat.init: company-sso requires HTTPS');
  }
  if (sso) {
    const rawCheckUrl = options.auth.checkUrl;
    if (typeof rawCheckUrl !== 'string' || rawCheckUrl.length > 2048 || /[\s\\]/.test(rawCheckUrl)) {
      throw new Error('MaoChat.init: checkUrl must be a valid HTTPS URL');
    }
    let checkUrl: URL;
    try { checkUrl = new URL(rawCheckUrl); } catch { throw new Error('MaoChat.init: checkUrl must be a valid HTTPS URL'); }
    if (checkUrl.protocol !== 'https:' || checkUrl.username || checkUrl.password || checkUrl.hash
      || /#$/.test(rawCheckUrl) || checkUrl.searchParams.has('token')) {
      throw new Error('MaoChat.init: checkUrl must be a valid HTTPS URL');
    }
  }
  if (window.__maoChatInstance) {
    // 单实例约束：重复 init 先销毁旧实例
    window.__maoChatInstance.destroy();
  }

  const ui = createUiState(options);
  const { cleanup, root, host } = mountApp(ui);
  // 主题主色：内联覆写 .mao-root 的 --mao-primary（规则内默认值优先级高于 host 继承）。
  // 同时按主色亮度派生前景色/描边，浅色主色（白、浅黄）下文字才不会消失。
  if (options.theme?.primary) {
    applyTheme(root, options.theme.primary);
  }
  const controller = new EmbedController(options, ui, (event) => {
    try {
      options.onEvent?.(event);
    } catch {
      /* 宿主回调异常不阻断 SDK */
    }
  }, cleanup, host);
  const instance: EmbeddedInstance = {
    open: () => controller.open(),
    close: () => controller.close(),
    toggle: () => controller.toggle(),
    newSession: () => controller.newSession(),
    toggleHistory: () => controller.toggleHistory(),
    setContext: (ctx) => controller.setContext(ctx),
    inspectPage: () => controller.pageEngine.inspect({ sessionId: controller.store.sessionId() }),
    executePageAction: (action, snapshotId) => controller.pageEngine.executeAction(
      action, snapshotId ?? controller.pageEngine.manager.currentSnapshotId ?? undefined, controller.store.sessionId() ?? 0,
    ),
    getPageAuthorization: () => controller.pageEngine.authorizationLevel,
    setPageAuthorization: (level) => controller.setPageAuthorization(level),
    capturePageScreenshot: (opts) => controller.pageEngine.screenshot({
      maskSensitive: opts?.maskSensitive, reason: opts?.reason, sessionId: controller.store.sessionId(),
    }),
    destroy: () => {
      controller.destroy();
      window.__maoChatInstance = undefined;
    },
    __ui: ui,
  };
  window.__maoChatInstance = instance;
  return instance;
}

declare global {
  interface Window {
    MaoChat?: { init(options: MaoChatInitOptions): MaoChatInstance };
    __maoChatInstance?: EmbeddedInstance;
  }
}

if (typeof window !== 'undefined') {
  window.MaoChat = { init: createInstance };
}

/** ESM 消费入口（CDN IIFE 场景走 window.MaoChat） */
export const init = createInstance;
