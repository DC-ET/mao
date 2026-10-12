import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { createProjectProvider, useWorkspaceFileProvider } from './workspace-file-provider'

const apiGet = vi.fn()
vi.mock('../api', () => ({
  api: {
    get: (url: string, config?: unknown) => apiGet(url, config),
  },
}))
vi.mock('../utils/auth-storage', () => ({
  getToken: () => 'test-token',
}))

function mockApiGet(data: unknown) {
  apiGet.mockReset()
  apiGet.mockImplementation(async () => ({ data }))
}

beforeEach(() => {
  apiGet.mockReset()
})

afterEach(() => {
  delete (globalThis as any).window
  vi.unstubAllGlobals()
})

describe('useWorkspaceFileProvider 分支序', () => {
  it('CLOUD 有会话：cloud provider，sessionId 透传', async () => {
    mockApiGet({ entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false }], truncated: false })
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref('42'), ref('demo')).value
    expect(provider).not.toBeNull()
    const result = await provider!.listDirectory('')
    expect(apiGet).toHaveBeenCalledWith('/files/workspace-directory', {
      params: { sessionId: 42, dir: undefined },
    })
    expect(result.entries?.[0].name).toBe('a.txt')
  })

  it('CLOUD 无会话有项目：project provider，projectKey 透传', async () => {
    mockApiGet({ entries: [], truncated: false })
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref(''), ref('demo')).value
    expect(provider).not.toBeNull()
    await provider!.listDirectory('src')
    expect(apiGet).toHaveBeenCalledWith('/files/project-directory', {
      params: { projectKey: 'demo', dir: 'src' },
    })
  })

  it('CLOUD 无会话无项目：null', () => {
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref(''), ref('')).value
    expect(provider).toBeNull()
  })

  it('LOCAL 有 workspace：local provider 走 Electron IPC', async () => {
    const listDirectory = vi.fn(async () => ({ entries: [], truncated: false }))
    ;(globalThis as any).window = { electronAPI: { listDirectory } }
    const provider = useWorkspaceFileProvider(ref('LOCAL'), ref('/tmp/ws'), ref(''), ref('')).value
    expect(provider).not.toBeNull()
    await provider!.listDirectory('')
    expect(listDirectory).toHaveBeenCalledWith('/tmp/ws', '/tmp/ws')
  })

  it('LOCAL 无 workspace：null', () => {
    const provider = useWorkspaceFileProvider(ref('LOCAL'), ref(''), ref(''), ref('')).value
    expect(provider).toBeNull()
  })
})

describe('createProjectProvider', () => {
  it('readFile 走 project-read 并透传 offset/limit', async () => {
    mockApiGet({ content: 'hi', total_lines: 1, media_type: 'text' })
    const provider = createProjectProvider('demo')
    const result = await provider.readFile('a.txt', { offset: 10, limit: 20 })
    expect(apiGet).toHaveBeenCalledWith('/files/project-read', {
      params: { projectKey: 'demo', path: 'a.txt', offset: 10, limit: 20 },
    })
    expect(result.content).toBe('hi')
    expect(result.media_type).toBe('text')
  })

  it('searchFiles 走 project-search 并透传 pattern/limit', async () => {
    mockApiGet({ entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false }], truncated: false })
    const provider = createProjectProvider('demo')
    const result = await provider.searchFiles('a', 50)
    expect(apiGet).toHaveBeenCalledWith('/files/project-search', {
      params: { projectKey: 'demo', pattern: 'a', limit: 50 },
    })
    expect(result.entries?.[0].name).toBe('a.txt')
  })

  it('接口抛错时返回 error 形状（useFileBrowser 错误节点兼容）', async () => {
    apiGet.mockReset()
    apiGet.mockImplementation(async () => { throw new Error('项目名称非法') })
    const provider = createProjectProvider('..')
    const dir = await provider.listDirectory('')
    expect(dir.error).toBe('项目名称非法')
    const file = await provider.readFile('a.txt')
    expect(file.error).toBe('项目名称非法')
    const search = await provider.searchFiles('a')
    expect(search.error).toBe('项目名称非法')
  })

  it('previewFile 走 project-preview 并带 Bearer token，返回 blob', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' })
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => blob }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = createProjectProvider('demo')
    const result = await provider.previewFile!('docs/a b.pdf')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toContain('/files/project-preview?')
    expect(url).toContain('projectKey=demo')
    expect(url).toContain('path=docs%2Fa%20b.pdf')
    expect(init.headers.Authorization).toBe('Bearer test-token')
    expect(result.blob).toBe(blob)
  })

  it('previewFile 非 2xx 时返回 error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      headers: { get: () => 'application/json' },
      json: async () => ({ message: '项目名称非法' }),
    })))
    const provider = createProjectProvider('..')
    const result = await provider.previewFile!('a.pdf')
    expect(result.error).toBe('项目名称非法')
  })

  it('不实现下载与绝对路径能力（无会话不可用）', () => {
    const provider = createProjectProvider('demo')
    expect(provider.downloadFile).toBeUndefined()
    expect(provider.downloadDirectory).toBeUndefined()
    expect(provider.getAbsolutePath).toBeUndefined()
  })
})
