// 构建后校验（技术方案 G1）：mermaid / katex 必须在按需 chunk，不得进首屏主 chunk。
// 注意不能用「chunk 文件名」判断——主 chunk 里会出现动态 import 的 chunk 文件名字符串，
// 这里检查的是库内部独有的字面量（本仓源码不含这些串）。
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const distAssets = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets')

let files
try {
  files = readdirSync(distAssets).filter((f) => /^index-.*\.js$/.test(f))
} catch {
  console.error('[check-main-chunk] 未找到 dist/assets，请先执行 vite build')
  process.exit(1)
}
if (files.length === 0) {
  console.error('[check-main-chunk] 未找到主 chunk（index-*.js）')
  process.exit(1)
}

const FORBIDDEN = ['sequenceDiagram', 'katex-mathml']

for (const file of files) {
  const content = readFileSync(join(distAssets, file), 'utf8')
  for (const token of FORBIDDEN) {
    if (content.includes(token)) {
      console.error(`[check-main-chunk] 主 chunk ${file} 含 "${token}"：mermaid/katex 进了首屏包`)
      process.exit(1)
    }
  }
}
console.log('[check-main-chunk] 主 chunk 未包含 mermaid/katex 内部字面量 ✓')
