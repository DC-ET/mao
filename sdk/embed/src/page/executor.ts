import type {
  PageAction, PageActionResult, PageBatchResult, PageEffect, PageToolError,
} from './types';
import { isMutatingAction } from './types';
import { PageSnapshotManager, type ResolvedElement } from './snapshot-manager';
import {
  isCheckable, isDisabled, isEditable, isReadonly, isVisible,
} from './visibility';
import {
  dispatchBlur, dispatchKeyEvents, dispatchValueEvents, setElementValue,
} from './framework-events';

export interface AuthorizeAction {
  (action: PageAction, target: ResolvedElement | null): Promise<{ allowed: boolean; error?: PageToolError; needsConfirmation?: boolean }>;
}

export interface ExecuteOptions {
  snapshotId?: string;
  authorize?: AuthorizeAction;
  /** 批量执行时，动作前由引擎刷新一次快照引用 */
  onStep?: (result: PageActionResult, index: number) => void;
  /** 用户停止时中断 wait/scroll 等长耗时动作 */
  shouldAbort?: () => boolean;
  /** per_action 下批量动作在第一个需要确认的动作执行后停止，避免多次确认超过后端超时 */
  stopOnConfirmation?: boolean;
}

const MAX_WAIT_MS = 10_000;
const SETTLE_MS = 60;
const KNOWN_ACTION_TYPES = new Set(['click', 'focus', 'check', 'uncheck', 'fill', 'select', 'keyboard', 'scroll', 'wait']);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
  await delay(SETTLE_MS);
}

function error(code: string, message: string, elementId?: string): PageToolError {
  return { code, message, ...(elementId ? { elementId } : {}) };
}

function failure(action: PageAction, pageVersion: string, err: PageToolError, snapshotId?: string): PageActionResult {
  return { success: false, action, pageVersion, snapshotId, error: err };
}

interface ElementState {
  url: string;
  checked: boolean | null;
  value: string | null;
  text: string | null;
  ariaExpanded: string | null;
  ariaSelected: string | null;
  ariaChecked: string | null;
  disabled: boolean;
}

function stateOf(el: Element | null): ElementState {
  return {
    url: location.href,
    checked: el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : null,
    value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : null,
    text: el instanceof HTMLElement ? (el.textContent ?? '').slice(0, 200) : null,
    ariaExpanded: el?.getAttribute('aria-expanded') ?? null,
    ariaSelected: el?.getAttribute('aria-selected') ?? null,
    ariaChecked: el?.getAttribute('aria-checked') ?? null,
    disabled: el ? isDisabled(el) : false,
  };
}

function observeEffect(before: ElementState, after: ElementState, mutated: boolean): PageEffect {
  if (before.url !== after.url) return 'navigation';
  if (before.checked !== after.checked || before.value !== after.value
    || before.ariaExpanded !== after.ariaExpanded || before.ariaSelected !== after.ariaSelected
    || before.ariaChecked !== after.ariaChecked || before.disabled !== after.disabled) {
    return 'state';
  }
  if (mutated) return 'dom';
  return 'none';
}

export class PageExecutor {
  constructor(private readonly manager: PageSnapshotManager) {}

  async execute(action: PageAction, options: ExecuteOptions = {}): Promise<PageActionResult> {
    const snapshotId = options.snapshotId;
    const pageVersion = this.manager.pageVersion;
    if (this.manager.destroyedFlag) {
      return failure(action, pageVersion, error('internal_error', '页面执行器已销毁', 'elementId' in action ? action.elementId : undefined), snapshotId);
    }
    if (options.shouldAbort?.()) {
      return failure(action, pageVersion, error('task_cancelled', '页面任务已取消'), snapshotId);
    }
    // 未知动作类型在请求授权/弹确认之前就拒绝，避免弹出空确认卡片。
    if (!KNOWN_ACTION_TYPES.has((action as { type?: string }).type ?? '')) {
      return failure(action, pageVersion, error('unsupported_action', `不支持的动作: ${(action as { type?: string }).type}`), snapshotId);
    }
    if (action.type === 'wait') return this.executeWait(action, snapshotId, options);

    const elementId = 'elementId' in action ? action.elementId : undefined;
    const elementRequired = action.type === 'click' || action.type === 'focus' || action.type === 'fill'
      || action.type === 'select' || action.type === 'check' || action.type === 'uncheck';
    if (elementRequired && !elementId) {
      return failure(action, pageVersion, error('invalid_arguments', '缺少 elementId；请使用 page_inspect 返回的元素引用'), snapshotId);
    }
    let resolved: ResolvedElement | null = null;
    if (elementId) {
      const result = this.manager.resolve(snapshotId, elementId);
      if (!result.ok || !result.resolved) {
        return failure(action, pageVersion, error(result.code ?? 'element_not_available', describeResolveFailure(result.code), elementId), snapshotId);
      }
      resolved = result.resolved;
    }

    if (options.authorize) {
      const decision = await options.authorize(action, resolved);
      if (!decision.allowed) {
        return failure(action, pageVersion, decision.error ?? error('authorization_denied', '用户未授权该页面操作', resolved?.descriptor.elementId), snapshotId);
      }
    }

    try {
      if (action.type === 'scroll') return await this.executeScroll(action, resolved, snapshotId, options);
      if (!resolved) return failure(action, pageVersion, error('element_not_available', '目标元素不存在'), snapshotId);
      if (action.type === 'focus') return await this.executeFocus(action, resolved, snapshotId);
      if (action.type === 'fill') return await this.executeFill(action, resolved, snapshotId);
      if (action.type === 'select') return await this.executeSelect(action, resolved, snapshotId);
      if (action.type === 'check' || action.type === 'uncheck') return await this.executeCheck(action, resolved, snapshotId);
      if (action.type === 'click') return await this.executeClick(action, resolved, snapshotId);
      if (action.type === 'keyboard') return await this.executeKeyboard(action, resolved, snapshotId);
      return failure(action, pageVersion, error('unsupported_action', `不支持的动作: ${(action as PageAction).type}`, resolved.descriptor.elementId), snapshotId);
    } catch (e) {
      return failure(action, this.manager.pageVersion, error('internal_error', e instanceof Error ? e.message : String(e), resolved?.descriptor.elementId), snapshotId);
    }
  }

  async executeBatch(actions: PageAction[], options: ExecuteOptions = {}): Promise<PageBatchResult> {
    const steps: PageActionResult[] = [];
    let stoppedAt: number | undefined;
    let reason: string | undefined;
    let lastNeededConfirmation = false;
    const authorize = options.authorize;
    const wrapped: AuthorizeAction | undefined = authorize
      ? async (action, target) => {
        const decision = await authorize(action, target);
        lastNeededConfirmation = decision.needsConfirmation === true;
        return decision;
      }
      : undefined;
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index]!;
      if (options.shouldAbort?.()) {
        stoppedAt = index;
        reason = '页面任务已取消';
        break;
      }
      lastNeededConfirmation = false;
      const result = await this.execute(action, { ...options, snapshotId: options.snapshotId, authorize: wrapped });
      steps.push(result);
      options.onStep?.(result, index);
      if (!result.success) {
        stoppedAt = index;
        reason = result.error?.message ?? '动作执行失败';
        break;
      }
      if (result.effect === 'navigation') {
        stoppedAt = index;
        reason = '页面发生导航，剩余动作已停止，请重新 page_inspect';
        break;
      }
      // per_action：逐个确认的累计耗时可能超过后端工具超时，执行完确认动作后即暂停。
      // 仅当后面还有动作时才算「中断」，单动作批次正常完成。
      if (options.stopOnConfirmation && lastNeededConfirmation && index < actions.length - 1) {
        stoppedAt = index;
        reason = '已执行经用户确认的动作；per_action 下批量动作暂停，请逐个确认后继续';
        break;
      }
      // 批量动作不允许跨快照：任一步让快照失效就停止后续动作。
      if (options.snapshotId && this.manager.currentSnapshotId !== options.snapshotId) {
        stoppedAt = index;
        reason = '页面结构已变化，快照失效，剩余动作已停止';
        break;
      }
    }
    return {
      steps,
      ...(stoppedAt === undefined ? {} : { stoppedAt }),
      ...(reason ? { reason } : {}),
      pageVersion: this.manager.pageVersion,
      ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
    };
  }

  private async executeWait(action: Extract<PageAction, { type: 'wait' }>, snapshotId?: string, options: ExecuteOptions = {}): Promise<PageActionResult> {
    const defaultMs = action.until === 'stable' ? 3_000 : 300;
    const ms = Math.min(Math.max(action.ms ?? defaultMs, 0), MAX_WAIT_MS);
    if (action.until === 'stable') {
      await waitForStable(Math.min(ms, 5_000), 300, options.shouldAbort);
    } else {
      await delay(ms);
    }
    if (options.shouldAbort?.()) {
      return failure(action, this.manager.pageVersion, error('task_cancelled', '页面任务已取消'), snapshotId);
    }
    return { success: true, action, pageVersion: this.manager.pageVersion, snapshotId, verified: true, effect: 'none' };
  }

  private async executeScroll(action: Extract<PageAction, { type: 'scroll' }>, resolved: ResolvedElement | null, snapshotId?: string, options: ExecuteOptions = {}): Promise<PageActionResult> {
    const target = resolved?.element;
    const isElement = target instanceof Element;
    const before = isElement ? { left: target.scrollLeft, top: target.scrollTop } : { left: window.scrollX, top: window.scrollY };
    const scrolling = isElement ? target : (document.scrollingElement ?? document.documentElement);
    const maxLeft = Math.max(0, scrolling.scrollWidth - (isElement ? target.clientWidth : window.innerWidth));
    const maxTop = Math.max(0, scrolling.scrollHeight - (isElement ? target.clientHeight : window.innerHeight));
    const requestedLeft = action.x != null ? Math.min(Math.max(0, action.x), maxLeft) : before.left;
    const requestedTop = action.y != null ? Math.min(Math.max(0, action.y), maxTop) : before.top;
    if (action.to === 'top') {
      if (isElement) target.scrollTo({ left: before.left, top: 0, behavior: 'auto' });
      else window.scrollTo({ left: before.left, top: 0, behavior: 'auto' });
    } else if (action.to === 'bottom') {
      if (isElement) target.scrollTo({ left: before.left, top: maxTop, behavior: 'auto' });
      else window.scrollTo({ left: before.left, top: maxTop, behavior: 'auto' });
    } else if (isElement) {
      target.scrollTo({ left: requestedLeft, top: requestedTop, behavior: 'auto' });
    } else {
      window.scrollTo({ left: requestedLeft, top: requestedTop, behavior: 'auto' });
    }
    await settle();
    if (options.shouldAbort?.()) {
      return failure(action, this.manager.pageVersion, error('task_cancelled', '页面任务已取消'), snapshotId);
    }
    const after = isElement ? { left: target.scrollLeft, top: target.scrollTop } : { left: window.scrollX, top: window.scrollY };
    const expected = action.to === 'top' ? { left: before.left, top: 0 }
      : action.to === 'bottom'
        ? { left: before.left, top: maxTop }
        : { left: requestedLeft, top: requestedTop };
    const verified = Math.abs(after.left - expected.left) <= 2 && Math.abs(after.top - expected.top) <= 2;
    if (!verified) {
      return failure(action, this.manager.pageVersion, error('scroll_failed', `滚动未生效（当前 ${after.left},${after.top}）`), snapshotId);
    }
    return {
      success: true, action, pageVersion: this.manager.pageVersion, snapshotId,
      verified: true, effect: after.left !== before.left || after.top !== before.top ? 'state' : 'none',
      observation: { scrollLeft: after.left, scrollTop: after.top },
    };
  }

  private async executeFocus(action: Extract<PageAction, { type: 'focus' }>, resolved: ResolvedElement, snapshotId?: string): Promise<PageActionResult> {
    const el = resolved.element;
    if (!(el instanceof HTMLElement) || typeof el.focus !== 'function') {
      return failure(action, this.manager.pageVersion, error('not_focusable', '目标元素不可聚焦', resolved.descriptor.elementId), snapshotId);
    }
    el.focus();
    await settle();
    // getRootNode()：同源 iframe / 开放 Shadow DOM 内元素的焦点在各自 root 上，
    // ownerDocument.activeElement 在 Shadow DOM 下会指向 host。
    const active = (el.getRootNode() as Document | ShadowRoot).activeElement;
    const verified = active === el;
    if (!verified) {
      return failure(action, this.manager.pageVersion, error('not_focusable', '焦点未落到目标元素', resolved.descriptor.elementId), snapshotId);
    }
    return { success: true, action, pageVersion: this.manager.pageVersion, snapshotId, verified: true, effect: 'state' };
  }

  private async executeFill(action: Extract<PageAction, { type: 'fill' }>, resolved: ResolvedElement, snapshotId?: string): Promise<PageActionResult> {
    const el = resolved.element;
    const elementId = resolved.descriptor.elementId;
    if (typeof action.value !== 'string') return failure(action, this.manager.pageVersion, error('invalid_arguments', '缺少字符串 value', elementId), snapshotId);
    if (isDisabled(el)) return failure(action, this.manager.pageVersion, error('element_disabled', '目标元素处于禁用状态', elementId), snapshotId);
    if (isReadonly(el)) return failure(action, this.manager.pageVersion, error('element_readonly', '目标元素为只读', elementId), snapshotId);
    if (!isEditable(el)) return failure(action, this.manager.pageVersion, error('element_not_fillable', '目标元素不可填写', elementId), snapshotId);
    const contentEditable = !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement);
    // 先聚焦再写入：设计约定 fill 触发 blur，而 dispatchBlur 只在元素持有焦点时派发；
    // 依赖失焦提交/校验的表单需要这一步。
    if (el instanceof HTMLElement && typeof el.focus === 'function') el.focus();
    if (!setElementValue(el, action.value)) {
      return failure(action, this.manager.pageVersion, error('element_not_fillable', '无法写入目标元素', elementId), snapshotId);
    }
    dispatchValueEvents(el, action.value, contentEditable);
    dispatchBlur(el);
    await settle();
    const actual = contentEditable ? (el.textContent ?? '') : (el as HTMLInputElement).value;
    if (actual !== action.value) {
      return failure(action, this.manager.pageVersion, error('value_not_applied', `写入后回读值不一致（实际长度 ${actual.length}）`, elementId), snapshotId);
    }
    this.manager.refreshDescriptor(elementId);
    return { success: true, action, pageVersion: this.manager.pageVersion, snapshotId, verified: true, effect: 'state', observation: { valueLength: actual.length } };
  }

  private async executeSelect(action: Extract<PageAction, { type: 'select' }>, resolved: ResolvedElement, snapshotId?: string): Promise<PageActionResult> {
    const el = resolved.element;
    const elementId = resolved.descriptor.elementId;
    if (typeof action.value !== 'string') return failure(action, this.manager.pageVersion, error('invalid_arguments', '缺少字符串 value', elementId), snapshotId);
    if (!(el instanceof HTMLSelectElement)) {
      return failure(action, this.manager.pageVersion, error('element_not_selectable', '目标元素不是原生 select', elementId), snapshotId);
    }
    if (isDisabled(el)) return failure(action, this.manager.pageVersion, error('element_disabled', '目标元素处于禁用状态', elementId), snapshotId);
    const option = Array.from(el.options).find((item) => item.value === action.value);
    if (!option) return failure(action, this.manager.pageVersion, error('option_not_found', `未找到 value=${action.value} 的选项`, elementId), snapshotId);
    if (option.disabled) return failure(action, this.manager.pageVersion, error('option_disabled', '目标选项不可选', elementId), snapshotId);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (descriptor?.set) descriptor.set.call(el, action.value);
    else el.value = action.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    if (el.value !== action.value) {
      return failure(action, this.manager.pageVersion, error('value_not_applied', `选择后回读值不一致（实际 ${el.value}）`, elementId), snapshotId);
    }
    this.manager.refreshDescriptor(elementId);
    return { success: true, action, pageVersion: this.manager.pageVersion, snapshotId, verified: true, effect: 'state', observation: { value: el.value } };
  }

  private async executeCheck(action: Extract<PageAction, { type: 'check' | 'uncheck' }>, resolved: ResolvedElement, snapshotId?: string): Promise<PageActionResult> {
    const el = resolved.element;
    const elementId = resolved.descriptor.elementId;
    const desired = action.type === 'check';
    if (isDisabled(el)) return failure(action, this.manager.pageVersion, error('element_disabled', '目标元素处于禁用状态', elementId), snapshotId);
    if (!isCheckable(el)) return failure(action, this.manager.pageVersion, error('element_not_checkable', '目标元素不是可勾选控件', elementId), snapshotId);
    const before = stateOf(el);
    if (el instanceof HTMLInputElement) {
      if (el.type === 'radio' && !desired) {
        return failure(action, this.manager.pageVersion, error('unsupported_action', 'radio 无法取消选中', elementId), snapshotId);
      }
      if (el.checked !== desired) (el as HTMLElement).click();
    } else {
      const current = el.getAttribute('aria-checked') === 'true';
      if (current !== desired) (el as HTMLElement).click();
    }
    await settle();
    const after = stateOf(el);
    const verified = el instanceof HTMLInputElement ? el.checked === desired : el.getAttribute('aria-checked') === String(desired);
    if (!verified) {
      return failure(action, this.manager.pageVersion, error('value_not_applied', '勾选状态未生效', elementId), snapshotId);
    }
    this.manager.refreshDescriptor(elementId);
    return {
      success: true, action, pageVersion: this.manager.pageVersion, snapshotId,
      verified: true, effect: observeEffect(before, after, false), observation: { checked: desired },
    };
  }

  private async executeClick(action: Extract<PageAction, { type: 'click' }>, resolved: ResolvedElement, snapshotId?: string): Promise<PageActionResult> {
    const el = resolved.element;
    const elementId = resolved.descriptor.elementId;
    if (isDisabled(el)) return failure(action, this.manager.pageVersion, error('element_disabled', '目标元素处于禁用状态', elementId), snapshotId);
    if (!isVisible(el)) return failure(action, this.manager.pageVersion, error('element_not_available', '目标元素不可见', elementId), snapshotId);
    if (el instanceof HTMLInputElement && el.type === 'file') {
      return failure(action, this.manager.pageVersion, error('unsupported_target', '不支持点击文件选择器', elementId), snapshotId);
    }
    if (el instanceof HTMLAnchorElement) {
      const target = (el.getAttribute('target') || '').toLowerCase();
      if (target === '_blank' || el.hasAttribute('download')) {
        return failure(action, this.manager.pageVersion, error('unsupported_target', '不支持打开新标签页或下载链接', elementId), snapshotId);
      }
    }
    const before = stateOf(el);
    let mutated = false;
    let observer: MutationObserver | null = null;
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(() => { mutated = true; });
      try {
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch { observer = null; }
    }
    try {
      (el as HTMLElement).click();
    } finally {
      await settle();
      observer?.disconnect();
    }
    const after = stateOf(el);
    const effect = observeEffect(before, after, mutated);
    return {
      success: true, action, pageVersion: this.manager.pageVersion, snapshotId,
      verified: effect !== 'none', effect,
      ...(effect === 'none' ? { observation: { note: '点击已下发但未观察到页面变化，请重新 page_inspect 确认' } } : {}),
    };
  }

  private async executeKeyboard(action: Extract<PageAction, { type: 'keyboard' }>, resolved: ResolvedElement | null, snapshotId?: string): Promise<PageActionResult> {
    const el = resolved?.element ?? document.activeElement;
    const elementId = resolved?.descriptor.elementId;
    if (resolved && isDisabled(el!)) return failure(action, this.manager.pageVersion, error('element_disabled', '目标元素处于禁用状态', elementId), snapshotId);
    if (!el) return failure(action, this.manager.pageVersion, error('not_focusable', '没有可接收键盘事件的目标元素', elementId), snapshotId);
    if (action.text != null && action.text !== '') {
      if (isReadonly(el)) return failure(action, this.manager.pageVersion, error('element_readonly', '目标元素为只读', elementId), snapshotId);
      if (!isEditable(el)) return failure(action, this.manager.pageVersion, error('element_not_fillable', '目标元素不可输入文本', elementId), snapshotId);
      const current = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? '');
      if (!setElementValue(el, current + action.text)) {
        return failure(action, this.manager.pageVersion, error('element_not_fillable', '无法写入目标元素', elementId), snapshotId);
      }
      dispatchValueEvents(el, action.text, !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement));
      await settle();
      const after = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? '');
      if (!after.includes(action.text)) {
        return failure(action, this.manager.pageVersion, error('value_not_applied', '键盘文本未写入', elementId), snapshotId);
      }
    }
    dispatchKeyEvents(el, { key: action.key, modifiers: action.modifiers });
    await settle();
    if (elementId) this.manager.refreshDescriptor(elementId);
    return {
      success: true, action, pageVersion: this.manager.pageVersion, snapshotId,
      verified: action.text != null && action.text !== '',
      effect: action.text != null && action.text !== '' ? 'state' : 'none',
      ...(action.text == null || action.text === ''
        ? { observation: { note: '已派发合成键盘事件；浏览器不会为合成事件执行原生默认行为（表单提交/Tab 跳转等）' } }
        : {}),
    };
  }
}

function describeResolveFailure(code: string | undefined): string {
  if (code === 'snapshot_expired') return '快照已失效（页面已导航或重新 inspect），请重新调用 page_inspect';
  if (code === 'element_changed') return '目标元素语义已变化，请重新 page_inspect 后重试';
  return '目标元素已不存在或不可用，请重新 page_inspect';
}

export async function waitForStable(maxMs: number, quietMs = 300, shouldAbort?: () => boolean): Promise<void> {
  if (typeof MutationObserver !== 'function') {
    await delay(quietMs);
    return;
  }
  await new Promise<void>((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (quietTimer) clearTimeout(quietTimer);
      observer.disconnect();
      clearTimeout(maxTimer);
      if (abortTimer) clearInterval(abortTimer);
      resolve();
    };
    const arm = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };
    const observer = new MutationObserver(() => arm());
    const maxTimer = setTimeout(finish, maxMs);
    const abortTimer = shouldAbort ? setInterval(() => { if (shouldAbort()) finish(); }, 100) : null;
    try {
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {
      finish();
      return;
    }
    arm();
  });
}

export { isMutatingAction };
