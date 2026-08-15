import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fastifyLoggerOptions,
  installStructuredConsole,
  restoreConsoleForTests,
  StructuredNestLogger,
  writeStructuredLog,
} from './structured-logger.js';

afterEach(() => {
  restoreConsoleForTests();
  vi.restoreAllMocks();
});

describe('structured logger', () => {
  it('writes one JSON line with an ISO time and uppercase level', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    writeStructuredLog('info', 'started', { module: 'test' }, { port: 9080 });

    expect(write).toHaveBeenCalledOnce();
    const output = String(write.mock.calls[0]?.[0]);
    expect(output.endsWith('\n')).toBe(true);
    expect(output.slice(0, -1)).not.toContain('\n');
    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record.level).toBe('INFO');
    expect(record.module).toBe('test');
    expect(record.message).toBe('started { port: 9080 }');
    expect(record.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(String(record.time)))).toBe(false);
  });

  it('adapts console errors to structured stderr output', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    installStructuredConsole();

    console.error('request failed', 503);

    const record = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record.level).toBe('ERROR');
    expect(record.message).toBe('request failed 503');
  });

  it('serializes Nest errors with context', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    new StructuredNestLogger().error('bootstrap failed', new Error('boom'), 'NestFactory');

    const record = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record.module).toBe('nest');
    expect(record.context).toBe('NestFactory');
    expect(record.error).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('configures Fastify timestamps as ISO strings and levels as uppercase', () => {
    expect(fastifyLoggerOptions.messageKey).toBe('message');
    expect(fastifyLoggerOptions.timestamp?.()).toMatch(/^,"time":"\d{4}-\d{2}-\d{2}T.*Z"$/);
    expect(fastifyLoggerOptions.formatters?.level?.('info', 30)).toEqual({ level: 'INFO' });
  });
});
