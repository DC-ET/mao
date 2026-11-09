/**
 * Web Embed SDK 页面工具（page_*）的读 / 写分类契约。
 *
 * 只放类型，不放运行期名单：backend 生产跑 `node dist/main.js`，而本包 exports 仅有
 * types 条件（前端靠 vite alias 直接引 src），运行期 import 会在生产解析失败。
 * 两端各自持一份运行期名单（backend `harness/page-tool-kinds.ts`、
 * SDK `sdk/embed/src/page/types.ts`），用 `Record<联合, true>` 声明吃编译期穷尽：
 * 任一工具改分类 → 联合变 → 两端 Record 同时报错，必须同改，不会静默漂移。
 *
 * 读：只读取页面信息，不改变页面状态——不受 page.enabled 开关控制，始终提供。
 * 写/操作：会改变页面状态（滚动、聚焦、填写、点击等）——受 page.enabled 控制，缺省关闭。
 *
 * 注意与 SDK 内 isMutatingAction（逐动作确认模型：scroll/wait 视为非变更）口径不同：
 * 那里的 scroll 免确认，但这里 scroll 属于写，ops 关闭时直接拒绝。两个关注点独立。
 */

/** 读类页面工具：始终提供，不受 page.enabled 控制。 */
export type PageReadToolName =
  | 'page_inspect'
  | 'page_observe'
  | 'page_screenshot'
  | 'page_wait';

/** 写/操作类页面工具：受 page.enabled 控制，缺省关闭。 */
export type PageWriteToolName =
  | 'page_scroll'
  | 'page_focus'
  | 'page_fill'
  | 'page_select'
  | 'page_check'
  | 'page_uncheck'
  | 'page_click'
  | 'page_keyboard'
  | 'page_actions';
