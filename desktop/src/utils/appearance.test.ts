import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ACCENT_PRESETS,
  FONT_SCALE_OPTIONS,
  normalizeAccent,
  normalizeFontScale
} from './appearance'

/** 依次读取 appearance.ts 同目录的 ../style.css，锁定令牌改写与预设块 */
const STYLE_CSS_PATH = fileURLToPath(new URL('../style.css', import.meta.url))
const COMPONENTS_DIR = fileURLToPath(new URL('../components', import.meta.url))
const VIEWS_DIR = fileURLToPath(new URL('../views', import.meta.url))

describe('外观 registry', () => {
  it('ACCENT_PRESETS 共 5 款，id 唯一且含默认 blue，每项有 label/swatch', () => {
    expect(ACCENT_PRESETS.length).toBe(5)
    const ids = ACCENT_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(5)
    expect(ids).toContain('blue')
    for (const p of ACCENT_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.swatch.startsWith('#')).toBe(true)
    }
  })

  it('FONT_SCALE_OPTIONS 共 3 档（小/标准/大），含默认 std', () => {
    expect(FONT_SCALE_OPTIONS.length).toBe(3)
    const ids = FONT_SCALE_OPTIONS.map((o) => o.id)
    expect(ids).toEqual(expect.arrayContaining(['small', 'std', 'large']))
    for (const o of FONT_SCALE_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0)
    }
  })
})

describe('normalize 归一化（默认档/非法值 → null）', () => {
  it('normalizeAccent：blue/null/undefined/非法值 → null，非默认合法 id 原样返回', () => {
    expect(normalizeAccent('blue')).toBeNull()
    expect(normalizeAccent(null)).toBeNull()
    expect(normalizeAccent(undefined)).toBeNull()
    expect(normalizeAccent('red')).toBeNull()
    expect(normalizeAccent('')).toBeNull()
    expect(normalizeAccent('Blue')).toBeNull()
    expect(normalizeAccent('violet')).toBe('violet')
    expect(normalizeAccent('green')).toBe('green')
    expect(normalizeAccent('orange')).toBe('orange')
    expect(normalizeAccent('graphite')).toBe('graphite')
  })

  it('normalizeFontScale：std/null/undefined/非法值 → null，非默认合法档原样返回', () => {
    expect(normalizeFontScale('std')).toBeNull()
    expect(normalizeFontScale(null)).toBeNull()
    expect(normalizeFontScale(undefined)).toBeNull()
    expect(normalizeFontScale('medium')).toBeNull()
    expect(normalizeFontScale('')).toBeNull()
    expect(normalizeFontScale('small')).toBe('small')
    expect(normalizeFontScale('large')).toBe('large')
  })
})

describe('style.css 源码守卫（等值改写与预设块的精确计数）', () => {
  const css = readFileSync(STYLE_CSS_PATH, 'utf8')

  function countOccurrences(haystack: string, needle: string): number {
    let count = 0
    let pos = haystack.indexOf(needle)
    while (pos !== -1) {
      count++
      pos = haystack.indexOf(needle, pos + needle.length)
    }
    return count
  }

  it('alpha 家族 12 处全部引用 --aw-accent-rgb 三元组', () => {
    expect(countOccurrences(css, 'rgba(var(--aw-accent-rgb)')).toBe(12)
  })

  it('亮/暗蓝家族字面量 rgba 残留：暗色 0 处、亮色仅 EP light-5/7/8/9 共 4 处', () => {
    expect(countOccurrences(css, 'rgba(41, 151, 255')).toBe(0)
    expect(countOccurrences(css, 'rgba(0, 102, 204')).toBe(4)
  })

  it('EP light-3 默认字面量保留恰好 1 处（预设亮色块各自覆写）', () => {
    expect(countOccurrences(css, '#3385d9')).toBe(1)
  })

  it('预设暗色块显式接管 EP 主色本值 / hover（html.dark EP 蓝字面量压过 :root 引用，预设需 (0,2,1) 覆写）：:root 1 处 + 4 预设暗色块 = 5 处', () => {
    expect(countOccurrences(css, '--el-color-primary: var(--aw-primary)')).toBe(5)
    expect(countOccurrences(css, '--el-color-primary-dark-2: var(--aw-primary-focus)')).toBe(5)
  })

  it('4 款非默认预设的亮色块与暗色块各恰好 1 处', () => {
    for (const id of ['violet', 'green', 'orange', 'graphite'] as const) {
      expect(countOccurrences(css, `html[data-accent='${id}']`)).toBe(1)
      expect(countOccurrences(css, `html[data-theme='dark'][data-accent='${id}']`)).toBe(1)
    }
    expect(countOccurrences(css, "html[data-accent='blue']")).toBe(0)
  })

  it('字号三档：small / large 块各恰好 1 处，std 不写属性', () => {
    expect(countOccurrences(css, "html[data-font-scale='small']")).toBe(1)
    expect(countOccurrences(css, "html[data-font-scale='large']")).toBe(1)
    expect(countOccurrences(css, "html[data-font-scale='std']")).toBe(0)
  })
})

describe('组件硬编码守卫（components/ + views/ 剥离回退形态后 0 命中）', () => {
  /** 剥离 var(--aw-primary…) / var(--aw-accent…) 整个表达式（含回退值），回退字面量不参与守卫 */
  const FALLBACK_VAR_PATTERN = /var\(--aw-(?:primary|accent)[^)]*\)/g

  /** AVATAR_PALETTE 是用户头像身份色板，与 UI 强调色无关（设计显式豁免） */
  const WHITELIST_LINES = [
    "const AVATAR_PALETTE = ['#0066cc', '#6c5ce7', '#0097a7', '#2e7d32', '#b26a00', '#c62828', '#5c6bc0']"
  ]

  const BLUE_FAMILY_PATTERNS = ['#0066cc', '#0071e3', '#2997ff', 'rgba(0, 102, 204', 'rgba(41, 151, 255']

  function collectVueFiles(dir: string): string[] {
    const result: string[] = []
    for (const name of readdirSync(dir)) {
      const full = dir + (dir.endsWith('/') ? '' : '/') + name
      if (statSync(full).isDirectory()) {
        result.push(...collectVueFiles(full))
      } else if (name.endsWith('.vue')) {
        result.push(full)
      }
    }
    return result
  }

  it('剥离回退形态后，蓝家族硬编码在组件源码中 0 命中', () => {
    const violations: string[] = []
    for (const file of [...collectVueFiles(COMPONENTS_DIR), ...collectVueFiles(VIEWS_DIR)]) {
      const lines = readFileSync(file, 'utf8').split('\n')
      // 暗色默认档零变化锚点块（选择器含 :not([data-accent])）内回填的原字面量属显式豁免，
      // 整块跳过（含单行规则）；块外仍按常规断言。
      let anchorDepth = 0
      lines.forEach((line, idx) => {
        if (anchorDepth > 0) {
          for (const ch of line) {
            if (ch === '{') anchorDepth++
            else if (ch === '}') anchorDepth--
          }
          return
        }
        if (line.includes(':not([data-accent])')) {
          for (const ch of line) {
            if (ch === '{') anchorDepth++
            else if (ch === '}') anchorDepth--
          }
          return
        }
        if (WHITELIST_LINES.some((w) => line.trim() === w || line.includes(w))) return
        const stripped = line.replace(FALLBACK_VAR_PATTERN, '')
        for (const pattern of BLUE_FAMILY_PATTERNS) {
          if (stripped.includes(pattern)) {
            violations.push(`${file}:${idx + 1}: ${pattern}`)
          }
        }
      })
    }
    expect(violations).toEqual([])
  })
})
