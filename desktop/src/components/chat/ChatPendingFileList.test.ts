/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import ChatPendingFileList from './ChatPendingFileList.vue'

function imageFile(name = 'shot.png'): File {
  return new File(['x'], name, { type: 'image/png' })
}

function textFile(name = 'doc.txt'): File {
  return new File(['x'], name, { type: 'text/plain' })
}

interface Entry { file: File; previewUrl: string; localPath?: string; originalFile?: File }

function mountList(items: Entry[], options: { disabled?: boolean; onAnnotate?: (index: number) => void; onRemove?: (index: number) => void } = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      return () => h(ChatPendingFileList, {
        pendingFiles: items,
        disabled: options.disabled ?? false,
        removeFile: options.onRemove ?? (() => {}),
        onAnnotate: options.onAnnotate,
      })
    },
  })
  app.config.warnHandler = () => {}
  app.mount(el)
  return {
    destroy() {
      app.unmount()
      el.remove()
    },
  }
}

function annotateButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.annotate-file')) as HTMLElement[]
}

describe('ChatPendingFileList 图片轻标注', () => {
  let mounted: ReturnType<typeof mountList> | null = null
  afterEach(() => { mounted?.destroy() })

  it('图片条目渲染标注按钮（aria-label + title 双写）；非图片条目不渲染', () => {
    mounted = mountList([
      { file: imageFile(), previewUrl: 'blob:a' },
      { file: textFile(), previewUrl: '' },
    ])
    const buttons = annotateButtons()
    expect(buttons.length).toBe(1)
    expect(buttons[0].getAttribute('aria-label')).toBe('标注图片')
    expect(buttons[0].getAttribute('title')).toBe('标注图片')
    // 移除按钮仍对两种条目都渲染
    expect(document.querySelectorAll('.remove-file').length).toBe(2)
  })

  it('点击标注按钮 emit annotate(index)', async () => {
    const onAnnotate = vi.fn()
    mounted = mountList([{ file: imageFile(), previewUrl: 'blob:a' }, { file: imageFile('b.png'), previewUrl: 'blob:b' }], { onAnnotate })
    annotateButtons()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(onAnnotate).toHaveBeenCalledWith(1)
  })

  it('disabled 守卫：点击不触发回调（与移除按钮同款交互守卫）', async () => {
    const onAnnotate = vi.fn()
    const onRemove = vi.fn()
    mounted = mountList([{ file: imageFile(), previewUrl: 'blob:a' }], { disabled: true, onAnnotate, onRemove })
    annotateButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.querySelector('.remove-file')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(onAnnotate).not.toHaveBeenCalled()
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('originalFile 字段在类型上可携带（不影响渲染）', () => {
    const original = imageFile('原始.png')
    mounted = mountList([{ file: imageFile('shot-annotated.png'), previewUrl: 'blob:c', originalFile: original }])
    expect(annotateButtons().length).toBe(1)
    expect(document.querySelector('.file-name')?.textContent).toBe('shot-annotated.png')
  })
})
