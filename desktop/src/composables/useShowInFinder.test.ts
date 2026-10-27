// @vitest-environment jsdom
// useShowInFinder 判定回归（技术方案 §5.7 / review round1 #5）：Electron 壳 +
// provider.getAbsolutePath 双条件缺一不可，点击走 showItemInFolder IPC 且以
// getAbsolutePath 的返回值为参数。LOCAL 降级态靠它避免死路。
import { describe, expect, it, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { useShowInFinder } from './useShowInFinder'
import type { WorkspaceFileProvider } from './workspace-file-provider'

type WindowLike = { electronAPI?: { showItemInFolder?: (p: string) => void } }

function setElectronApi(api: WindowLike['electronAPI']): void {
  ;(window as unknown as WindowLike).electronAPI = api
}

function clearElectronApi(): void {
  delete (window as unknown as WindowLike).electronAPI
}

afterEach(() => {
  clearElectronApi()
})

describe('useShowInFinder', () => {
  it('Electron 壳 + getAbsolutePath 齐备：可用，点击带绝对路径调 IPC', async () => {
    const shown: string[] = []
    setElectronApi({ showItemInFolder: (p: string) => { shown.push(p) } })
    const provider = { getAbsolutePath: (p: string) => `/Users/u/work/${p}` } as unknown as WorkspaceFileProvider

    const { canShowInFinder, showInFinder } = useShowInFinder(() => provider, () => 'report.xlsx')
    await nextTick()
    expect(canShowInFinder.value).toBe(true)

    showInFinder()
    expect(shown).toEqual(['/Users/u/work/report.xlsx'])
  })

  it('非 Electron 壳（Web / 安卓）：不可用，不调 IPC', async () => {
    clearElectronApi()
    const provider = { getAbsolutePath: (p: string) => `/Users/u/work/${p}` } as unknown as WorkspaceFileProvider
    const { canShowInFinder, showInFinder } = useShowInFinder(() => provider, () => 'a.zip')
    await nextTick()
    expect(canShowInFinder.value).toBe(false)
    // 直接调用也不应抛（无 electronAPI 时静默无操作）
    expect(() => showInFinder()).not.toThrow()
  })

  it('CLOUD provider 无 getAbsolutePath：不可用', async () => {
    setElectronApi({ showItemInFolder: vi.fn() })
    const provider = {} as unknown as WorkspaceFileProvider
    const { canShowInFinder } = useShowInFinder(() => provider, () => 'a.zip')
    await nextTick()
    expect(canShowInFinder.value).toBe(false)
  })

  it('provider 为 null（未就绪）：不可用', async () => {
    setElectronApi({ showItemInFolder: vi.fn() })
    const { canShowInFinder } = useShowInFinder(() => null, () => 'a.zip')
    await nextTick()
    expect(canShowInFinder.value).toBe(false)
  })

  it('getAbsolutePath 返回空：不调 IPC（守卫 falsy 路径）', () => {
    const spy = vi.fn()
    setElectronApi({ showItemInFolder: spy })
    const provider = { getAbsolutePath: () => '' } as unknown as WorkspaceFileProvider
    const { showInFinder } = useShowInFinder(() => provider, () => 'a.zip')
    showInFinder()
    expect(spy).not.toHaveBeenCalled()
  })
})
