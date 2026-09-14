/**
 * 受控组件（React/Vue）事件兼容层。
 *
 * React 会在 input/textarea 上安装自己的 value tracker，直接赋值 DOM.value 会让它认为值没变而跳过 onChange。
 * 因此必须调用原型上的原生 setter 写入，再派发标准 input/change 事件。
 */

function nativeSetter(el: Element, value: string): boolean {
  const prototype = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : null;
  if (!prototype) return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (!descriptor?.set) return false;
  descriptor.set.call(el, value);
  return true;
}

/** 写入输入类元素的值，返回是否写入成功（contenteditable 走 textContent）。 */
export function setElementValue(el: Element, value: string): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (!nativeSetter(el, value)) {
      try { (el as HTMLInputElement).value = value; } catch { return false; }
    }
    return true;
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    el.textContent = value;
    return true;
  }
  return false;
}

/** 派发 input/change 事件；contenteditable 额外带 inputType。 */
export function dispatchValueEvents(el: Element, value: string, contentEditable: boolean): void {
  try {
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      ...(contentEditable ? { inputType: 'insertText', data: value } : {}),
    }));
  } catch {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 焦点变化事件：只在元素当前持有焦点时派发，避免无谓地触发页面校验。 */
export function dispatchBlur(el: Element): void {
  // 用 getRootNode()：同源 iframe 与开放 Shadow DOM 内元素的焦点记录在各自 root 上，
  // 顶层 document.activeElement 此时是 <iframe> 宿主元素 / Shadow host（与 executeFocus 口径一致）。
  const active = (el.getRootNode() as Document | ShadowRoot).activeElement;
  if (active !== el) return;
  el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}

export interface KeyboardOptions {
  key: string;
  code?: string;
  modifiers?: string[];
  repeat?: boolean;
}

const MODIFIER_FLAGS: Record<string, keyof KeyboardEventInit> = {
  ctrl: 'ctrlKey',
  control: 'ctrlKey',
  alt: 'altKey',
  shift: 'shiftKey',
  meta: 'metaKey',
};

export function keyboardInit(options: KeyboardOptions): KeyboardEventInit {
  const init: KeyboardEventInit = { key: options.key, code: options.code ?? keyToCode(options.key), bubbles: true, cancelable: true, repeat: options.repeat === true };
  for (const modifier of options.modifiers ?? []) {
    const flag = MODIFIER_FLAGS[modifier.toLowerCase()];
    if (flag) (init as Record<string, unknown>)[flag as string] = true;
  }
  return init;
}

export function dispatchKeyEvents(target: EventTarget, options: KeyboardOptions): void {
  const init = keyboardInit(options);
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keypress', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}

function fireMouseLike(el: EventTarget, type: string, init: MouseEventInit): void {
  if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
    try {
      el.dispatchEvent(new PointerEvent(type, {
        ...init,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }));
      return;
    } catch { /* 某些环境 PointerEvent 构造失败则回退 MouseEvent */ }
  }
  el.dispatchEvent(new MouseEvent(type, init));
}

/**
 * 模拟真实鼠标按下/抬起再 click。
 * Element/Ant 等组件库常用 mousedown 防误关弹层，只派发 click 会选不中下拉项。
 */
export function dispatchNativeClick(el: HTMLElement): void {
  const rect = el.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  if (typeof el.focus === 'function') el.focus();
  fireMouseLike(el, 'pointerdown', init);
  fireMouseLike(el, 'mousedown', init);
  fireMouseLike(el, 'pointerup', init);
  fireMouseLike(el, 'mouseup', init);
  fireMouseLike(el, 'click', init);
}

/** 下拉项选中态：用于 click 后回读，避免 Agent 把「已点开/已过滤」当成「已选中」。 */
export function readOptionSelected(el: Element): boolean | null {
  // 节点已被父级重渲染替换时，旧节点上的 aria-selected/class 不可信
  if (!el.isConnected) return null;
  const aria = el.getAttribute('aria-selected');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  if (
    el.classList.contains('selected')
    || el.classList.contains('is-selected')
    || el.getAttribute('aria-checked') === 'true'
    || el.getAttribute('data-selected') === 'true'
  ) {
    return true;
  }
  return null;
}

const CODE_MAP: Record<string, string> = {
  Enter: 'Enter', Escape: 'Escape', Esc: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
  Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space',
};

export function keyToCode(key: string): string {
  if (CODE_MAP[key]) return CODE_MAP[key];
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (/[A-Z]/.test(upper)) return `Key${upper}`;
    if (/[0-9]/.test(key)) return `Digit${key}`;
  }
  return key;
}
