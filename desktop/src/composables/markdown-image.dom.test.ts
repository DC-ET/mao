// @vitest-environment jsdom
// 回归锁定：正文 Markdown 里的工作区相对图片必须能在渲染后被解析成可访问地址，
// 否则浏览器按页面地址请求 /screenshots/... 得到 404（线上裂图的根因）。
import { describe, expect, it, vi } from 'vitest'

vi.mock('../utils/auth-storage', () => ({ getToken: () => 'jwt-token' }))

const { renderMarkdown } = await import('./useMarkdown')
const { decorateMarkdownImages } = await import('../utils/markdownImages')

describe('正文 Markdown 工作区图片', () => {
  it('相对路径图片渲染后按会话改写为可访问地址', async () => {
    const html = await renderMarkdown('截图（完成态）：\n\n![Cursor 提交推送完成](screenshots/cursor-done.png)')
    // marked 默认 image renderer 原样保留相对路径——这正是裂图来源
    expect(html).toContain('src="screenshots/cursor-done.png"')

    const root = document.createElement('div')
    root.innerHTML = html
    decorateMarkdownImages(root, { sessionId: '42', executionMode: 'CLOUD' })

    const img = root.querySelector('img')!
    expect(img.getAttribute('src')).toBe(
      'http://localhost:9080/api/v1/files/workspace-download?sessionId=42&path=screenshots%2Fcursor-done.png&token=jwt-token',
    )
    expect(img.getAttribute('alt')).toBe('Cursor 提交推送完成')
  })

  it('外链图片不受影响', async () => {
    const html = await renderMarkdown('![图](https://etarch.oss-cn-hangzhou.aliyuncs.com/uploads/a.png)')
    const root = document.createElement('div')
    root.innerHTML = html
    decorateMarkdownImages(root, { sessionId: '42', executionMode: 'CLOUD' })
    expect(root.querySelector('img')!.getAttribute('src'))
      .toBe('https://etarch.oss-cn-hangzhou.aliyuncs.com/uploads/a.png')
  })
})
