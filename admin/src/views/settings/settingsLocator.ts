import type { IntegrationGroupSpec } from './integrationFieldCatalog'

/** 滚动定位用的 DOM id。key 中的点号在 getElementById 下合法。 */
export function settingFieldId(key: string): string {
  return `setting-field-${key}`
}

export interface LocatorSection {
  id: string
  label: string
  group: string
  /** 卡片上没有单独表单项、但用户会拿来搜的词（如「环境变量」）。 */
  keywords?: string
}

export interface LocatorField {
  fieldId: string
  label: string
  key?: string
  /** 说明、占位、选项、库里的 description。参与匹配，不作为结果标题。 */
  detail?: string
  sectionId: string
}

export interface SettingRowLike {
  settingKey: string
  description?: string | null
  category?: string | null
}

export interface SearchHit {
  fieldId: string
  label: string
  key?: string
  group: string
  section: string
  sectionId: string
  /** 命中的是整张卡片，而不是卡片里的某一项。 */
  sectionHit: boolean
}

const RESULT_LIMIT_DEFAULT = 8

function compact(value: string): string {
  return value.toLowerCase().replace(/[\s._\-·/\\（）()：:，,、]+/g, '')
}

function tokensOf(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

function textMatches(parts: Array<string | undefined>, query: string): boolean {
  const tokens = tokensOf(query)
  if (tokens.length === 0) return false
  const text = parts.filter((part): part is string => !!part && part.trim() !== '').join('\n').toLowerCase()
  const packed = compact(text)
  return tokens.every((token) => text.includes(token) || packed.includes(compact(token)))
}

/** 单个文本相对查询的相关度。精确等于 > 前缀 > 包含；多词则逐词累加。 */
function scoreText(text: string, query: string): number {
  const tokens = tokensOf(query)
  const lower = text.toLowerCase()
  const packed = compact(text)
  let score = 0
  for (const token of tokens) {
    const packedToken = compact(token)
    if (lower === token || packed === packedToken) score += 400
    else if (lower.startsWith(token) || packed.startsWith(packedToken)) score += 280
    else if (lower.includes(token) || packed.includes(packedToken)) score += 160
  }
  return score
}

function fieldScore(field: LocatorField, query: string): number {
  const label = scoreText(field.label, query) * 3
  const key = field.key ? scoreText(field.key, query) * 2 : 0
  const detail = field.detail ? scoreText(field.detail, query) : 0
  let exactKey = 0
  const keyLower = (field.key ?? '').toLowerCase()
  for (const token of tokensOf(query)) {
    if (keyLower === token || keyLower.endsWith(`.${token}`)) exactKey += 500
  }
  return label + key + detail + exactKey - Math.min(field.label.length, 48) * 0.05
}

function sectionScore(section: LocatorSection, query: string): number {
  return scoreText(section.label, query) * 3
    + scoreText(section.group, query) * 2
    + (section.keywords ? scoreText(section.keywords, query) : 0)
}

export function searchSettings(
  fields: LocatorField[],
  sections: LocatorSection[],
  query: string,
  limit = RESULT_LIMIT_DEFAULT,
): { hits: SearchHit[]; total: number } {
  const trimmed = query.trim()
  if (!trimmed) return { hits: [], total: 0 }
  const sectionById = new Map(sections.map((section) => [section.id, section]))
  const ranked: Array<{ hit: SearchHit; score: number }> = []

  for (const section of sections) {
    if (!textMatches([section.label, section.group, section.keywords], trimmed)) continue
    ranked.push({
      score: sectionScore(section, trimmed),
      hit: {
        fieldId: section.id,
        label: section.label,
        group: section.group,
        section: section.label,
        sectionId: section.id,
        sectionHit: true,
      },
    })
  }

  for (const field of fields) {
    const section = sectionById.get(field.sectionId)
    if (!section) continue
    if (!textMatches([field.label, field.key, field.detail], trimmed)) continue
    ranked.push({
      score: fieldScore(field, trimmed),
      hit: {
        fieldId: field.fieldId,
        label: field.label,
        key: field.key,
        group: section.group,
        section: section.label,
        sectionId: section.id,
        sectionHit: false,
      },
    })
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.hit.sectionHit !== b.hit.sectionHit) return a.hit.sectionHit ? 1 : -1
    return a.hit.label.localeCompare(b.hit.label, 'zh-CN')
  })

  return {
    total: ranked.length,
    hits: ranked.slice(0, limit).map((item) => item.hit),
  }
}

/** 把集成组字段、专属面板子项、以及按分类渲染的设置行收成一份搜索索引。 */
export function buildSettingsLocatorFields(args: {
  rows: SettingRowLike[]
  integrationGroups: IntegrationGroupSpec[]
  panelFields: LocatorField[]
  /** 已由集成组或专属面板渲染的 key，不再按分类卡片收录。 */
  coveredKeys: Set<string>
}): LocatorField[] {
  const descriptionOf = new Map(args.rows.map((row) => [row.settingKey, (row.description ?? '').trim()]))
  const fields: LocatorField[] = []
  for (const group of args.integrationGroups) {
    for (const field of group.fields) {
      const options = (field.options ?? []).map((opt) => `${opt.label} ${opt.value}`).join(' ')
      fields.push({
        fieldId: settingFieldId(field.key),
        label: field.label,
        key: field.key,
        detail: [field.hint, field.placeholder, options, descriptionOf.get(field.key)].filter(Boolean).join('\n'),
        sectionId: `setting-group-${group.name}`,
      })
    }
  }
  for (const field of args.panelFields) {
    const description = field.key ? descriptionOf.get(field.key) : ''
    fields.push({
      ...field,
      detail: [field.detail, description].filter(Boolean).join('\n'),
    })
  }
  for (const row of args.rows) {
    if (args.coveredKeys.has(row.settingKey)) continue
    const category = row.category || '未分类'
    const description = (row.description ?? '').trim()
    fields.push({
      fieldId: settingFieldId(row.settingKey),
      label: description || row.settingKey,
      key: row.settingKey,
      detail: description,
      sectionId: `setting-cat-${category}`,
    })
  }
  return fields
}

/** 把查询里的词在标题中标出来。只标原文里能对上的片段，紧凑匹配（去掉空格）不额外拆字。 */
export function highlightSegments(text: string, query: string): Array<{ text: string; mark: boolean }> {
  const tokens = [...new Set(tokensOf(query))]
  if (tokens.length === 0 || text.length === 0) return [{ text, mark: false }]
  const lower = text.toLowerCase()
  const marks = new Array<boolean>(text.length).fill(false)
  for (const token of tokens) {
    let from = 0
    while (from < lower.length) {
      const at = lower.indexOf(token, from)
      if (at < 0) break
      for (let i = at; i < at + token.length && i < marks.length; i++) marks[i] = true
      from = at + token.length
    }
  }
  const out: Array<{ text: string; mark: boolean }> = []
  let index = 0
  while (index < text.length) {
    const mark = marks[index] === true
    let end = index + 1
    while (end < text.length && (marks[end] === true) === mark) end++
    out.push({ text: text.slice(index, end), mark })
    index = end
  }
  return out
}
