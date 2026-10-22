import { nextTick, ref, watch, type Ref } from 'vue'
import { scrollElementToMessage } from '../components/search/search-highlight'

/** 判定「用户上滑」时离底部的像素阈值（含一点容差，避免亚像素抖动） */
const NEAR_BOTTOM = 80
/** scrollTop 向上移动超过该像素数才算主动上滑（容忍 1-2px 的回弹） */
const SCROLL_UP_TOLERANCE = 2
/**
 * 手势窗口：只有手势（滚轮/触摸/按键/鼠标按下）之后这段时间内派发的 scroll，
 * 才允许改变「是否跟随」。窗口外一切 scrollTop 位移都是布局产物——浏览器钳制、
 * 滚动锚定、兄弟面板挤压、内容塌陷——不得据此关闭跟随。
 */
const GESTURE_WINDOW_MS = 250
/** 两次自动定位的最小间隔：合并流式高频重排，降低与用户手势抢帧的概率 */
const FOLLOW_MIN_INTERVAL_MS = 50
/**
 * 自动补位的最大距底距离（倍屏）。超过说明用户已经真正离开底部，不再强行拉回；
 * 「跟随中但底部被面板挤走」通常只有几十到几百 px，远小于该上限。
 */
const MAX_FOLLOW_DISTANCE_RATIO = 2

/**
 * 对话区滚动控制器：主会话 / 边路任务 / 子代理共用同一套实现。
 *
 * 状态只有两个来源，不再从 scroll 事件反推意图：
 * - 用户手势（滚轮上滑、触摸下拉）→ 停止跟随；
 * - 用户手势结束时已回到近底部 → 恢复跟随；
 * - 显式动作（发送消息、切回 Tab、点「回到最新」）→ resumeFollow()。
 *
 * 触发定位也不靠枚举事件，而是 ResizeObserver 观察容器与内容子元素的尺寸：
 * 队列面板/审批卡/软键盘压缩 clientHeight、流式文本/图片/工具卡片撑高内容，
 * 都会走到同一个 scheduleFollow()。
 */
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
  let followRaf: number | undefined
  let followTimer: ReturnType<typeof setTimeout> | undefined
  let lastFollowAt = Number.NEGATIVE_INFINITY
  /** 最近一次用户手势的时间戳；初值 -Infinity 保证首帧 scroll 一律按布局处理 */
  let lastGestureAt = Number.NEGATIVE_INFINITY
  let resizeObserver: ResizeObserver | undefined
  let mutationObserver: MutationObserver | undefined

  // 上次 scroll 事件的 scrollTop / scrollHeight，仅用于手势窗口内的方向判定
  let lastScrollTop = -1
  let lastScrollHeight = -1

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function distanceFromBottom(el: HTMLElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }

  function syncBaseline(el: HTMLElement) {
    lastScrollTop = el.scrollTop
    lastScrollHeight = el.scrollHeight
  }

  function cancelScheduledFollow() {
    if (followRaf != null) {
      cancelAnimationFrame(followRaf)
      followRaf = undefined
    }
    if (followTimer != null) {
      clearTimeout(followTimer)
      followTimer = undefined
    }
  }

  /** 停止跟随：手势上滑的唯一副作用，同时取消已经排队的定位帧 */
  function stopFollowing() {
    userScrolledUp.value = true
    cancelScheduledFollow()
  }

  /** 真正写到底部；只在跟随中、且底部确实离开视口时才写 */
  function writeBottom() {
    const el = container.value
    if (!el || disposed || userScrolledUp.value) return
    const dist = distanceFromBottom(el)
    if (dist <= 1) return
    if (dist > el.clientHeight * MAX_FOLLOW_DISTANCE_RATIO) return
    programmatic = true
    el.scrollTop = el.scrollHeight
    syncBaseline(el)
    lastFollowAt = performance.now()
    requestAnimationFrame(() => {
      programmatic = false
    })
  }

  /** 尺寸变化的统一入口：rAF 合并 + 最小间隔，避免每帧强制布局 */
  function scheduleFollow() {
    if (disposed || userScrolledUp.value) return
    if (followRaf != null || followTimer != null) return
    const wait = Math.max(0, FOLLOW_MIN_INTERVAL_MS - (performance.now() - lastFollowAt))
    if (wait === 0) {
      followRaf = requestAnimationFrame(() => {
        followRaf = undefined
        writeBottom()
      })
      return
    }
    followTimer = setTimeout(() => {
      followTimer = undefined
      scheduleFollow()
    }, wait)
  }

  function scrollToBottom() {
    const current = generation
    void nextTick(() => {
      requestAnimationFrame(() => {
        const el = container.value
        if (disposed || current !== generation || userScrolledUp.value || !el) return
        programmatic = true
        el.scrollTop = el.scrollHeight
        syncBaseline(el)
        lastFollowAt = performance.now()
        requestAnimationFrame(() => {
          if (current === generation) programmatic = false
        })
      })
    })
  }

  /**
   * 显式「恢复跟随」：发送消息、切回 Tab、点「回到最新」等动作调用。
   * 与 scrollToBottom 的差别是它不信任当前的上滑状态——这些动作本身就代表
   * 用户要看最新内容，不能因为历史上一次（可能是布局引起的）误判继续停在原处。
   */
  function resumeFollow() {
    userScrolledUp.value = false
    scrollToBottom()
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
    cancelScheduledFollow()
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
    // 高亮/Markdown 可能晚于恢复窗口完成；尺寸变化本身由 ResizeObserver 兜底，
    // 这里只补一次调度（重复调用会被 scheduleFollow 合并）。
    scheduleFollow()
    if (restoring) settleRestore()
  }

  function markGesture() {
    lastGestureAt = performance.now()
  }

  function handleWheel(event: WheelEvent) {
    // 双指缩放（ctrl+wheel）不是滚动，不能被当成上滑
    if (event.ctrlKey) return
    markGesture()
    if (event.deltaY < 0) stopFollowing()
  }

  let touchY: number | undefined
  function handleTouchStart(event: TouchEvent) {
    markGesture()
    touchY = event.touches[0]?.clientY
  }
  function handleTouchMove(event: TouchEvent) {
    markGesture()
    const y = event.touches[0]?.clientY
    if (y != null && touchY != null && y > touchY) stopFollowing()
    touchY = y
  }

  /** 鼠标按下：覆盖中键自动滚动 / 拖拽选择等没有 wheel 事件的滚动来源 */
  function handlePointerDown() {
    markGesture()
  }

  function handleScroll() {
    const el = container.value
    if (!el || disposed) return
    // 程序写入与恢复期替换缓存产生的 scroll 不代表任何意图
    if (programmatic || (restoring && !userScrolledUp.value)) {
      syncBaseline(el)
      return
    }
    // 只有手势窗口内的 scroll 才允许改变跟随状态；窗口外一律视为布局产物
    if (performance.now() - lastGestureAt <= GESTURE_WINDOW_MS) {
      const contentShrank = lastScrollHeight >= 0 && el.scrollHeight < lastScrollHeight - 2
      const contentGrew = lastScrollHeight >= 0 && el.scrollHeight > lastScrollHeight + 2
      if (lastScrollTop < 0) {
        // 无基准（容器重建 / 首帧）：按距底推断
        if (distanceFromBottom(el) >= NEAR_BOTTOM) stopFollowing()
      } else if (contentShrank || contentGrew) {
        // 手势窗口内也可能夹杂布局变化，不据此关闭跟随；已上滑时按距底恢复
        if (userScrolledUp.value && distanceFromBottom(el) < NEAR_BOTTOM) userScrolledUp.value = false
      } else if (el.scrollTop < lastScrollTop - SCROLL_UP_TOLERANCE) {
        stopFollowing()
      } else if (distanceFromBottom(el) < NEAR_BOTTOM) {
        userScrolledUp.value = false
      }
    }
    syncBaseline(el)

    if (loading || !userScrolledUp.value || el.scrollTop > 120 || !options.canLoadOlder()) return
    const current = generation
    const oldHeight = el.scrollHeight
    const oldTop = el.scrollTop
    void options.loadOlder().then(async loaded => {
      await nextTick()
      if (!loaded || disposed || current !== generation || !userScrolledUp.value || container.value !== el) return
      el.scrollTop = oldTop + el.scrollHeight - oldHeight
      // 同步基准：追加历史后位置是「保持」而非「上滑」
      syncBaseline(el)
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
    cancelScheduledFollow()
  }

  /** 容器重建（中心态 → 会话态）后重新开始度量，避免拿旧容器的 scrollTop 当基准 */
  function resetScrollBaseline() {
    lastScrollTop = -1
    lastScrollHeight = -1
  }

  function scrollToMessage(messageId: string) {
    // 定位到某条历史消息 = 用户要看那一屏，后续内容增长不得把视野拽回底部
    if (messageId !== '') stopFollowing()
    const current = generation
    void nextTick(() => {
      if (disposed || current !== generation) return
      programmatic = true
      scrollElementToMessage(container.value, messageId)
      requestAnimationFrame(() => {
        if (current === generation) programmatic = false
      })
    })
  }

  // --- 尺寸观察：容器（clientHeight）+ 内容直接子元素（内容高度）---
  function observeTargets() {
    if (!resizeObserver) return
    const el = container.value
    if (!el) return
    resizeObserver.disconnect()
    resizeObserver.observe(el)
    for (const child of Array.from(el.children ?? [])) resizeObserver.observe(child)
  }

  function bindObservers() {
    unbindObservers()
    const el = container.value
    // 测试环境（node）没有 ResizeObserver / MutationObserver，静默降级为显式触发
    if (!el || typeof ResizeObserver === 'undefined') return
    resizeObserver = new ResizeObserver(() => scheduleFollow())
    observeTargets()
    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(() => {
        // 子元素增删（新轮次 / 折叠块替换）后重新登记观察目标
        observeTargets()
        scheduleFollow()
      })
      mutationObserver.observe(el, { childList: true })
    }
  }

  function unbindObservers() {
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
    resizeObserver = undefined
    mutationObserver = undefined
  }

  watch(container, () => {
    bindObservers()
    resetScrollBaseline()
  }, { flush: 'post', immediate: true })

  function dispose() {
    disposed = true
    unbindObservers()
    cancelRestore()
    cancelScheduledFollow()
  }

  return { userScrolledUp, scrollToBottom, resumeFollow, pauseFollow: stopFollowing, scrollToMessage, beginRestore, completeRestore,
    handleMarkdownRendered, handleWheel, handleTouchStart, handleTouchMove, handlePointerDown, handleScroll,
    cancelRestore, resetScrollBaseline, scheduleFollow, dispose }
}
