import { writeStructuredLog, type LogLevel } from '../common/structured-logger.js';

export function harnessLog(level: LogLevel, message: string, ...args: unknown[]): void {
  writeStructuredLog(level, message, { module: 'harness' }, ...args);
}
