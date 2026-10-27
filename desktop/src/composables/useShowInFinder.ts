/**
 * 「在 Finder 中显示」出口（与 FileTree 的 handleOpenInFinder 同源，走 Electron 既有
 * IPC，preload.cjs:55）。
 *
 * 为什么抽成 composable：MediaPlayer 与 ArchiveBrowser / SpreadsheetView / DocxPreview
 * 的降级态都要它。降级态原本只有「下载后在本地查看」按钮，而 LOCAL provider 没有
 * downloadFile（createLocalProvider 未实现下载），按钮随 v-if 隐藏后降级态就成了死路
 * ——文件就在本机，至少要让用户能定位到它。判定同时要求 Electron 壳（electronAPI）
 * 与 provider 的 getAbsolutePath，CLOUD / Web 下自动不可用。
 */
import { computed } from 'vue'
import type { WorkspaceFileProvider } from './workspace-file-provider'

export function useShowInFinder(
  getProvider: () => WorkspaceFileProvider | null,
  getFilePath: () => string,
) {
  const canShowInFinder = computed(
    () =>
      typeof window !== 'undefined' &&
      !!window.electronAPI?.showItemInFolder &&
      !!getProvider()?.getAbsolutePath,
  )

  function showInFinder(): void {
    const abs = getProvider()?.getAbsolutePath?.(getFilePath())
    if (abs) window.electronAPI?.showItemInFolder?.(abs)
  }

  return { canShowInFinder, showInFinder }
}
