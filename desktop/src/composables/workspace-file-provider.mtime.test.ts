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

  it('按请求参数带上 sessionId 与 dir', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { entries: [] } })
    const provider = createCloudProvider('42')
    await provider.listDirectory('src')

    expect(api.get).toHaveBeenCalledWith('/files/workspace-directory', {
      params: { sessionId: 42, dir: 'src' },
    })
  })
})
