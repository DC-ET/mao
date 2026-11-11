/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { getToolResultView, setToolResultView, toCsv, tryParseTable } from './tool-result-table'

describe('tryParseTable 扁平对象数组', () => {
  it('基础：行列正确、键序 = 首元素键序', () => {
    const rows = tryParseTable(JSON.stringify([
      { name: 'a', count: 1 },
      { name: 'b', count: 2, done: true },
    ]))
    expect(rows).toEqual([
      ['name', 'count', 'done'],
      ['a', '1', ''],
      ['b', '2', 'true'],
    ])
  })

  it('缺失键填空串；null 保留字面量；number 走 String', () => {
    const rows = tryParseTable(JSON.stringify([
      { id: 1, note: null },
      { id: 2, note: 'x', extra: 0.5 },
    ]))
    expect(rows).toEqual([
      ['id', 'note', 'extra'],
      ['1', 'null', ''],
      ['2', 'x', '0.5'],
    ])
  })

  it('字符串值中的逗号/换行原样保留（转义是 toCsv 的职责）', () => {
    const rows = tryParseTable(JSON.stringify([{ text: 'a,b\nc' }]))
    expect(rows).toEqual([['text'], ['a,b\nc']])
  })
})

describe('tryParseTable 包裹对象（唯一数组字段，不限键名）', () => {
  it('task_list 实际形态：{todos:[…], progress, hint} 命中', () => {
    const rows = tryParseTable(JSON.stringify({
      todos: [
        { id: '1', content: '设计', status: 'completed' },
        { id: '2', content: '开发', status: 'in_progress' },
      ],
      progress: '已完成 1/2，进行中 1',
      hint: '继续推进',
    }))
    expect(rows).toEqual([
      ['id', 'content', 'status'],
      ['1', '设计', 'completed'],
      ['2', '开发', 'in_progress'],
    ])
  })

  it('常见包裹键 {records:[…], total} 命中', () => {
    const rows = tryParseTable(JSON.stringify({ records: [{ k: 'v' }], total: 3 }))
    expect(rows).toEqual([['k'], ['v']])
  })

  it('带第二个数组字段 → null（歧义形态）', () => {
    expect(tryParseTable(JSON.stringify({ records: [{ k: 1 }], tags: ['a'] }))).toBeNull()
  })

  it('其余字段含嵌套对象 → null', () => {
    expect(tryParseTable(JSON.stringify({ items: [{ k: 1 }], page: { no: 1 } }))).toBeNull()
  })

  it('只有标量没有数组字段 → null', () => {
    expect(tryParseTable(JSON.stringify({ total: 3, ok: true }))).toBeNull()
  })

  it('包裹对象内数组为空 → null', () => {
    expect(tryParseTable(JSON.stringify({ records: [], total: 0 }))).toBeNull()
  })
})

describe('tryParseTable 拒绝形态', () => {
  it('空数组 → null', () => {
    expect(tryParseTable('[]')).toBeNull()
  })

  it('元素含嵌套值（对象/数组）→ null，整表拒绝而非部分渲染', () => {
    expect(tryParseTable(JSON.stringify([{ ok: 1 }, { nested: { a: 1 } }]))).toBeNull()
    expect(tryParseTable(JSON.stringify([{ ok: 1 }, { list: [1, 2] }]))).toBeNull()
  })

  it('元素为标量（非对象）→ null', () => {
    expect(tryParseTable(JSON.stringify([1, 2, 3]))).toBeNull()
    expect(tryParseTable(JSON.stringify(['a']))).toBeNull()
  })

  it('JSON.parse 失败 → null', () => {
    expect(tryParseTable('[{broken]')).toBeNull()
  })

  it('非 JSON 开头（shell 输出等纯文本）→ null', () => {
    expect(tryParseTable('total 3\ndrwxr-xr-x foo')).toBeNull()
    expect(tryParseTable('')).toBeNull()
    expect(tryParseTable('  ')).toBeNull()
  })

  it('顶层标量 / 顶层数值 → null', () => {
    expect(tryParseTable('"text"')).toBeNull()
    expect(tryParseTable('42')).toBeNull()
    expect(tryParseTable('null')).toBeNull()
  })

  it('带前导/尾随空白的 JSON：trim 后命中', () => {
    const rows = tryParseTable('  \n[{"k":"v"}]\n  ')
    expect(rows).toEqual([['k'], ['v']])
  })

  it('包裹对象标量兄弟字段在数组之前（list_signal_watchers 实际形态）→ 命中', () => {
    const rows = tryParseTable(JSON.stringify({ total: 2, watchers: [{ id: 'w1' }, { id: 'w2' }] }))
    expect(rows).toEqual([['id'], ['w1'], ['w2']])
  })

  it('[{}]（元素无任何键）→ null', () => {
    expect(tryParseTable('[{}]')).toBeNull()
  })
})

describe('tryParseTable 规模上限', () => {
  const oneRow = { a: 1, b: 2 }

  it('201 数据行（+表头 202）→ null；恰好 200 数据行 → 通过', () => {
    const tooMany = tryParseTable(JSON.stringify(Array.from({ length: 201 }, () => oneRow)))
    expect(tooMany).toBeNull()
    const atLimit = tryParseTable(JSON.stringify(Array.from({ length: 200 }, () => oneRow)))
    expect(atLimit).not.toBeNull()
    expect(atLimit).toHaveLength(201)
  })

  it('31 列 → null；恰好 30 列 → 通过', () => {
    const keysOf = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`)
    const wide31 = tryParseTable(JSON.stringify([{ ...Object.fromEntries(keysOf(31).map((k) => [k, 1])) }]))
    expect(wide31).toBeNull()
    const wide30 = tryParseTable(JSON.stringify([{ ...Object.fromEntries(keysOf(30).map((k) => [k, 1])) }]))
    expect(wide30).not.toBeNull()
    expect(wide30![0]).toHaveLength(30)
  })

  it('超过 1MB 文本 → null（长度预判，零解析）', () => {
    const big = JSON.stringify([{ a: 'x'.repeat(1_100_000) }])
    expect(big.length).toBeGreaterThan(1_000_000)
    expect(tryParseTable(big)).toBeNull()
  })

  it('恰好 1,000,000 字符（trim 后）→ 放行', () => {
    const pad = 'x'.repeat(1_000_000 - '[{"a":""}]'.length)
    const exact = JSON.stringify([{ a: pad }])
    expect(exact.length).toBe(1_000_000)
    expect(tryParseTable(exact)).not.toBeNull()
  })
})

describe('toCsv（RFC 4180）', () => {
  it('正常字段原样、逗号分隔、\\r\\n 行结尾', () => {
    expect(toCsv([['h1', 'h2'], ['a', 'b']])).toBe('h1,h2\r\na,b')
  })

  it('字段含逗号 → 双引号包裹', () => {
    expect(toCsv([['a,b']])).toBe('"a,b"')
  })

  it('字段含引号 → 包裹 + 引号翻倍', () => {
    expect(toCsv([['he said "hi"']])).toBe('"he said ""hi"""')
  })

  it('字段含换行 → 包裹，内部换行原样', () => {
    expect(toCsv([['line1\nline2'], ['x']])).toBe('"line1\nline2"\r\nx')
    expect(toCsv([['a\rb']])).toBe('"a\rb"')
  })

  it('三者混合转义；空数组 → 空串', () => {
    // a,"b"\nc → 包裹 + 引号翻倍："a,""b""\nc"
    expect(toCsv([['a,"b"\nc', 'plain']])).toBe('"a,""b""\nc",plain')
    expect(toCsv([])).toBe('')
  })
})

describe('视图偏好读写（localStorage）', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('缺省原文；set table 后 get 回 table；set text 移除键回落原文', () => {
    expect(getToolResultView('task_list')).toBe('text')
    setToolResultView('task_list', 'table')
    expect(getToolResultView('task_list')).toBe('table')
    expect(window.localStorage.getItem('aw-tool-result-view.task_list')).toBe('table')
    setToolResultView('task_list', 'text')
    expect(getToolResultView('task_list')).toBe('text')
    expect(window.localStorage.getItem('aw-tool-result-view.task_list')).toBeNull()
  })

  it('按工具名隔离：set 只影响该工具', () => {
    setToolResultView('task_list', 'table')
    expect(getToolResultView('list_scheduled_tasks')).toBe('text')
    expect(getToolResultView('task_list')).toBe('table')
  })
})
