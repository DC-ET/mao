import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * URL 拼接回归：会话工作区文件端点的完整 URL 必须是
 * `{API_BASE}/admin/sessions/{id}/files/{suffix}`，API_BASE 只出现一次。
 *
 * 背景（2026-10-16 线上问题）：admin 的 `api` 实例自身已带
 * `baseURL = VITE_API_BASE_URL || '/api/v1'`，而 composable 曾把同一份 base
 * 再拼进自己构造的 URL，实际请求 `/api/v1/api/v1/admin/...` → 404。
 * 404 的错误体经 `loadDirectory` 归一成「目录加载失败」，用户在会话详情点
 * 「查看文件」只看到「工作区目录不存在或已被清理」，而工作区其实好着。
 */

const apiGet = vi.fn(async () => ({ data: { entries: [], truncated: false } }))

vi.mock('../../../api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}))

/** 记录裸 fetch 的 URL（字节流端点：download / download-zip / preview）。 */
const fetchCalls: string[] = []

function stubFetch(body = 'binary-bytes') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetchCalls.push(String(url))
    return {
      ok: true,
      headers: { get: (name: string) => (name === 'content-disposition' ? 'attachment; filename="x.bin"' : 'application/octet-stream') },
      blob: async () => new Blob([body]),
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

describe('useWorkspaceFiles URL 拼接', () => {
  beforeEach(() => {
    apiGet.mockClear()
    fetchCalls.length = 0
    localStorage.clear()
    stubFetch()
  })

  it('directory 请求的 API base 只出现一次（默认 /api/v1）', async () => {
    const files = await loadComposable(undefined)
    await files.open(2163)
    const url = apiGet.mock.calls[0]?.[0] as string
    expect(url).toBe('/api/v1/admin/sessions/2163/files/directory')
    // 双重前缀即线上故障形态：必须恰好出现一次
    expect(url.split('/api/v1').length - 1).toBe(1)
  })

  it('自定义 API_BASE 时也只拼一次，其余路径形态不变', async () => {
    const files = await loadComposable('https://mao.etarch.cn/api/v1')
    await files.open(42)
    expect(apiGet.mock.calls[0]?.[0]).toBe('https://mao.etarch.cn/api/v1/admin/sessions/42/files/directory')
  })

  it('子目录导航带上 dir 参数且不含空前缀', async () => {
    const files = await loadComposable(undefined)
    await files.open(7)
    apiGet.mockClear()
    files.navigateTo('docs/plan')
    await vi.waitFor(() => expect(apiGet).toHaveBeenCalled())
    expect(apiGet.mock.calls[0]?.[0]).toBe('/api/v1/admin/sessions/7/files/directory?dir=docs%2Fplan')
  })

  it('字节流端点（download / download-zip / preview）与 JSON 端点同基', async () => {
    const files = await loadComposable(undefined)
    await files.open(9)
    await files.downloadFile('a/b.txt')
    await files.downloadZip()
    expect(fetchCalls).toEqual([
      '/api/v1/admin/sessions/9/files/download?path=a%2Fb.txt',
      '/api/v1/admin/sessions/9/files/download-zip',
    ])
  })

  it('read / search 端点同基且无双重前缀', async () => {
    const files = await loadComposable(undefined)
    await files.open(11)
    apiGet.mockClear()
    await files.search('report')
    await files.previewFile('README.md')
    expect(apiGet.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/admin/sessions/11/files/search?pattern=report',
      '/api/v1/admin/sessions/11/files/read?path=README.md',
    ])
  })

  it('切换会话后 URL 跟随新会话 id，不残留上一个会话', async () => {
    const files = await loadComposable(undefined)
    await files.open(1)
    await files.open(2)
    expect(apiGet.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/admin/sessions/1/files/directory',
      '/api/v1/admin/sessions/2/files/directory',
    ])
  })
})
