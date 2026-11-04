import { describe, expect, it } from 'vitest'
// vitest.config 未挂 @mao/contracts 别名（桌面单测只擦除 type import）；直接引源文件。
import { formatSignalChangeValue, formatSignalCheckDetail } from '../../../../shared/contracts/src/signal.ts'

describe('formatSignalChangeValue', () => {
  it('JSON 字段模式带上 jsonPath', () => {
    expect(formatSignalChangeValue({
      compareMode: 'JSON_FIELD',
      oldText: '1',
      newText: '2',
      jsonPath: 'data.price',
    })).toBe('[字段 data.price] 旧值：1 → 新值：2')
  })

  it('状态码模式不套字段前缀', () => {
    expect(formatSignalChangeValue({
      compareMode: 'STATUS_CODE',
      oldText: '200',
      newText: '500',
    })).toBe('[HTTP 状态码] 200 → 500')
  })
})

describe('formatSignalCheckDetail', () => {
  it('触发失败在错误下换行附新旧值对', () => {
    expect(formatSignalCheckDetail({
      compareMode: 'JSON_FIELD',
      changed: 1,
      error: '预算不足',
      oldValueSnippet: '1',
      newValueSnippet: '2',
      jsonPath: 'data.price',
    })).toBe('预算不足\n[字段 data.price] 旧值：1 → 新值：2')
  })

  it('探针失败只展示错误', () => {
    expect(formatSignalCheckDetail({
      compareMode: 'HASH',
      changed: 0,
      error: '连接超时',
      oldValueSnippet: null,
      newValueSnippet: null,
    })).toBe('连接超时')
  })

  it('上线前历史行两列皆空时回落破折号', () => {
    expect(formatSignalCheckDetail({
      compareMode: 'HASH',
      changed: 1,
      error: null,
      oldValueSnippet: null,
      newValueSnippet: null,
    })).toBe('—')
  })

  it('未变行显示新值', () => {
    expect(formatSignalCheckDetail({
      compareMode: 'HASH',
      changed: 0,
      error: null,
      oldValueSnippet: 'same',
      newValueSnippet: 'same',
    })).toBe('same')
  })
})
