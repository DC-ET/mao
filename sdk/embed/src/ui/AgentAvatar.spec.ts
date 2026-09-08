import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createUiState } from '../controller';
import RootApp from './RootApp.vue';

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

describe('Agent avatar', () => {
  it('入口和面板使用同一头像，移除后恢复原有 AssistantMark 并保留运行提示', async () => {
    const ui = createUiState({ serverUrl: 'https://mao.example.com', agentId: 3, getToken: async () => '' });
    ui.panelOpen = true;
    ui.phase = 'RUNNING';
    ui.unread = 1;
    ui.sessionTitle = '客服助手';
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp({ render: () => h(RootApp, { ui }) });
    app.mount(el);
    expect(el.querySelector('.mao-panel__title')?.textContent).toBe('客服助手');
    expect(el.querySelector('.mao-panel')?.getAttribute('aria-label')).toBe('客服助手对话');
    expect(el.querySelector('.mao-launcher')?.getAttribute('aria-label')).toBe('客服助手，正在处理');
    expect(el.querySelector<HTMLTextAreaElement>('.mao-composer__input')?.disabled).toBe(false);
    expect(el.querySelector('.mao-composer__stop')).not.toBeNull();
    expect(el.querySelectorAll('.mao-assistant-mark')).toHaveLength(2);
    expect(el.querySelectorAll('.mao-agent-avatar')).toHaveLength(0);

    ui.agentAvatarUrl = 'https://mao.example.com/uploads/agents/3.png';
    await nextTick();
    expect(el.querySelectorAll('.mao-assistant-mark')).toHaveLength(0);
    const images = el.querySelectorAll<HTMLImageElement>('.mao-agent-avatar');
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.src).toBe(ui.agentAvatarUrl);
      expect(image.alt).toBe('');
    }
    expect(el.querySelector('.mao-launcher__spinner')).not.toBeNull();
    expect(el.querySelector('.mao-launcher__dot')).not.toBeNull();

    ui.agentAvatarUrl = null;
    await nextTick();
    expect(el.querySelectorAll('.mao-assistant-mark')).toHaveLength(2);
    expect(el.querySelectorAll('.mao-agent-avatar')).toHaveLength(0);
  });
});
