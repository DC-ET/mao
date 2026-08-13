import type { ErrorCodeDef } from './error-code.js';

export class BusinessException extends Error {
  readonly code: number;

  constructor(errorCodeOrCode: ErrorCodeDef | number, message?: string) {
    if (typeof errorCodeOrCode === 'number') {
      super(message ?? '');
      this.code = errorCodeOrCode;
    } else {
      super(message ?? errorCodeOrCode.message);
      this.code = errorCodeOrCode.code;
    }
    this.name = 'BusinessException';
  }
}
