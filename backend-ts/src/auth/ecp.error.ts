import { BusinessException } from '../common/business-exception.js';

export class EcpError extends BusinessException {
  constructor(message: string, code = 5002) {
    super(code, message);
  }
}

export function assertEcpEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new EcpError('ECP 登录未启用');
  }
}

export function assertEcpDisabled(enabled: boolean): void {
  if (enabled) {
    throw new BusinessException(403, '已启用 ECP 登录，请使用飞书登录');
  }
}
