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
        lastScrollHeight = el.scrollHeight
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
    lastScrollHeight = -1
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

  // 上次 scroll 事件的 scrollTop 与 scrollHeight：只有位置**向上**移动才算用户上滑。
  // 兄弟面板（QueuePanel / ApprovalStack / QuestionPanel）出现会压缩
  // clientHeight，此时 scrollTop 不变而「距底」骤增，不能当成用户上滑；
  // 同理，消息列表被 REST 结果整体覆盖（终态回填 / roundLimit 截断）导致
  // 内容塌陷时，浏览器会把 scrollTop 向下钳制到新的最大可滚动值——位置
  // 绝对值反而变小，单看方向会误判为用户上滑，把跟随永久关死，
  // 表现为发送消息后停在顶部且后续流式输出也不再滚动。
  // 还有一类：发送消息使 sending 变 true，ChatRoundList 把最后一轮从折叠态
  // 展开为平铺，内容变高、scrollTop 相对变小——这同样是布局变化而非手势。
  let lastScrollTop = -1
  let lastScrollHeight = -1

  function handleScroll() {
    const el = container.value
    if (!el || disposed || programmatic) return
    // 替换缓存消息、浏览器滚动锚定产生的 scroll 不代表用户上滑。
    if (restoring && !userScrolledUp.value) return
    if (el.scrollTop !== lastScrollTop && el.scrollTop > 0) {
      // 内容塌陷（scrollHeight 缩小）时 scrollTop 的变化是浏览器钳制，不是用户手势；
      // 内容增高（追加消息 / 展开轮次）时 scrollTop 的位移是浏览器滚动锚定的副作用，
      // 用户同样没有产生任何手势。二者都不得据此停止跟随。
      const contentShrank = lastScrollHeight >= 0 && el.scrollHeight < lastScrollHeight - 2
      const contentGrew = lastScrollHeight >= 0 && el.scrollHeight > lastScrollHeight + 2
      if (lastScrollTop < 0) {
        // 无基准（容器重建 / 首帧）：无从判断方向，按距底推断
        userScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM
      } else if (contentShrank || contentGrew) {
        // 布局变化（塌陷钳制 / 追加消息 / 展开轮次）不是用户手势，不得据此
        // 停止跟随；已上滑时仍按距底判断用户是否已滚回底部。
        if (userScrolledUp.value) {
          userScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight >= NEAR_BOTTOM
        }
      } else if (el.scrollTop < lastScrollTop - SCROLL_UP_TOLERANCE) {
        // 位置向上移动超过容差 = 用户主动上滑，停止跟随
        userScrolledUp.value = true
      } else if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) {
        // 位置向下且已回到近底部 = 恢复跟随；距底仍远时保持当前状态
        userScrolledUp.value = false
      }
    }
    lastScrollTop = el.scrollTop
    lastScrollHeight = el.scrollHeight
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
      lastScrollHeight = el.scrollHeight
    })
  }

  function cancelRestore() {
    generation++
    clearTimer()
    restoring = false
    loading = false
    programmatic = false
    lastScrollTop = -1
    lastScrollHeight = -1
  }

  /** 容器重建（中心态 → 会话态）后重新开始度量，避免拿旧容器的 scrollTop 当基准 */
  function resetScrollBaseline() {
    lastScrollTop = -1
    lastScrollHeight = -1
  }

  function dispose() {
    disposed = true
    cancelRestore()
  }

  return { userScrolledUp, scrollToBottom, beginRestore, completeRestore,
    handleMarkdownRendered, handleWheel, handleTouchStart, handleTouchMove, handleScroll,
    cancelRestore, resetScrollBaseline, dispose }
}
