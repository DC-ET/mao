import type { PageRect } from './types';

/** 样式层面可见（不依赖布局盒模型）。 */
export function isStyleVisible(el: Element): boolean {
  if (!(el instanceof Element)) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (Number.parseFloat(style.opacity || '1') === 0) return false;
  if ((el as HTMLElement).hidden === true) return false;
  return true;
}

export function hasLayoutBox(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** 元素在当前文档中可见（样式可见且有布局尺寸）。 */
export function isVisible(el: Element): boolean {
  return isStyleVisible(el) && hasLayoutBox(el);
}

export function rectOf(el: Element): PageRect {
  const local = el.getBoundingClientRect();
  let x = local.x;
  let y = local.y;
  // 同源 iframe 内的元素坐标是 iframe 局部坐标：沿 frameElement 链累加偏移，
  // 换算成主文档视口坐标，否则高亮与截图遮罩会错位。
  let win: Window | null = el.ownerDocument.defaultView;
  let guard = 0;
  while (win && win !== window && guard++ < 10) {
    let frame: Element | null = null;
    try { frame = win.frameElement; } catch { frame = null; }
    if (!frame) break;
    const frameRect = frame.getBoundingClientRect();
    x += frameRect.x;
    y += frameRect.y;
    win = frame.ownerDocument.defaultView;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(local.width), height: Math.round(local.height) };
}

export function isInViewport(rect: PageRect): boolean {
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return rect.width > 0 && rect.height > 0
    && rect.y + rect.height > 0 && rect.y < vh
    && rect.x + rect.width > 0 && rect.x < vw;
}

/** disabled 判定包含 disabled fieldset 继承；fieldset 内首个 legend 下的控件不受影响。 */
export function isDisabled(el: Element): boolean {
  if (el.hasAttribute('disabled')) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  if ((el as HTMLInputElement).disabled === true) return true;
  const fieldset = el.closest('fieldset[disabled]');
  if (!fieldset) return false;
  const legend = fieldset.querySelector(':scope > legend');
  if (legend && legend.contains(el)) return false;
  return true;
}

export function isReadonly(el: Element): boolean {
  if (el.hasAttribute('readonly')) return true;
  if (el.getAttribute('aria-readonly') === 'true') return true;
  const node = el as HTMLInputElement | HTMLTextAreaElement;
  return node.readOnly === true;
}

export function isEditable(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (el instanceof HTMLInputElement) {
    const type = (el.type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'hidden', 'range', 'color'].includes(type);
  }
  return false;
}

export function isCheckable(el: Element): boolean {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return true;
  const role = el.getAttribute('role');
  return role === 'checkbox' || role === 'radio' || role === 'switch';
}

export function isSelect(el: Element): el is HTMLSelectElement {
  return el instanceof HTMLSelectElement;
}

const SENSITIVE_HINTS = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'captcha', 'verify', 'verification',
  'otp', 'pin', 'cvv', 'cvc', 'card', 'creditcard', 'credit-card', 'bankcard',
  'idcard', 'id-card', 'ssn', 'socialsecurity', '安全码', '验证码', '密码', '银行卡', '身份证', '信用卡',
];

/** 疑似敏感字段：密码、隐藏字段、支付/证件类 autocomplete 或名称提示。 */
export function isSensitiveField(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    const type = (el.type || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
  }
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (autocomplete.startsWith('cc-') || autocomplete.includes('password') || autocomplete.includes('one-time-code')) {
    return true;
  }
  const haystack = [
    el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('aria-label'),
    el.getAttribute('placeholder'), el.getAttribute('data-testid'),
  ].filter(Boolean).join(' ').toLowerCase();
  return SENSITIVE_HINTS.some((hint) => haystack.includes(hint));
}

export function isPasswordLike(el: Element): boolean {
  return el instanceof HTMLInputElement && (el.type || '').toLowerCase() === 'password';
}
