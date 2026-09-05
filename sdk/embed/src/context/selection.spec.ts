import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SelectionTracker } from './selection';

/**
 * happy-dom 的 Selection 支持有限（toString/anchorNode 依赖 range 实现），
 * 这里 stub window.getSelection 以精确控制选区归属。
 */
interface FakeSelection {
  isCollapsed: boolean;
  rangeCount: number;
  anchorNode: Node | null;
  focusNode: Node | null;
  toString(): string;
}

function stubSelection(sel: FakeSelection | null) {
  (window as unknown as { getSelection: () => unknown }).getSelection = () => sel;
}

function makeSelection(text: string, node: Node | null): FakeSelection {
  return {
    isCollapsed: text === '',
    rangeCount: 1,
    anchorNode: node,
    focusNode: node,
    toString: () => text,
  };
}

/** 触发一次 selectionchange 并跑完 200ms debounce */
async function fireSelectionChange() {
  document.dispatchEvent(new Event('selectionchange'));
  await new Promise((r) => setTimeout(r, 260));
}

describe('SelectionTracker', () => {
  let hostPage: HTMLElement;
  let sdkHost: HTMLElement;
  let shadowInner: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    hostPage = document.createElement('p');
    hostPage.textContent = '宿主页面正文';
    document.body.appendChild(hostPage);

    sdkHost = document.createElement('div');
    sdkHost.id = 'mao-chat-embed-host';
    document.body.appendChild(sdkHost);
    const shadow = sdkHost.attachShadow({ mode: 'open' });
    shadowInner = document.createElement('div');
    shadowInner.textContent = '助手回答内容';
    shadow.appendChild(shadowInner);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('宿主页面内的选中被采集', () => {
    const tracker = new SelectionTracker(() => {}, sdkHost);
    stubSelection(makeSelection('宿主页面正文', hostPage.firstChild));
    expect(tracker.peek()).toBe('宿主页面正文');
    tracker.destroy();
  });

  it('浮窗（Shadow DOM）内部的选中被忽略', () => {
    const tracker = new SelectionTracker(() => {}, sdkHost);
    stubSelection(makeSelection('助手回答内容', shadowInner.firstChild));
    expect(tracker.peek()).toBeNull();
    tracker.destroy();
  });

  it('选区落在 host 元素自身（light DOM）也忽略', () => {
    const tracker = new SelectionTracker(() => {}, sdkHost);
    stubSelection(makeSelection('x', sdkHost));
    expect(tracker.peek()).toBeNull();
    tracker.destroy();
  });

  it('选区被折叠时保留已捕获的引用（用户点输入框准备打字）', async () => {
    const notified: Array<string | null> = [];
    const tracker = new SelectionTracker((v) => notified.push(v), sdkHost);
    stubSelection(makeSelection('这段很重要', hostPage.firstChild));
    await fireSelectionChange();
    expect(notified).toEqual(['这段很重要']);

    // 点进浮窗输入框：宿主选区折叠，但引用不能消失（否则引用功能不可用）
    stubSelection(makeSelection('', hostPage.firstChild));
    await fireSelectionChange();
    expect(notified).toEqual(['这段很重要']);
    tracker.destroy();
  });

  it('选中另一段文本时引用被替换', async () => {
    const notified: Array<string | null> = [];
    const tracker = new SelectionTracker((v) => notified.push(v), sdkHost);
    stubSelection(makeSelection('第一段', hostPage.firstChild));
    await fireSelectionChange();
    stubSelection(makeSelection('第二段', hostPage.firstChild));
    await fireSelectionChange();
    expect(notified).toEqual(['第一段', '第二段']);
    tracker.destroy();
  });

  it('dismiss 后同一段文本不再作为引用，换选别的仍可用', async () => {
    const notified: Array<string | null> = [];
    const tracker = new SelectionTracker((v) => notified.push(v), sdkHost);
    stubSelection(makeSelection('这段很重要', hostPage.firstChild));
    expect(tracker.peek()).toBe('这段很重要');

    tracker.dismiss('这段很重要');
    expect(tracker.peek()).toBeNull();
    expect(notified).toEqual([null]);
    // 关闭 chip 后选区未变：不得再次冒出引用
    await fireSelectionChange();
    expect(notified).toEqual([null]);

    stubSelection(makeSelection('另一段', hostPage.firstChild));
    expect(tracker.peek()).toBe('另一段');
    tracker.destroy();
  });

  it('重新选择被屏蔽的文本时恢复引用', async () => {
    const notified: Array<string | null> = [];
    const tracker = new SelectionTracker((v) => notified.push(v), sdkHost);
    stubSelection(makeSelection('这段很重要', hostPage.firstChild));
    tracker.consume('这段很重要');
    expect(tracker.peek()).toBeNull();

    // 重新拉选：mousedown 先折叠选区，mouseup 后又选中同一段
    stubSelection(makeSelection('', hostPage.firstChild));
    await fireSelectionChange();
    stubSelection(makeSelection('这段很重要', hostPage.firstChild));
    expect(tracker.peek()).toBe('这段很重要');
    await fireSelectionChange();
    expect(notified).toEqual([null, '这段很重要']);
    tracker.destroy();
  });

  it('unconsume 立即恢复引用（发送失败回滚）', () => {
    const tracker = new SelectionTracker(() => {}, sdkHost);
    stubSelection(makeSelection('刚发出去的', hostPage.firstChild));
    tracker.consume('刚发出去的');
    expect(tracker.peek()).toBeNull();
    tracker.unconsume();
    expect(tracker.peek()).toBe('刚发出去的');
    tracker.destroy();
  });

  it('折叠选区与纯空白选中返回 null', () => {
    const tracker = new SelectionTracker(() => {}, sdkHost);
    stubSelection(makeSelection('', hostPage.firstChild));
    expect(tracker.peek()).toBeNull();
    stubSelection(makeSelection('   \n ', hostPage.firstChild));
    expect(tracker.peek()).toBeNull();
    tracker.destroy();
  });

  it('未传 host 时不做浮窗过滤（向后兼容）', () => {
    const tracker = new SelectionTracker(() => {});
    stubSelection(makeSelection('助手回答内容', shadowInner.firstChild));
    expect(tracker.peek()).toBe('助手回答内容');
    tracker.destroy();
  });
});
