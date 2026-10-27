// @vitest-environment jsdom
// MediaPlayer 接线回归（技术方案 §5.7 / §9）：音视频 blob URL 生命周期、
// 50MB 阈值降级（决策 5）、下载 / Finder 出口显隐、KeepAlive 暂停释放与回前台重建。
// 无第三方解析库，被接线的正是 URL.createObjectURL 调用序列与元素分支。
import { readFileSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, ref, isRef, defineComponent, createRenderer, KeepAlive, type Ref } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

vi.mock('@element-plus/icons-vue', () => ({
  Refresh: { render: () => null },
  Download: { render: () => null },
}))

import MediaPlayer from './MediaPlayer.vue'

// jsdom 环境下 import.meta.url 是 http scheme，readFileSync 只吃 file:——按 cwd 拼路径
const sfcPath = pathJoin(process.cwd(), 'src/components/center/MediaPlayer.vue')
const descriptor = parse(readFileSync(sfcPath, 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'media-player' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ClientPlayer = {
  ...(MediaPlayer as object),
  render: clientRender,
}

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown>; pause: () => void }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const createElement = (tag: string): StubEl => ({
    tag,
    children: [],
    parent: null,
    props: {},
    // 模板 ref 拿到的是 stub 元素：pause 必须是可观测的 spy，否则暂停逻辑无从断言
    pause: vi.fn(),
  })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
    createElement,
    createText,
    createComment: () => createText(''),
    setText: (n: StubNode, t: string) => { if ('text' in n) n.text = String(t) },
    setElementText: (el: StubEl, t: string) => { el.children = [{ text: t, parent: el }] },
    insert: (child: StubNode, parent: StubEl, anchor?: StubNode | null) => {
      child.parent = parent
      const at = anchor == null ? -1 : parent.children.indexOf(anchor)
      if (at < 0) parent.children.push(child)
      else parent.children.splice(at, 0, child)
    },
    remove: (child: StubNode) => {
      const p = child.parent
      if (p && !('text' in child)) {
        const i = p.children.indexOf(child)
        if (i >= 0) p.children.splice(i, 1)
      }
      child.parent = null
    },
    parentNode: (n: StubNode) => n.parent ?? null,
    nextSibling: (n: StubNode) => {
      const p = n.parent
      if (!p) return null
      return p.children[p.children.indexOf(n) + 1] ?? null
    },
    querySelector: () => null,
    setScopeId: () => {},
    cloneNode: (el: StubEl) => el,
    insertStaticContent: () => [createElement('static-start'), createElement('static-end')] as [StubEl, StubEl],
    patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => { el.props[key] = next },
  }
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

function collectText(node: StubNode | null): string {
  if (node == null) return ''
  if ('text' in node) return node.text
  return node.children.map((child) => collectText(child)).join(' ')
}

function flatText(root: StubEl): string {
  return collectText(root).replace(/\s+/g, ' ')
}

function findAll(node: StubNode | null, pred: (el: StubEl) => boolean): StubEl[] {
  if (node == null || 'text' in node) return []
  const self = pred(node) ? [node] : []
  return [...self, ...node.children.flatMap((child) => findAll(child, pred))]
}

function byTag(tag: string) {
  return (el: StubEl) => el.tag === tag
}

function byClass(cls: string) {
  return (el: StubEl) => typeof el.props.class === 'string' && el.props.class.split(' ').includes(cls)
}

function click(el: StubEl) {
  ;(el.props.onClick as (() => void) | undefined)?.()
}

interface BlobRecord { type: string; size: number }
let blobSeq = 0
let created: BlobRecord[] = []
let revoked: string[] = []

/** 在测试内替换 URL.createObjectURL / revokeObjectURL，记录调用序列 */
function stubUrlApi() {
  blobSeq = 0
  created = []
  revoked = []
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobSeq += 1
    created.push({ type: blob.type, size: blob.size })
    return `blob:mock-${blobSeq}`
  }) as never
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url)
  }) as never
}

function restoreUrlApi() {
  delete (URL as unknown as Record<string, unknown>).createObjectURL
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL
}

interface MountOptions {
  provider?: Record<string, unknown> | null
  /** 挂到 KeepAlive 下，返回的 toggle 可切走再切回（onDeactivated / onActivated） */
  keepAlive?: boolean
}

async function mountPlayer(
  bytes: Uint8Array | Ref<Uint8Array>,
  filePath = 'clip.mp4',
  options: MountOptions = {},
): Promise<{ root: StubEl; toggle?: () => void }> {
  const bytesRef = isRef(bytes) ? bytes : ref(bytes)
  const provider = options.provider ?? null
  const props = () => ({ filePath, bytes: bytesRef.value, provider })

  if (options.keepAlive) {
    const visible = ref(true)
    const Placeholder = defineComponent({ render: () => h('div', { class: 'placeholder' }, 'other') })
    const Host = defineComponent({
      render: () =>
        h(KeepAlive, null, {
          default: () => (visible.value ? h(ClientPlayer as never, props() as never) : h(Placeholder)),
        }),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    const errors: unknown[] = []
    app.config.warnHandler = () => {}
    app.config.errorHandler = (err) => { errors.push(err) }
    app.mount(root as never)
    if (errors.length) throw errors[0]
    await flush()
    return { root, toggle: () => { visible.value = !visible.value } }
  }

  const Host = defineComponent({
    render: () => h(ClientPlayer as never, props() as never),
  })
  const ops = nodeOps()
  const { createApp } = createRenderer(ops)
  const root = ops.createElement('root')
  const app = createApp(Host)
  const errors: unknown[] = []
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  app.mount(root as never)
  if (errors.length) throw errors[0]
  await flush()
  return { root }
}

describe('MediaPlayer 播放与生命周期', () => {
  beforeEach(() => {
    stubUrlApi()
  })

  afterEach(() => {
    restoreUrlApi()
  })

  it('mp4：渲染 video 元素，blob URL 带上 video/mp4 MIME（§5.7 白名单）', async () => {
    const { root } = await mountPlayer(new Uint8Array([1, 2, 3, 4]), 'clip.mp4')

    const video = findAll(root, byTag('video'))[0]
    expect(video).toBeDefined()
    expect(findAll(root, byTag('audio'))).toHaveLength(0)
    expect(video.props.src).toBe('blob:mock-1')
    expect(created).toHaveLength(1)
    expect(created[0].type).toBe('video/mp4')
    expect(created[0].size).toBe(4)
    // 工具条展示文件名与类型/大小
    expect(flatText(root)).toContain('clip.mp4')
    expect(flatText(root)).toContain('视频')
  })

  it('mp3：渲染 audio 元素，blob URL 带上 audio/mpeg MIME', async () => {
    const { root } = await mountPlayer(new Uint8Array([9, 9]), 'song.mp3')

    const audio = findAll(root, byTag('audio'))[0]
    expect(audio).toBeDefined()
    expect(findAll(root, byTag('video'))).toHaveLength(0)
    expect(audio.props.src).toBe('blob:mock-1')
    expect(created[0].type).toBe('audio/mpeg')
    expect(flatText(root)).toContain('音频')
  })

  it('文件内容为空：错误态提示，不建 blob URL', async () => {
    const { root } = await mountPlayer(new Uint8Array(0), 'empty.mp4')

    expect(created).toHaveLength(0)
    expect(flatText(root)).toContain('文件内容为空')
    expect(findAll(root, byTag('video'))).toHaveLength(0)
  })

  it('超过 50MB：不建 blob URL，展示降级文案并自动触发下载（决策 5）', async () => {
    const downloadCalls: Array<[string, string]> = []
    const provider = {
      downloadFile: async (path: string, name: string) => {
        downloadCalls.push([path, name])
        return { ok: true }
      },
    }
    const { root } = await mountPlayer(
      new Uint8Array(50 * 1024 * 1024 + 1),
      'huge.mov',
      { provider },
    )

    expect(created).toHaveLength(0)
    expect(downloadCalls).toEqual([['huge.mov', 'huge.mov']])
    expect(flatText(root)).toContain('已转为下载')
    expect(flatText(root)).toContain('不直接播放')
    expect(findAll(root, byTag('video'))).toHaveLength(0)
  })

  it('超过 50MB 且无 downloadFile（project 模式）：仅展示降级文案，不报错', async () => {
    const { root } = await mountPlayer(new Uint8Array(50 * 1024 * 1024 + 1), 'huge.mp4')

    expect(created).toHaveLength(0)
    expect(flatText(root)).toContain('已转为下载')
    expect(findAll(root, byClass('error'))).toHaveLength(0)
  })

  it('LOCAL：有 downloadFile 时工具条渲染下载按钮，点击走 provider.downloadFile', async () => {
    const downloadCalls: Array<[string, string]> = []
    const provider = {
      downloadFile: async (path: string, name: string) => {
        downloadCalls.push([path, name])
        return { ok: true }
      },
    }
    const { root } = await mountPlayer(new Uint8Array([1]), 'a.mp4', { provider })

    const dlBtn = findAll(root, byClass('tool-btn')).find((el) => (el.props.title as string) === '下载')
    expect(dlBtn).toBeDefined()
    // 有 downloadFile 就不渲染 Finder 按钮（二选一）
    expect(findAll(root, byClass('tool-btn')).some((el) => el.props.title === '在 Finder 中显示')).toBe(false)
    click(dlBtn!)
    await flush()
    expect(downloadCalls).toEqual([['a.mp4', 'a.mp4']])
  })

  it('无 downloadFile 时（LOCAL Electron）：「在 Finder 中显示」按钮调起既有 IPC', async () => {
    const shown: string[] = []
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      showItemInFolder: (abs: string) => { shown.push(abs) },
    }
    try {
      const provider = { getAbsolutePath: (path: string) => `/Users/u/work/${path}` }
      const { root } = await mountPlayer(new Uint8Array([1]), 'b.mp3', { provider })

      const btn = findAll(root, byClass('tool-btn')).find((el) => el.props.title === '在 Finder 中显示')
      expect(btn).toBeDefined()
      click(btn!)
      await flush()
      expect(shown).toEqual(['/Users/u/work/b.mp3'])
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
    }
  })

  it('CLOUD：无 electronAPI 时两个按钮都不渲染，只留刷新', async () => {
    const { root } = await mountPlayer(new Uint8Array([1]), 'c.webm')

    const buttons = findAll(root, byClass('tool-btn'))
    expect(buttons.every((el) => el.props.title !== '下载')).toBe(true)
    expect(buttons.every((el) => el.props.title !== '在 Finder 中显示')).toBe(true)
    expect(buttons.some((el) => el.props.title === '刷新')).toBe(true)
  })

  it('卸载：暂停播放并释放 blob URL（§5.7 生命周期纪律）', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const Host = defineComponent({
      render: () => h(ClientPlayer as never, { filePath: 'd.mp4', bytes, provider: null } as never),
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(Host)
    const errors: unknown[] = []
    app.config.warnHandler = () => {}
    app.config.errorHandler = (err) => { errors.push(err) }
    app.mount(root as never)
    if (errors.length) throw errors[0]
    await flush()

    const video = findAll(root, byTag('video'))[0]
    expect(created).toHaveLength(1)
    app.unmount()
    await flush()

    expect(video.pause).toHaveBeenCalledTimes(1)
    expect(revoked).toEqual(['blob:mock-1'])
  })
  it('刷新造新 bytes：重建 blob URL 前先释放旧的（§6-A3 变更重载）', async () => {
    const bytesRef = ref(new Uint8Array([1]))
    const { root } = await mountPlayer(bytesRef, 'e.mp4')

    expect(findAll(root, byTag('video'))[0].props.src).toBe('blob:mock-1')
    bytesRef.value = new Uint8Array([2, 3])
    await flush()

    expect(created).toHaveLength(2)
    expect(revoked).toEqual(['blob:mock-1'])
    expect(findAll(root, byTag('video'))[0].props.src).toBe('blob:mock-2')
  })

  it('KeepAlive 切走：暂停并释放 blob URL；切回：按需重建（A5）', async () => {
    const { root, toggle } = await mountPlayer(new Uint8Array([1, 2]), 'f.mp4', { keepAlive: true })

    const video = findAll(root, byTag('video'))[0]
    expect(video.props.src).toBe('blob:mock-1')
    expect(created).toHaveLength(1)

    toggle!()
    await flush()
    expect(video.pause).toHaveBeenCalledTimes(1)
    expect(revoked).toEqual(['blob:mock-1'])
    // KeepAlive 只隐藏不移除 DOM：元素仍在树里（浏览器侧不可见），
    // 关键是播放已停、blob URL 已释放，回前台按需重建

    toggle!()
    await flush()
    expect(created).toHaveLength(2)
    const restored = findAll(root, byTag('video'))[0]
    expect(restored.props.src).toBe('blob:mock-2')
  })

  it('刷新按钮：emit refresh 交回 FileViewer 重走 dispatch（§5.8 工具条范式）', async () => {
    const refreshes: number[] = []
    const ClientWithListener = defineComponent({
      emits: ['refresh'],
      render() {
        return h(ClientPlayer as never, {
          filePath: 'g.mp4',
          bytes: new Uint8Array([1]),
          provider: null,
          onRefresh: () => refreshes.push(1),
        } as never)
      },
    })
    const ops = nodeOps()
    const { createApp } = createRenderer(ops)
    const root = ops.createElement('root')
    const app = createApp(ClientWithListener)
    app.config.warnHandler = () => {}
    app.mount(root as never)
    await flush()

    const refreshBtn = findAll(root, byClass('tool-btn')).find((el) => el.props.title === '刷新')
    expect(refreshBtn).toBeDefined()
    click(refreshBtn!)
    await flush()
    expect(refreshes).toEqual([1])
  })

  it('mp4 / mov：常驻编解码依赖标注（技术方案 §6-G2 ★）', async () => {
    const mp4 = await mountPlayer(new Uint8Array([1]), 'clip.mp4')
    expect(flatText(mp4.root)).toContain('依赖编解码支持')
    const mov = await mountPlayer(new Uint8Array([1]), 'clip.mov')
    expect(flatText(mov.root)).toContain('依赖编解码支持')
    // webm / 音频不标注（白名单优先格式）
    const webm = await mountPlayer(new Uint8Array([1]), 'clip.webm')
    expect(flatText(webm.root)).not.toContain('依赖编解码支持')
    expect(flatText(webm.root)).toContain('视频')
  })

  it('播放失败（@error）：落错误态给出下载 / Finder 出口，不停在黑屏上（G2 兜底）', async () => {
    const downloadCalls: Array<[string, string]> = []
    const provider = {
      downloadFile: async (path: string, name: string) => {
        downloadCalls.push([path, name])
        return { ok: true }
      },
    }
    const { root } = await mountPlayer(new Uint8Array([1]), 'clip.mp4', { provider })
    const video = findAll(root, byTag('video'))[0]
    expect(video).toBeDefined()

    ;(video.props.onError as (() => void) | undefined)?.()
    await flush()

    expect(flatText(root)).toContain('播放失败')
    expect(flatText(root)).toContain('编解码')
    expect(findAll(root, byTag('video'))).toHaveLength(0)
    // 元素已摘掉：blob URL 同步释放，不白占内存
    expect(revoked).toEqual(['blob:mock-1'])
    const dlBtn = findAll(root, byClass('retry-btn'))[0]
    expect(dlBtn).toBeDefined()
    click(dlBtn)
    await flush()
    expect(downloadCalls).toEqual([['clip.mp4', 'clip.mp4']])
  })

  it('LOCAL 播放失败且无 downloadFile：错误态给「在 Finder 中显示」出口', async () => {
    const shown: string[] = []
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      showItemInFolder: (p: string) => { shown.push(p) },
    }
    try {
      const provider = { getAbsolutePath: (p: string) => `/Users/u/work/${p}` }
      const { root } = await mountPlayer(new Uint8Array([1]), 'clip.mp4', { provider })
      const video = findAll(root, byTag('video'))[0]
      ;(video.props.onError as (() => void) | undefined)?.()
      await flush()

      const finderBtn = findAll(root, byClass('retry-btn')).find((el) => collectText(el).includes('在 Finder 中显示'))
      expect(finderBtn).toBeDefined()
      click(finderBtn!)
      await flush()
      expect(shown).toEqual(['/Users/u/work/clip.mp4'])
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
    }
  })
})
