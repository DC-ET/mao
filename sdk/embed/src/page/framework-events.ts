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
  if (document.activeElement !== el) return;
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
