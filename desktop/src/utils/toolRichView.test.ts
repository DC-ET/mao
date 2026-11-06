import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_ITEMS,
  formatImageBytes,
  parseAskUserPairs,
  parseImageGenItems,
  parseSubagentProgressRows,
} from './toolRichView'

const imageEntry = (overrides: Record<string, unknown> = {}) => ({
  image_url: 'https://mao.example.com/uploads/7/gen-1.png',
  image_path: '/opt/mao-data/uploads/7/gen-1.png',
  size_bytes: 1536 * 1024,
  source: 'generate',
  mime: 'image/png',
  ...overrides,
})

describe('formatImageBytes', () => {
  it('B/KB/MB 三档，Math.floor 口径与后端 formatFileSize 一致', () => {
    expect(formatImageBytes(512)).toBe('512B')
    expect(formatImageBytes(1023)).toBe('1023B')
    expect(formatImageBytes(1024)).toBe('1KB')
    expect(formatImageBytes(1536 * 1024)).toBe('1MB')
    expect(formatImageBytes(1023 * 1024)).toBe('1023KB')
    expect(formatImageBytes(1024 * 1024)).toBe('1MB')
    expect(formatImageBytes(3.9 * 1024 * 1024)).toBe('3MB')
  })
})

describe('parseImageGenItems', () => {
  it('正常结果解析出 prompt/model/size 与角标', () => {
    const view = parseImageGenItems({
      images: [imageEntry()],
      model: 'cogview-4',
      size: '1024x1024',
      prompt: '一只橘猫坐在窗台',
    })
    expect(view).toEqual({
      prompt: '一只橘猫坐在窗台',
      model: 'cogview-4',
      size: '1024x1024',
      items: [{
        url: 'https://mao.example.com/uploads/7/gen-1.png',
        path: '/opt/mao-data/uploads/7/gen-1.png',
        bytesLabel: '1MB',
        mimeTag: 'PNG',
      }],
      hiddenCount: 0,
    })
  })

  it('空 images / 非数组 / 首项无 image_url / null 返回 null 回落原始 JSON', () => {
    expect(parseImageGenItems({ images: [], model: 'm', prompt: 'p' })).toBeNull()
    expect(parseImageGenItems({ images: 'not-array', prompt: 'p' })).toBeNull()
    expect(parseImageGenItems({ prompt: 'p' })).toBeNull()
    expect(parseImageGenItems({ images: [{ image_path: '/tmp/a.png' }] })).toBeNull()
    expect(parseImageGenItems({ images: [{ image_url: '' }] })).toBeNull()
    expect(parseImageGenItems({ images: ['https://a.com/1.png'] })).toBeNull()
    expect(parseImageGenItems(null)).toBeNull()
  })

  it('12 项截前 9 张，hiddenCount=3', () => {
    const images = Array.from({ length: 12 }, (_, i) => imageEntry({ image_url: `https://a.com/${i}.png` }))
    const view = parseImageGenItems({ images, prompt: 'p' })
    expect(view).not.toBeNull()
    expect(view!.items).toHaveLength(MAX_IMAGE_ITEMS)
    expect(view!.items[MAX_IMAGE_ITEMS - 1]!.url).toBe('https://a.com/8.png')
    expect(view!.hiddenCount).toBe(3)
  })

  it('size_bytes 非有限数/非正数不给字节角标，未知 mime 不给 mime 角标', () => {
    const view = parseImageGenItems({
      images: [imageEntry({ size_bytes: 'bad' }), imageEntry({ size_bytes: 0, mime: 'image/avif', image_url: 'https://a.com/2.avif' })],
      prompt: 'p',
    })
    expect(view!.items[0]).toMatchObject({ bytesLabel: '', mimeTag: 'PNG' })
    expect(view!.items[1]).toMatchObject({ bytesLabel: '', mimeTag: '' })
  })

  it('model/size 为 null（后端 ?? null 形态）时给空串', () => {
    const view = parseImageGenItems({ images: [imageEntry()], model: null, size: null, prompt: 'p' })
    expect(view!.model).toBe('')
    expect(view!.size).toBe('')
  })
})

describe('parseAskUserPairs', () => {
  it('正常解析问答对：多选标签全收，customInput 空为空串', () => {
    const pairs = parseAskUserPairs({
      answers: [
        { question: '用哪个方案？', selectedLabels: ['方案 A', '方案 C'], customInput: null },
        { question: '有补充吗？', selectedLabels: ['没有了'], customInput: '希望周五前完成' },
      ],
    })
    expect(pairs).toEqual([
      { question: '用哪个方案？', labels: ['方案 A', '方案 C'], customInput: '' },
      { question: '有补充吗？', labels: ['没有了'], customInput: '希望周五前完成' },
    ])
  })

  it('空数组 / 缺 answers / 全部 question 为空 / null 返回 null', () => {
    expect(parseAskUserPairs({ answers: [] })).toBeNull()
    expect(parseAskUserPairs({})).toBeNull()
    expect(parseAskUserPairs({ answers: [{ question: '', selectedLabels: ['a'] }] })).toBeNull()
    expect(parseAskUserPairs(null)).toBeNull()
  })

  it('selectedLabels 非数组或缺省给空串数组，非字符串项被过滤', () => {
    const pairs = parseAskUserPairs({ answers: [{ question: 'q', selectedLabels: ['a', 42, null] } as unknown as Record<string, unknown>, { question: 'q2' }] })
    expect(pairs).toEqual([
      { question: 'q', labels: ['a'], customInput: '' },
      { question: 'q2', labels: [], customInput: '' },
    ])
  })
})

const progressEntry = (overrides: Record<string, unknown> = {}) => ({
  taskId: 3,
  childSessionId: 321,
  agentType: 'explore',
  status: 'RUNNING',
  totalRounds: 4,
  totalToolCalls: 12,
  totalPromptTokens: 8200,
  totalCompletionTokens: 950,
  recentOutput: '正在读取配置文件...',
  ...overrides,
})

describe('parseSubagentProgressRows', () => {
  it('background_subagents 数组形态逐项组装，RUNNING→running', () => {
    const rows = parseSubagentProgressRows({ background_subagents: [progressEntry()] })
    expect(rows).toEqual([{
      taskId: 3,
      agentType: 'explore',
      status: 'RUNNING',
      statusKind: 'running',
      stats: '4 轮 / 12 次工具 / 8200+950 tok',
      recentOutput: '正在读取配置文件...',
    }])
  })

  it('check_subagent 带 task_id 的单对象形态包成单元素数组', () => {
    const rows = parseSubagentProgressRows(progressEntry({ status: 'COMPLETED', recentOutput: null }))
    expect(rows).toEqual([{
      taskId: 3,
      agentType: 'explore',
      status: 'COMPLETED',
      statusKind: 'ok',
      stats: '4 轮 / 12 次工具 / 8200+950 tok',
      recentOutput: '',
    }])
  })

  it('statusKind 映射：FAILED→fail，CANCELLED 与未知→muted', () => {
    const rows = parseSubagentProgressRows({
      background_subagents: [
        progressEntry({ taskId: 1, status: 'FAILED' }),
        progressEntry({ taskId: 2, status: 'CANCELLED' }),
        progressEntry({ taskId: 3, status: 'PENDING' }),
      ],
    })
    expect(rows!.map(r => r.statusKind)).toEqual(['fail', 'muted', 'muted'])
  })

  it('stats 只由非空字段拼，token 只有单边时单独显示', () => {
    const rows = parseSubagentProgressRows({
      background_subagents: [
        progressEntry({ taskId: 1, totalRounds: null, totalToolCalls: null, totalPromptTokens: null, totalCompletionTokens: null }),
        progressEntry({ taskId: 2, totalRounds: null, totalToolCalls: 2, totalPromptTokens: 100, totalCompletionTokens: null }),
      ],
    })
    expect(rows![0]!.stats).toBe('')
    expect(rows![1]!.stats).toBe('2 次工具 / 100 tok')
  })

  it('error 对象 / 空 background_subagents / null 返回 null 回落原始 JSON', () => {
    expect(parseSubagentProgressRows({ error: '后台子代理不存在: 9' })).toBeNull()
    expect(parseSubagentProgressRows({ background_subagents: [] })).toBeNull()
    expect(parseSubagentProgressRows(null)).toBeNull()
  })
})
