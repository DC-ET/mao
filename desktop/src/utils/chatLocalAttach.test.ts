import { beforeEach, describe, expect, it, vi } from 'vitest'

const el = vi.hoisted(() => ({ error: vi.fn() }))
const storageMode = vi.hoisted(() => ({ getUploadConfig: vi.fn() }))

vi.mock('element-plus', () => ({ ElMessage: { error: el.error } }))
vi.mock('./storageMode', () => storageMode)

import { copyLocalPendingFiles, type LocalPendingFile } from './chatLocalAttach'

const localCopyAttachment = vi.fn()

function makeFile(name: string): File {
  return new File([`content-${name}`], name, { type: 'application/octet-stream' })
}

function makePending(name: string, localPath = `/tmp/src/${name}`): LocalPendingFile {
  return { file: makeFile(name), localPath }
}

function installElectronApi(present = true) {
  if (present) {
    ;(globalThis as any).window = { electronAPI: { localCopyAttachment } }
  } else {
    ;(globalThis as any).window = {}
  }
}

describe('copyLocalPendingFiles（LOCAL 懒拷贝到 ~/.mao/attachments）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageMode.getUploadConfig.mockResolvedValue({ storageMode: 'oss', baseUrl: '', maxSizeMb: 50 })
    installElectronApi()
  })

  it('全部成功：追加 @{absolutePath}@ 引用（与 CLOUD uploadPendingFiles 同结构）', async () => {
    localCopyAttachment.mockImplementation(async (params: any) => ({
      ok: true,
      absolutePath: `/home/u/.mao/attachments/host/${params.sessionId}/${params.sourcePath.split('/').pop()}`,
    }))
    const result = await copyLocalPendingFiles('请看这个文件', [makePending('a.txt'), makePending('b.txt')], '12')
    expect(result.copiedCount).toBe(2)
    expect(result.text).toBe(
      '请看这个文件\n@{/home/u/.mao/attachments/host/12/a.txt}@ @{/home/u/.mao/attachments/host/12/b.txt}@'
    )
    // 入参：sessionId 转数字、maxSizeMb 走后端上传配置（与 CLOUD 同口径）
    expect(localCopyAttachment).toHaveBeenCalledWith({
      sourcePath: '/tmp/src/a.txt',
      sessionId: 12,
      maxSizeMb: 50,
    })
  })

  it('原文为空：引用直接作为消息文本', async () => {
    localCopyAttachment.mockResolvedValue({ ok: true, absolutePath: '/home/u/.mao/attachments/host/1/a.txt' })
    const result = await copyLocalPendingFiles('', [makePending('a.txt')], '1')
    expect(result.text).toBe('@{/home/u/.mao/attachments/host/1/a.txt}@')
    expect(result.copiedCount).toBe(1)
  })

  it('部分失败：失败文件提示、不阻断其余', async () => {
    localCopyAttachment.mockImplementation(async (params: any) =>
      params.sourcePath.endsWith('b.txt')
        ? { ok: false, error: '文件超过 50MB 限制' }
        : { ok: true, absolutePath: `/abs/${params.sourcePath.split('/').pop()}` }
    )
    const result = await copyLocalPendingFiles('文本', [makePending('a.txt'), makePending('b.txt')], '3')
    expect(result.copiedCount).toBe(1)
    expect(result.text).toBe('文本\n@{/abs/a.txt}@')
    expect(el.error).toHaveBeenCalledWith('文件 b.txt 文件超过 50MB 限制')
  })

  it('全部失败：返回原文本与 copiedCount=0（由 guardUploadsBeforeSend 阻断发送）', async () => {
    localCopyAttachment.mockResolvedValue({ ok: false, error: '文件已不存在，可能已被移动或删除' })
    const result = await copyLocalPendingFiles('文本', [makePending('a.txt')], '3')
    expect(result.copiedCount).toBe(0)
    expect(result.text).toBe('文本')
    expect(el.error).toHaveBeenCalledWith('文件 a.txt 文件已不存在，可能已被移动或删除')
  })

  it('invoke 抛异常时按拷贝失败提示，不影响其余文件', async () => {
    localCopyAttachment.mockImplementation(async (params: any) => {
      if (params.sourcePath.endsWith('a.txt')) throw new Error('ipc broken')
      return { ok: true, absolutePath: '/abs/b.txt' }
    })
    const result = await copyLocalPendingFiles('', [makePending('a.txt'), makePending('b.txt')], '3')
    expect(result.copiedCount).toBe(1)
    expect(el.error).toHaveBeenCalledWith('文件 a.txt 拷贝失败')
  })

  it('localPath 为空（取不到路径）：按加入失败提示', async () => {
    const result = await copyLocalPendingFiles('', [makePending('a.txt', '')], '3')
    expect(result.copiedCount).toBe(0)
    expect(localCopyAttachment).not.toHaveBeenCalled()
    expect(el.error).toHaveBeenCalledWith('文件 a.txt 加入失败：无法获取文件路径')
  })

  it('非 Electron（无 electronAPI）：逐个提示不支持', async () => {
    installElectronApi(false)
    const result = await copyLocalPendingFiles('文本', [makePending('a.txt')], '3')
    expect(result.copiedCount).toBe(0)
    expect(result.text).toBe('文本')
    expect(el.error).toHaveBeenCalledWith('文件 a.txt 加入失败：当前客户端不支持本地附件')
  })

  it('getUploadConfig 失败时 maxSizeMb 传 undefined（主进程回落默认上限）', async () => {
    storageMode.getUploadConfig.mockRejectedValue(new Error('no config'))
    localCopyAttachment.mockResolvedValue({ ok: true, absolutePath: '/abs/a.txt' })
    await copyLocalPendingFiles('', [makePending('a.txt')], '3')
    expect(localCopyAttachment).toHaveBeenCalledWith({
      sourcePath: '/tmp/src/a.txt',
      sessionId: 3,
      maxSizeMb: undefined,
    })
  })
})
