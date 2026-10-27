// file-preview-format 纯函数：扩展名判定与 zip/xlsx 内容 sniff（技术方案 §5.1 / §9）。
import { describe, expect, it } from 'vitest'
import { resolvePreviewKind, sniffContainerKind } from './file-preview-format'

describe('resolvePreviewKind', () => {
  it('CSV / TSV / tab 判定为 csv', () => {
    expect(resolvePreviewKind('a/b/report.csv')).toBe('csv')
    expect(resolvePreviewKind('report.tsv')).toBe('csv')
    expect(resolvePreviewKind('data.tab')).toBe('csv')
  })

  it('xlsx 家族判定为 xlsx（xlsm / xltx 同族）', () => {
    expect(resolvePreviewKind('sales.xlsx')).toBe('xlsx')
    expect(resolvePreviewKind('macro.xlsm')).toBe('xlsx')
    expect(resolvePreviewKind('template.xltx')).toBe('xlsx')
  })

  it('docx / zip 各自判定', () => {
    expect(resolvePreviewKind('spec.docx')).toBe('docx')
    expect(resolvePreviewKind('bundle.zip')).toBe('zip')
  })

  it('媒体白名单判定为 media', () => {
    for (const ext of ['mp4', 'webm', 'ogg', 'mov', 'm4a', 'mp3', 'wav', 'flac']) {
      expect(resolvePreviewKind(`demo.${ext}`)).toBe('media')
    }
  })

  it('扩展名大小写不敏感', () => {
    expect(resolvePreviewKind('REPORT.CSV')).toBe('csv')
    expect(resolvePreviewKind('Demo.MP4')).toBe('media')
    expect(resolvePreviewKind('book.XLSX')).toBe('xlsx')
  })

  it('双扩展名取最后一段：data.csv.zip → zip', () => {
    expect(resolvePreviewKind('data.csv.zip')).toBe('zip')
    expect(resolvePreviewKind('a.b.c.docx')).toBe('docx')
  })

  it('Windows 路径分隔符与深层目录', () => {
    expect(resolvePreviewKind('C:\\work\\out\\chart.png')).toBeNull()
    expect(resolvePreviewKind('C:\\work\\out\\chart.mp4')).toBe('media')
    expect(resolvePreviewKind('a/b/c/d/e.csv')).toBe('csv')
  })

  it('既有五态格式与未知格式一律返回 null（交回既有链路）', () => {
    // 图片集合与后端 ImageFileSupport 对齐（png/jpg/jpeg/gif/webp），此处不应被新分支接走
    for (const p of ['a.md', 'a.markdown', 'a.pdf', 'a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.txt', 'a.json', 'a.ts', 'a.exe', 'a.tar.gz', 'a.gz', 'a.tar']) {
      expect(resolvePreviewKind(p)).toBeNull()
    }
  })

  it('无扩展名与点文件返回 null', () => {
    expect(resolvePreviewKind('Makefile')).toBeNull()
    expect(resolvePreviewKind('a/b/.gitignore')).toBeNull()
    expect(resolvePreviewKind('')).toBeNull()
  })
})

describe('sniffContainerKind', () => {
  it('PK 魔数命中判为 zip', () => {
    expect(sniffContainerKind('PK\u0003\u0004' + '任意二进制噪声')).toBe('zip')
  })

  it('空档 / 跨卷魔数同样命中', () => {
    expect(sniffContainerKind('PK\u0005\u0006' + 'x'.repeat(30))).toBe('zip')
    expect(sniffContainerKind('PK\u0007\u0008' + 'x'.repeat(30))).toBe('zip')
  })

  it('zip 内含 xl/workbook.xml 判为 xlsx', () => {
    expect(sniffContainerKind('PK\u0003\u0004[Content_Types].xmlxl/workbook.xml')).toBe('xlsx')
  })

  it('普通文本 / 空内容 / 过短内容不误判', () => {
    expect(sniffContainerKind('hello,world\n1,2')).toBeNull()
    expect(sniffContainerKind('')).toBeNull()
    expect(sniffContainerKind('PK')).toBeNull()
    // PDF 头不是 PK
    expect(sniffContainerKind('%PDF-1.7 ...')).toBeNull()
  })
})
