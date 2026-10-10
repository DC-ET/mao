// 渠道绑定合并页的 Tab 解析：URL → 初始 Tab。
// 覆盖两个口径：
// 1. `?tab=` 决定初始 Tab，缺省/空串/未知值（旧链接、手改地址）一律回落微信Bot，
//    否则拼错一个 tab 名就白屏或停在空面板。
// 2. 钉钉授权回调（?bound=1 / ?bindError=…）必须落在钉钉 Tab：钉钉面板是 lazy 的，
//    若被 tab 名盖回微信，「绑定成功 / 绑定失败」提示就没组件读取了。
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_BINDING_TABS,
  DEFAULT_CHANNEL_BINDING_TAB,
  isChannelBindingTabKey,
  normalizeChannelBindingTab,
  resolveInitialChannelBindingTab
} from './tabs'

describe('渠道绑定 Tab 定义', () => {
  it('三个渠道 Tab 的顺序与名称固定', () => {
    expect(CHANNEL_BINDING_TABS.map(tab => tab.key)).toEqual(['weixin', 'feishu', 'dingtalk'])
    expect(CHANNEL_BINDING_TABS.map(tab => tab.label)).toEqual(['微信Bot', '飞书机器人', '钉钉Bot'])
  })

  it('默认 Tab 是微信Bot', () => {
    expect(DEFAULT_CHANNEL_BINDING_TAB).toBe('weixin')
  })
})

describe('normalizeChannelBindingTab', () => {
  it('接受合法 Tab key', () => {
    expect(normalizeChannelBindingTab('weixin')).toBe('weixin')
    expect(normalizeChannelBindingTab('feishu')).toBe('feishu')
    expect(normalizeChannelBindingTab('dingtalk')).toBe('dingtalk')
  })

  it('缺省、空串与非字符串回落默认 Tab', () => {
    expect(normalizeChannelBindingTab(undefined)).toBe('weixin')
    expect(normalizeChannelBindingTab(null)).toBe('weixin')
    expect(normalizeChannelBindingTab('')).toBe('weixin')
    expect(normalizeChannelBindingTab(3)).toBe('weixin')
    expect(normalizeChannelBindingTab({})).toBe('weixin')
  })

  it('未知值回落默认 Tab（旧 /settings/weixin-bot 等手改地址）', () => {
    expect(normalizeChannelBindingTab('weixin-bot')).toBe('weixin')
    expect(normalizeChannelBindingTab('Weixin')).toBe('weixin')
  })

  it('isChannelBindingTabKey 只认三个 key', () => {
    expect(isChannelBindingTabKey('dingtalk')).toBe(true)
    expect(isChannelBindingTabKey('dingtalk-bot')).toBe(false)
  })
})

describe('resolveInitialChannelBindingTab', () => {
  it('按 ?tab= 选择 Tab', () => {
    expect(resolveInitialChannelBindingTab({ tab: 'feishu' })).toBe('feishu')
    expect(resolveInitialChannelBindingTab({ tab: 'dingtalk' })).toBe('dingtalk')
  })

  it('没有 tab 参数时用默认 Tab', () => {
    expect(resolveInitialChannelBindingTab({})).toBe('weixin')
    expect(resolveInitialChannelBindingTab({ tab: '' })).toBe('weixin')
    expect(resolveInitialChannelBindingTab({ tab: ['weixin', 'feishu'] })).toBe('weixin')
  })

  it('钉钉回调参数优先于 tab 名，落到钉钉 Tab', () => {
    expect(resolveInitialChannelBindingTab({ bound: '1' })).toBe('dingtalk')
    expect(resolveInitialChannelBindingTab({ bindError: 'expired' })).toBe('dingtalk')
    expect(resolveInitialChannelBindingTab({ tab: 'weixin', bound: '1' })).toBe('dingtalk')
    expect(resolveInitialChannelBindingTab({ tab: 'feishu', bindError: '绑定失败' })).toBe('dingtalk')
  })

  it('回调参数为空串时不覆盖 tab 名', () => {
    expect(resolveInitialChannelBindingTab({ tab: 'feishu', bound: '' })).toBe('feishu')
    expect(resolveInitialChannelBindingTab({ tab: 'feishu', bindError: '' })).toBe('feishu')
  })
})
