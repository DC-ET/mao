import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedController, createUiState } from './controller';
import type { MaoChatInitOptions } from './types';
import { SessionManager } from './core/session-manager';

const controllers: EmbedController[] = [];
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.destroy());
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  let user = 1;
  const options: MaoChatInitOptions = { serverUrl: 'https://mao.example.test', agentId: 9, auth: { type: 'company-sso', getSsoToken: async () => 'synthetic', checkUrl: 'https://app.example.test/check' } };
  const ui = createUiState(options);
  const controller = new EmbedController(options, ui, vi.fn(), vi.fn());
  controllers.push(controller);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {
    accessToken: `mao-${user}`, expiresIn: 300, expiresAt: Date.now() + 300000, refreshAfter: 100, user: { id: user, displayName: 'Test' },
  } })));
  vi.stubGlobal('fetch', fetcher);
  // Drive real controller callbacks without opening network sockets or reaching a real SSO.
  const internals = controller as unknown as {
    tokens: { get(): Promise<string>; resume(): void };
    rest: { request(method: 'GET', path: string): Promise<unknown> };
    ws: { disconnect(): void; refreshAuth(token: string, expiresAt: number): Promise<void> };
  };
  return { controller, ui, internals, fetcher, switchUser: () => { user = 2; } };
}

describe('embed SSO controller identity lifecycle', () => {
  it('clears old account messages, questions, and draft identity on account switch', async () => {
    const { controller, ui, internals, switchUser } = setup();
    await internals.tokens.get();
    controller.store.bindSession(11);
    controller.store.appendLocalUserMessage('old private content');
    ui.messages = controller.store.messages.value;
    ui.quotedSelection = 'old quote';
    ui.pendingQuestion = { requestId: 'old', questions: [] };
    const disconnect = vi.spyOn(internals.ws, 'disconnect');
    switchUser(); internals.tokens.resume();
    await internals.tokens.get();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(controller.store.sessionId()).toBeNull();
    expect(ui.messages).toEqual([]);
    expect(ui.pendingQuestion).toBeNull();
    expect(ui.quotedSelection).toBeNull();
    expect(ui.identityVersion).toBe(1); // Composer is keyed by this identity version.
  });

  it('renews same identity through WS update without clearing active conversation', async () => {
    const { controller, internals } = setup();
    await internals.tokens.get();
    controller.store.bindSession(11);
    controller.store.appendLocalUserMessage('keep conversation');
    const refresh = vi.spyOn(internals.ws, 'refreshAuth').mockResolvedValue();
    const disconnect = vi.spyOn(internals.ws, 'disconnect');
    internals.tokens.resume(); await internals.tokens.get();
    expect(refresh).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    expect(controller.store.sessionId()).toBe(11);
    expect(controller.store.messages.value[0].content).toBe('keep conversation');
  });

  it('rejects an old-account REST body that finishes after identity switches', async () => {
    const { internals, fetcher, switchUser } = setup();
    await internals.tokens.get();
    let finishBody!: (body: string) => void;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    fetcher.mockResolvedValueOnce({ ok: true, status: 200, text: () => { reading(); return new Promise<string>((resolve) => { finishBody = resolve; }); } } as Response);
    const pending = internals.rest.request('GET', '/sessions/11/messages');
    const rejected = expect(pending).rejects.toThrow('unauthorized');
    await started;
    switchUser(); internals.tokens.resume(); await internals.tokens.get();
    finishBody('{"code":0,"data":{"private":"old account"}}');
    await rejected;
  });

  it('separates persistent session IDs by server and identity scope', () => {
    const a = new SessionManager({ rest: {} as never, agentId: 9, scope: () => 'server/user1' });
    const b = new SessionManager({ rest: {} as never, agentId: 9, scope: () => 'server/user2' });
    a.writeStoredSessionId(11);
    expect(a.readStoredSessionId()).toBe(11);
    expect(b.readStoredSessionId()).toBeNull();
  });
});
