export function harnessLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]): void {
  const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
  fn(`[harness] ${message}`, ...args);
}
