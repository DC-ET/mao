export interface Result<T> {
  code: number;
  message: string;
  data?: T;
  timestamp: number;
}

export function ok<T>(data?: T): Result<T> {
  const result: Result<T> = {
    code: 0,
    message: 'success',
    timestamp: Date.now(),
  };
  if (data !== undefined && data !== null) {
    result.data = data;
  }
  return result;
}

export function fail<T = unknown>(code: number, message: string): Result<T> {
  return {
    code,
    message,
    timestamp: Date.now(),
  };
}

export function failCode<T = unknown>(errorCode: { code: number; message: string }): Result<T> {
  return fail(errorCode.code, errorCode.message);
}
