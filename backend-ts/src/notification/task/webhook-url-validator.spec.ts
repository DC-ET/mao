import { describe, expect, it } from 'vitest';
import { BusinessException } from '../../common/business-exception.js';
import { WebhookUrlValidator } from './webhook-url-validator.js';

describe('WebhookUrlValidator', () => {
  const validator = new WebhookUrlValidator();

  it('acceptsSupportedWebhookUrls', () => {
    expect(validator.validate('DINGTALK', 'https://oapi.dingtalk.com/robot/send?access_token=abc'))
      .toBe('https://oapi.dingtalk.com/robot/send?access_token=abc');
    expect(validator.validate('FEISHU', 'https://open.feishu.cn/open-apis/bot/v2/hook/abc'))
      .toBe('https://open.feishu.cn/open-apis/bot/v2/hook/abc');
  });

  it('rejectsSsrfAndChannelMismatch', () => {
    expect(() => validator.validate('DINGTALK', 'http://oapi.dingtalk.com/robot/send?access_token=abc')).toThrow(BusinessException);
    expect(() => validator.validate('DINGTALK', 'https://oapi.dingtalk.com.evil.test/robot/send?access_token=abc')).toThrow(BusinessException);
    expect(() => validator.validate('FEISHU', 'https://oapi.dingtalk.com/robot/send?access_token=abc')).toThrow(BusinessException);
    expect(() => validator.validate('FEISHU', 'https://127.0.0.1/open-apis/bot/v2/hook/abc')).toThrow(BusinessException);
  });
});
