import { describe, expect, it } from 'vitest'
import { buildWatcherPayload, collectHeaders, headerPairsFromView, type HeaderPair, type SignalWatcherForm } from './signal-watcher-form'

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

  it('掩码行留空表示不改动，跳过该键', () => {
    expect(collectHeaders([pair('Authorization', '', true)])).toBeUndefined()
    expect(collectHeaders([pair('Authorization', 'sk-new', true)])).toEqual({ Authorization: 'sk-new' })
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

  it('编辑态未填请求头：不下发该键（axios 会丢掉 undefined，服务端保留原值）', () => {
    const payload = buildWatcherPayload(form({ headers: [pair('Authorization', '', true)] }), true)
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
