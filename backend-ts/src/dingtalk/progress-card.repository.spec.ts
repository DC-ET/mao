import { describe, expect, it } from 'vitest';
import { mapProgressCardRow } from './progress-card.repository.js';

describe('mapProgressCardRow', () => {
  it('finds a card by outTrackId fields from either camel or snake case', () => {
    expect(mapProgressCardRow({
      session_id: 9, bot_id: 2, out_track_id: 'track-9', chat_type: 'p2p', conversation_id: 'cid', sender_userid: 'staff',
    })).toEqual({
      sessionId: 9, botId: 2, outTrackId: 'track-9', chatType: 'p2p', conversationId: 'cid', senderUserid: 'staff',
    });
  });
});
