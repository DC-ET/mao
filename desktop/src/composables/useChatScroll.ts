import { nextTick, ref, type Ref } from 'vue'

/** 主聊天的滚动生命周期；每次切换都作废旧帧、恢复定时器和分页定位。 */
export function useChatScroll(container: Ref<HTMLElement | undefined>, options: {
  loadOlder: () => Promise<boolean>
  canLoadOlder: () => boolean
}) {
  const userScrolledUp = ref(false)
  let generation = 0
  let restoring = false
  let loading = false
  let programmatic = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function scrollToBottom() {
    const current = generation
    void nextTick(() => {
      requestAnimationFrame(() => {
        const el = container.value
        if (disposed || current !== generation || userScrolledUp.value || !el) return
        programmatic = true
        el.scrollTop = el.scrollHeight
        requestAnimationFrame(() => {
          if (current === generation) programmatic = false
        })
      })
    })
  }

  function beginRestore() {
    clearTimer()
    generation++
    restoring = true
    loading = true
    programmatic = false
    userScrolledUp.value = false
    touchY = undefined
    return generation
  }

  function settleRestore() {
    clearTimer()
    if (loading) return
    timer = setTimeout(() => {
      restoring = false
      scrollToBottom()
    }, 300)
  }

  function completeRestore(current: number) {
    if (disposed || current !== generation) return
    loading = false
    scrollToBottom()
    settleRestore()
  }

  function handleMarkdownRendered() {
    // 高亮/Markdown 可能晚于恢复窗口完成；只要用户未上滑，仍跟随到底部。
    scrollToBottom()
    if (restoring) settleRestore()
  }

  function handleWheel(event: WheelEvent) {
    if (event.deltaY < 0) userScrolledUp.value = true
  }

  let touchY: number | undefined
  function handleTouchStart(event: TouchEvent) {
    touchY = event.touches[0]?.clientY
  }
  function handleTouchMove(event: TouchEvent) {
    const y = event.touches[0]?.clientY
    if (y != null && touchY != null && y > touchY) userScrolledUp.value = true
    touchY = y
  }

  function handleScroll() {
    const el = container.value
    if (!el || disposed || programmatic) return
    // 替换缓存消息、浏览器滚动锚定产生的 scroll 不代表用户上滑。
    if (restoring && !userScrolledUp.value) return
    userScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight >= 80
    if (loading || !userScrolledUp.value || el.scrollTop > 120 || !options.canLoadOlder()) return
    const current = generation
    const oldHeight = el.scrollHeight
    const oldTop = el.scrollTop
    void options.loadOlder().then(async loaded => {
      await nextTick()
      if (!loaded || disposed || current !== generation || !userScrolledUp.value || container.value !== el) return
      el.scrollTop = oldTop + el.scrollHeight - oldHeight
    })
  }

  function cancelRestore() {
    generation++
    clearTimer()
    restoring = false
    loading = false
    programmatic = false
  }

  function dispose() {
    disposed = true
    cancelRestore()
  }

  return { userScrolledUp, scrollToBottom, beginRestore, completeRestore,
    handleMarkdownRendered, handleWheel, handleTouchStart, handleTouchMove, handleScroll, cancelRestore, dispose }
}
