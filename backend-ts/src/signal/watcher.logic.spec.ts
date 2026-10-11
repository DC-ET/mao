import { describe, expect, it } from 'vitest';
import {
  ProbeValueError,
  buildDiff,
  computeValueHash,
  extractJsonPath,
  renderWatcherPrompt,
  valueTextForDiff,
} from './watcher.logic.js';

describe('extractJsonPath', () => {
  const root = {
    data: { items: [{ price: 10 }, { price: 20 }], name: 'widget' },
    count: 2,
    nested: { deep: { deeper: { value: 'x' } } },
  };

  it('reads nested object fields', () => {
    expect(extractJsonPath(root, 'data.name')).toBe('widget');
    expect(extractJsonPath(root, 'count')).toBe(2);
  });

  it('reads array elements by index', () => {
    expect(extractJsonPath(root, 'data.items.0.price')).toBe(10);
    expect(extractJsonPath(root, 'data.items.1.price')).toBe(20);
  });

  it('reads deeply nested values', () => {
    expect(extractJsonPath(root, 'nested.deep.deeper.value')).toBe('x');
  });

  it('throws on missing segment', () => {
    expect(() => extractJsonPath(root, 'data.missing')).toThrow(ProbeValueError);
  });

  it('throws on array index out of range', () => {
    expect(() => extractJsonPath(root, 'data.items.5.price')).toThrow(ProbeValueError);
  });

  it('throws on non-numeric array index', () => {
    expect(() => extractJsonPath(root, 'data.items.first')).toThrow(ProbeValueError);
  });

  it('throws on null or undefined leaf', () => {
    expect(() => extractJsonPath({ a: null }, 'a')).toThrow(ProbeValueError);
    expect(() => extractJsonPath({}, 'a')).toThrow(ProbeValueError);
  });

  it('throws on empty path, empty segment and over-long path', () => {
    expect(() => extractJsonPath(root, '')).toThrow(ProbeValueError);
    expect(() => extractJsonPath(root, 'data..name')).toThrow(ProbeValueError);
    const long = Array.from({ length: 20 }, () => 'a').join('.');
    expect(() => extractJsonPath(root, long)).toThrow(ProbeValueError);
  });

  it('keeps falsy but present values (0 / false / empty string)', () => {
    expect(extractJsonPath({ a: 0 }, 'a')).toBe(0);
    expect(extractJsonPath({ a: false }, 'a')).toBe(false);
    expect(extractJsonPath({ a: '' }, 'a')).toBe('');
  });
});

describe('computeValueHash', () => {
  it('HASH mode hashes raw bytes', () => {
    const bytes = Buffer.from('payload', 'utf8');
    expect(computeValueHash({
      compareMode: 'HASH', httpStatus: 200, bodyBytes: bytes, body: 'payload', jsonPath: null,
    })).toBe(computeValueHash({
      compareMode: 'HASH', httpStatus: 200, bodyBytes: bytes, body: 'other', jsonPath: null,
    }));
  });

  it('HASH mode throws when body bytes are absent', () => {
    expect(() => computeValueHash({
      compareMode: 'HASH', httpStatus: 200, bodyBytes: null, body: 'x', jsonPath: null,
    })).toThrow(ProbeValueError);
  });

  it('STATUS_CODE mode hashes the status only', () => {
    const a = computeValueHash({
      compareMode: 'STATUS_CODE', httpStatus: 200, bodyBytes: null, body: 'one', jsonPath: null,
    });
    const b = computeValueHash({
      compareMode: 'STATUS_CODE', httpStatus: 200, bodyBytes: null, body: 'two', jsonPath: null,
    });
    const c = computeValueHash({
      compareMode: 'STATUS_CODE', httpStatus: 503, bodyBytes: null, body: 'one', jsonPath: null,
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('STATUS_CODE mode throws without a status', () => {
    expect(() => computeValueHash({
      compareMode: 'STATUS_CODE', httpStatus: null, bodyBytes: null, body: null, jsonPath: null,
    })).toThrow(ProbeValueError);
  });

  it('JSON_FIELD mode hashes the extracted value, not the whole body', () => {
    const bodyA = JSON.stringify({ v: '1', noise: 'aaa' });
    const bodyB = JSON.stringify({ v: '1', noise: 'bbb' });
    const a = computeValueHash({
      compareMode: 'JSON_FIELD', httpStatus: 200, bodyBytes: Buffer.from(bodyA), body: bodyA, jsonPath: 'v',
    });
    const b = computeValueHash({
      compareMode: 'JSON_FIELD', httpStatus: 200, bodyBytes: Buffer.from(bodyB), body: bodyB, jsonPath: 'v',
    });
    expect(a).toBe(b);
  });

  it('JSON_FIELD mode throws on invalid JSON', () => {
    expect(() => computeValueHash({
      compareMode: 'JSON_FIELD', httpStatus: 200, bodyBytes: Buffer.from('nope'), body: 'nope', jsonPath: 'v',
    })).toThrow(/JSON/);
  });

  it('JSON_FIELD mode throws without a configured path', () => {
    const body = JSON.stringify({ v: 1 });
    expect(() => computeValueHash({
      compareMode: 'JSON_FIELD', httpStatus: 200, bodyBytes: Buffer.from(body), body, jsonPath: null,
    })).toThrow(ProbeValueError);
  });
});

describe('valueTextForDiff', () => {
  it('returns raw body for HASH mode', () => {
    expect(valueTextForDiff({
      compareMode: 'HASH', httpStatus: 200, bodyBytes: null, body: 'abc', jsonPath: null,
    })).toBe('abc');
  });

  it('returns the field value for JSON_FIELD mode', () => {
    const body = JSON.stringify({ v: { n: 1 } });
    expect(valueTextForDiff({
      compareMode: 'JSON_FIELD', httpStatus: 200, bodyBytes: null, body, jsonPath: 'v',
    })).toBe('{"n":1}');
  });

  it('returns the status for STATUS_CODE mode', () => {
    expect(valueTextForDiff({
      compareMode: 'STATUS_CODE', httpStatus: 503, bodyBytes: null, body: 'x', jsonPath: null,
    })).toBe('503');
  });

  it('returns empty string when JSON_FIELD extraction fails', () => {
    expect(valueTextForDiff({
      compareMode: 'JSON_FIELD', httpStatus: 200, bodyBytes: null, body: 'nope', jsonPath: 'v',
    })).toBe('');
  });
});

describe('buildDiff', () => {
  it('labels HASH mode snippets', () => {
    const diff = buildDiff({ compareMode: 'HASH', oldText: 'old', newText: 'new' });
    expect(diff).toContain('响应体前');
    expect(diff).toContain('old');
    expect(diff).toContain('new');
  });

  it('labels JSON_FIELD mode with the field path', () => {
    const diff = buildDiff({ compareMode: 'JSON_FIELD', oldText: '1', newText: '2', jsonPath: 'data.v' });
    expect(diff).toContain('data.v');
    expect(diff).toContain('旧值：1');
    expect(diff).toContain('新值：2');
  });

  it('labels STATUS_CODE mode with an arrow', () => {
    const diff = buildDiff({ compareMode: 'STATUS_CODE', oldText: '200', newText: '503' });
    expect(diff).toContain('200 → 503');
  });

  it('truncates long snippets at 500 chars', () => {
    const long = 'x'.repeat(2000);
    const diff = buildDiff({ compareMode: 'HASH', oldText: long, newText: long });
    expect(diff.length).toBeLessThan(1200);
    expect(diff).toContain('已截断');
  });
});

describe('renderWatcherPrompt', () => {
  it('substitutes all three placeholders', () => {
    const out = renderWatcherPrompt('{name} {url} {diff}', {
      name: 'watcher', url: 'https://e.com', diff: 'D',
    });
    expect(out).toBe('watcher https://e.com D');
  });

  it('does not treat $ in the template as a regex group', () => {
    const out = renderWatcherPrompt('cost $1 and $& end', {
      name: 'n', url: 'u', diff: 'd',
    });
    expect(out).toBe('cost $1 and $& end');
  });

  it('keeps literal braces other than the three placeholders', () => {
    expect(renderWatcherPrompt('{other} {url}', { name: 'n', url: 'u', diff: 'd' })).toBe('{other} u');
  });

  it('works with no placeholders at all', () => {
    expect(renderWatcherPrompt('ping', { name: 'n', url: 'u', diff: 'd' })).toBe('ping');
  });

  it('truncates the rendered result beyond the message cap', () => {
    const out = renderWatcherPrompt('{diff}', { name: 'n', url: 'u', diff: 'y'.repeat(40000) });
    expect(out.length).toBeLessThanOrEqual(32000 + 10);
    expect(out).toContain('已截断');
  });
});
