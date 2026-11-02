import { describe, expect, it, vi } from 'vitest'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('../utils/auth-storage', () => ({
  getToken: () => 'token',
}))

import { createCloudProvider } from './workspace-file-provider'

describe('createCloudProvider listDirectory mtime 映射', () => {
  it('把后端 mtimeMs 映射为前端 mtime', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        entries: [
          { name: 'a.txt', path: 'a.txt', isDirectory: false, size: 3, isSymlink: false, mtimeMs: 1700000000000 },
          { name: 'src', path: 'src', isDirectory: true, size: 4096, isSymlink: false, mtimeMs: 1699999999000 },
        ],
        truncated: false,
      },
    })
    const provider = createCloudProvider('42')
    const result = await provider.listDirectory('')

    expect(result.error).toBeUndefined()
    expect(result.entries?.[0].mtime).toBe(1700000000000)
    expect(result.entries?.[1].mtime).toBe(1699999999000)
  })

  it('后端未返回 mtimeMs 时不臆造时间', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: {
        entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 3, isSymlink: false }],
        truncated: false,
      },
    })
    const provider = createCloudProvider('42')
    const result = await provider.listDirectory('')

    expect(result.entries?.[0].mtime).toBeUndefined()
  })

  it('把只读标记和 403 文案交给文件页', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: { entries: [], truncated: false, readOnly: true, workspaceRoot: '/ws' },
    })
    const provider = createCloudProvider('42')
    const listing = await provider.listDirectory('团队经验')
    expect(listing.readOnly).toBe(true)

    vi.mocked(api.get).mockRejectedValueOnce({
      message: 'Request failed with status code 403',
      response: { data: { message: '路径访问被拒绝' } },
    })
    const read = await provider.readFile('团队经验')
    expect(read.error).toBe('路径访问被拒绝')
  })

  it('按请求参数带上 sessionId 与 dir', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { entries: [] } })
    const provider = createCloudProvider('42')
    await provider.listDirectory('src')

    expect(api.get).toHaveBeenCalledWith('/files/workspace-directory', {
      params: { sessionId: 42, dir: 'src' },
    })
  })
})
