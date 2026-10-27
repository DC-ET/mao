import { describe, expect, it } from 'vitest'
import { buildWatcherPayload, collectHeaders, copyFormFromView, headerPairsFromView, type HeaderPair, type SignalWatcherForm } from './signal-watcher-form'

function pair(key: string, value: string, masked = false): HeaderPair {
  return { key, value, masked }
}

function form(partial: Partial<SignalWatcherForm> = {}): SignalWatcherForm {
  return {
    name: '汇率',
    agentId: 7,
    url: 'https://example.com/api/rate',
    method: 'GET',
    body: '',
    headers: [],
    intervalMinutes: 30,
    compareMode: 'HASH',
    jsonPath: '',
    promptTemplate: '值变了 {diff}',
    triggerMode: 'NEW_SESSION',
    ...partial
  }
}

describe('collectHeaders', () => {
  it('空键跳过，有键才下发', () => {
    expect(collectHeaders([pair('', 'x'), pair('X-Token', 'abc')])).toEqual({ 'X-Token': 'abc' })
  })

  it('一行都没填出来时返回 undefined（不下发该键，服务端保留原值）', () => {
    expect(collectHeaders([])).toBeUndefined()
    expect(collectHeaders([pair('', '')])).toBeUndefined()
  })

  it('掩码行留空：下发 SECRET_MASK 占位（服务端据此还原库内原值，不丢请求头）', () => {
    expect(collectHeaders([pair('Authorization', '', true)])).toEqual({ Authorization: '******' })
    expect(collectHeaders([pair('Authorization', 'sk-new', true)])).toEqual({ Authorization: 'sk-new' })
  })

  it('掩码行留空 + 新增其他请求头：掩码键仍在，不会因新增而被删掉', () => {
    expect(collectHeaders([pair('Authorization', '', true), pair('X-Trace', '1')]))
      .toEqual({ Authorization: '******', 'X-Trace': '1' })
  })

  it('键名按输入原样保留（trim 仅用于判空）', () => {
    expect(collectHeaders([pair('  X-A  ', ' 1 ')])).toEqual({ 'X-A': ' 1 ' })
  })
})

describe('headerPairsFromView', () => {
  it('打码值回填空值并标记 masked', () => {
    expect(headerPairsFromView({ Authorization: '******', 'X-Token': 'abc' })).toEqual([
      { key: 'Authorization', value: '', masked: true },
      { key: 'X-Token', value: 'abc', masked: false }
    ])
  })
})

describe('buildWatcherPayload', () => {
  it('新建态：请求头与请求体照常下发', () => {
    const payload = buildWatcherPayload(form({
      method: 'POST',
      body: '{"a":1}',
      headers: [pair('Authorization', 'sk-1')]
    }), false)
    expect(payload.headers).toEqual({ Authorization: 'sk-1' })
    expect(payload.body).toBe('{"a":1}')
  })

  it('编辑态只新增一个请求头：留空的掩码键也要下发占位，服务端才还原原值', () => {
    const payload = buildWatcherPayload(form({ headers: [pair('Authorization', '', true)] }), true)
    expect(payload.headers).toEqual({ Authorization: '******' })
  })

  it('编辑态未填任何请求头：不下发该键（axios 会丢掉 undefined，服务端保留原值）', () => {
    const payload = buildWatcherPayload(form({ headers: [] }), true)
    expect(payload).not.toHaveProperty('headers')
  })

  it('编辑态把行删光：下发 null 显式清空（服务端支持，否则用户无法撤掉已保存请求头）', () => {
    const payload = buildWatcherPayload(form({ headers: [] }), true, { Authorization: 'sk' })
    expect(payload.headers).toBeNull()
  })

  it('新建态无请求头：不下发该键（必填校验由服务端 normalizeInput 拦）', () => {
    const payload = buildWatcherPayload(form({ headers: [] }), false, undefined)
    expect(payload).not.toHaveProperty('headers')
  })

  it('编辑态原本就没有请求头：删空不下发 null（无实质变化）', () => {
    const payload = buildWatcherPayload(form({ headers: [] }), true, {})
    expect(payload).not.toHaveProperty('headers')
  })

  it('编辑态未改请求体：不下发 body 键（服务端按「留空不修改」保留）', () => {
    const payload = buildWatcherPayload(form({ method: 'POST', body: '' }), true)
    expect(payload).not.toHaveProperty('body')
  })

  it('编辑态改了请求体：照常下发', () => {
    const payload = buildWatcherPayload(form({ method: 'POST', body: '{"a":2}' }), true)
    expect(payload.body).toBe('{"a":2}')
  })

  it('非 POST：请求体键不出现，避免残留被服务端强制清空前还发出去', () => {
    const payload = buildWatcherPayload(form({ method: 'GET', body: '残留' }), true)
    expect(payload).not.toHaveProperty('body')
  })

  it('非 JSON_FIELD：不下发 jsonPath，由服务端置 null 清掉旧值', () => {
    const payload = buildWatcherPayload(form({ compareMode: 'HASH', jsonPath: 'data.price' }), true)
    expect(payload).not.toHaveProperty('jsonPath')
  })

  it('JSON_FIELD：trim 后下发提取路径', () => {
    const payload = buildWatcherPayload(form({ compareMode: 'JSON_FIELD', jsonPath: ' data.items.0.price ' }), true)
    expect(payload.jsonPath).toBe('data.items.0.price')
  })
})

describe('buildWatcherPayload 触发方式', () => {
  it('新建态默认下发 NEW_SESSION', () => {
    const payload = buildWatcherPayload(form(), false)
    expect(payload.triggerMode).toBe('NEW_SESSION')
  })

  it('新建态选复用：下发 REUSE_SESSION', () => {
    const payload = buildWatcherPayload(form({ triggerMode: 'REUSE_SESSION' }), false)
    expect(payload.triggerMode).toBe('REUSE_SESSION')
  })

  it('编辑态未改动：下发回显值（与原值相同即幂等，后端同值不清指针）', () => {
    const payload = buildWatcherPayload(form({ triggerMode: 'REUSE_SESSION' }), true)
    expect(payload.triggerMode).toBe('REUSE_SESSION')
  })

  it('编辑态切到新建：下发 NEW_SESSION（后端据此清复用指针）', () => {
    const payload = buildWatcherPayload(form({ triggerMode: 'NEW_SESSION' }), true)
    expect(payload.triggerMode).toBe('NEW_SESSION')
  })

  it('reuseSessionId 永不下发（指针系统维护，入参里没有这个字段）', () => {
    const payload = buildWatcherPayload(form({ triggerMode: 'REUSE_SESSION' }), true) as unknown as Record<string, unknown>
    expect(payload).not.toHaveProperty('reuseSessionId')
  })
})

describe('buildWatcherPayload 复制态（copyFrom）', () => {
  it('下发 copyFrom；其余字段照常', () => {
    const payload = buildWatcherPayload(form({ triggerMode: 'REUSE_SESSION' }), false, undefined, 42)
    expect(payload.copyFrom).toBe(42)
    expect(payload.triggerMode).toBe('REUSE_SESSION')
  })

  it('非复制态不下发 copyFrom', () => {
    const payload = buildWatcherPayload(form(), false) as unknown as Record<string, unknown>
    expect(payload).not.toHaveProperty('copyFrom')
  })

  it('复制态 POST 请求体留空：不下发 body 键（后端从源行解密继承）', () => {
    const payload = buildWatcherPayload(
      form({ method: 'POST', body: '', headers: [pair('Authorization', '', true)] }),
      false, undefined, 42
    ) as unknown as Record<string, unknown>
    expect(payload).not.toHaveProperty('body')
    // 掩码行照常下发，后端据此从源行还原真实凭据
    expect(payload.headers).toEqual({ Authorization: '******' })
  })

  it('复制态 POST 请求体填了新值：照常下发（覆盖继承）', () => {
    const payload = buildWatcherPayload(
      form({ method: 'POST', body: '{"k":"new"}', headers: [pair('Authorization', '', true)] }),
      false, undefined, 42
    )
    expect(payload.body).toBe('{"k":"new"}')
  })

  it('复制态删光请求头行：不下发 headers（= 不要请求头，不触发编辑态的显式清空）', () => {
    const payload = buildWatcherPayload(
      form({ method: 'POST', body: '{"k":1}', headers: [] }),
      false, { Authorization: 'sk-1' }, 42
    ) as unknown as Record<string, unknown>
    expect(payload).not.toHaveProperty('headers')
  })

  it('复制态 GET：不下发 body（body 只对 POST 有意义）', () => {
    const payload = buildWatcherPayload(form({ method: 'GET', body: '残留' }), false, undefined, 42) as unknown as Record<string, unknown>
    expect(payload).not.toHaveProperty('body')
  })
})

describe('copyFormFromView 复制预填', () => {
  it('name 带「副本」后缀、非敏感字段原值、敏感头为掩码行、body 留空、triggerMode 随源', () => {
    const view = {
      id: 9,
      name: '汇率',
      agentId: 7,
      url: 'https://example.com/api/rate',
      method: 'POST',
      headers: { Authorization: '******', 'X-Trace': '1' },
      hasBody: true,
      bodyLength: 14,
      intervalMinutes: 30,
      compareMode: 'HASH' as const,
      jsonPath: null,
      promptTemplate: '值变了 {diff}',
      status: 'ACTIVE' as const,
      triggerMode: 'REUSE_SESSION' as const,
      reuseSessionId: 42,
      lastValueHash: null,
      lastCheckedAt: null,
      lastChangedAt: null,
      consecutiveFailures: 0,
      createdAt: null
    }
    const copied = copyFormFromView(view)
    expect(copied.name).toBe('汇率 副本')
    expect(copied.agentId).toBe(7)
    expect(copied.url).toBe('https://example.com/api/rate')
    expect(copied.method).toBe('POST')
    expect(copied.intervalMinutes).toBe(30)
    expect(copied.compareMode).toBe('HASH')
    expect(copied.promptTemplate).toBe('值变了 {diff}')
    expect(copied.triggerMode).toBe('REUSE_SESSION')
    // 敏感头是掩码行：留空即沿用源行原值；body 无明文可预填
    expect(copied.headers).toEqual([
      { key: 'Authorization', value: '', masked: true },
      { key: 'X-Trace', value: '1', masked: false }
    ])
    expect(copied.body).toBe('')
  })

  it('源哨兵 triggerMode 缺省（老数据）时回落 NEW_SESSION', () => {
    const view = {
      id: 9, name: 'w', agentId: 7, url: 'https://example.com', method: 'GET',
      headers: {}, hasBody: false, bodyLength: 0, intervalMinutes: 15,
      compareMode: 'HASH' as const, jsonPath: null, promptTemplate: 'p',
      status: 'ACTIVE' as const, lastValueHash: null, lastCheckedAt: null,
      lastChangedAt: null, consecutiveFailures: 0, createdAt: null
    } as Parameters<typeof copyFormFromView>[0]
    expect(copyFormFromView(view).triggerMode).toBe('NEW_SESSION')
  })
})
