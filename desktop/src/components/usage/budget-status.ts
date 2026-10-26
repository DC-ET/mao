// 预算 Tab 展示纯函数：与 admin BudgetView 的进度条口径逐字对齐（≥100 按档红/橙、≥80 橙、否则绿），
// 但单位口径比 admin 安全——VO 的 periodSpend 与 limitValue 由服务端统一换算为同单位（决策 4），
// 前端不再自除 1e6（admin 页那种不对称曾差点造出「进度条恒 0%」）。
import type { MyBudgetItemVO } from '@mao/contracts'
import { formatCost, formatNumber } from '../../utils/usageFormat'

export function budgetScopeLabel(scope: MyBudgetItemVO['scope']): string {
  return scope === 'GLOBAL' ? '全局预算' : '我的预算'
}

/** 越线比例：上限 100 封顶，保留 1 位小数；上限非正数（脏数据）时 0 不误导。 */
export function budgetSpendPercent(item: MyBudgetItemVO): number {
  if (item.limitValue <= 0) return 0
  return Math.min(100, Math.round((item.periodSpend / item.limitValue) * 1000) / 10)
}

/** 进度条配色：阈值与 admin（BudgetView.vue:221-226）一致——越线按档红/橙、≥80% 橙、否则绿。 */
export function budgetProgressColor(item: MyBudgetItemVO): string {
  const p = budgetSpendPercent(item)
  if (p >= 100) return item.action === 'BLOCK' ? '#f56c6c' : '#e6a23c'
  if (p >= 80) return '#e6a23c'
  return '#67c23a'
}

export function budgetStatusLabel(item: MyBudgetItemVO): string {
  return item.status === 'BLOCKED' ? '已拦截' : item.status === 'WARNED' ? '已越线' : '正常'
}

export function formatBudgetValue(value: number, limitType: MyBudgetItemVO['limitType']): string {
  return limitType === 'COST' ? formatCost(value) : formatNumber(value)
}

/** 口径文案：COST 为成本单位（价格填写口径），TOKENS 为 token 原值。 */
export function budgetLimitTypeLabel(limitType: MyBudgetItemVO['limitType']): string {
  return limitType === 'COST' ? '成本' : 'Token'
}

/**
 * 卡片展示序：BLOCKED 置顶，其次 WARNED，最后 NORMAL；同状态内保持服务端返回序
 * （服务端已是 GLOBAL → USER + id 升序，稳定排序不重排同档）。
 */
export function sortBudgetItems(items: MyBudgetItemVO[]): MyBudgetItemVO[] {
  const rank = (s: MyBudgetItemVO['status']) => (s === 'BLOCKED' ? 0 : s === 'WARNED' ? 1 : 2)
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.status) - rank(b.item.status) || a.index - b.index)
    .map((x) => x.item)
}
