import { describe, expect, it } from 'vitest'
import { resolveDocsClick } from './docsLink'

const slugs = new Set(['project', 'business_process', 'install', 'deploy', 'electron', 'desktop'])
const reference = 'skills/mao-cli/reference/desktop.md'
const business = 'skills/mao-cli/business_process.md'

describe('resolveDocsClick', () => {
  it('总览卡片走站内文档路由', () => {
    expect(resolveDocsClick('/docs/project', null, slugs)).toEqual({
      type: 'route',
      path: '/docs/project',
      hash: ''
    })
    expect(resolveDocsClick('/docs', null, slugs)).toEqual({
      type: 'route',
      path: '/docs',
      hash: ''
    })
    expect(resolveDocsClick('/docs/', null, slugs)).toEqual({
      type: 'route',
      path: '/docs',
      hash: ''
    })
  })

  it('站内文档路由保留锚点', () => {
    expect(resolveDocsClick('/docs/deploy#上线清单', null, slugs)).toEqual({
      type: 'route',
      path: '/docs/deploy',
      hash: '#上线清单'
    })
  })

  it('正文相对链接定位到站内文档', () => {
    expect(resolveDocsClick('electron.md', reference, slugs)).toEqual({
      type: 'route',
      path: '/docs/electron',
      hash: ''
    })
    expect(resolveDocsClick('../business_process.md', reference, slugs)).toEqual({
      type: 'route',
      path: '/docs/business_process',
      hash: ''
    })
    expect(resolveDocsClick('reference/install.md#准备', business, slugs)).toEqual({
      type: 'route',
      path: '/docs/install',
      hash: '#准备'
    })
  })

  it('当前页锚点只滚动', () => {
    expect(resolveDocsClick('#本页目录', reference, slugs)).toEqual({
      type: 'anchor',
      id: '本页目录'
    })
  })

  it('已编码的中文锚点只解一次', () => {
    const encoded = encodeURIComponent('回复引用溯源')
    expect(resolveDocsClick(`desktop.md#${encoded}`, reference, slugs)).toEqual({
      type: 'route',
      path: '/docs/desktop',
      hash: '#回复引用溯源'
    })
    expect(resolveDocsClick(`#${encoded}`, reference, slugs)).toEqual({
      type: 'anchor',
      id: '回复引用溯源'
    })
  })

  it('对不上文档集的仓库文件留在当前页', () => {
    expect(
      resolveDocsClick('../../docs/guides/single-domain-nginx-migration.md', reference, slugs)
    ).toEqual({ type: 'none' })
    expect(resolveDocsClick('scripts/deploy-desktop.sh', reference, slugs)).toEqual({ type: 'none' })
    expect(resolveDocsClick('/docs/project', null, slugs).type).not.toBe('none')
  })

  it('外链不拦截', () => {
    expect(resolveDocsClick('https://github.com/DC-ET/mao/blob/main/README.md', reference, slugs)).toEqual({
      type: 'ignore'
    })
    expect(resolveDocsClick('mailto:a@b.com', reference, slugs)).toEqual({ type: 'ignore' })
    expect(resolveDocsClick('   ', reference, slugs)).toEqual({ type: 'ignore' })
  })
})
