import type { RouteLocationNormalized } from 'vue-router'

/**
 * 浮窗助手页面上下文（纯函数，可单测）：只采路由结构性信息。
 * 严禁读取任何 store 的表格数据、表单值、用户资料或服务端响应体——Agent 需要页面内容时
 * 由 page_* 工具按授权级别自行获取（快照脱敏 / 截图遮罩），此处不做第二份采集。
 */
export interface EmbedPageContext {
  /** route.name（仅字符串名；symbol 名回落 path） */
  route: string
  path: string
  /** vue-router params 值为 string | string[]（重复参数） */
  params: Record<string, string | string[]>
  /** vue-router query 值为 string | null | 数组（重复 query 参数） */
  query: Record<string, string | null | Array<string | null>>
}

export function collectEmbedContext(route: RouteLocationNormalized): EmbedPageContext {
  return {
    // vue-router 的 name 为 string | symbol | null | undefined：symbol 无法进 JSON 上下文，回落 path
    route: typeof route.name === 'string' ? route.name : route.path,
    path: route.path,
    // 展开拷贝：vue-router 的 params/query 只含实际出现的键，空路由即 {}，
    // 不会注入 undefined 值造成无意义的上下文变化（SDK 按 hash 变更检测重复注入）
    params: { ...route.params },
    query: { ...route.query },
  }
}
