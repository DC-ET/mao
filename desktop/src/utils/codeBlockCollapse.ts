/**
 * 聊天消息代码块「折叠 + 换行」DOM 增强（技术方案 docs/plan/2026-11-08-message-code-block-polish-technical-design.md）。
 *
 * MarkdownContent（仅消息宿主开启）渲染完成后调用 enhanceCodeBlocks：遍历宿主内
 * pre.code-block（跳过 .mermaid-block 占位内的），给块头插行数徽标与按钮、给 pre 加
 * 状态 class。事件走本模块独立的 document 级 capture 委托（与 codeCopy 同款幂等注册），
 * v-html 内容无 onclick，sanitize 白名单零改动。
 *
 * - 折叠：>30 行默认折为首 8 行（视觉折叠，max-height 裁剪，DOM 与高亮照常生成）；
 *   展开状态记在模块级 Set（键 = 内容哈希 + 长度），重渲染（主题切换 / 流式结束 /
 *   分页重渲）不把用户展开过的块折回去，应用运行期有效、刷新即重置。
 * - 换行：全局偏好 localStorage（aw-code-word-wrap），写法对齐 FileViewer 的
 *   aw-file-word-wrap；按钮只在折叠块块头，切换作用于全部 code-enhanced 块。
 * - 宿主隔离：code-enhanced 标记是换行切换的作用域，文件查看器 / trace 等其它宿主的
 *   同名 .code-block 未被增强即不受波及（D4）。
 */
import { decodeBase64Utf8 } from './base64'

export const CODE_COLLAPSE_LINES = 30
export const CODE_COLLAPSE_PREVIEW = 8
const WRAP_STORAGE_KEY = 'aw-code-word-wrap'

/** 折叠展开状态：模块级 Set（应用运行期），键 = djb2 + ':' + 内容长度（D3）。 */
const expandedKeys = new Set<string>()

/** 解码后去尾部空行按 \n 计数；空串 / 全空行为 0 行。 */
export function codeLineCount(raw: string): number {
  if (!raw) return 0
  const body = raw.replace(/\n+$/, '')
  if (!body) return 0
  return body.split('\n').length
}

/** djb2 + ':' + length 双键：哈希碰撞概率可忽略，长度参与进一步压低（D3）。 */
export function contentHashKey(raw: string): string {
  let hash = 5381
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0
  }
  return `${hash}:${raw.length}`
}

/** 换行偏好读取：缺省水平滚动（false）；无 localStorage（node 测试等）按关闭。 */
export function isWrapOn(): boolean {
  return globalThis.localStorage?.getItem(WRAP_STORAGE_KEY) === '1'
}

/** 写穿偏好并就地切换文档内全部已增强块的换行态（含按钮 aria-pressed / active）。 */
export function setWrapOn(on: boolean): void {
  globalThis.localStorage?.setItem(WRAP_STORAGE_KEY, on ? '1' : '0')
  document.querySelectorAll('pre.code-block.code-enhanced').forEach((pre) => {
    pre.classList.toggle('code-wrap-on', on)
    pre.querySelectorAll('.code-wrap-btn').forEach((btn) => {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
      btn.classList.toggle('active', on)
    })
  })
}

/**
 * 渲染后增强：>30 行块插徽标（语言名后）+ 换行钮 + 展开钮（复制钮后），未在展开
 * Set 中的加 code-collapse-collapsed；全部块（含 ≤30 行短块）加 code-enhanced 标记
 * 与按偏好的 code-wrap-on。幂等判据 = code-enhanced 已存在即跳过（v-html 重建 DOM
 * 后标记消失、天然重新增强；DOM 未重建但回调再入的路径靠它防重复插按钮）。
 * data-code 缺失 / 损坏或块头结构缺失的块整体跳过，保持原样（与 codeCopy 容错口径一致）。
 */
export function enhanceCodeBlocks(root: HTMLElement): void {
  const wrapOn = isWrapOn()
  root.querySelectorAll('pre.code-block').forEach((node) => {
    const pre = node as HTMLElement
    if (pre.classList.contains('code-enhanced')) return
    // Mermaid 占位（含渲染成功后移入「查看源码」折叠的原代码块）一律不增强（D8）
    if (pre.closest('.mermaid-block')) return
    const header = pre.querySelector('.code-block-header')
    const encoded = pre.dataset.code
    const raw = encoded ? decodeBase64Utf8(encoded) : null
    if (!header || raw == null) return
    pre.classList.add('code-enhanced')
    if (wrapOn) pre.classList.add('code-wrap-on')
    const lineCount = codeLineCount(raw)
    if (lineCount <= CODE_COLLAPSE_LINES) return
    const lang = header.querySelector('.code-lang')
    const badgeHtml = `<span class="code-lines-badge">${lineCount} 行</span>`
    const collapsed = !expandedKeys.has(contentHashKey(raw))
    const toggleText = collapsed ? `展开全部 ${lineCount} 行` : '收起'
    const btnsHtml =
      `<button class="code-wrap-btn${wrapOn ? ' active' : ''}" type="button" aria-label="切换代码块换行" aria-pressed="${wrapOn ? 'true' : 'false'}">换行</button>` +
      `<button class="code-toggle-btn" type="button" aria-label="展开或收起代码块" aria-expanded="${collapsed ? 'false' : 'true'}">${toggleText}</button>`
    if (lang) lang.insertAdjacentHTML('afterend', badgeHtml)
    else header.insertAdjacentHTML('afterbegin', badgeHtml)
    // 复制按钮之后（header 末尾）插换行 / 展开钮（D5）
    header.insertAdjacentHTML('beforeend', btnsHtml)
    if (collapsed) pre.classList.add('code-collapse-collapsed')
  })
}

function onDelegatedClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  const toggleBtn = target?.closest?.('.code-toggle-btn') as HTMLElement | null
  if (toggleBtn) {
    const pre = toggleBtn.closest('pre.code-block.code-enhanced') as HTMLElement | null
    const raw = pre?.dataset.code ? decodeBase64Utf8(pre.dataset.code) : null
    if (!pre || raw == null) return
    event.preventDefault()
    event.stopPropagation()
    const key = contentHashKey(raw)
    const collapsed = pre.classList.toggle('code-collapse-collapsed')
    if (collapsed) {
      expandedKeys.delete(key)
      toggleBtn.textContent = `展开全部 ${codeLineCount(raw)} 行`
      toggleBtn.setAttribute('aria-expanded', 'false')
    } else {
      expandedKeys.add(key)
      toggleBtn.textContent = '收起'
      toggleBtn.setAttribute('aria-expanded', 'true')
    }
    return
  }
  const wrapBtn = target?.closest?.('.code-wrap-btn') as HTMLElement | null
  if (wrapBtn) {
    const pre = wrapBtn.closest('pre.code-block.code-enhanced') as HTMLElement | null
    if (!pre) return
    event.preventDefault()
    event.stopPropagation()
    setWrapOn(!isWrapOn())
  }
}

const DELEGATION_MARK = 'data-code-block-collapse-delegated'

/** 注册 document 级 capture 委托（幂等），与既有复制 / 外链 / 表格复制三套委托并列。 */
export function ensureCodeBlockDelegation(): void {
  const doc = document as Document & { [DELEGATION_MARK]?: boolean }
  if (doc[DELEGATION_MARK]) return
  doc[DELEGATION_MARK] = true
  document.addEventListener('click', onDelegatedClick, true)
}
