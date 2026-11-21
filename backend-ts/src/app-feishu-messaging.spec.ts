import { describe, expect, it } from 'vitest';
import { feishuSessionTitleOf } from './app-feishu-messaging.js';

describe('feishuSessionTitleOf', () => {
  it('keeps the pending default title for group /new sessions instead of the group name (D6)', () => {
    expect(feishuSessionTitleOf({ pendingTitle: true, isGroup: true, isThread: false, groupTitle: '项目群' })).toBe('飞书Bot会话');
  });

  it('uses the group name for normal non-thread group sessions, falling back to the default when empty', () => {
    expect(feishuSessionTitleOf({ isGroup: true, isThread: false, groupTitle: '项目群' })).toBe('项目群');
    expect(feishuSessionTitleOf({ isGroup: true, isThread: false, groupTitle: '' })).toBe('飞书Bot会话');
  });

  it('uses the default title for threads and p2p regardless', () => {
    expect(feishuSessionTitleOf({ isGroup: true, isThread: true, groupTitle: '项目群' })).toBe('飞书Bot会话');
    expect(feishuSessionTitleOf({ isGroup: false, isThread: false, groupTitle: '项目群' })).toBe('飞书Bot会话');
  });
});
