import { describe, expect, it } from 'vitest'
import type { InboxPreference } from '@mao/contracts'
import { isInboxKindEnabled } from './useInboxSystemNotify'

/**
 * 系统通知的 kind 级开关。后端 InboxService.isKindEnabled 对
 * WEIXIN_REPLY_WINDOW_CLOSED 与 DAILY_DIGEST 明确「无偏好开关，始终通知」，
 * 桌面这里漏列后走 default:false，窗口失焦时这两类收件箱条目不弹系统通知。
 */
const allOff: InboxPreference = {
  taskCompletedEnabled: false,
  questionPendingEnabled: false,
  approvalPendingEnabled: false,
  subagentDoneEnabled: false,
  budgetWarnEnabled: false,
  openApiCallFailedEnabled: false,
  systemNotifyEnabled: true,
}

describe('isInboxKindEnabled', () => {
  it('对照组：有偏好开关的 kind 按偏好返回', () => {
    expect(isInboxKindEnabled('TASK_COMPLETED', allOff)).toBe(false)
    expect(isInboxKindEnabled('TASK_COMPLETED', { ...allOff, taskCompletedEnabled: true })).toBe(true)
  })

  it('回归：微信 24h 窗口关闭属运维级事件，后端始终通知，桌面也应始终允许', () => {
    expect(isInboxKindEnabled('WEIXIN_REPLY_WINDOW_CLOSED', allOff)).toBe(true)
  })

  it('回归：每日摘要不受收件箱 kind 偏好门控，桌面也应始终允许', () => {
    expect(isInboxKindEnabled('DAILY_DIGEST', allOff)).toBe(true)
  })
})
