import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { executeLocalFileOp, FILE_OP_MAX_FRAME_BYTES } from './local-file-op'

function stubElectronApi(overrides: Record<string, Mock> = {}) {
  ;(globalThis as any).window = {
    electronAPI: {
      listDirectory: overrides.listDirectory ?? vi.fn(async () => ({ entries: [], truncated: false })),
      localReadFile: overrides.localReadFile ?? vi.fn(async () => ({ content: 'hi', total_lines: 1 })),
      listWorkspaceFiles: overrides.listWorkspaceFiles ?? vi.fn(async () => [{ path: 'a.txt', name: 'a.txt', size: 1 }]),
    },
  }
}

afterEach(() => {
  delete (globalThis as any).window
  vi.restoreAllMocks()
})

const BASE_REQUEST = { requestId: 'r1', workspace: '/Users/yang/proj' }

describe('executeLocalFileOp（LOCAL 文件代理设备端执行器）', () => {
  it('非 Electron 环境回不支持文案，不抛错', async () => {
    ;(globalThis as any).window = {}
    const frame = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'list', params: {} })
    expect(frame).toEqual({
      type: 'file_op_result', sessionId: 11, requestId: 'r1', ok: false, error: '当前客户端不支持执行文件操作',
    })
  })

  it('list：相对路径解析后调 listDirectory 并透传 workspace', async () => {
    const listDirectory = vi.fn(async () => ({ entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false, mtime: 1 }], truncated: false }))
    stubElectronApi({ listDirectory })
    const frame = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'list', params: { dir: 'src' } })
    expect(frame.ok).toBe(true)
    expect(listDirectory).toHaveBeenCalledWith('/Users/yang/proj/src', '/Users/yang/proj')
    expect((frame.data as { entries: unknown[] }).entries).toHaveLength(1)
  })

  it('list：缺省 dir 视为工作区根', async () => {
    const listDirectory = vi.fn(async () => ({ entries: [], truncated: false }))
    stubElectronApi({ listDirectory })
    await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'list', params: {} })
    expect(listDirectory).toHaveBeenCalledWith('/Users/yang/proj', '/Users/yang/proj')
  })

  it('containment 校验：.. 逃逸与绝对路径越界一律拒绝（localReadFile 无 IPC 侧校验）', async () => {
    const localReadFile = vi.fn()
    stubElectronApi({ localReadFile })
    for (const path of ['../../etc/passwd', '/etc/passwd', 'a/../../../etc/passwd']) {
      const frame = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'read', params: { path } })
      expect(frame.ok).toBe(false)
      expect(frame.error).toBe('路径越出工作区范围')
    }
    expect(localReadFile).not.toHaveBeenCalled()
  })

  it('containment 校验：Windows 盘符工作区的相对 / 绝对路径放行与越界拒绝', async () => {
    const localReadFile = vi.fn(async () => ({ content: 'x', total_lines: 1 }))
    stubElectronApi({ localReadFile })
    const winRequest = { requestId: 'r1', workspace: 'C:\\Users\\yang\\proj' }
    for (const path of ['a.txt', 'C:\\Users\\yang\\proj\\a.txt', 'sub\\..\\b.txt']) {
      const frame = await executeLocalFileOp(11, { ...winRequest, op: 'read', params: { path } })
      expect(frame.ok).toBe(true)
    }
    // 盘符头部拼接必须带分隔符：否则工作区内合法路径会被误判越界（曾致 Windows 全废）
    expect(localReadFile).toHaveBeenLastCalledWith({ path: 'C:\\Users\\yang\\proj\\b.txt', offset: 0, limit: 5000 })
    for (const path of ['..\\escape.txt', 'D:\\evil.txt', 'C:\\Users\\other\\secret']) {
      const frame = await executeLocalFileOp(11, { ...winRequest, op: 'read', params: { path } })
      expect(frame.ok).toBe(false)
      expect(frame.error).toBe('路径越出工作区范围')
    }
    expect(localReadFile).toHaveBeenCalledTimes(3)
  })

  it('containment 校验：UNC 工作区放行内部路径、拒绝越界', async () => {
    const localReadFile = vi.fn(async () => ({ content: 'x', total_lines: 1 }))
    stubElectronApi({ localReadFile })
    const uncRequest = { requestId: 'r1', workspace: '\\\\server\\share\\ws' }
    const inside = await executeLocalFileOp(11, { ...uncRequest, op: 'read', params: { path: 'f.txt' } })
    expect(inside.ok).toBe(true)
    expect(localReadFile).toHaveBeenLastCalledWith({ path: '\\\\server\\share\\ws\\f.txt', offset: 0, limit: 5000 })
    const outside = await executeLocalFileOp(11, { ...uncRequest, op: 'read', params: { path: '..\\..\\other\\x' } })
    expect(outside.ok).toBe(false)
    // workspace 退化为根目录：包含性失去意义，一律拒绝
    const root = await executeLocalFileOp(11, { requestId: 'r1', workspace: '/', op: 'read', params: { path: '/etc/passwd' } })
    expect(root.ok).toBe(false)
  })

  it('read：工作区内的相对与绝对路径放行', async () => {
    const localReadFile = vi.fn(async () => ({ content: 'x', total_lines: 1 }))
    stubElectronApi({ localReadFile })
    await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'read', params: { path: 'docs/../a.txt' } })
    expect(localReadFile).toHaveBeenCalledWith({ path: '/Users/yang/proj/a.txt', offset: 0, limit: 5000 })
    await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'read', params: { path: '/Users/yang/proj/sub/b.txt' } })
    expect(localReadFile).toHaveBeenLastCalledWith({ path: '/Users/yang/proj/sub/b.txt', offset: 0, limit: 5000 })
  })

  it('设备端 IPC 返回 { error } 字段时收敛为失败帧', async () => {
    stubElectronApi({ listDirectory: vi.fn(async () => ({ error: 'Access denied: path outside workspace' })) })
    const frame = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'list', params: { dir: 'x' } })
    expect(frame.ok).toBe(false)
    expect(frame.error).toBe('Access denied: path outside workspace')
  })

  it('search：透传 pattern/limit，经 searchLocalWorkspace 逐层 IPC 遍历', async () => {
    const listDirectory = vi.fn(async (abs: string) => {
      if (abs === '/Users/yang/proj') {
        return {
          entries: [
            { name: 'src', path: 'src', isDirectory: true, size: 0, isSymlink: false },
            { name: 'target-report.txt', path: 'target-report.txt', isDirectory: false, size: 1, isSymlink: false },
          ],
          truncated: false,
        }
      }
      return { entries: [], truncated: false }
    })
    stubElectronApi({ listDirectory })
    const frame = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'search', params: { pattern: 'report', limit: 50 } })
    expect(frame.ok).toBe(true)
    expect((frame.data as { entries: Array<{ name: string }> }).entries.map((e) => e.name)).toEqual(['target-report.txt'])
    // 空 pattern 直接拒绝
    const bad = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'search', params: { pattern: ' ' } })
    expect(bad.ok).toBe(false)
  })

  it('files：透传 workspace/filter/limit 调 listWorkspaceFiles', async () => {
    const listWorkspaceFiles = vi.fn(async () => [{ path: 'a.txt', name: 'a.txt', size: 1 }])
    stubElectronApi({ listWorkspaceFiles })
    const frame = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'files', params: { filter: 'a', limit: 20 } })
    expect(frame.ok).toBe(true)
    expect(listWorkspaceFiles).toHaveBeenCalledWith('/Users/yang/proj', 'a', 20)
    expect(frame.data).toEqual([{ path: 'a.txt', name: 'a.txt', size: 1 }])
  })

  it('尺寸预检按最终整帧 UTF-8 字节：中文长文本超 700KB 回友好错误且错误帧本身远小于上限', async () => {
    // 300k 个中文字符 = UTF-16 长度 30 万（字符串 length 预检会误判在限内），UTF-8 ≈ 900KB
    const big = '中'.repeat(300_000)
    expect(big.length).toBeLessThan(FILE_OP_MAX_FRAME_BYTES)
    stubElectronApi({ localReadFile: vi.fn(async () => ({ content: big, total_lines: 1 })) })
    const frame = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'read', params: { path: 'a.txt' } })
    expect(frame.ok).toBe(false)
    expect(frame.error).toBe('文件过大，移动端暂不支持查看该文件')
    expect(JSON.stringify(frame).length).toBeLessThan(200)
  })

  it('正常尺寸内容不受预检影响', async () => {
    stubElectronApi({ localReadFile: vi.fn(async () => ({ content: 'x'.repeat(100_000), total_lines: 1 })) })
    const frame = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'read', params: { path: 'a.txt' } })
    expect(frame.ok).toBe(true)
    expect(JSON.stringify(frame).length).toBeLessThan(FILE_OP_MAX_FRAME_BYTES)
  })

  it('未知 op 与异常 IPC 都收敛为失败帧（永不向服务端抛错）', async () => {
    stubElectronApi({ listDirectory: vi.fn(async () => { throw new Error('IPC failed') }) })
    const unknownOp = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'evil' as never, params: {} })
    expect(unknownOp.ok).toBe(false)
    const ipcError = await executeLocalFileOp(11, { ...BASE_REQUEST, op: 'list', params: {} })
    expect(ipcError.ok).toBe(false)
    expect(ipcError.error).toBe('IPC failed')
  })
})
