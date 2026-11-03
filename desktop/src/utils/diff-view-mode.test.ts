import { describe, expect, it } from 'vitest'
import { diffEditorLayoutOptions, nextHunkIndex, resolveInitialDiffInlineMode } from './diff-view-mode'

describe('resolveInitialDiffInlineMode', () => {
  it('stored value wins over viewport width', () => {
    // 有过切换后永久以 localStorage 为准（'1'=行内 / '0'=并排）
    expect(resolveInitialDiffInlineMode('1', 1280)).toBe(true)
    expect(resolveInitialDiffInlineMode('0', 375)).toBe(false)
  })

  it('falls back to viewport width when nothing stored', () => {
    // 无存储：窄屏默认行内、宽屏默认并排
    expect(resolveInitialDiffInlineMode(null, 375)).toBe(true)
    expect(resolveInitialDiffInlineMode(null, 639)).toBe(true)
    expect(resolveInitialDiffInlineMode(null, 640)).toBe(false)
    expect(resolveInitialDiffInlineMode(null, 1280)).toBe(false)
  })

  it('treats unknown stored value as not-inline', () => {
    expect(resolveInitialDiffInlineMode('whatever', 1280)).toBe(false)
  })
})

describe('diffEditorLayoutOptions', () => {
  it('honors side-by-side even when the pane is narrower than Monaco 900px fallback', () => {
    expect(diffEditorLayoutOptions(false)).toEqual({
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
    })
  })

  it('honors inline mode', () => {
    expect(diffEditorLayoutOptions(true)).toEqual({
      renderSideBySide: false,
      useInlineViewWhenSpaceIsLimited: false,
    })
  })
})

describe('nextHunkIndex', () => {
  it('advances cyclically', () => {
    expect(nextHunkIndex(-1, 3, 1)).toBe(0)
    expect(nextHunkIndex(0, 3, 1)).toBe(1)
    expect(nextHunkIndex(2, 3, 1)).toBe(0)
  })

  it('steps back cyclically', () => {
    expect(nextHunkIndex(0, 3, -1)).toBe(2)
    expect(nextHunkIndex(1, 3, -1)).toBe(0)
  })

  it('returns -1 when there are no changes', () => {
    expect(nextHunkIndex(0, 0, 1)).toBe(-1)
    expect(nextHunkIndex(2, 0, -1)).toBe(-1)
  })
})
