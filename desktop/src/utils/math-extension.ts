/**
 * KaTeX 数学公式 marked 扩展（技术方案 §5.3）。
 *
 * 决策 5 实施取备选「自研 tokenizer」：marked-katex-extension 的定界匹配无法注入
 * 自定义校验层，而误判防线（A6：价格语境不渲染公式）必须在定界匹配处收紧。
 *
 * 定界规则（全部收紧后仍渲染不了的公式只会回落原文，无阅读损失）：
 * - 行内 $...$：不跨行、开定界右侧非空白、闭定界左侧非空白、内容非纯数字（价格 $2$ 不误判）；
 * - 行内 $$...$$：同上规则，按 display 模式渲染；
 * - 块级 $$...$$：两种有界形态——多行（$$ 独占一行开 / 闭）与单行（整行仅 $$x$$，尾随文字
 *   留给行内扩展）；闭合锚定「独占 $$ 的行」，行内对的 $$ 无法充当闭合点，杜绝惰性匹配
 *   跨行吞并正文（评审 R1-1）；多行 inner 允许裸 $（后果仅为有界红色报错，无吞并面）；
 * - 转义 \\$ 由 marked 内建 escape 规则先行消费，天然豁免；code/codespan 不经本扩展。
 */
import type { MarkedExtension, Tokens } from 'marked'
import { getKatex } from './katex-loader'

/** 单条公式源码上限（F3）：超过按原文展示。 */
export const MATH_SOURCE_CAP = 10 * 1024

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderMath(raw: string, text: string, displayMode: boolean): string {
  const katex = getKatex()
  // katex 未加载（hint 漏判 / 加载失败）或超长：按原文展示
  if (!katex || text.length > MATH_SOURCE_CAP) return escapeHtml(raw)
  try {
    return katex.renderToString(text, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'htmlAndMathml',
    })
  } catch {
    return escapeHtml(raw)
  }
}

function isValidInlineMath(inner: string): boolean {
  if (inner.length === 0) return false
  if (/\s/.test(inner[0]) || /\s/.test(inner[inner.length - 1])) return false
  // 价格语境（$2$）不渲染；真实公式极少是纯数字
  if (/^\d+$/.test(inner)) return false
  return true
}

export function mathExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'blockMath',
        level: 'block',
        tokenizer(src: string): Tokens.Generic | undefined {
          // 两种闭合形态，闭合点均锚定「独占 $$ 的行」（行内对的 $$ 后跟尾随文字，不满足
          // 形态）——杜绝「行内 $$a$$ 说明文字 + 后文任意行尾 $$」时惰性匹配跨行吞并正文
          // （评审 R1-1）：多行块 $$ 独占一行开、独占一行闭；单行块整行只有 $$x$$。
          const multiline = /^\$\$[ \t]*\n([\s\S]+?)\n[ \t]*\$\$[ \t]*(?:\n|$)/.exec(src)
          const singleline = multiline ? null : /^\$\$([^$\n]+?)\$\$[ \t]*(?:\n|$)/.exec(src)
          const match = multiline ?? singleline
          if (!match) return undefined
          const inner = match[1].trim()
          if (inner.length === 0 || inner.length > MATH_SOURCE_CAP) return undefined
          return { type: 'blockMath', raw: match[0], text: inner } as Tokens.Generic
        },
        renderer(token: Tokens.Generic) {
          return renderMath(String(token.raw), String(token.text), true)
        },
      },
      {
        name: 'inlineMath',
        level: 'inline',
        start(src: string): number | undefined {
          const idx = src.indexOf('$')
          return idx === -1 ? undefined : idx
        },
        tokenizer(src: string): Tokens.Generic | undefined {
          const double = /^\$\$([^$\n]+?)\$\$/.exec(src)
          if (double) {
            if (!isValidInlineMath(double[1]) || double[1].length > MATH_SOURCE_CAP) return undefined
            return { type: 'inlineMath', raw: double[0], text: double[1], display: true } as Tokens.Generic
          }
          const single = /^\$([^$\n]+?)\$/.exec(src)
          if (single) {
            if (!isValidInlineMath(single[1]) || single[1].length > MATH_SOURCE_CAP) return undefined
            return { type: 'inlineMath', raw: single[0], text: single[1], display: false } as Tokens.Generic
          }
          return undefined
        },
        renderer(token: Tokens.Generic) {
          return renderMath(String(token.raw), String(token.text), token.display === true)
        },
      },
    ],
  }
}
