/**
 * 外观个性化（强调色 / 界面字号）：与 theme.ts 完全同构的模块级单例。
 *
 * 机制：JS 只切 html 上的 data-accent / data-font-scale 属性，不注内联样式；
 * CSS 侧由 style.css 的预设块（html[data-accent='<id>'] 等）接管取值。
 * 默认档（blue / std）归一为 null → removeAttribute，属性缺省即 :root 现值，
 * 「不写属性 = 默认观感零变化」由这一结构性约定保证。
 *
 * 存储口径与 aw-theme-mode 完全一致：localStorage 设备本地，不随登出清除。
 */
import { ref } from 'vue'
import { safeSetItem } from './safe-storage'

export type AccentId = 'blue' | 'violet' | 'green' | 'orange' | 'graphite'
export type FontScaleId = 'small' | 'std' | 'large'

export const ACCENT_PRESETS: ReadonlyArray<{ id: AccentId; label: string; swatch: string }> = [
  { id: 'blue', label: '经典蓝', swatch: '#0066cc' },
  { id: 'violet', label: '紫', swatch: '#6E56CF' },
  { id: 'green', label: '绿', swatch: '#15803D' },
  { id: 'orange', label: '橙', swatch: '#C2410C' },
  { id: 'graphite', label: '石墨', swatch: '#475569' },
]

export const FONT_SCALE_OPTIONS: ReadonlyArray<{ id: FontScaleId; label: string }> = [
  { id: 'small', label: '小' },
  { id: 'std', label: '标准' },
  { id: 'large', label: '大' },
]

const ACCENT_IDS: ReadonlyArray<string> = ACCENT_PRESETS.map((p) => p.id)
const FONT_SCALE_IDS: ReadonlyArray<string> = FONT_SCALE_OPTIONS.map((o) => o.id)

const ACCENT_STORAGE_KEY = 'aw-accent'
const FONT_SCALE_STORAGE_KEY = 'aw-font-scale'

const accent = ref<AccentId>('blue')
const fontScale = ref<FontScaleId>('std')

let initialized = false

/**
 * 归一化强调色：合法非默认 id 原样返回；'blue' / null / undefined / 非法值 → null
 * （null = 默认档 = 不写属性）。损坏存储值读作默认档，不主动清洗。
 */
export function normalizeAccent(v: string | null | undefined): AccentId | null {
  if (v && v !== 'blue' && ACCENT_IDS.includes(v)) {
    return v as AccentId
  }
  return null
}

/** 同 normalizeAccent：'std' 为默认档归一为 null。 */
export function normalizeFontScale(v: string | null | undefined): FontScaleId | null {
  if (v && v !== 'std' && FONT_SCALE_IDS.includes(v)) {
    return v as FontScaleId
  }
  return null
}

function applyAccent(id: AccentId | null) {
  if (id === null) {
    document.documentElement.removeAttribute('data-accent')
  } else {
    document.documentElement.setAttribute('data-accent', id)
  }
}

function applyFontScale(id: FontScaleId | null) {
  if (id === null) {
    document.documentElement.removeAttribute('data-font-scale')
  } else {
    document.documentElement.setAttribute('data-font-scale', id)
  }
}

/** 读存储并归一化（非法值读作默认档，不主动清除；与 theme.ts 同口径直接读）。 */
function getStoredAccent(): AccentId {
  return normalizeAccent(localStorage.getItem(ACCENT_STORAGE_KEY)) ?? 'blue'
}

function getStoredFontScale(): FontScaleId {
  return normalizeFontScale(localStorage.getItem(FONT_SCALE_STORAGE_KEY)) ?? 'std'
}

function initAppearance() {
  if (initialized) return
  initialized = true

  accent.value = getStoredAccent()
  fontScale.value = getStoredFontScale()
  applyAccent(normalizeAccent(accent.value))
  applyFontScale(normalizeFontScale(fontScale.value))
}

export function useAppearance() {
  initAppearance()

  /** 写存储 + 应用属性 + 同步 ref（'blue' 也落存储，保证 UI 有合法选中态）。 */
  function setAccent(id: AccentId) {
    accent.value = id
    safeSetItem(ACCENT_STORAGE_KEY, id)
    applyAccent(normalizeAccent(id))
  }

  function setFontScale(id: FontScaleId) {
    fontScale.value = id
    safeSetItem(FONT_SCALE_STORAGE_KEY, id)
    applyFontScale(normalizeFontScale(id))
  }

  return {
    accent,
    fontScale,
    setAccent,
    setFontScale,
    ACCENT_PRESETS,
    FONT_SCALE_OPTIONS
  }
}
