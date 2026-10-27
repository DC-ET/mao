// archive-entries 纯函数回归（技术方案 §5.4 / §9）：zip 炸弹三道防线、
// 条目排序与展示名、点击分类、压缩率。用假中央目录数据，不依赖真实 zip 文件。
import { describe, expect, it } from 'vitest'
import {
  evaluateArchive,
  classifyArchiveEntry,
  compressionRatio,
  displayNameOf,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_TOTAL_BYTES,
  ZIP_MAX_ENTRY_BYTES,
  ZIP_TEXT_PREVIEW_MAX_BYTES,
} from './archive-entries'

function file(name: string, uncompressedSize: number, compressedSize = uncompressedSize) {
  return { name, isDirectory: false, uncompressedSize, compressedSize }
}

function dir(name: string) {
  return { name, isDirectory: true, uncompressedSize: 0, compressedSize: 0 }
}

describe('evaluateArchive 三道防线', () => {
  it('正常包：全部条目可浏览，无拒绝、无置灰', () => {
    const result = evaluateArchive([
      file('a.txt', 100, 40),
      dir('docs/'),
      file('docs/readme.md', 200, 80),
    ])
    expect(result.rejected).toBeUndefined()
    expect(result.hasTooLargeEntries).toBe(false)
    expect(result.entries).toHaveLength(3)
  })

  it('防线 1：文件条目数超 ZIP_MAX_ENTRIES → 整包拒绝', () => {
    const raw = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => file(`f${i}.txt`, 10))
    const result = evaluateArchive(raw)
    expect(result.rejected).toContain('条目过多')
    expect(result.rejected).toContain(String(ZIP_MAX_ENTRIES))
    expect(result.hasTooLargeEntries).toBe(false)
  })

  it('防线 1 边界：恰好 ZIP_MAX_ENTRIES 个文件 + 目录 → 不拒绝', () => {
    const raw = [
      ...Array.from({ length: ZIP_MAX_ENTRIES }, (_, i) => file(`f${i}.txt`, 10)),
      dir('docs/'),
    ]
    const result = evaluateArchive(raw)
    expect(result.rejected).toBeUndefined()
  })

  it('防线 2：解压合计超 ZIP_MAX_TOTAL_BYTES → 整包拒绝', () => {
    const raw = [
      file('big1.bin', ZIP_MAX_TOTAL_BYTES / 2 + 1),
      file('big2.bin', ZIP_MAX_TOTAL_BYTES / 2 + 1),
    ]
    const result = evaluateArchive(raw)
    expect(result.rejected).toContain('解压后总大小')
    expect(result.rejected).toContain('上限')
  })

  it('防线 2 边界：合计恰好等于上限 → 不拒绝', () => {
    const raw = [
      file('big1.bin', ZIP_MAX_TOTAL_BYTES / 2),
      file('big2.bin', ZIP_MAX_TOTAL_BYTES / 2),
    ]
    expect(evaluateArchive(raw).rejected).toBeUndefined()
  })

  it('防线 3：单条目超 ZIP_MAX_ENTRY_BYTES → 该条目标灰，整包仍可浏览', () => {
    const result = evaluateArchive([
      file('huge.bin', ZIP_MAX_ENTRY_BYTES + 1),
      file('small.txt', 10),
    ])
    expect(result.rejected).toBeUndefined()
    expect(result.hasTooLargeEntries).toBe(true)
    const huge = result.entries.find((e) => e.name === 'huge.bin')!
    const small = result.entries.find((e) => e.name === 'small.txt')!
    expect(huge.tooLarge).toBe(true)
    expect(small.tooLarge).toBe(false)
  })

  it('防线 3 边界：单条目恰好等于上限 → 不置灰', () => {
    const result = evaluateArchive([file('edge.bin', ZIP_MAX_ENTRY_BYTES)])
    expect(result.hasTooLargeEntries).toBe(false)
    expect(result.entries[0].tooLarge).toBe(false)
  })

  it('空包：无拒绝无条目', () => {
    const result = evaluateArchive([])
    expect(result.entries).toEqual([])
    expect(result.rejected).toBeUndefined()
    expect(result.hasTooLargeEntries).toBe(false)
  })

  it('条目按名称排序（目录与文件混排，locale 口径）', () => {
    const result = evaluateArchive([
      file('z.txt', 1),
      dir('docs/'),
      file('a.txt', 1),
      file('docs/b.md', 1),
    ])
    expect(result.entries.map((e) => e.name)).toEqual(['a.txt', 'docs/', 'docs/b.md', 'z.txt'])
  })
})

describe('displayNameOf', () => {
  it('文件取末段', () => {
    expect(displayNameOf('docs/sub/readme.md', false)).toBe('readme.md')
  })

  it('目录剥掉尾斜杠后取末段并补斜杠', () => {
    expect(displayNameOf('docs/sub/', true)).toBe('sub/')
  })

  it('顶层条目原样', () => {
    expect(displayNameOf('a.txt', false)).toBe('a.txt')
  })

  it('伪造路径条目名只作字符串处理（../../etc/passwd）', () => {
    expect(displayNameOf('../../etc/passwd', false)).toBe('passwd')
  })
})

describe('classifyArchiveEntry', () => {
  it('图片扩展名 → image', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']) {
      expect(classifyArchiveEntry(`x.${ext}`)).toBe('image')
    }
    expect(classifyArchiveEntry('X.PNG')).toBe('image')
  })

  it('pdf → pdf', () => {
    expect(classifyArchiveEntry('doc.pdf')).toBe('pdf')
  })

  it('文本 / 代码扩展名 → text', () => {
    for (const ext of ['md', 'txt', 'json', 'csv', 'tsv', 'log', 'yml', 'ts', 'py', 'go', 'sh']) {
      expect(classifyArchiveEntry(`x.${ext}`)).toBe('text')
    }
  })

  it('未知扩展名与无扩展名 → other（下载，不猜）', () => {
    expect(classifyArchiveEntry('binary.bin')).toBe('other')
    expect(classifyArchiveEntry('Makefile.old')).toBe('other')
    expect(classifyArchiveEntry('noext')).toBe('other')
    expect(classifyArchiveEntry('archive.zip')).toBe('other')
  })
})

describe('compressionRatio', () => {
  it('正常压缩收益', () => {
    expect(compressionRatio(25, 100)).toBe('75%')
  })

  it('空文件 / 无收益 → —', () => {
    expect(compressionRatio(0, 0)).toBe('—')
    expect(compressionRatio(100, 100)).toBe('—')
    expect(compressionRatio(120, 100)).toBe('—')
  })
})

describe('上限常量单调性（技术方案 §9）', () => {
  it('文本预览上限 < 单条目上限 < 合计上限', () => {
    expect(ZIP_TEXT_PREVIEW_MAX_BYTES).toBeLessThan(ZIP_MAX_ENTRY_BYTES)
    expect(ZIP_MAX_ENTRY_BYTES).toBeLessThan(ZIP_MAX_TOTAL_BYTES)
  })
})
