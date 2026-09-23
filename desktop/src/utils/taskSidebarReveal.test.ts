import { describe, expect, it } from 'vitest'
import { planFocusReveal, planGroupReveal } from './taskSidebarReveal'

const groups = [
  { key: 'FEISHU_PRIVATE:1', sessionIds: ['10', '11', '12'] },
  { key: 'FEISHU_GROUP:ws', sessionIds: ['20', '21', '22', '23', '24', '25', '26'] },
]

describe('planGroupReveal', () => {
  it('目标不在任何分组时不调整', () => {
    expect(planGroupReveal('99', groups, () => false, () => 5)).toBeNull()
  })

  it('收起的分组会展开，已在前几条内则不加大可见条数', () => {
    expect(planGroupReveal('11', groups, (key) => key === 'FEISHU_PRIVATE:1', () => 5)).toEqual({
      groupKey: 'FEISHU_PRIVATE:1',
      index: 1,
      expand: true,
      visibleCount: 5,
    })
  })

  it('已展开但落在默认可见条数之外时，把可见条数扩到该会话', () => {
    expect(planGroupReveal('26', groups, () => false, () => 5)).toEqual({
      groupKey: 'FEISHU_GROUP:ws',
      index: 6,
      expand: false,
      visibleCount: 7,
    })
  })

  it('数字 id 与字符串 id 视为同一会话', () => {
    const plan = planGroupReveal('10', [{ key: 'g', sessionIds: [10, 11] }], () => true, () => 5)
    expect(plan).toEqual({ groupKey: 'g', index: 0, expand: true, visibleCount: 5 })
  })
})

describe('planFocusReveal', () => {
  it('主列表靠后的会话会加大可见条数', () => {
    expect(planFocusReveal('8', ['1', '2', '3', '8'], [], 3, true)).toEqual({
      zone: 'main',
      visibleCount: 4,
      expandHistory: false,
    })
  })

  it('落在历史折叠区时展开历史，不改主列表可见条数', () => {
    expect(planFocusReveal('9', ['1'], ['9'], 20, true)).toEqual({
      zone: 'history',
      visibleCount: 20,
      expandHistory: true,
    })
  })

  it('两边都没有时返回空', () => {
    expect(planFocusReveal('9', ['1'], ['2'], 20, true)).toBeNull()
  })
})
