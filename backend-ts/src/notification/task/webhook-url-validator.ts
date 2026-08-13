import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import type { NotificationChannel } from './types.js';

export class WebhookUrlValidator {
  validate(channel: NotificationChannel, rawUrl: string | null | undefined): string {
    if (rawUrl == null || rawUrl.trim() === '') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Webhook 地址不能为空');
    }
    try {
      const uri = new URL(rawUrl.trim());
      if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash) {
        throw this.invalid();
      }
      if (channel === 'DINGTALK') {
        if (uri.hostname.toLowerCase() !== 'oapi.dingtalk.com'
          || uri.pathname !== '/robot/send'
          || this.queryValue(uri.search.slice(1), 'access_token') == null) {
          throw this.invalid();
        }
      } else if (uri.hostname.toLowerCase() !== 'open.feishu.cn'
        || uri.pathname == null
        || !/^\/open-apis\/bot\/v2\/hook\/[^/]+$/.test(uri.pathname)
        || uri.search) {
        throw this.invalid();
      }
      return uri.href;
    } catch (e) {
      if (e instanceof BusinessException) {
        throw e;
      }
      throw this.invalid();
    }
  }

  mask(rawUrl: string): string {
    try {
      const uri = new URL(rawUrl);
      const value = rawUrl;
      const keep = Math.min(4, Math.max(0, value.length - value.lastIndexOf('/') - 1));
      const suffix = keep > 0 ? value.slice(value.length - keep) : '';
      if (uri.hostname.toLowerCase() === 'oapi.dingtalk.com') {
        return `https://oapi.dingtalk.com/robot/send?access_token=****${suffix}`;
      }
      return `https://open.feishu.cn/open-apis/bot/v2/hook/****${suffix}`;
    } catch {
      return '****';
    }
  }

  private queryValue(query: string, key: string): string | null {
    if (!query) {
      return null;
    }
    for (const part of query.split('&')) {
      const separator = part.indexOf('=');
      if (separator > 0 && key === part.slice(0, separator) && separator < part.length - 1) {
        return part.slice(separator + 1);
      }
    }
    return null;
  }

  private invalid(): BusinessException {
    return new BusinessException(ErrorCode.PARAM_INVALID, 'Webhook 地址与所选通知渠道不匹配');
  }
}
