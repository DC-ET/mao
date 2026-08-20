import { redactJson, redactString } from './redact';

export interface Logger {
  debug(message: string, extra?: unknown): void;
  warn(message: string): void;
  info(message: string): void;
}

export function createLogger(debugEnabled: boolean): Logger {
  return {
    debug(message: string, extra?: unknown): void {
      if (!debugEnabled) return;
      const suffix = extra === undefined ? '' : ` ${typeof extra === 'string' ? redactString(extra) : redactJson(extra)}`;
      process.stderr.write(`[debug] ${redactString(message)}${suffix}\n`);
    },
    warn(message: string): void {
      process.stderr.write(`${redactString(message)}\n`);
    },
    info(message: string): void {
      process.stderr.write(`${redactString(message)}\n`);
    },
  };
}
