import { describe, expect, it } from 'vitest'
import { formatSize, formatTime, iconKindOf } from './file-format'

/**
 * 纯函数回归：规则对齐桌面端 utils/file-manager.ts，
 * 图标分类供工作区文件弹窗的图标 / 列表双视图共用。
 */
describe('file-format', () => {
  describe('formatSize', () => {
    it('按 B/KB/MB/GB 分档，>=100 取整', () => {
      expect(formatSize(0)).toBe('0 B')
      expect(formatSize(1023)).toBe('1023 B')
      expect(formatSize(1024)).toBe('1.0 KB')
      expect(formatSize(1536)).toBe('1.5 KB')
      expect(formatSize(1024 * 100)).toBe('100 KB')
      expect(formatSize(1024 * 1024 * 2)).toBe('2.0 MB')
    })

    it('null/undefined 显示占位符', () => {
      expect(formatSize(null)).toBe('—')
      expect(formatSize(undefined)).toBe('—')
    })
  })

  describe('formatTime', () => {
    it('epoch ms → YYYY-MM-DD HH:mm（本地时区）', () => {
      const d = new Date(2026, 9, 15, 17, 26)
      expect(formatTime(d.getTime())).toBe('2026-10-15 17:26')
    })

    it('0 / null / undefined 显示占位符', () => {
      expect(formatTime(0)).toBe('—')
      expect(formatTime(null)).toBe('—')
      expect(formatTime(undefined)).toBe('—')
    })
  })

  describe('iconKindOf', () => {
    it('符号链接优先于目录与扩展名', () => {
      expect(iconKindOf('src', true, true)).toBe('link')
      expect(iconKindOf('a.png', false, true)).toBe('link')
    })

    it('目录判 folder', () => {
      expect(iconKindOf('src', true)).toBe('folder')
      expect(iconKindOf('.git', true)).toBe('folder')
    })

    it('图片扩展名判 image（大小写不敏感）', () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']) {
        expect(iconKindOf(`a.${ext}`, false)).toBe('image')
      }
      expect(iconKindOf('LOGO.PNG', false)).toBe('image')
    })

    it('其余文件判 doc', () => {
      expect(iconKindOf('README.md', false)).toBe('doc')
      expect(iconKindOf('Makefile', false)).toBe('doc')
      // 点开头（.gitignore）不算扩展名分隔
      expect(iconKindOf('.gitignore', false)).toBe('doc')
      // 以点结尾（trailing dot）无扩展名
      expect(iconKindOf('weird.', false)).toBe('doc')
    })
  })
})
