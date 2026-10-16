import { describe, expect, it } from 'vitest'
import type { RouteLocationNormalized } from 'vue-router'
import { collectEmbedContext } from './embedContext'

/** 只取 collectEmbedContext 实际读取的字段构造路由快照。 */
function route(partial: Partial<RouteLocationNormalized>): RouteLocationNormalized {
  return { path: '/', params: {}, query: {}, ...partial } as RouteLocationNormalized
}

describe('collectEmbedContext', () => {
  it('collects route name, path, params and query', () => {
    expect(collectEmbedContext(route({
      name: 'SessionDetail',
      path: '/sessions/42',
      params: { id: '42' },
      query: { tab: 'messages' },
    }))).toEqual({
      route: 'SessionDetail',
      path: '/sessions/42',
      params: { id: '42' },
      query: { tab: 'messages' },
    })
  })

  it('falls back to path when the route has no name', () => {
    expect(collectEmbedContext(route({ path: '/usage' })).route).toBe('/usage')
  })

  it('falls back to path when the route name is a symbol (not JSON-serializable)', () => {
    const ctx = collectEmbedContext(route({ name: Symbol('lazy'), path: '/lazy' }))
    expect(ctx.route).toBe('/lazy')
  })

  it('keeps repeated params and query as arrays', () => {
    const ctx = collectEmbedContext(route({
      path: '/x',
      params: { id: ['1', '2'] },
      query: { tag: ['a', 'b'] },
    }))
    expect(ctx.params).toEqual({ id: ['1', '2'] })
    expect(ctx.query).toEqual({ tag: ['a', 'b'] })
  })

  it('yields empty objects for routes without params and query', () => {
    const ctx = collectEmbedContext(route({ name: 'Dashboard', path: '/dashboard' }))
    expect(ctx.params).toEqual({})
    expect(ctx.query).toEqual({})
    // 空路由不得注入 undefined 值：SDK 按 hash 做变更检测，undefined 值会造成无意义重复注入
    expect(Object.values(ctx.params).some((v) => v === undefined)).toBe(false)
    expect(Object.values(ctx.query).some((v) => v === undefined)).toBe(false)
  })

  it('exposes only structural route keys, never table rows or form values', () => {
    const ctx = collectEmbedContext(route({ name: 'Agents', path: '/agents', query: { kw: 'x' } }))
    expect(Object.keys(ctx).sort()).toEqual(['params', 'path', 'query', 'route'])
  })

  it('copies params and query so later route mutation cannot leak in', () => {
    const source = route({ name: 'Sessions', path: '/sessions', params: { id: '1' } })
    const ctx = collectEmbedContext(source)
    source.params.id = '2'
    expect(ctx.params).toEqual({ id: '1' })
  })
})
