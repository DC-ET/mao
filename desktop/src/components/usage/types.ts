/** 明细筛选（场景 / 模型 / 成败），设置页与抽屉明细 Tab 共用。 */
export interface UsageFilters {
  scene: string
  modelId: number | undefined
  success: boolean | undefined
}

/** 空筛选（重置态）：scene 空串与 undefined 由各宿主转换为不传参。 */
export const EMPTY_USAGE_FILTERS: UsageFilters = { scene: '', modelId: undefined, success: undefined }
