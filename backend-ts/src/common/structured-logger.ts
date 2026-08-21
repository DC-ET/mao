import type { LoggerService } from '@nestjs/common';
import type { PinoLoggerOptions } from 'fastify/types/logger.js';
import { inspect } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  module?: string;
  context?: string;
  error?: unknown;
  [key: string]: unknown;
}

const originalConsole = {
  debug: console.debug.bind(console),
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let consoleInstalled = false;

const LOG_TIME_ZONE = 'Asia/Shanghai';

const logTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: LOG_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
});

export function formatLogTime(date: Date = new Date()): string {
  const parts = Object.fromEntries(logTimeFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}+08:00`;
}

export function writeStructuredLog(level: LogLevel, message: unknown, fields: LogFields = {}, ...args: unknown[]): void {
  const record: Record<string, unknown> = {
    time: formatLogTime(),
    level: level.toUpperCase(),
    message: formatMessage(message, args),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = normalize(value);
  }
  const line = `${JSON.stringify(record)}\n`;
  if (level === 'warn' || level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

export function installStructuredConsole(): void {
  if (consoleInstalled) return;
  consoleInstalled = true;
  console.debug = (message?: unknown, ...args: unknown[]) => writeStructuredLog('debug', message, {}, ...args);
  console.log = (message?: unknown, ...args: unknown[]) => writeStructuredLog('info', message, {}, ...args);
  console.info = (message?: unknown, ...args: unknown[]) => writeStructuredLog('info', message, {}, ...args);
  console.warn = (message?: unknown, ...args: unknown[]) => writeStructuredLog('warn', message, {}, ...args);
  console.error = (message?: unknown, ...args: unknown[]) => writeStructuredLog('error', message, {}, ...args);
}

export function restoreConsoleForTests(): void {
  console.debug = originalConsole.debug;
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  consoleInstalled = false;
}

export class StructuredNestLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    const params = [...optionalParams];
    const context = typeof params.at(-1) === 'string' ? String(params.pop()) : undefined;
    const error = params.find((value) => value instanceof Error);
    writeStructuredLog(level, message, { module: 'nest', context, error }, ...params.filter((value) => value !== error));
  }
}

export const fastifyLoggerOptions: PinoLoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  messageKey: 'message',
  timestamp: () => `,"time":"${formatLogTime()}"`,
  formatters: {
    level(label: string) {
      return { level: label.toUpperCase() };
    },
  },
};

function formatMessage(message: unknown, args: unknown[]): string {
  return [message, ...args]
    .filter((value) => value !== undefined)
    .map((value) => typeof value === 'string' ? value : value instanceof Error ? value.message : inspect(value, { depth: 5, breakLength: Infinity }))
    .join(' ');
}

function normalize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause == null ? undefined : normalize(value.cause),
    };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}
