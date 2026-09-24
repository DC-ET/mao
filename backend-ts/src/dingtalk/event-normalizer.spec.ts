import { describe, expect, it } from 'vitest';
import { isNewSessionCommand, normalizeDingtalkEvent } from './event-normalizer.js';

describe('normalizeDingtalkEvent', () => {
  it('normalizes p2p text and drops encrypted senderId', () => {
    const event = normalizeDingtalkEvent({
      conversationType: '1',
      conversationId: 'cid-p2p',
      msgId: 'm1',
      msgtype: 'text',
      senderStaffId: 'staff-1',
      senderUnionId: 'union-1',
      senderNick: '张三',
      senderId: 'encrypted-do-not-keep',
      text: { content: '  你好' },
    });
    expect(event).toMatchObject({
      chatType: 'p2p', conversationId: 'cid-p2p', messageId: 'm1', senderUserid: 'staff-1',
      senderUnionId: 'union-1', senderName: '张三', text: '你好', isInAtList: true,
    });
    expect(event).not.toHaveProperty('senderId');
    expect(JSON.stringify(event)).not.toContain('encrypted-do-not-keep');
  });

  it('trims the space after a group mention', () => {
    const event = normalizeDingtalkEvent({
      conversationType: '2', conversationId: 'cid-g', msgId: 'm2', msgtype: 'text',
      senderStaffId: 'staff-1', isInAtList: true,
      text: { content: ' @机器人 你好' },
    });
    expect(event?.chatType).toBe('group');
    expect(event?.text).toBe('你好');
    expect(event?.isInAtList).toBe(true);
  });

  it('collects rich-text image download codes', () => {
    const event = normalizeDingtalkEvent({
      conversationType: '1', conversationId: 'cid', msgId: 'm3', msgtype: 'richText',
      senderStaffId: 'staff-1',
      content: { richText: [{ text: '看图' }, { type: 'picture', downloadCode: 'dl-1' }] },
    });
    expect(event?.text).toBe('看图');
    expect(event?.downloadCodes).toEqual(['dl-1']);
  });

  it('keeps quoted text and treats a quote without body as empty', () => {
    const withBody = normalizeDingtalkEvent({
      conversationType: '1', conversationId: 'cid', msgId: 'm4', msgtype: 'text', senderStaffId: 's',
      text: { content: '基于这句', isReplyMsg: true, repliedMsg: { content: { text: '原文' } } },
    });
    expect(withBody?.quotedText).toBe('原文');
    const empty = normalizeDingtalkEvent({
      conversationType: '1', conversationId: 'cid', msgId: 'm5', msgtype: 'text', senderStaffId: 's',
      text: { content: '继续', isReplyMsg: true, repliedMsg: { content: {} } },
    });
    expect(empty?.quotedText).toBeNull();
  });

  it('reads picture and file download codes', () => {
    const picture = normalizeDingtalkEvent({
      conversationType: '2', conversationId: 'cid', msgId: 'm6', msgtype: 'picture', senderStaffId: 's', isInAtList: true,
      content: { downloadCode: 'pic' },
    });
    expect(picture?.downloadCodes).toEqual(['pic']);
    const file = normalizeDingtalkEvent({
      conversationType: '1', conversationId: 'cid', msgId: 'm7', msgtype: 'file', senderStaffId: 's',
      content: { downloadCode: 'file-code', fileName: 'a.pdf' },
    });
    expect(file?.fileName).toBe('a.pdf');
    expect(file?.downloadCodes).toEqual(['file-code']);
  });
});

describe('isNewSessionCommand', () => {
  it('accepts three or more dashes', () => {
    expect(isNewSessionCommand('---')).toBe(true);
    expect(isNewSessionCommand('  ——— ')).toBe(true);
    expect(isNewSessionCommand('--')).toBe(false);
    expect(isNewSessionCommand('--- 好')).toBe(false);
  });
});
