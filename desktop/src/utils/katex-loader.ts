/**
 * KaTeX 懒加载（技术方案 §4.3/G1）：首个疑似含公式的消息触发动态 import，
 * 库与 CSS/字体进独立 chunk，无公式路径零加载。加载失败置空可重试，
 * 公式由 math-extension 的 renderer 兜底回落原文。
 */
type KatexLib = (typeof import('katex'))['default']

let katexRef: KatexLib | null = null
let katexPromise: Promise<void> | null = null

export function getKatex(): KatexLib | null {
  return katexRef
}

export async function ensureKatex(): Promise<void> {
  katexPromise ??= (async () => {
    const [mod] = await Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ] as const)
    katexRef = mod.default
  })()
  try {
    await katexPromise
  } catch (err) {
    katexPromise = null
    throw err
  }
}

/** 测试专用：node 层测试注入 / 清空 katex 实例，锁定「未加载时回落原文」路径。 */
export function setKatexForTest(lib: KatexLib | null): void {
  katexRef = lib
}
