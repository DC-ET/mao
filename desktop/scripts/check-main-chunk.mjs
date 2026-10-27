// 构建后校验（技术方案 G1）：mermaid / katex / jszip / exceljs / mammoth 必须在按需
// chunk，不得进首屏主 chunk。
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

const FORBIDDEN = [
  'sequenceDiagram',
  'katex-mathml',
  // jszip 中央目录错误消息（ArchiveBrowser 动态 import）。冒号前那个空格是 jszip
  // 原文（dist/jszip.min.js），写成无空格版恒不命中——字面量必须与库产物逐字符对齐
  "Can't find end of central directory",
  'Corrupted zip : CRC32 mismatch',
  // exceljs 浏览器包内置同一份 jszip，上面这条同时覆盖它；mammoth 的浏览器版独有串
  'cannot open linked files from a web browser',
]

for (const file of files) {
  const content = readFileSync(join(distAssets, file), 'utf8')
  for (const token of FORBIDDEN) {
    if (content.includes(token)) {
      console.error(`[check-main-chunk] 主 chunk ${file} 含 "${token}"：mermaid/katex/jszip/exceljs/mammoth 进了首屏包`)
      process.exit(1)
    }
  }
}
console.log('[check-main-chunk] 主 chunk 未包含 mermaid/katex/jszip/exceljs/mammoth 内部字面量 ✓')
