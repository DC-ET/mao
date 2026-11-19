import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isUploadCancelled, uploadWorkspace } from './workspace-file-write'

const messageError = vi.fn()
const messageBoxConfirm = vi.fn()

vi.mock('element-plus', () => ({
  ElMessage: {
    error: (...args: unknown[]) => messageError(...args),
    success: vi.fn(),
    info: vi.fn(),
  },
  ElMessageBox: {
    confirm: (...args: unknown[]) => messageBoxConfirm(...args),
  },
}))

vi.mock('../api', () => ({
  api: { post: vi.fn(), delete: vi.fn() },
}))

vi.mock('../utils/auth-storage', () => ({
  getToken: () => 'token',
}))

class FakeXHR {
  static instances: FakeXHR[] = []
  upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
  timeout = 0
  responseText = ''
  aborted = false
  sent = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXHR.instances.push(this)
  }

  open() {}

  setRequestHeader() {}

  abort() {
    this.aborted = true
    this.onabort?.()
  }

  send() {
    this.sent = true
  }
}

function oneFile() {
  return [{ file: new File(['hello'], 'a.txt'), relativePath: 'a.txt' }]
}

beforeEach(() => {
  FakeXHR.instances = []
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
  messageError.mockReset()
  messageBoxConfirm.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadWorkspace 取消', () => {
  it('取消会中止正在上传的请求，且不提示失败', async () => {
    const controller = new AbortController()
    const pending = uploadWorkspace(1, '.', oneFile(), undefined, undefined, controller.signal)
    expect(FakeXHR.instances).toHaveLength(1)
    expect(FakeXHR.instances[0]!.sent).toBe(true)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'UploadCancelledError' })
    expect(FakeXHR.instances[0]!.aborted).toBe(true)
    expect(isUploadCancelled(await pending.catch((error: unknown) => error))).toBe(true)
    expect(messageError).not.toHaveBeenCalled()
  })

  it('开始前已取消则不发请求', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(uploadWorkspace(1, '.', oneFile(), undefined, undefined, controller.signal))
      .rejects.toMatchObject({ name: 'UploadCancelledError' })
    expect(FakeXHR.instances.filter((xhr) => xhr.sent)).toHaveLength(0)
  })

  it('确认覆盖期间取消则不会重传', async () => {
    const controller = new AbortController()
    messageBoxConfirm.mockImplementation(async () => {
      controller.abort()
    })
    const pending = uploadWorkspace(1, '.', oneFile(), undefined, undefined, controller.signal)
    const xhr = FakeXHR.instances[0]!
    xhr.responseText = JSON.stringify({ code: 3045, message: '目标已存在' })
    xhr.onload?.()
    await expect(pending).rejects.toMatchObject({ name: 'UploadCancelledError' })
    expect(FakeXHR.instances.filter((item) => item.sent)).toHaveLength(1)
    expect(messageError).not.toHaveBeenCalled()
  })

  it('网络失败仍提示错误', async () => {
    const pending = uploadWorkspace(1, '.', oneFile())
    FakeXHR.instances[0]!.onerror?.()
    await expect(pending).rejects.toThrow('上传失败，请重试')
    expect(messageError).toHaveBeenCalledWith('上传失败，请重试')
  })
})
