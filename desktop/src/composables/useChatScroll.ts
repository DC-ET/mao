import { nextTick, ref, type Ref } from 'vue'

/** 判定「用户上滑」时离底部的像素阈值（含一点容差，避免亚像素抖动） */
const NEAR_BOTTOM = 80
/** scrollTop 向上移动超过该像素数才算主动上滑（容忍 1-2px 的回弹） */
const SCROLL_UP_TOLERANCE = 2

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
        // 同步基准：紧随其后的 scroll 事件（programmatic 已复位）不应被判为「向上移动」
        lastScrollTop = el.scrollTop
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
    lastScrollTop = -1
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

  // 上次 scroll 事件的 scrollTop：只有位置**向上**移动才算用户上滑。
  // 兄弟面板（QueuePanel / ApprovalStack / QuestionPanel）出现会压缩
  // clientHeight，此时 scrollTop 不变而「距底」骤增，不能当成用户上滑。
  let lastScrollTop = -1

  function handleScroll() {
    const el = container.value
    if (!el || disposed || programmatic) return
    // 替换缓存消息、浏览器滚动锚定产生的 scroll 不代表用户上滑。
    if (restoring && !userScrolledUp.value) return
    // scrollTop 未变化（布局压缩 / 内容替换导致的 scroll）不改变跟随状态；
    // scrollTop 为 0 时容器刚创建或被完全挤压，同样不是用户主动上滑。
    if (el.scrollTop !== lastScrollTop && el.scrollTop > 0) {
      const scrolledUp = el.scrollTop < lastScrollTop - SCROLL_UP_TOLERANCE
      userScrolledUp.value = scrolledUp || (el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM)
    }
    lastScrollTop = el.scrollTop
    if (loading || !userScrolledUp.value || el.scrollTop > 120 || !options.canLoadOlder()) return
    const current = generation
    const oldHeight = el.scrollHeight
    const oldTop = el.scrollTop
    void options.loadOlder().then(async loaded => {
      await nextTick()
      if (!loaded || disposed || current !== generation || !userScrolledUp.value || container.value !== el) return
      el.scrollTop = oldTop + el.scrollHeight - oldHeight
      // 同步基准：追加历史后位置是「保持」而非「上滑」
      lastScrollTop = el.scrollTop
    })
  }

  function cancelRestore() {
    generation++
    clearTimer()
    restoring = false
    loading = false
    programmatic = false
    lastScrollTop = -1
  }

  /** 容器重建（中心态 → 会话态）后重新开始度量，避免拿旧容器的 scrollTop 当基准 */
  function resetScrollBaseline() {
    lastScrollTop = -1
  }

  function dispose() {
    disposed = true
    cancelRestore()
  }

  return { userScrolledUp, scrollToBottom, beginRestore, completeRestore,
    handleMarkdownRendered, handleWheel, handleTouchStart, handleTouchMove, handleScroll,
    cancelRestore, resetScrollBaseline, dispose }
}
