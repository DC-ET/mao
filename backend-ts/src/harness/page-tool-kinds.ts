import type { PageReadToolName, PageWriteToolName } from '@mao/contracts';

/**
 * 页面工具读 / 写分类的运行期口径（类型契约见 shared/contracts/src/page.ts）。
 *
 * 用 Record<联合, true> 而非 string[]：任一工具改分类 → 契约联合变 → 下面两个 Record
 * 同时报类型错误，必须同改，不会静默漂移；也顺带挡住拼错的工具名。
 *
 * 读：只读取页面信息，不受 page.enabled 开关控制，绑定 embed 连接即提供。
 * 写/操作：受 page.enabled 控制（缺省 false），关闭时工具不可见、请求直接失败。
 */

/** 写/操作类工具集合：工具过滤（HarnessService.filterPageTools）与请求门控共用。 */
export const PAGE_WRITE_TOOLS: Record<PageWriteToolName, true> = {
  page_scroll: true,
  page_focus: true,
  page_fill: true,
  page_select: true,
  page_check: true,
  page_uncheck: true,
  page_click: true,
  page_keyboard: true,
  page_actions: true,
};

/** 读类工具集合：始终提供；列出以便文档/测试对照，门控上不参与判断。 */
export const PAGE_READ_TOOLS: Record<PageReadToolName, true> = {
  page_inspect: true,
  page_observe: true,
  page_screenshot: true,
  page_wait: true,
};

/** 写/操作类页面工具判定：开关关闭时这些工具不可见、不可执行。 */
export function isPageWriteTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAGE_WRITE_TOOLS, name);
}
