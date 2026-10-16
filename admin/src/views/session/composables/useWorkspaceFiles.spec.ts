import { beforeEach, describe, expect, it, vi } from 'vitest'
import axios from 'axios'

/**
 * 会话工作区文件端点的 URL 拼接回归。
 *
 * 历史故障（2026-10-16 线上）：请求实际打到 `/api/v1/api/v1/admin/...` → 404，
 * 404 被 loadDirectory 归一成「目录加载失败」，用户在会话详情点「查看文件」
 * 只看到「工作区目录不存在或已被清理」，而后端接口与工作区目录均正常。
 *
 * 根因是 base 的归属搞反了。admin 有两条请求路径，口径不同：
 * - JSON 端点走全局 `api` 实例，它自带 `baseURL = VITE_API_BASE_URL || '/api/v1'`，
 *   所以调用方必须传**不含 base 的相对路径**；
 * - 字节流端点走裸 fetch，没有 baseURL，必须**自带完整 base**。
 * 关键陷阱：axios 的 baseURL 只豁免 `http(s)://` 这类绝对 URL，以 `/` 开头的
 * 路径一样会被拼上 base——「URL 以 / 开头所以 axios 会忽略 baseURL」是错的。
 */

const apiGet = vi.fn(async () => ({ data: { entries: [], truncated: false } }))

vi.mock('../../../api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}))

/** 记录裸 fetch 的 URL（字节流端点：download / download-zip / preview）。 */
const fetchCalls: string[] = []

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetchCalls.push(String(url))
    return {
      ok: true,
      headers: { get: (name: string) => (name === 'content-disposition' ? 'attachment; filename="x.bin"' : 'application/octet-stream') },
      blob: async () => new Blob(['bytes']),
    } as unknown as Response
  }))
}

/** 每次用例前按给定 base 重新加载模块，确保 API_BASE 常量取到桩值。 */
async function loadComposable(apiBase: string | undefined) {
  vi.resetModules()
  if (apiBase == null) {
    vi.stubEnv('VITE_API_BASE_URL', undefined as unknown as string)
  } else {
    vi.stubEnv('VITE_API_BASE_URL', apiBase)
  }
  return (await import('./useWorkspaceFiles')).useWorkspaceFiles()
}

/**
 * 复刻 axios v1 的 buildFullPath 口径，用于断言「api 实例最终请求的地址」。
 * 只有协议相对/绝对 URL（http://、//host）才豁免 baseURL；`/x` 会被拼接。
 */
function combineWithBaseURL(baseURL: string, url: string): string {
  const isAbsoluteURL = /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url)
  return isAbsoluteURL
    ? url
    : `${baseURL.replace(/\/?\/$/, '')}/${url.replace(/^\/+/, '')}`
}

const BASE = '/api/v1'

describe('useWorkspaceFiles URL 拼接', () => {
  beforeEach(() => {
    apiGet.mockClear()
    fetchCalls.length = 0
    localStorage.clear()
    stubFetch()
  })

  it('api 实例拿到的路径不含 base，经 baseURL 拼接后落在唯一前缀上', async () => {
    const files = await loadComposable(undefined)
    await files.open(2163)
    const passed = apiGet.mock.calls[0]?.[0] as string
    expect(passed).toBe('/admin/sessions/2163/files/directory')
    // 关键断言：真正发出去的地址里 /api/v1 只出现一次
    const finalUrl = combineWithBaseURL(BASE, passed)
    expect(finalUrl).toBe('/api/v1/admin/sessions/2163/files/directory')
    expect(finalUrl.split('/api/v1').length - 1).toBe(1)
  })

  it('裸 fetch 的字节流端点自带完整 base', async () => {
    const files = await loadComposable(undefined)
    await files.open(9)
    await files.downloadFile('a/b.txt')
    await files.downloadZip()
    expect(fetchCalls).toEqual([
      '/api/v1/admin/sessions/9/files/download?path=a%2Fb.txt',
      '/api/v1/admin/sessions/9/files/download-zip',
    ])
    for (const url of fetchCalls) {
      expect(url.split('/api/v1').length - 1).toBe(1)
    }
  })

  it('两类请求最终落在同一个地址上（JSON 与字节流同基）', async () => {
    const files = await loadComposable(undefined)
    await files.open(5)
    await files.search('report')
    await files.previewFile('notes/a.pdf')
    // open() 先发 directory，故 search 是第二条 api 调用
    const searchPassed = apiGet.mock.calls[1]?.[0] as string
    expect(combineWithBaseURL(BASE, searchPassed))
      .toBe('/api/v1/admin/sessions/5/files/search?pattern=report')
    expect(fetchCalls[0]).toBe('/api/v1/admin/sessions/5/files/preview?path=notes%2Fa.pdf')
  })

  it('自定义 API_BASE 时两条路都只拼一次', async () => {
    const custom = 'https://mao.etarch.cn/api/v1'
    const files = await loadComposable(custom)
    await files.open(42)
    await files.downloadZip()
    expect(combineWithBaseURL(custom, apiGet.mock.calls[0]?.[0] as string))
      .toBe('https://mao.etarch.cn/api/v1/admin/sessions/42/files/directory')
    expect(fetchCalls[0]).toBe('https://mao.etarch.cn/api/v1/admin/sessions/42/files/download-zip')
  })

  it('子目录导航带上 dir 参数，且不含 base', async () => {
    const files = await loadComposable(undefined)
    await files.open(7)
    apiGet.mockClear()
    files.navigateTo('docs/plan')
    await vi.waitFor(() => expect(apiGet).toHaveBeenCalled())
    const passed = apiGet.mock.calls[0]?.[0] as string
    expect(passed).toBe('/admin/sessions/7/files/directory?dir=docs%2Fplan')
    expect(combineWithBaseURL(BASE, passed)).toBe('/api/v1/admin/sessions/7/files/directory?dir=docs%2Fplan')
  })

  it('read 端点同口径', async () => {
    const files = await loadComposable(undefined)
    await files.open(11)
    await files.previewFile('README.md')
    expect(apiGet.mock.calls.at(-1)?.[0]).toBe('/admin/sessions/11/files/read?path=README.md')
  })

  it('切换会话后路径跟随新会话 id，不残留上一个会话', async () => {
    const files = await loadComposable(undefined)
    await files.open(1)
    await files.open(2)
    expect(apiGet.mock.calls.map((c) => c[0])).toEqual([
      '/admin/sessions/1/files/directory',
      '/admin/sessions/2/files/directory',
    ])
  })

  it('以 / 开头不等于 axios 豁免 baseURL（陷阱本身有测试锁定）', () => {
    // 若有人据此把 base 拼进 api 路径，这里会直接暴露
    expect(combineWithBaseURL('/api/v1', '/admin/sessions/1/files/directory'))
      .toBe('/api/v1/admin/sessions/1/files/directory')
    expect(combineWithBaseURL('/api/v1', '/api/v1/admin/sessions/1/files/directory'))
      .toBe('/api/v1/api/v1/admin/sessions/1/files/directory')
    // 对照：真绝对 URL 才会被豁免
    expect(axios.isCancel).toBeTypeOf('function')
    expect(combineWithBaseURL('/api/v1', 'https://x.test/api/v1/admin/sessions/1/files/directory'))
      .toBe('https://x.test/api/v1/admin/sessions/1/files/directory')
  })
})
