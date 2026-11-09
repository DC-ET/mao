/** 页面操作 SDK 的公共类型：快照、元素引用、动作与结果。 */
import type { PageReadToolName, PageWriteToolName } from '@mao/contracts';

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
  | { type: 'fill'; elementId: string; value: string; blur?: boolean }
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

/**
 * 读 / 写分类（类型契约 shared/contracts/src/page.ts）：读类工具不受 page.enabled
 * 开关控制、始终提供；写/操作类受开关控制，缺省关闭。
 * 用 Record<联合, true> 而非 string[]：契约联合一变（某工具改分类）这里立刻报类型错误，
 * 必须与后端 page-tool-kinds.ts 同改，不会静默漂移。
 */
const PAGE_WRITE_TOOLS: Record<PageWriteToolName, true> = {
  page_scroll: true,
  page_focus: true,
  page_fill: true,
  page_select: true,
  page_check: true,
  page_uncheck: true,
  page_click: true,
  page_keyboard: true,
  page_actions: true,
};

const PAGE_READ_TOOLS: Record<PageReadToolName, true> = {
  page_inspect: true,
  page_observe: true,
  page_screenshot: true,
  page_wait: true,
};

/** 写/操作类工具判定：page.enabled 关闭时这些工具不可见、请求直接失败。 */
export function isPageWriteTool(name: string): name is PageWriteToolName {
  return Object.prototype.hasOwnProperty.call(PAGE_WRITE_TOOLS, name);
}

/** 读类工具判定：始终提供，不受开关控制。 */
export function isPageReadTool(name: string): name is PageReadToolName {
  return Object.prototype.hasOwnProperty.call(PAGE_READ_TOOLS, name);
}

export function isMutatingAction(type: PageActionType): boolean {
  return type !== 'wait' && type !== 'scroll';
}
