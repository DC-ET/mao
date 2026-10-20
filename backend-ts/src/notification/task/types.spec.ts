import { describe, expect, it } from 'vitest';
import { BusinessException } from '../../common/business-exception.js';
import { parseNotificationChannel } from './types.js';

describe('parseNotificationChannel', () => {
  it('放行 DINGTALK / FEISHU / EMAIL', () => {
    expect(parseNotificationChannel('DINGTALK')).toBe('DINGTALK');
    expect(parseNotificationChannel('FEISHU')).toBe('FEISHU');
    expect(parseNotificationChannel('EMAIL')).toBe('EMAIL');
  });

  it('大小写不敏感（DB 存量行可能大小写混杂）', () => {
    expect(parseNotificationChannel('email')).toBe('EMAIL');
    expect(parseNotificationChannel(' DingTalk ')).toBe('DINGTALK');
  });

  it('空值 / 其他值拒绝', () => {
    expect(() => parseNotificationChannel(null)).toThrow(BusinessException);
    expect(() => parseNotificationChannel('')).toThrow(BusinessException);
    expect(() => parseNotificationChannel('WECHAT')).toThrow(/DINGTALK、FEISHU 或 EMAIL/);
  });
});
