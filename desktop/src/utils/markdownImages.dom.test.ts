// @vitest-environment jsdom
// 正文图片解析 + 失败回退（utils/markdownImages）：桌面 vitest 全局是 node 环境，本文件单开 DOM。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authState = vi.hoisted(() => ({ token: null as string | null }))
vi.mock('./auth-storage', () => ({ getToken: () => authState.token }))

const { BROKEN_IMAGE_CLASS, decorateMarkdownImages, isWorkspaceRelativeImageSrc, toWorkspaceImageUrl } =
  await import('./markdownImages')

const CLOUD = { sessionId: '42', executionMode: 'CLOUD' }

function imgRoot(src: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `<img src="${src}" alt="截图">`
  return root
}

beforeEach(() => {
  authState.token = null
})

describe('isWorkspaceRelativeImageSrc', () => {
  it('相对路径 / ./ 前缀算工作区相对路径', () => {
    expect(isWorkspaceRelativeImageSrc('screenshots/a.png')).toBe(true)
    expect(isWorkspaceRelativeImageSrc(' ./screenshots/a.png ')).toBe(true)
  })

  it('http(s) / data: / 协议相对 / 站内绝对路径都不改写', () => {
    expect(isWorkspaceRelativeImageSrc('https://a.com/x.png')).toBe(false)
    expect(isWorkspaceRelativeImageSrc('data:image/png;base64,AAA')).toBe(false)
    expect(isWorkspaceRelativeImageSrc('//cdn.a.com/x.png')).toBe(false)
    expect(isWorkspaceRelativeImageSrc('/uploads/x.png')).toBe(false)
  })

  it('空值不算', () => {
    expect(isWorkspaceRelativeImageSrc('')).toBe(false)
    expect(isWorkspaceRelativeImageSrc(null)).toBe(false)
    expect(isWorkspaceRelativeImageSrc(undefined)).toBe(false)
  })
})

describe('toWorkspaceImageUrl', () => {
  it('CLOUD 会话改写为文件下载地址（path 保留原始相对路径）', () => {
    const url = toWorkspaceImageUrl('./screenshots/截图 1.png', CLOUD)
    expect(url).toBe(
      'http://localhost:9080/api/v1/files/workspace-download?sessionId=42&path=screenshots%2F%E6%88%AA%E5%9B%BE+1.png',
    )
  })

  it('有 token 时追加 query token（img 无法带 Authorization 头）', () => {
    authState.token = 'jwt-token'
    const url = toWorkspaceImageUrl('a.png', CLOUD)
    expect(url).toContain('token=jwt-token')
  })

  it('LOCAL 会话与 CLOUD 同构：改写同一下载地址（LOCAL 由后端按需委托执行端读取）', () => {
    const url = toWorkspaceImageUrl('a.png', { sessionId: '1', executionMode: 'LOCAL' })
    expect(url).toBe('http://localhost:9080/api/v1/files/workspace-download?sessionId=1&path=a.png')
  })

  it('缺会话 / 绝对 URL / 空路径不改写', () => {
    expect(toWorkspaceImageUrl('a.png', null)).toBeNull()
    expect(toWorkspaceImageUrl('https://a.com/x.png', CLOUD)).toBeNull()
    expect(toWorkspaceImageUrl('./', CLOUD)).toBeNull()
  })
})

describe('decorateMarkdownImages', () => {
  it('CLOUD 会话：改写 src，原路径保留在 data-md-src', () => {
    const root = imgRoot('screenshots/x.png')
    decorateMarkdownImages(root, CLOUD)
    const img = root.querySelector('img')!
    expect(img.getAttribute('src')).toContain('/files/workspace-download?sessionId=42&path=screenshots%2Fx.png')
    expect(img.getAttribute('data-md-src')).toBe('screenshots/x.png')
  })

  it('加载失败：img 换成「📎 原路径」文本，而不是破图图标', () => {
    const root = imgRoot('screenshots/x.png')
    decorateMarkdownImages(root, CLOUD)
    const img = root.querySelector('img')!
    img.dispatchEvent(new Event('error'))
    const placeholder = root.querySelector(`.${BROKEN_IMAGE_CLASS}`)!
    expect(root.querySelector('img')).toBeNull()
    expect(placeholder.textContent).toBe('📎 screenshots/x.png')
    expect(placeholder.getAttribute('title')).toBe('图片未加载：screenshots/x.png')
  })

  it('LOCAL 会话：改写为委托下载地址并带 lazy（执行端离线时由后端报错 → 回退文本）', () => {
    const root = imgRoot('screenshots/x.png')
    decorateMarkdownImages(root, { sessionId: '1', executionMode: 'LOCAL' })
    const img = root.querySelector('img')!
    expect(img.getAttribute('src')).toContain('/files/workspace-download?sessionId=1&path=screenshots%2Fx.png')
    expect(img.getAttribute('loading')).toBe('lazy')
    img.dispatchEvent(new Event('error'))
    expect(root.querySelector(`.${BROKEN_IMAGE_CLASS}`)?.textContent).toBe('📎 screenshots/x.png')
  })

  it('改写成功的图片补 loading=lazy（长消息多图削峰）', () => {
    const root = document.createElement('div')
    root.innerHTML = '<img src="a.png"><img src="https://a.com/x.png">'
    decorateMarkdownImages(root, CLOUD)
    const imgs = root.querySelectorAll('img')
    expect(imgs[0].getAttribute('loading')).toBe('lazy') // 工作区相对图片改写后带 lazy
    expect(imgs[1].hasAttribute('loading')).toBe(false) // 站外图片不改写也不加 lazy
  })

  it('幂等：重复处理不重复拼地址、不重复挂监听', () => {
    const root = imgRoot('screenshots/x.png')
    decorateMarkdownImages(root, CLOUD)
    const first = root.querySelector('img')!.getAttribute('src')
    decorateMarkdownImages(root, CLOUD)
    expect(root.querySelector('img')!.getAttribute('src')).toBe(first)
    expect(root.querySelector('img')!.getAttribute('data-md-src')).toBe('screenshots/x.png')
  })
})
