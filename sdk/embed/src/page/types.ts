/** 页面操作 SDK 的公共类型：快照、元素引用、动作与结果。 */

export type PageElementKind = 'button' | 'form-control' | 'link' | 'other';

export interface PageRect { x: number; y: number; width: number; height: number; }

export interface PageOption { label: string; value: string; selected: boolean; disabled: boolean; }

export interface PageElement {
  /** opaque 引用：只在对应 snapshotId 有效期内可用，不暴露 selector/XPath/DOM path。 */
  elementId: string;
  kind: PageElementKind;
  role: string;
  type: string;
  label: string;
  text: string;
  value: unknown;
  options: PageOption[];
  visible: boolean;
  inViewport: boolean;
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  /** 疑似敏感字段（密码/验证码/银行卡等）：值按授权级别脱敏。 */
  sensitive: boolean;
  /** 元素所在文档是否与主文档同源（同源 iframe 内元素） */
  inFrame: boolean;
  /** 开放 Shadow DOM 内元素 */
  inShadowRoot: boolean;
  rect: PageRect;
}

export interface PageSnapshot {
  snapshotId: string;
  pageVersion: string;
  url: string;
  title: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  elements: PageElement[];
  /** 无法操作的边界提示（如跨域 iframe 数量）。 */
  warnings?: string[];
}

export type PageAction =
  | { type: 'click'; elementId: string }
  | { type: 'focus'; elementId: string }
  | { type: 'check'; elementId: string }
  | { type: 'uncheck'; elementId: string }
  | { type: 'fill'; elementId: string; value: string }
  | { type: 'select'; elementId: string; value: string }
  | { type: 'keyboard'; elementId?: string; key: string; modifiers?: string[]; text?: string }
  | { type: 'scroll'; elementId?: string; x?: number; y?: number; to?: 'top' | 'bottom' }
  | { type: 'wait'; ms?: number; until?: 'stable' };

export type PageActionType = PageAction['type'];

export type PageEffect = 'none' | 'dom' | 'navigation' | 'state';

export interface PageToolError {
  code: string;
  message: string;
  elementId?: string;
}

export interface PageActionResult {
  success: boolean;
  action: PageAction;
  pageVersion: string;
  snapshotId?: string;
  error?: PageToolError;
  /** 动作后是否观察到可验证的效果；false 表示已下发但未观察到变化，建议重新 inspect。 */
  verified?: boolean;
  effect?: PageEffect;
  observation?: Record<string, unknown>;
}

export interface PageScreenshot {
  dataUri: string;
  mime: string;
  width: number;
  height: number;
  masked: boolean;
}

export interface PageObserveResult {
  pageVersion: string;
  url: string;
  title: string;
  snapshotId: string | null;
  elementCount: number;
  changes: {
    added: number;
    removed: number;
    updated: number;
    navigated: boolean;
  };
}

export interface PageBatchResult {
  steps: PageActionResult[];
  stoppedAt?: number;
  reason?: string;
  pageVersion: string;
  snapshotId?: string;
  /** 请求的动作数超过单批上限，已截断。 */
  truncated?: boolean;
}

export type PageToolName =
  | 'page_inspect'
  | 'page_screenshot'
  | 'page_scroll'
  | 'page_focus'
  | 'page_fill'
  | 'page_select'
  | 'page_check'
  | 'page_uncheck'
  | 'page_click'
  | 'page_keyboard'
  | 'page_wait'
  | 'page_observe'
  | 'page_actions';

export const PAGE_TOOL_NAMES: readonly PageToolName[] = [
  'page_inspect', 'page_screenshot', 'page_scroll', 'page_focus', 'page_fill', 'page_select',
  'page_check', 'page_uncheck', 'page_click', 'page_keyboard', 'page_wait', 'page_observe', 'page_actions',
];

export function isPageToolName(value: string): value is PageToolName {
  return (PAGE_TOOL_NAMES as readonly string[]).includes(value);
}

export function isMutatingAction(type: PageActionType): boolean {
  return type !== 'wait' && type !== 'scroll';
}
