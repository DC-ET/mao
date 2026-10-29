'use strict'
/**
 * 本机环境补丁（与本次被审代码无关）：Node 22.14 的 zlib 没有 createZstdDecompress，
 * undici 装载即抛 TypeError → jsdom 环境 worker 起不来。这里补一个占位实现，只为让 jsdom 用例能跑。
 * Node ≥ 22.15（或 23.8+ 的 zstd API 全量）不需要本文件。
 */
const zlib = require('zlib')
if (typeof zlib.createZstdDecompress !== 'function') {
  zlib.createZstdDecompress = function createZstdDecompress() {
    throw new Error('zstd not supported in this node build')
  }
}
