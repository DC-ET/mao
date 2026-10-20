import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import RootApp from './RootApp.vue';
import { createUiState } from '../controller';
import type { MaoChatInitOptions } from '../types';
import type { PageHighlightTarget } from '../page';

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

function mountRoot(pageEnabled: boolean) {
  const ui = createUiState({
    serverUrl: 'https://mao.example.com',
    agentId: 1,
    getToken: () => Promise.resolve('tok'),
    page: { enabled: pageEnabled },
  } as MaoChatInitOptions);
  ui.panelOpen = true;
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({ render: () => h(RootApp, { ui }) });
  app.mount(el);
  return ui;
}

const target: PageHighlightTarget = {
  elementId: 'e1',
  label: '保存',
  rect: { x: 1, y: 2, width: 3, height: 4 },
};

describe('RootApp 页面能力开关', () => {
  it('pageEnabled=true 时渲染授权入口，高亮目标存在时渲染高亮框', async () => {
    const ui = mountRoot(true);
    await nextTick();
    expect(el.querySelector('.mao-auth__badge')).not.toBeNull();
    ui.pageHighlight = target;
    await nextTick();
    expect(el.querySelector('.mao-page-highlight')).not.toBeNull();
  });

  it('pageEnabled=false 时不渲染授权入口，高亮目标存在也不渲染高亮框', async () => {
    const ui = mountRoot(false);
    await nextTick();
    expect(el.querySelector('.mao-auth__badge')).toBeNull();
    ui.pageHighlight = target;
    await nextTick();
    expect(el.querySelector('.mao-page-highlight')).toBeNull();
  });
});
