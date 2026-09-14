import type { PageElement, PageElementKind, PageOption, PageRect } from './types';
import { hasLayoutBox, isDisabled, isInViewport, isReadonly, isSensitiveField, isStyleVisible, rectOf } from './visibility';

export interface ScanOptions {
  /** SDK 宿主：其自身及 Shadow DOM 内部永远不进入快照。 */
  host?: HTMLElement | null;
  includeHidden?: boolean;
  /** true 时敏感字段值脱敏（per_action 级别）。 */
  redactSensitive?: boolean;
  /** 只采集疑似敏感字段：截图遮罩用，不受普通元素预算影响。 */
  sensitiveOnly?: boolean;
  maxElements?: number;
}

export interface ScannedElement {
  element: Element;
  descriptor: PageElement;
  /** 语义签名：用于动作前检测节点被复用/语义变化。 */
  signature: string;
  /** 节点身份 token：同一 DOM 节点跨快照保持稳定，节点被替换后变化。 */
  token: string;
}

export interface ScanResult {
  elements: ScannedElement[];
  url: string;
  title: string;
  /** 因跨域无法访问的 iframe 数量（明确告知 Agent 不可操作）。 */
  crossOriginFrames: number;
}

const INTERACTIVE_SELECTOR = [
  'button', 'a[href]', 'input', 'textarea', 'select', 'summary',
  '[contenteditable="true"]', '[contenteditable=""]',
  '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="menuitem"]', '[role="option"]',
  '[role="treeitem"]',
  '[role="tab"]', '[role="slider"]', '[role="spinbutton"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const DROPDOWN_ITEM_CLASSES = [
  'el-select-dropdown__item',
  'el-autocomplete-suggestion__item',
  'el-cascader-node',
  'ant-select-item',
  'ant-select-item-option',
  'n-base-select-option',
];

const DROPDOWN_LIST_CLASSES = [
  'el-select-dropdown__list',
  'el-autocomplete-suggestion__list',
];

const SEARCH_CONTAINER_SELECTOR = [
  '[role="combobox"]',
  '.el-select',
  '.el-autocomplete',
  '.el-cascader',
  '.ant-select',
  '.ant-cascader',
  '.n-select',
  '.n-auto-complete',
].join(',');

const DEFAULT_MAX_ELEMENTS = 400;
const MAX_SUGGESTION_LABELS = 20;

interface RootContext { inFrame: boolean; inShadowRoot: boolean; }

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function lookupById(root: Node, id: string): Element | null {
  try {
    return (root as Document | ShadowRoot).querySelector(`#${cssEscape(id)}`);
  } catch {
    return null;
  }
}

function cssEscape(value: string): string {
  const escapeFn = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  if (escapeFn) return escapeFn(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function labelOf(el: Element): string {  const parts: string[] = [];
  const root = el.getRootNode();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/).filter(Boolean)) {
      const target = lookupById(root, id);
      if (target) parts.push(textOf(target));
    }
  }
  const input = el as HTMLInputElement;
  if (input.labels) {
    for (const label of Array.from(input.labels)) parts.push(textOf(label));
  }
  for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
    const value = el.getAttribute(attr);
    if (value) parts.push(value);
  }
  // Element/Ant 表单项：内部 input 往往没有 <label for>，用 form-item 标题补充
  const formItem = el.closest('.el-form-item, .ant-form-item');
  if (formItem) {
    const label = formItem.querySelector(':scope > .el-form-item__label, :scope > .ant-form-item-label, :scope > label');
    if (label) parts.push(textOf(label));
  }
  const unique = Array.from(new Set(parts.map((p) => p.trim()).filter(Boolean)));
  return unique.join(' / ').slice(0, 500);
}

/** 打开的自定义下拉项：组件库常用 class，或 listbox/menu 下的 li。 */
export function isDropdownOption(el: Element): boolean {
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'option' || role === 'treeitem') return true;
  if (DROPDOWN_ITEM_CLASSES.some((name) => el.classList.contains(name))) return true;
  const parent = el.parentElement;
  if (!parent) return false;
  const parentRole = (parent.getAttribute('role') || '').toLowerCase();
  if ((parentRole === 'listbox' || parentRole === 'menu') && el.tagName === 'LI') return true;
  if (DROPDOWN_LIST_CLASSES.some((name) => parent.classList.contains(name)) && el.tagName === 'LI') return true;
  return false;
}

/** combobox / 远程搜索框：fill 后应保持焦点并等待建议，而不是立刻 blur。 */
export function isSearchLikeField(el: Element): boolean {
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'combobox' || role === 'searchbox') return true;
  if (el.getAttribute('aria-autocomplete')) return true;
  if (el.getAttribute('aria-expanded') != null) return true;
  if (el.getAttribute('aria-controls') || el.getAttribute('list')) return true;
  try {
    return el.closest(SEARCH_CONTAINER_SELECTOR) != null;
  } catch {
    return false;
  }
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  if (isDropdownOption(el)) return 'option';
  if (el instanceof HTMLAnchorElement) return 'link';
  if (el instanceof HTMLButtonElement) return 'button';
  if (el instanceof HTMLSelectElement) return 'combobox';
  if (el instanceof HTMLTextAreaElement) return 'textbox';
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return 'checkbox';
    if (el.type === 'radio') return 'radio';
    if (['button', 'submit', 'reset', 'image'].includes(el.type)) return 'button';
    if (el.type === 'range') return 'slider';
    if (el.type === 'number') return 'spinbutton';
    return 'textbox';
  }
  if (el instanceof HTMLElement && el.isContentEditable) return 'textbox';
  return el.tagName.toLowerCase();
}

function kindOf(el: Element, role: string): PageElementKind {
  if (role === 'button' || role === 'menuitem' || role === 'tab') return 'button';
  if (role === 'link') return 'link';
  if (role === 'option' || role === 'treeitem') return 'other';
  if (['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton'].includes(role)) return 'form-control';
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return 'form-control';
  return 'other';
}

function optionsOf(el: Element): PageOption[] {
  if (!(el instanceof HTMLSelectElement)) return [];
  return Array.from(el.options).map((option) => ({
    label: textOf(option),
    value: option.value,
    selected: option.selected,
    disabled: option.disabled,
  }));
}

function rawValue(el: Element): unknown {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return { checked: el.checked, value: el.value };
    if (el.type === 'file') return '[FILE_INPUT]';
    return el.value;
  }
  if (el instanceof HTMLTextAreaElement) return el.value;
  if (el instanceof HTMLSelectElement) return el.value;
  if (el instanceof HTMLElement && el.isContentEditable) return el.textContent ?? '';
  const ariaValue = el.getAttribute('aria-valuenow');
  return ariaValue ?? null;
}

function valueOf(el: Element, sensitive: boolean, redactSensitive: boolean): unknown {
  if (sensitive && redactSensitive) return '[REDACTED]';
  return rawValue(el);
}

const VOLATILE_ATTRIBUTES = new Set(['style', 'class', 'value', 'checked', 'selected']);

function attributeHash(el: Element): string {
  const parts: string[] = [];
  for (const attr of Array.from(el.attributes)) {
    if (VOLATILE_ATTRIBUTES.has(attr.name)) continue;
    parts.push(`${attr.name}=${attr.value}`);
  }
  return parts.join(';');
}

export function signatureOf(el: Element, role: string): string {
  return [
    el.tagName, role, (el as HTMLInputElement).type ?? '',
    el.getAttribute('name') ?? '', el.getAttribute('id') ?? '',
    labelOf(el), textOf(el).slice(0, 120),
    attributeHash(el),
  ].join('|');
}

let tokenCounter = 0;
const elementTokens = new WeakMap<Element, string>();

/** 节点身份 token：同一 DOM 节点始终返回同一 token，节点被替换后得到新 token。 */
export function tokenOf(el: Element): string {
  let token = elementTokens.get(el);
  if (!token) {
    token = `t${++tokenCounter}`;
    elementTokens.set(el, token);
  }
  return token;
}

function isInteractive(el: Element): boolean {
  if (el.matches(INTERACTIVE_SELECTOR)) return true;
  if (isDropdownOption(el)) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

function isOptionDisabled(el: Element): boolean {
  return el.classList.contains('is-disabled')
    || el.classList.contains('ant-select-item-option-disabled');
}

/** 当前可见的下拉建议文案，供 fill 观察结果使用。 */
export function collectVisibleOptionLabels(): string[] {
  const labels: string[] = [];
  const visit = (root: Document | ShadowRoot): void => {
    let nodes: Element[];
    try {
      nodes = Array.from(root.querySelectorAll('*'));
    } catch {
      return;
    }
    for (const el of nodes) {
      if (labels.length >= MAX_SUGGESTION_LABELS) return;
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const doc = (el as HTMLIFrameElement).contentDocument;
          if (doc) visit(doc);
        } catch { /* 跨域 */ }
        continue;
      }
      if (el.shadowRoot) visit(el.shadowRoot);
      if (!isDropdownOption(el) || isExcluded(el, null)) continue;
      if (!isStyleVisible(el) || !hasLayoutBox(el) || isOptionDisabled(el)) continue;
      const label = textOf(el).slice(0, 80);
      if (!label || labels.includes(label)) continue;
      labels.push(label);
    }
  };
  visit(document);
  return labels;
}

function isExcluded(el: Element, host: HTMLElement | null | undefined): boolean {
  if (host && (el === host || host.contains(el))) return true;
  let node: Element | null = el;
  while (node) {
    if (node.hasAttribute?.('data-mao-embed-host') || node.id === 'mao-chat-embed-host') return true;
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      if (root.host === host || root.host.hasAttribute('data-mao-embed-host')) return true;
      node = root.host;
    } else {
      node = node.parentElement;
    }
  }
  return false;
}

export function scanPage(options: ScanOptions = {}): ScanResult {
  const host = options.host ?? null;
  const includeHidden = options.includeHidden === true;
  const redactSensitive = options.redactSensitive === true;
  const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;
  const collected: ScannedElement[] = [];
  let crossOriginFrames = 0;

  const visitRoot = (root: Document | ShadowRoot, context: RootContext): void => {
    let nodes: Element[];
    try {
      nodes = Array.from(root.querySelectorAll('*'));
    } catch {
      return;
    }
    for (const el of nodes) {
      if (collected.length >= maxElements) return;
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const doc = (el as HTMLIFrameElement).contentDocument;
          if (doc) visitRoot(doc, { inFrame: true, inShadowRoot: context.inShadowRoot });
          else crossOriginFrames++;
        } catch {
          crossOriginFrames++;
        }
        continue;
      }
      if (el.shadowRoot) {
        visitRoot(el.shadowRoot, { inFrame: context.inFrame, inShadowRoot: true });
      }
      if (isDropdownOption(el) && !textOf(el)) continue;
      if (!isInteractive(el)) continue;
      if (isExcluded(el, host)) continue;
      const styleVisible = isStyleVisible(el);
      if (!styleVisible && !includeHidden) continue;
      const rect = rectOf(el);
      const visible = styleVisible && hasLayoutBox(el);
      const role = roleOf(el);
      const sensitive = isSensitiveField(el);
      if (options.sensitiveOnly === true && !sensitive) continue;
      const elementId = `e${collected.length + 1}`;
      const descriptor: PageElement = {
        elementId,
        kind: kindOf(el, role),
        role,
        type: ((el as HTMLInputElement).type ?? el.tagName).toLowerCase(),
        label: labelOf(el),
        text: textOf(el),
        value: valueOf(el, sensitive, redactSensitive),
        options: optionsOf(el),
        visible,
        inViewport: visible && isInViewport(rect),
        disabled: isDisabled(el) || (isDropdownOption(el) && isOptionDisabled(el)),
        readonly: isReadonly(el),
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
        sensitive,
        inFrame: context.inFrame,
        inShadowRoot: context.inShadowRoot,
        rect,
      };
      collected.push({ element: el, descriptor, signature: signatureOf(el, role), token: tokenOf(el) });
    }
  };

  visitRoot(document, { inFrame: false, inShadowRoot: false });
  return {
    elements: collected,
    url: location.href,
    title: document.title,
    crossOriginFrames,
  };
}

export function rectWithinViewport(rect: PageRect): boolean {
  return isInViewport(rect);
}
