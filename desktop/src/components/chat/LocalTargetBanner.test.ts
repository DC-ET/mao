/**
 * LocalTargetBanner 可见性矩阵（技术方案 2026-11-05 §4.1-3 重设计）：
 *  - 非 LOCAL 会话不渲染；
 *  - 当前设备即绑定执行端时不渲染（用户可见性约束）；
 *  - 未登记 / 绑定他端离线 / 绑定他端在线三态文案与样式类；
 *  - 浏览器（无当前设备身份）拿不到比对，照常提示。
 */
import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import LocalTargetBanner from './LocalTargetBanner.vue'

async function renderBanner(props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({
    render: () => h(LocalTargetBanner as never, { executionMode: 'LOCAL', ...props }),
  })
  return renderToString(app)
}

describe('LocalTargetBanner', () => {
  it('非 LOCAL 会话不渲染', async () => {
    const html = await renderBanner({
      executionMode: 'CLOUD',
      targetDeviceId: 'dev-1',
      targetDeviceName: 'MyMac',
      targetDeviceOnline: true,
    })
    expect(html).not.toContain('local-target-banner')
  })

  it('当前设备即绑定执行端时不渲染', async () => {
    const html = await renderBanner({
      targetDeviceId: 'dev-1',
      currentDeviceId: 'dev-1',
      targetDeviceName: 'MyMac',
      targetDeviceOnline: true,
    })
    expect(html).not.toContain('local-target-banner')
  })

  it('未登记执行端时警告态提示', async () => {
    const html = await renderBanner({
      targetDeviceId: null,
      currentDeviceId: 'dev-2',
      targetDeviceName: null,
    })
    expect(html).toContain('local-target-banner warning')
    expect(html).toContain('该本地任务还未登记执行端，请在桌面客户端打开一次完成登记')
  })

  it('绑定他端离线时警告态提示', async () => {
    const html = await renderBanner({
      targetDeviceId: 'dev-1',
      currentDeviceId: 'dev-2',
      targetDeviceName: 'MyMac',
      targetDeviceOnline: false,
    })
    expect(html).toContain('local-target-banner warning')
    expect(html).toContain('执行端 MyMac 不在线，发送前请在该设备上打开 Mao')
  })

  it('绑定他端在线时信息态提示', async () => {
    const html = await renderBanner({
      targetDeviceId: 'dev-1',
      currentDeviceId: 'dev-2',
      targetDeviceName: 'MyMac',
      targetDeviceOnline: true,
    })
    expect(html).toContain('local-target-banner info')
    expect(html).toContain('该任务在 MyMac 上执行')
  })

  it('展示名剥离 mDNS 的 .local 尾巴', async () => {
    const html = await renderBanner({
      targetDeviceId: 'dev-1',
      currentDeviceId: 'dev-2',
      targetDeviceName: 'MyMac.local',
      targetDeviceOnline: true,
    })
    expect(html).toContain('该任务在 MyMac 上执行')
    expect(html).not.toContain('MyMac.local')
  })

  it('浏览器（无当前设备身份）时照常提示', async () => {
    const html = await renderBanner({
      targetDeviceId: 'dev-1',
      currentDeviceId: null,
      targetDeviceName: 'MyMac',
      targetDeviceOnline: true,
    })
    expect(html).toContain('该任务在 MyMac 上执行')
  })
})
