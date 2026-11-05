import { describe, expect, it } from 'vitest'
import { buildEditDiff } from './toolDiff'

/** 把 blocks 摊平成 [type, text] 列表，便于断言（gap 记为 ['gap', count]）。 */
function flatten(diff: ReturnType<typeof buildEditDiff>): Array<[string, string | number]> {
  const out: Array<[string, string | number]> = []
  for (const block of diff.blocks) {
    if (block.kind === 'gap') out.push(['gap', block.count])
    else for (const line of block.lines) out.push([line.type, line.text])
  }
  return out
}

describe('buildEditDiff', () => {
  it('纯新增：old 为空时全部为 add', () => {
    const diff = buildEditDiff('', 'x\ny')
    expect(flatten(diff)).toEqual([['add', 'x'], ['add', 'y']])
    expect(diff.added).toBe(2)
    expect(diff.deleted).toBe(0)
  })

  it('纯删除：new 为空时全部为 del', () => {
    const diff = buildEditDiff('a\nb', '')
    expect(flatten(diff)).toEqual([['del', 'a'], ['del', 'b']])
    expect(diff.added).toBe(0)
    expect(diff.deleted).toBe(2)
  })

  it('中间修改：变化行前后各保留 3 行上下文', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
    const diff = buildEditDiff(old, ['a', 'b', 'c', 'D', 'e', 'f', 'g'].join('\n'))
    // 变化块是「del d + add D」：上下文从块首尾各延 3 行，7 行文件全亮相、无 gap
    expect(flatten(diff)).toEqual([
      ['context', 'a'], ['context', 'b'], ['context', 'c'],
      ['del', 'd'], ['add', 'D'],
      ['context', 'e'], ['context', 'f'], ['context', 'g'],
    ])
    expect(diff.added).toBe(1)
    expect(diff.deleted).toBe(1)
  })

  it('多 hunk 折叠：相距远的两处修改拆成两个 hunk，中间折叠为 gap', () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`)
    lines[2] = 'X2'
    lines[17] = 'X17'
    const diff = buildEditDiff(old, lines.join('\n'))
    const flat = flatten(diff)
    // 第一个 hunk：l0,l1,del l2,add X2,后接 3 行上下文 l3,l4,l5
    expect(flat.slice(0, 7)).toEqual([
      ['context', 'l0'], ['context', 'l1'],
      ['del', 'l2'], ['add', 'X2'],
      ['context', 'l3'], ['context', 'l4'], ['context', 'l5'],
    ])
    // gap 折叠掉 l6..l13 共 8 行
    expect(flat[7]).toEqual(['gap', 8])
    // 第二个 hunk：前接 3 行上下文 l14,l15,l16,del l17,add X17,l18,l19
    expect(flat.slice(8)).toEqual([
      ['context', 'l14'], ['context', 'l15'], ['context', 'l16'],
      ['del', 'l17'], ['add', 'X17'],
      ['context', 'l18'], ['context', 'l19'],
    ])
    expect(diff.added).toBe(2)
    expect(diff.deleted).toBe(2)
  })

  it('CRLF 与末尾换行：不产生幽灵空行', () => {
    const diff = buildEditDiff('a\r\nb\r\nc', 'a\r\nB\r\nc')
    expect(flatten(diff)).toEqual([
      ['context', 'a'], ['del', 'b'], ['add', 'B'], ['context', 'c'],
    ])

    const append = buildEditDiff('a\n', 'a\nb\n')
    expect(flatten(append)).toEqual([['context', 'a'], ['add', 'b']])
  })

  it('无变化：返回空 blocks（调用方回退原始 JSON）', () => {
    const diff = buildEditDiff('a\nb', 'a\nb')
    expect(diff.blocks).toEqual([])
    expect(diff.added).toBe(0)
    expect(diff.deleted).toBe(0)
  })

  it('超大片段：超过 LCS cell 上限退化为整段替换，不卡死', () => {
    const old = Array.from({ length: 1500 }, (_, i) => `o${i}`).join('\n')
    const next = Array.from({ length: 1400 }, (_, i) => `n${i}`).join('\n')
    const diff = buildEditDiff(old, next)
    expect(diff.added).toBe(1400)
    expect(diff.deleted).toBe(1500)
    // 1500 * 1400 = 2.1M > 2M cell 上限 → 全删 + 全增，无 equal 行
    const types = new Set(flatten(diff).map(([type]) => type))
    expect(types.has('context')).toBe(false)
    expect(diff.blocks).toHaveLength(1)
  })
})
