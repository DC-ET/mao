import { describe, expect, it } from 'vitest';
import { ProbeValueError, computeValueHash, extractJsonPath } from './watcher.logic.js';

/**
 * BUG：`extractJsonPath` 用 `in` 运算符判定路径段是否存在，`in` 会命中原型链成员。
 *
 * 期望行为（watcher.logic.ts 文件头契约）：「任一段缺失、越界、取到 undefined/null
 * 均抛 ProbeValueError（不静默取空串——空串会让『字段消失』看起来像一次正常变化）」。
 * JSON.parse 出来的对象原型是 Object.prototype，`'toString' in {}` 为 true，
 * 因此路径段 `toString` / `constructor` / `valueOf` / `hasOwnProperty` 等会被当成
 * 「存在」而取到原型上的函数，最终 `normalizeExtractedValue` 交给
 * `JSON.stringify(function)` → undefined → `?? ''` → 空串，哈希退化成 sha256('')。
 *
 * 实际行为：不抛错、静默按空串建立基线——JSON_FIELD 哨兵配了这类路径时永远不失败
 * （不计连败、不会自动停用）也永远不触发，轮询记录一片正常，与「字段消失」无法区分。
 * 正确判定应使用自有属性（`Object.prototype.hasOwnProperty.call`）。
 */
describe('BUG：extractJsonPath 命中原型链成员而非抛 ProbeValueError', () => {
  it('对象没有自有属性 toString，必须抛 ProbeValueError（当前返回 Object.prototype.toString）', () => {
    const root = JSON.parse('{"a":1}');
    expect(() => extractJsonPath(root, 'toString')).toThrow(ProbeValueError);
  });

  it('constructor / valueOf / hasOwnProperty / isPrototypeOf / __proto__ 同样按「段不存在」处理', () => {
    const root = JSON.parse('{}');
    for (const segment of ['constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__', 'toLocaleString']) {
      expect(() => extractJsonPath(root, segment), `路径段 ${segment} 不是自有属性，应抛 ProbeValueError`).toThrow(ProbeValueError);
    }
  });

  it('嵌套路径的中间段命中原型链同样抛错（data.constructor）', () => {
    const root = JSON.parse('{"data":{"v":1}}');
    expect(() => extractJsonPath(root, 'data.constructor')).toThrow(ProbeValueError);
  });

  it('computeValueHash(JSON_FIELD) 对原型链路径必须抛错，不能静默算出 sha256("")', () => {
    const body = JSON.stringify({ a: 1 });
    expect(() => computeValueHash({
      compareMode: 'JSON_FIELD', httpStatus: 200, bodyBytes: null, body, jsonPath: 'toString',
    })).toThrow(ProbeValueError);
  });

  it('hash 不得退化为 sha256("")：原型链路径与「取到空串」必须可区分', () => {
    // 若按空串计价，'toString' 路径与一个真的返回空串的字段拿到同一个哈希，
    // 「字段消失」被伪装成一次正常取值——正是文件头注释要避免的情况。
    const body = JSON.stringify({ a: 1 });
    let hashForProtoPath: string | null = null;
    try {
      hashForProtoPath = computeValueHash({
        compareMode: 'JSON_FIELD', httpStatus: 200, bodyBytes: null, body, jsonPath: 'toString',
      });
    } catch {
      hashForProtoPath = null;
    }
    expect(hashForProtoPath, '原型链路径必须抛错，而不是返回 sha256("")').toBeNull();
  });

  it('真实自有属性仍正常取值（修复不得误伤）', () => {
    const root = JSON.parse('{"data":{"items":[{"price":10}]}}');
    expect(extractJsonPath(root, 'data.items.0.price')).toBe(10);
    expect(extractJsonPath(root, 'data')).toEqual({ items: [{ price: 10 }] });
  });
});
