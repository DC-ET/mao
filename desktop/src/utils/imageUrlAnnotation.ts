/**
 * 聊天图片 URL 注入行（技术方案 docs/plan/2026-10-22-chat-image-url-injection-technical-design.md §5.1）
 * 的桌面端剥离工具：与后端 backend-ts/src/session/util/image-url-annotation.ts 同款格式、各自实现
 * （与 citationMarkers.ts 同一约定：展示层语法不进 shared/contracts）。
 *
 * 用途只有一个：乐观用户消息与 REST 回显/WS 广播比对时做归一化。落库文本 part 带注入行，
 * 而乐观消息是用户原始正文，`user_message_saved` 帧丢失走 REST 兜底时只有剥离后才能判为同一条。
 */

/**
 * 既有注入行：行首锚定 + 整行锚定，只剥服务端生成的格式，不碰用户正文。
 * 与后端 backend-ts/src/session/util/image-url-annotation.ts 逐字节一致：
 * 行尾容忍空白（空格 / 制表 / CR），否则编辑回传带行尾空白时漏剥会破坏幂等比对。
 */
const IMAGE_URL_LINE_PATTERN = /^\[图片 \d+\] \S+[ \t\r]*$/gm

/**
 * 剥离全部注入行，并收敛行尾多余空行（含 CR，与后端 stripImageUrlLines 逐字节一致）。
 * 恒收敛是有意为之（比对契约）：服务端有图时会先剥注入行再收敛落库/广播，乐观消息只有
 * 正文——两边各自收敛才能判等；去掉收敛会让回声去重失配，user_message_saved 兜底渲染重。
 * 展示口径的恒等要求见 userVisibleText，不要把这里的收敛去掉。
 */
export function stripImageUrlLines(text: string): string {
  return text.replace(IMAGE_URL_LINE_PATTERN, '').replace(/[\r\n]+$/, '')
}

/** 单行探测版（无 g 标志）：g 版的 `.test()` 带 lastIndex 状态，重复探测会漏判。 */
const IMAGE_URL_LINE_SINGLE = /^\[图片 \d+\] \S+[ \t\r]*$/m

/**
 * 用户消息的展示口径：剥离注入行后的正文。
 *
 * 注入行是给 Agent 的文件地址通道（存储即注入，技术方案 §5.1），对用户是噪音——
 * 落库文本带 URL 行而本地乐观消息只有正文，历史重拉后气泡会「多出一行」，看起来像
 * 消息被服务端改掉。气泡、编辑框回填、复制、添加到指令统一走这个口径；
 * 落库内容与 Agent 可见内容不变。
 *
 * 没有注入行的内容保持恒等（尾随空行不裁，BUG-5）：非桌面来源的消息此前在编辑回填、
 * 复制里被静默改写正文，编辑重发会把尾随空行永久裁掉。
 * 比对口径不走这里：回声去重统一用 stripImageUrlLines 的恒收敛归一化。
 */
export function userVisibleText(text: string): string {
  if (!IMAGE_URL_LINE_SINGLE.test(text)) return text
  return stripImageUrlLines(text)
}
