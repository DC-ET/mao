/**
 * 测试专用 SQL WHERE 求值器：在内存行上求值本项目实际生成的 WHERE 子句，
 * 避免为分组过滤/列表查询逻辑拉起真实 MySQL。
 *
 * 覆盖的子句形态（遇到未覆盖的形态直接抛错，逼测试补全而不是静默放过）：
 *   `col IS NULL` / `col = ?` / `col != ?` / `col LIKE ?` / `col NOT LIKE ?` /
 *   `col NOT IN ('a', 'b')`（字面量列表，不占参数位），以及括号与顶层 AND/OR。
 *
 * 参数绑定按「每个顶层子句各自一份」进行：子句内部的 OR/AND 短路不能影响
 * 其它子句的参数位。若用跨子句共享游标，`workspace IS NULL` 命中时后续子句
 * 会错位消费参数，把本不该命中的行误判为命中（曾导致分组一致性探针误报）。
 */

export type SqlRow = Record<string, unknown>;

/** 按顶层（括号深度 0）分隔符切分。 */
function splitTop(input: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && input.startsWith(separator, i)) {
      out.push(input.slice(start, i));
      i += separator.length - 1;
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

/** SQL LIKE 语义：% 匹配任意串，其余字符按字面量（含 .）。 */
function likeMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function parseAtom(text: string, args: unknown[], row: SqlRow): boolean {
  if (text.startsWith('(') && text.endsWith(')')) {
    return splitTop(text.slice(1, -1), ' OR ').some((part) => parseAnd(part.trim(), args, row));
  }
  const isNull = /^(\w+) IS NULL$/.exec(text);
  if (isNull) return row[isNull[1]!] == null;
  const notIn = /^(\w+) NOT IN \((.*)\)$/.exec(text);
  if (notIn) {
    const list = notIn[2]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    return !list.includes(String(row[notIn[1]!]));
  }
  const eq = /^(\w+) = \?$/.exec(text);
  if (eq) return String(row[eq[1]!]) === String(args.shift());
  const ne = /^(\w+) != \?$/.exec(text);
  if (ne) return String(row[ne[1]!]) !== String(args.shift());
  const like = /^(\w+) LIKE \?$/.exec(text);
  if (like) return likeMatch(String(row[like[1]!] ?? ''), String(args.shift()));
  const notLike = /^(\w+) NOT LIKE \?$/.exec(text);
  if (notLike) return !likeMatch(String(row[notLike[1]!] ?? ''), String(args.shift()));
  throw new Error(`unhandled SQL clause: ${text}`);
}

function parseAnd(text: string, args: unknown[], row: SqlRow): boolean {
  return splitTop(text, ' AND ').every((part) => parseAtom(part.trim(), args, row));
}

/** 单行是否满足 whereSql（params 与 whereSql 中的 ? 按顺序一一对应）。 */
export function whereMatches(whereSql: string, params: unknown[], row: SqlRow): boolean {
  const clauses = splitTop(whereSql, ' AND ').map((c) => c.trim()).filter((c) => c.length > 0);
  let offset = 0;
  for (const clause of clauses) {
    // 每个顶层子句按自身 ? 个数切一份参数：子句内短路不影响其它子句的参数位
    const size = (clause.match(/\?/g) ?? []).length;
    const args = params.slice(offset, offset + size);
    offset += size;
    if (!splitTop(clause, ' OR ').some((part) => parseAnd(part.trim(), [...args], row))) return false;
  }
  return true;
}

/** 多行过滤：等价于 `SELECT ... WHERE whereSql`。 */
export function whereFilter(whereSql: string, params: unknown[], rows: SqlRow[]): SqlRow[] {
  return rows.filter((row) => whereMatches(whereSql, params, row));
}
