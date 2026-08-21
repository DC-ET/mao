/**
 * 将图片 URL 列表转为 File 对象（用于队列消息撤回到输入框时回填附件区）。
 * 任一图片获取失败即整体抛错，由调用方决定中止撤回。
 */
export async function fetchImagesAsFiles(urls: string[]): Promise<File[]> {
  const files: File[] = []
  for (const url of urls) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!resp.ok) throw new Error(`图片获取失败（HTTP ${resp.status}）`)
    const blob = await resp.blob()
    const rawName = url.split('/').pop()?.split('?')[0] || ''
    const name = rawName || `image-${Date.now()}-${files.length + 1}.png`
    files.push(new File([blob], name, { type: blob.type || 'image/png' }))
  }
  return files
}
