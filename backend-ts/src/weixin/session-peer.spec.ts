import { afterEach, describe, expect, it } from 'vitest';
import {
  bindWeixinSessionPeer,
  configureWeixinSessionPeerStore,
  getWeixinSessionPeer,
  resetWeixinSessionPeerForTests,
} from './session-peer.js';

describe('weixin session peer', () => {
  afterEach(() => {
    resetWeixinSessionPeerForTests();
  });

  it('returns memory binding immediately', async () => {
    bindWeixinSessionPeer(11, 'wx-1');
    expect(await getWeixinSessionPeer(11)).toBe('wx-1');
  });

  it('loads from store after process-local cache miss', async () => {
    configureWeixinSessionPeerStore({
      save: async () => undefined,
      load: async (sessionId) => sessionId === 11 ? 'wx-persisted' : undefined,
    });
    expect(await getWeixinSessionPeer(11)).toBe('wx-persisted');
    expect(await getWeixinSessionPeer(11)).toBe('wx-persisted');
  });

  it('ignores empty wxUserId', async () => {
    bindWeixinSessionPeer(11, '');
    bindWeixinSessionPeer(11, undefined);
    expect(await getWeixinSessionPeer(11)).toBeUndefined();
  });
});
