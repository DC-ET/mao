import { beforeEach, describe, expect, it, vi } from 'vitest'

const el = vi.hoisted(() => ({ error: vi.fn() }))
const storageMode = vi.hoisted(() => ({ getUploadConfig: vi.fn() }))
const api = vi.hoisted(() => ({ post: vi.fn() }))

vi.mock('element-plus', () => ({ ElMessage: { error: el.error } }))
vi.mock('./storageMode', () => storageMode)
vi.mock('../api', () => ({ api }))

import { uploadImages } from './imageUpload'

/** 可编程的 XHR 桩：覆盖 open/setRequestHeader/send/onload/onerror。 */
class FakeXhr {
  static nextStatus = 200
  static sent: FakeXhr[] = []
  status = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  method = ''
  url = ''
  body: unknown = null
  headers: Record<string, string> = {}
  open(_m: string, url: string) {
    this.method = _m
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: unknown) {
    this.body = body
    FakeXhr.sent.push(this)
    this.status = FakeXhr.nextStatus
    this.onload?.()
  }
}

const TICKET = {
  uploadUrl: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/uploads/1/1_a.png?x-oss-signature=sig',
  key: 'uploads/1/1_a.png',
  publicUrl: 'https://bucket.oss-cn-hangzhou.aliyuncs.com/uploads/1/1_a.png',
  expiration: '2026-11-21T03:35:45.000Z',
}

describe('uploadImages（图片附件上传分流）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    FakeXhr.nextStatus = 200
    FakeXhr.sent = []
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest)
  })

  it('local 模式走 /files/upload multipart', async () => {
    storageMode.getUploadConfig.mockResolvedValue({ storageMode: 'local', baseUrl: '', maxSizeMb: 50 })
    api.post.mockResolvedValue({ data: { url: '/uploads/1/a.png' } })
    const urls = await uploadImages([new File(['x'], 'a.png', { type: 'image/png' })], '7')
    expect(api.post).toHaveBeenCalledWith('/files/upload', expect.any(FormData), expect.anything())
    expect(api.post).not.toHaveBeenCalledWith('/upload/ticket', expect.anything())
    expect(urls).toEqual(['/uploads/1/a.png'])
  })

  it('对象存储模式先领票据再 PUT 直传，返回 publicUrl（不感知云厂商）', async () => {
    storageMode.getUploadConfig.mockResolvedValue({ storageMode: 'cos', baseUrl: '', maxSizeMb: 50 })
    api.post.mockResolvedValue({ data: TICKET })
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const urls = await uploadImages([file], '7')
    expect(api.post).toHaveBeenCalledWith('/upload/ticket', { contentType: 'image/png', fileName: 'a.png' })
    expect(FakeXhr.sent).toHaveLength(1)
    expect(FakeXhr.sent[0].method).toBe('PUT')
    expect(FakeXhr.sent[0].url).toBe(TICKET.uploadUrl)
    // OSS 会把请求 Content-Type 计入预签名，必须与领票据时的 contentType 完全一致
    expect(FakeXhr.sent[0].headers['Content-Type']).toBe('image/png')
    expect(FakeXhr.sent[0].body).toBe(file)
    expect(urls).toEqual([TICKET.publicUrl])
  })

  it('票据接口失败时提示且不 PUT', async () => {
    storageMode.getUploadConfig.mockResolvedValue({ storageMode: 'obs', baseUrl: '', maxSizeMb: 50 })
    api.post.mockRejectedValue(new Error('未配置'))
    const urls = await uploadImages([new File(['x'], 'a.png', { type: 'image/png' })], '7')
    expect(FakeXhr.sent).toHaveLength(0)
    expect(el.error).toHaveBeenCalledWith('图片 a.png 上传失败')
    expect(urls).toEqual([])
  })

  it('直传非 2xx 时提示失败', async () => {
    storageMode.getUploadConfig.mockResolvedValue({ storageMode: 'oss', baseUrl: '', maxSizeMb: 50 })
    api.post.mockResolvedValue({ data: TICKET })
    FakeXhr.nextStatus = 403
    const urls = await uploadImages([new File(['x'], 'a.png', { type: 'image/png' })], '7')
    expect(urls).toEqual([])
    expect(el.error).toHaveBeenCalledWith('图片 a.png 上传失败')
  })

  it('local 模式单文件失败只提示不阻断其余', async () => {
    storageMode.getUploadConfig.mockResolvedValue({ storageMode: 'local', baseUrl: '', maxSizeMb: 50 })
    api.post.mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ data: { url: '/uploads/1/b.png' } })
    const urls = await uploadImages([
      new File(['x'], 'a.png', { type: 'image/png' }),
      new File(['y'], 'b.png', { type: 'image/png' }),
    ], '7')
    expect(urls).toEqual(['/uploads/1/b.png'])
    expect(el.error).toHaveBeenCalledTimes(1)
  })
})
