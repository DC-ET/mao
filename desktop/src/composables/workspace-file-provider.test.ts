import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { createCloudProvider, createDeliveryFileProvider, createLocalProvider, createOwnedWorkspaceProvider, createProjectProvider, useWorkspaceFileProvider, downloadDeliveryUrl } from './workspace-file-provider'

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
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref('42'), ref('demo'), ref(null)).value
    expect(provider).not.toBeNull()
    const result = await provider!.listDirectory('')
    expect(apiGet).toHaveBeenCalledWith('/files/workspace-directory', {
      params: { sessionId: 42, dir: undefined },
    })
    expect(result.entries?.[0].name).toBe('a.txt')
  })

  it('CLOUD 无会话有项目：project provider，projectKey 透传', async () => {
    mockApiGet({ entries: [], truncated: false })
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref(''), ref('demo'), ref(null)).value
    expect(provider).not.toBeNull()
    await provider!.listDirectory('src')
    expect(apiGet).toHaveBeenCalledWith('/files/project-directory', {
      params: { projectKey: 'demo', dir: 'src' },
    })
  })

  it('CLOUD 无会话无项目：null', () => {
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref(''), ref(''), ref(null)).value
    expect(provider).toBeNull()
  })

  it('LOCAL 有 workspace：local provider 走 Electron IPC', async () => {
    const listDirectory = vi.fn(async () => ({ entries: [], truncated: false }))
    ;(globalThis as any).window = { electronAPI: { listDirectory } }
    const provider = useWorkspaceFileProvider(ref('LOCAL'), ref('/tmp/ws'), ref(''), ref(''), ref(null)).value
    expect(provider).not.toBeNull()
    await provider!.listDirectory('')
    expect(listDirectory).toHaveBeenCalledWith('/tmp/ws', '/tmp/ws')
  })

  it('LOCAL 无 workspace：null', () => {
    const provider = useWorkspaceFileProvider(ref('LOCAL'), ref(''), ref(''), ref(''), ref(null)).value
    expect(provider).toBeNull()
  })

  it('LOCAL + 代理会话 id：走 cloud provider（服务端 WS 代理，同 URL 同 DTO）', async () => {
    mockApiGet({ entries: [{ name: 'device.txt', path: 'device.txt', isDirectory: false, size: 1, isSymlink: false }], truncated: false })
    const provider = useWorkspaceFileProvider(ref('LOCAL'), ref('/Users/yang/proj'), ref(''), ref(''), ref('7')).value
    expect(provider).not.toBeNull()
    await provider!.listDirectory('')
    expect(apiGet).toHaveBeenCalledWith('/files/workspace-directory', {
      params: { sessionId: 7, dir: undefined },
    })
  })

  it('LOCAL + 代理会话 id 为空：回落本地 IPC provider（执行端本机 / 未绑定），不触达 API', () => {
    const listDirectory = vi.fn(async () => ({ entries: [], truncated: false }))
    ;(globalThis as any).window = { electronAPI: { listDirectory } }
    const provider = useWorkspaceFileProvider(ref('LOCAL'), ref('/tmp/ws'), ref(''), ref(''), ref(null)).value
    expect(provider).not.toBeNull()
    void provider!.listDirectory('')
    expect(apiGet).not.toHaveBeenCalled()
    expect(listDirectory).toHaveBeenCalledWith('/tmp/ws', '/tmp/ws')
  })
})

describe('createLocalProvider P0 防御（无 electronAPI 环境）', () => {
  it('各方法返回中文 error 形状，不抛 TypeError', async () => {
    // 不设置 window.electronAPI（afterEach 会清 window）
    ;(globalThis as any).window = {}
    const provider = createLocalProvider('/tmp/ws')
    expect(await provider.listDirectory('')).toEqual({ error: '本地任务文件仅在桌面客户端内可浏览' })
    expect(await provider.readFile('a.txt')).toEqual({ content: '', total_lines: 0, error: '本地任务文件仅在桌面客户端内可浏览' })
    expect(await provider.previewFile!('a.pdf')).toEqual({ error: '本地任务文件仅在桌面客户端内可浏览' })
    expect(await provider.readFileBytes!('a.bin')).toEqual({ error: '本地任务文件仅在桌面客户端内可浏览' })
    // searchFiles 必须显式回 error：不能靠 searchLocalWorkspace 内部 catch 静默返回空结果
    expect(await provider.searchFiles('a')).toEqual({ error: '本地任务文件仅在桌面客户端内可浏览' })
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

  it('不实现下载能力（写与下载依附会话，无会话不可用）', () => {
    const provider = createProjectProvider('demo')
    expect(provider.downloadFile).toBeUndefined()
    expect(provider.downloadDirectory).toBeUndefined()
    expect(provider.downloadEntriesZip).toBeUndefined()
  })
})

describe('getAbsolutePath（复制绝对路径）', () => {
  it('CLOUD：目录拉取后以响应里的 workspaceRoot 为基准拼绝对路径', async () => {
    mockApiGet({
      entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false }],
      truncated: false,
      workspaceRoot: '/opt/mao-data/workspace/42',
    })
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref('42'), ref('demo'), ref(null)).value!
    // 拉取前无根可依：原样返回相对路径，不拼出错路径
    expect(provider.getAbsolutePath!('scripts/deploy.sh')).toBe('scripts/deploy.sh')
    await provider.listDirectory('scripts')
    expect(provider.getAbsolutePath!('scripts/deploy.sh')).toBe('/opt/mao-data/workspace/42/scripts/deploy.sh')
    // 搜索响应同样刷新根，路径语义与目录一致
    mockApiGet({ entries: [], truncated: false, workspaceRoot: '/opt/mao-data/workspace/42' })
    await provider.searchFiles('deploy')
    expect(provider.getAbsolutePath!('scripts/deploy.sh')).toBe('/opt/mao-data/workspace/42/scripts/deploy.sh')
  })

  it('project：以 project-directory 响应里的 workspaceRoot 为基准（新建态无会话也可用）', async () => {
    mockApiGet({ entries: [], truncated: false, workspaceRoot: '/opt/mao-data/workspace/7/projects/demo' })
    const provider = createProjectProvider('demo')
    expect(provider.getAbsolutePath!('src/main.ts')).toBe('src/main.ts')
    await provider.listDirectory('src')
    expect(provider.getAbsolutePath!('src/main.ts')).toBe('/opt/mao-data/workspace/7/projects/demo/src/main.ts')
  })

  it('LOCAL：以 Electron 选中的 workspace 拼绝对路径（行为不变）', async () => {
    ;(globalThis as any).window = { electronAPI: { listDirectory: vi.fn(async () => ({ entries: [], truncated: false })) } }
    const provider = useWorkspaceFileProvider(ref('LOCAL'), ref('/tmp/ws'), ref(''), ref(''), ref(null)).value!
    expect(provider.getAbsolutePath!('scripts/deploy.sh')).toBe('/tmp/ws/scripts/deploy.sh')
  })
})

describe('downloadEntriesZip（多选合并 zip 下载）', () => {
  /** node 环境无 DOM：triggerBrowserDownload 需要最小 document / URL 桩 */
  function stubDownloadDom() {
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    })
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    })
    return anchor
  }

  it('CLOUD：POST workspace-download-multi-zip，body 含 sessionId 与 paths，一次浏览器下载', async () => {
    vi.useFakeTimers()
    try {
      const blob = new Blob(['zip-bytes'], { type: 'application/zip' })
      const fetchMock = vi.fn(async () => ({
        ok: true,
        headers: { get: (k: string) => (k === 'content-disposition' ? `attachment; filename*=UTF-8''multi.zip` : 'application/zip') },
        blob: async () => blob,
      }))
      vi.stubGlobal('fetch', fetchMock)
      const anchor = stubDownloadDom()
      const provider = createCloudProvider('42')
      const result = await provider.downloadEntriesZip!(['a.txt', 'docs'], 'selected.zip')
      expect(result.ok).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain('/files/workspace-download-multi-zip')
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' })
      expect(JSON.parse(String(init.body))).toEqual({ sessionId: 42, paths: ['a.txt', 'docs'] })
      // 文件名优先后端 Content-Disposition；一次 anchor click，blob URL 延迟回收
      expect(anchor.download).toBe('multi.zip')
      expect(anchor.click).toHaveBeenCalledTimes(1)
      expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
      expect(URL.revokeObjectURL).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
    } finally {
      vi.useRealTimers()
    }
  })

  it('owned：POST owned-download-multi-zip，body 含 root 与 paths', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        headers: { get: (k: string) => (k === 'content-disposition' ? `attachment; filename*=UTF-8''owned.zip` : 'application/zip') },
        blob: async () => new Blob(['z'], { type: 'application/zip' }),
      }))
      vi.stubGlobal('fetch', fetchMock)
      stubDownloadDom()
      const provider = createOwnedWorkspaceProvider('demo')
      const result = await provider.downloadEntriesZip!(['a.txt'], 'selected.zip')
      expect(result.ok).toBe(true)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain('/files/owned-download-multi-zip')
      expect(JSON.parse(String(init.body))).toEqual({ root: 'demo', paths: ['a.txt'] })
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('CLOUD：HTTP 500 JSON 错误体 → error 映射', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => 'application/json' },
      json: async () => ({ code: 3044, message: '所选内容过大（1.0 GB）' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = createCloudProvider('42')
    const result = await provider.downloadEntriesZip!(['a.txt'], 'selected.zip')
    expect(result).toEqual({ ok: false, error: '所选内容过大（1.0 GB）' })
  })

  it('CLOUD：ok 响应携带 JSON 错误体（无 disposition）→ error 映射', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: (k: string) => (k === 'content-disposition' ? null : 'application/json') },
      json: async () => ({ code: 5000, message: '打包选中项失败' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = createCloudProvider('42')
    const result = await provider.downloadEntriesZip!(['a.txt'], 'selected.zip')
    expect(result).toEqual({ ok: false, error: '打包选中项失败' })
  })

  it('LOCAL / 项目 provider 不实现（调用方提示「当前模式不支持下载」）', () => {
    expect(createLocalProvider('/tmp/ws').downloadEntriesZip).toBeUndefined()
    expect(createProjectProvider('demo').downloadEntriesZip).toBeUndefined()
  })

  it('会话未就绪 fallback：返回错误而非「不支持下载」', async () => {
    const provider = createCloudProvider('not-a-number')
    expect(await provider.downloadEntriesZip!(['a.txt'], 'selected.zip')).toEqual({ ok: false, error: '会话未就绪' })
  })
})

describe('createLocalProvider.downloadFile 与 createDeliveryFileProvider', () => {
  it('LOCAL provider：有 electronAPI 时经 localReadBytes 触发指定文件名下载，无 electronAPI 返回中文提示', async () => {
    ;(globalThis as any).window = {}
    const noElectron = createLocalProvider('/tmp/ws')
    expect(await noElectron.downloadFile!('a.txt', 'a.txt')).toEqual({
      ok: false,
      error: '本地任务文件仅在桌面客户端内可浏览',
    })

    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    })
    const createObjectURL = vi.fn(() => 'blob:local-1')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL as never
    URL.revokeObjectURL = revokeObjectURL as never
    ;(globalThis as any).window = {
      electronAPI: {
        localReadBytes: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer, size: 3 })),
      },
    }

    const local = createLocalProvider('/tmp/ws')
    const res = await local.downloadFile!('sub/report.pdf', 'report.pdf')
    expect(res).toEqual({ ok: true })
    expect(anchor.download).toBe('report.pdf')
    expect(anchor.click).toHaveBeenCalledTimes(1)
  })

  it('createDeliveryFileProvider：支持文本读取、字节读取、PDF 预览与保留原文件名下载', async () => {
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    })
    URL.createObjectURL = vi.fn(() => 'blob:delivery-1') as never
    URL.revokeObjectURL = vi.fn() as never

    const payloadBytes = new TextEncoder().encode('line1\nline2\nline3')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: (k: string) => (k === 'content-type' ? 'text/markdown; charset=utf-8' : null) },
      arrayBuffer: async () => payloadBytes.buffer.slice(payloadBytes.byteOffset, payloadBytes.byteOffset + payloadBytes.byteLength),
      blob: async () => new Blob([payloadBytes]),
    })))

    const provider = createDeliveryFileProvider({
      url: 'https://mao.example.com/uploads/7/send-uuid.md',
      filename: 'SKILL.md',
      mime: 'text/markdown',
    })

    const readRes = await provider.readFile('SKILL.md', { offset: 0, limit: 2 })
    expect(readRes.content).toBe('line1\nline2')
    expect(readRes.total_lines).toBe(3)

    const bytesRes = await provider.readFileBytes!('SKILL.md')
    expect(bytesRes.size).toBe(payloadBytes.byteLength)

    const pdfRes = await provider.previewFile!('SKILL.md')
    expect(pdfRes.blob?.size).toBe(payloadBytes.byteLength)

    const dlRes = await provider.downloadFile!('SKILL.md', 'SKILL.md')
    expect(dlRes.ok).toBe(true)
    expect(anchor.download).toBe('SKILL.md')
    expect(anchor.click).toHaveBeenCalledTimes(1)
  })

  it('活引用形态 A（2026-11-20 §5.2）：workspace-download 业务错误信封报错，不存成文件 / 不渲染信封文本', async () => {
    // CLOUD workspace-download 的业务错误（如「文件不存在」）经 handleError 映射为 HTTP 200 + code 信封
    const refUrl = 'http://localhost:9080/api/v1/files/workspace-download?sessionId=42&path=reports%2Fa.png&token=t'
    const envelope = {
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === 'content-type' ? 'application/json; charset=utf-8' : null) },
      json: async () => ({ code: 1002, message: '文件不存在：reports/a.png' }),
      arrayBuffer: async () => new TextEncoder().encode('{"code":1002}').buffer,
    }
    vi.stubGlobal('fetch', vi.fn(async () => envelope))
    const provider = createDeliveryFileProvider({
      url: refUrl,
      filename: 'a.png',
      mime: 'image/png',
    })

    const readRes = await provider.readFile('a.png')
    expect(readRes.error).toBe('文件不存在：reports/a.png')
    expect(readRes.content).toBe('')

    const bytesRes = await provider.readFileBytes!('a.png')
    expect(bytesRes.error).toBe('文件不存在：reports/a.png')
    expect(bytesRes.bytes).toBeUndefined()

    const pdfRes = await provider.previewFile!('a.png')
    expect(pdfRes.error).toBe('文件不存在：reports/a.png')

    const dlRes = await downloadDeliveryUrl(refUrl, 'a.png')
    expect(dlRes).toEqual({ ok: false, error: '文件不存在：reports/a.png', url: refUrl })
  })

  it('/uploads 静态 URL 不触发信封判定：含数字 code 字段的 JSON 文件照常下载', async () => {
    const payload = new TextEncoder().encode('{"code":1002,"hello":1}')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k === 'content-type' ? 'application/json' : null) },
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      blob: async () => new Blob([payload]),
    })))
    const provider = createDeliveryFileProvider({
      url: 'https://mao.example.com/uploads/7/send-uuid.json',
      filename: 'data.json',
      mime: 'application/json',
    })
    const bytesRes = await provider.readFileBytes!('data.json')
    expect(bytesRes.error).toBeUndefined()
    expect(bytesRes.size).toBe(payload.byteLength)
  })
})
