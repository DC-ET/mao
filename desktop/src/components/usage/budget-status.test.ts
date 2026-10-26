// budget-status 纯函数测试：单位口径（C1）、进度配色与 admin 对齐、展示序稳定（C7）。
import { describe, expect, it } from 'vitest'
import type { MyBudgetItemVO } from '@mao/contracts'
import {
  budgetLimitTypeLabel,
  budgetProgressColor,
  budgetScopeLabel,
  budgetSpendPercent,
  budgetStatusLabel,
  formatBudgetValue,
  sortBudgetItems,
} from './budget-status'

function item(overrides: Partial<MyBudgetItemVO> = {}): MyBudgetItemVO {
  return {
    id: 1,
    scope: 'GLOBAL',
    periodSpend: 50,
    limitValue: 100,
    limitType: 'COST',
    action: 'BLOCK',
    status: 'NORMAL',
    period: '2026-10',
    resetAt: '2026-11-01 00:00:00',
    ...overrides,
  }
}

describe('budgetScopeLabel', () => {
  it('GLOBAL → 全局预算；USER → 我的预算', () => {
    expect(budgetScopeLabel('GLOBAL')).toBe('全局预算')
    expect(budgetScopeLabel('USER')).toBe('我的预算')
  })
})

describe('budgetSpendPercent', () => {
  it('两侧同单位直接相除（服务端已换算，前端不再自除 1e6）', () => {
    expect(budgetSpendPercent(item({ periodSpend: 42.5, limitValue: 100 }))).toBe(42.5)
  })

  it('上限 100 封顶（越线不溢出进度条）', () => {
    expect(budgetSpendPercent(item({ periodSpend: 150, limitValue: 100 }))).toBe(100)
  })

  it('上限非正数 → 0（脏数据不误导）', () => {
    expect(budgetSpendPercent(item({ periodSpend: 50, limitValue: 0 }))).toBe(0)
  })
})

describe('budgetProgressColor', () => {
  it('越线：BLOCK 红、WARN 橙', () => {
    expect(budgetProgressColor(item({ action: 'BLOCK', periodSpend: 120, limitValue: 100 }))).toBe('#f56c6c')
    expect(budgetProgressColor(item({ action: 'WARN', periodSpend: 120, limitValue: 100 }))).toBe('#e6a23c')
  })

  it('≥80% 未越线：橙', () => {
    expect(budgetProgressColor(item({ action: 'BLOCK', periodSpend: 80, limitValue: 100 }))).toBe('#e6a23c')
    expect(budgetProgressColor(item({ action: 'BLOCK', periodSpend: 99.9, limitValue: 100 }))).toBe('#e6a23c')
  })

  it('其余：绿', () => {
    expect(budgetProgressColor(item({ action: 'BLOCK', periodSpend: 79.9, limitValue: 100 }))).toBe('#67c23a')
  })
})

describe('budgetStatusLabel', () => {
  it('BLOCKED → 已拦截；WARNED → 已越线；NORMAL → 正常', () => {
    expect(budgetStatusLabel(item({ status: 'BLOCKED' }))).toBe('已拦截')
    expect(budgetStatusLabel(item({ status: 'WARNED' }))).toBe('已越线')
    expect(budgetStatusLabel(item({ status: 'NORMAL' }))).toBe('正常')
  })
})

describe('formatBudgetValue', () => {
  it('COST 走 formatCost（小数口径）', () => {
    expect(formatBudgetValue(42.5, 'COST')).toBe('42.5')
  })

  it('TOKENS 走 formatNumber（千分位）', () => {
    expect(formatBudgetValue(1_234_567, 'TOKENS')).toBe('1,234,567')
  })
})

describe('budgetLimitTypeLabel', () => {
  it('COST → 成本；TOKENS → Token', () => {
    expect(budgetLimitTypeLabel('COST')).toBe('成本')
    expect(budgetLimitTypeLabel('TOKENS')).toBe('Token')
  })
})

describe('sortBudgetItems', () => {
  it('BLOCKED 置顶、WARNED 次之、NORMAL 收尾；同状态内保持传入序', () => {
    const rows = [
      item({ id: 1, status: 'NORMAL' }),
      item({ id: 2, status: 'WARNED' }),
      item({ id: 3, status: 'BLOCKED' }),
      item({ id: 4, status: 'NORMAL' }),
    ]
    expect(sortBudgetItems(rows).map((r) => r.id)).toEqual([3, 2, 1, 4])
  })

  it('空数组原样返回', () => {
    expect(sortBudgetItems([])).toEqual([])
  })
})
