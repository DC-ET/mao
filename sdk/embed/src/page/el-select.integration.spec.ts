import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PageSnapshotManager } from './snapshot-manager';
import { PageExecutor } from './executor';

/**
 * 集成场景：业务页 Element 风格 filterable + multiple + allow-create 的 el-select。
 * 覆盖 Agent 真实路径：定位过滤框 → fill 不失焦 → 重新 inspect → click 选项 → 确认选中。
 */

const originalRect = Element.prototype.getBoundingClientRect;

interface SelectState {
  open: boolean;
  selected: string[];
  query: string;
}

interface MockSelect {
  root: HTMLElement;
  state: SelectState;
  filterInput: HTMLInputElement;
  readonlyDisplay: HTMLInputElement;
  sideSearch: HTMLInputElement;
  popper: HTMLElement;
  getOption: (label: string) => HTMLElement | null;
  getTag: (label: string) => HTMLElement | null;
}

const SERVERS = [
  { appId: 'rob-system', appName: 'rob-system' },
  { appId: 'rob-api', appName: 'rob-api' },
  { appId: 'pay-center', appName: 'pay-center' },
  { appId: 'user-center', appName: 'user-center' },
];

function mountElementMultiSelect(): MockSelect {
  document.body.innerHTML = `
    <div class="el-form">
      <div class="el-form-item server">
        <div class="el-form-item__label">服务:</div>
        <div class="el-select" data-testid="server-select">
          <div class="el-select__wrapper">
            <div class="el-select__selection">
              <span class="el-select__placeholder" data-testid="placeholder">请先选择</span>
              <span class="el-select__tags" data-testid="tags" style="display:none"></span>
              <div class="el-select__input-wrapper">
                <input class="el-select__input" data-testid="filter-input" autocomplete="off" aria-label="服务">
              </div>
            </div>
          </div>
          <input class="el-input__inner" data-testid="readonly-display" readonly value="">
        </div>
      </div>
      <input class="side-search" data-testid="side-search" placeholder="其它搜索">
    </div>
    <div class="el-popper el-select__popper" data-testid="popper" style="display:none">
      <div class="el-select-dropdown">
        <ul class="el-select-dropdown__list" data-testid="dropdown-list"></ul>
      </div>
    </div>
  `;

  const root = document.querySelector('[data-testid="server-select"]') as HTMLElement;
  const filterInput = document.querySelector('[data-testid="filter-input"]') as HTMLInputElement;
  const readonlyDisplay = document.querySelector('[data-testid="readonly-display"]') as HTMLInputElement;
  const sideSearch = document.querySelector('[data-testid="side-search"]') as HTMLInputElement;
  const popper = document.querySelector('[data-testid="popper"]') as HTMLElement;
  const list = document.querySelector('[data-testid="dropdown-list"]') as HTMLElement;
  const placeholder = document.querySelector('[data-testid="placeholder"]') as HTMLElement;
  const tags = document.querySelector('[data-testid="tags"]') as HTMLElement;

  const state: SelectState = { open: false, selected: [], query: '' };

  const renderTags = (): void => {
    if (state.selected.length === 0) {
      tags.style.display = 'none';
      tags.innerHTML = '';
      placeholder.style.display = '';
      readonlyDisplay.value = '';
      return;
    }
    placeholder.style.display = 'none';
    tags.style.display = '';
    tags.innerHTML = state.selected
      .map((id) => `<span class="el-tag" data-value="${id}">${id}</span>`)
      .join('');
    readonlyDisplay.value = state.selected.join(',');
  };

  const visibleServers = (): typeof SERVERS => {
    if (!state.query) return SERVERS;
    const q = state.query.toLowerCase();
    return SERVERS.filter((item) => item.appName.toLowerCase().includes(q) || item.appId.includes(q));
  };

  const renderOptions = (): void => {
    list.innerHTML = visibleServers()
      .map((item) => {
        const selected = state.selected.includes(item.appId);
        return `<li class="el-select-dropdown__item${selected ? ' selected' : ''}" role="option" data-value="${item.appId}" aria-selected="${selected}">${item.appName}</li>`;
      })
      .join('');
  };

  const openDropdown = (): void => {
    state.open = true;
    popper.style.display = '';
    filterInput.setAttribute('aria-expanded', 'true');
    renderOptions();
  };

  const closeDropdown = (): void => {
    state.open = false;
    popper.style.display = 'none';
    filterInput.setAttribute('aria-expanded', 'false');
  };

  const selectValue = (appId: string): void => {
    if (!state.selected.includes(appId)) state.selected.push(appId);
    renderTags();
    renderOptions();
    // 业务 @change：多选保持弹层打开
    root.dispatchEvent(new CustomEvent('change', { detail: state.selected.slice(), bubbles: true }));
  };

  // Element 多选常见实现：仅容器 mousedown 展开；focus/input 单独不会打开弹层
  root.addEventListener('mousedown', () => {
    if (!state.open) openDropdown();
  });
  filterInput.addEventListener('input', () => {
    state.query = filterInput.value.trim();
    if (!state.open) return;
    renderOptions();
  });
  filterInput.addEventListener('blur', (event) => {
    const next = event.relatedTarget as Node | null;
    if (next && (popper.contains(next) || root.contains(next))) return;
    // 失焦收起：模拟「fill 默认 blur 导致建议消失」
    closeDropdown();
    state.query = '';
    filterInput.value = '';
    renderOptions();
  });

  list.addEventListener('mousedown', (event) => {
    const option = (event.target as HTMLElement).closest('.el-select-dropdown__item') as HTMLElement | null;
    if (!option) return;
    event.preventDefault();
  });
  list.addEventListener('click', (event) => {
    const option = (event.target as HTMLElement).closest('.el-select-dropdown__item') as HTMLElement | null;
    if (!option) return;
    // 仅 .click()（无 mousedown）在部分组件库上不触发；这里用 mousedown 标记模拟
    if (!option.dataset.mousedown) return;
    selectValue(option.dataset.value!);
    delete option.dataset.mousedown;
  });

  // 仅当观察到完整 mousedown 序列时标记，供 click 处理器校验
  const trackMousedown = (event: Event): void => {
    const option = (event.target as HTMLElement).closest?.('.el-select-dropdown__item') as HTMLElement | null;
    if (option) option.dataset.mousedown = '1';
  };
  document.addEventListener('mousedown', trackMousedown);

  sideSearch.addEventListener('input', () => {
    // 旁路搜索只过滤自己的列表，永远不写 form.appId
    sideSearch.dataset.lastQuery = sideSearch.value;
  });

  closeDropdown();
  renderTags();

  return {
    root,
    state,
    filterInput,
    readonlyDisplay,
    sideSearch,
    popper,
    getOption: (label) => list.querySelector(`.el-select-dropdown__item[data-value="${CSS.escape(label)}"]`),
    getTag: (label) => tags.querySelector(`.el-tag[data-value="${CSS.escape(label)}"]`),
  };
}

function dumpElements(snapshot: { elements: unknown[] }): string {
  return JSON.stringify(
    snapshot.elements.map((el) => {
      const item = el as { elementId: string; text: string; label: string; role: string; readonly: boolean; type: string };
      return { id: item.elementId, text: item.text, label: item.label, role: item.role, readonly: item.readonly, type: item.type };
    }),
  );
}

function elementIdByText(snapshot: { elements: { elementId: string; text: string; label: string; role: string; readonly: boolean; type: string }[] }, match: (el: { text: string; label: string; role: string; readonly: boolean; type: string }) => boolean): string {
  const hit = snapshot.elements.find(match);
  if (!hit) throw new Error(`snapshot missing element: ${dumpElements(snapshot)}`);
  return hit.elementId;
}

describe('el-select filterable multiple integration', () => {
  let manager: PageSnapshotManager;
  let executor: PageExecutor;
  let mock: MockSelect;

  beforeEach(() => {
    document.body.innerHTML = '';
    Element.prototype.getBoundingClientRect = function stubRect(this: Element) {
      return { x: 0, y: 0, width: 120, height: 28, top: 0, left: 0, right: 120, bottom: 28, toJSON: () => ({}) } as DOMRect;
    };
    mock = mountElementMultiSelect();
    manager = new PageSnapshotManager({});
    executor = new PageExecutor(manager);
  });

  afterEach(() => {
    manager.destroy();
    document.body.innerHTML = '';
    Element.prototype.getBoundingClientRect = originalRect;
  });

  it('inspects the filter input as the editable service control, not only the readonly display', () => {
    const snapshot = manager.inspect();
    const filter = snapshot.elements.find((el) => el.label.includes('服务') && !el.readonly && el.role === 'textbox');
    const readonly = snapshot.elements.find((el) => el.readonly && el.type === 'text');

    expect(filter, dumpElements(snapshot)).toBeTruthy();
    expect(filter!.readonly).toBe(false);
    expect(filter!.label).toContain('服务');

    expect(readonly, dumpElements(snapshot)).toBeTruthy();
    expect(readonly!.readonly).toBe(true);
  });

  it('fill on the filter input keeps the dropdown open and reports rob-system suggestion', async () => {
    const snapshot = manager.inspect();
    const filterId = elementIdByText(snapshot, (el) => el.label.includes('服务') && !el.readonly);

    const fill = await executor.execute(
      { type: 'fill', elementId: filterId, value: 'rob-system' },
      { snapshotId: snapshot.snapshotId },
    );

    expect(fill.success).toBe(true);
    expect(fill.observation?.keepFocus).toBe(true);
    // 组件仅容器 mousedown 打开：fill 必须保证弹层已展开，否则线上会出现「填了关键字但没有选项」
    expect(fill.observation?.dropdownOpened).toBe(true);
    expect(fill.observation?.suggestions).toContain('rob-system');
    expect(mock.state.open).toBe(true);
    expect(mock.getOption('rob-system')).toBeTruthy();
  });

  it('completes the full select flow: fill → re-inspect → click option → observe selected tag', async () => {
    const first = manager.inspect();
    const filterId = elementIdByText(first, (el) => el.label.includes('服务') && !el.readonly);
    await executor.execute(
      { type: 'fill', elementId: filterId, value: 'rob-system' },
      { snapshotId: first.snapshotId },
    );

    // 打开/过滤后必须重新 inspect：option 是新节点
    const second = manager.inspect();
    const optionId = elementIdByText(second, (el) => el.role === 'option' && el.text === 'rob-system');

    const click = await executor.execute(
      { type: 'click', elementId: optionId },
      { snapshotId: second.snapshotId },
    );

    expect(click.success).toBe(true);
    expect(click.observation?.selected).toBe(true);
    expect(mock.state.selected).toContain('rob-system');
    expect(mock.getTag('rob-system')).toBeTruthy();
    expect(mock.state.open).toBe(true);
  });

  it('does not select when option is only clicked without mousedown sequence (legacy behavior guard)', async () => {
    // 当前 SDK 若只派发 click，组件库要求 mousedown 的场景会失败；
    // 修复后本用例改为断言完整鼠标序列可选中，因此这里单独验证组件模拟器本身。
    const first = manager.inspect();
    const filterId = elementIdByText(first, (el) => el.label.includes('服务') && !el.readonly);
    await executor.execute(
      { type: 'fill', elementId: filterId, value: 'rob-api' },
      { snapshotId: first.snapshotId },
    );
    const option = mock.getOption('rob-api')!;
    expect(option).toBeTruthy();

    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(mock.state.selected).not.toContain('rob-api');
  });

  it('fill on the side search box does not bind service selection', async () => {
    const snapshot = manager.inspect();
    const sideEl = snapshot.elements.find((el) => el.label.includes('其它搜索') || el.label === '其它搜索');
    expect(sideEl, dumpElements(snapshot)).toBeTruthy();

    const fill = await executor.execute(
      { type: 'fill', elementId: sideEl!.elementId, value: 'rob-system' },
      { snapshotId: snapshot.snapshotId },
    );
    expect(fill.success).toBe(true);
    expect(mock.state.selected).toHaveLength(0);
    expect(mock.getTag('rob-system')).toBeNull();
  });

  it('click option with a stale snapshot after dropdown re-render reports element/snapshot failure', async () => {
    const first = manager.inspect();
    const filterId = elementIdByText(first, (el) => el.label.includes('服务') && !el.readonly);
    await executor.execute(
      { type: 'fill', elementId: filterId, value: 'user' },
      { snapshotId: first.snapshotId },
    );

    const optionBefore = manager.inspect();
    const optionId = elementIdByText(optionBefore, (el) => el.role === 'option' && el.text === 'user-center');

    // 组件库重渲染 options（节点替换）
    mock.state.query = 'user';
    listRerender(mock);

    const click = await executor.execute(
      { type: 'click', elementId: optionId },
      { snapshotId: optionBefore.snapshotId },
    );
    expect(click.success).toBe(false);
    expect(['element_changed', 'element_not_available', 'snapshot_expired']).toContain(click.error!.code);
  });
});

function listRerender(mock: MockSelect): void {
  const list = mock.popper.querySelector('.el-select-dropdown__list')!;
  const current = Array.from(list.querySelectorAll('.el-select-dropdown__item'));
  for (const item of current) {
    item.replaceWith(item.cloneNode(true));
  }
}
