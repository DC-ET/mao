'use strict'

/**
 * 一次性资产生成器：产出桌面托盘图标 PNG（electron/assets/）。
 * 运行：node scripts/gen-tray-icons.cjs（提交产物，脚本保留以便再生成）。
 * - tray-icon-template.png  16x16  纯黑 M 字形 + alpha（macOS Template，明暗自适应）
 * - tray-icon.png           32x32  蓝底圆角白 M（Windows / Linux）
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** @param {number} size @param {(x:number,y:number)=>[number,number,number,number]} pixelFn 返回 [r,g,b,a] */
function encodePng(size, pixelFn) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  let offset = 0
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0 // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      raw[offset++] = r
      raw[offset++] = g
      raw[offset++] = b
      raw[offset++] = a
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** M 字形判定：左/右竖笔画 + 两段对角笔画，2px 笔宽，画布中央留 1px 边距 */
function isGlyphM(x, y, size) {
  const scale = size / 16
  const px = (x + 0.5) / scale
  const py = (y + 0.5) / scale
  const stroke = 2.2
  const inRect = (cx, cy, w, h) =>
    Math.abs(px - cx) <= w / 2 && Math.abs(py - cy) <= h / 2
  // 左竖 / 右竖
  if (inRect(3.6, 8, stroke, 10)) return true
  if (inRect(12.4, 8, stroke, 10)) return true
  // 左对角（3.6,3）→（8,8）；右对角（12.4,3）→（8,8）
  const onDiagonal = (x0, y0, x1, y1) => {
    const dx = x1 - x0
    const dy = y1 - y0
    const len2 = dx * dx + dy * dy
    let t = ((px - x0) * dx + (py - y0) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const cx = x0 + t * dx
    const cy = y0 + t * dy
    return (px - cx) * (px - cx) + (py - cy) * (py - cy) <= (stroke / 2) * (stroke / 2)
  }
  if (onDiagonal(3.6, 3, 8, 8)) return true
  if (onDiagonal(12.4, 3, 8, 8)) return true
  return false
}

function inRoundedRect(x, y, size, radius) {
  const px = x + 0.5
  const py = y + 0.5
  const m = size * 0.08
  const left = m
  const right = size - m
  const top = m
  const bottom = size - m
  if (px < left || px > right || py < top || py > bottom) return false
  // 圆角：距角心 > radius 且在角区外
  const cx = px < left + radius ? left + radius : px > right - radius ? right - radius : px
  const cy = py < top + radius ? top + radius : py > bottom - radius ? bottom - radius : py
  return (px - cx) * (px - cx) + (py - cy) * (py - cy) <= radius * radius
}

function writePng(filePath, size, pixelFn) {
  const png = encodePng(size, pixelFn)
  fs.writeFileSync(filePath, png)
  // 自检：签名 + IHDR 尺寸 + IDAT 可解压
  const head = png.subarray(0, 33)
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error(`PNG 签名错误: ${filePath}`)
  }
  if (head.readUInt32BE(8) !== 13) throw new Error(`IHDR 长度错误: ${filePath}`)
  if (head.readUInt32BE(16) !== size || head.readUInt32BE(20) !== size) {
    throw new Error(`PNG 尺寸错误: ${filePath}`)
  }
  const idatStart = png.indexOf(Buffer.from('IDAT', 'ascii'))
  const compressed = png.subarray(idatStart + 4, png.length - 12)
  const raw = zlib.inflateSync(compressed)
  if (raw.length !== (size * 4 + 1) * size) throw new Error(`PNG 解压长度错误: ${filePath}`)
  console.log(`ok ${path.relative(process.cwd(), filePath)} ${size}x${size} ${png.length}B`)
}

const outDir = path.join(__dirname, '..', 'electron', 'assets')
fs.mkdirSync(outDir, { recursive: true })

// macOS Template：纯黑字形，透明背景（系统自动适配明暗，无需双份）
writePng(
  path.join(outDir, 'tray-icon-template.png'),
  16,
  (x, y) => (isGlyphM(x, y, 16) ? [0, 0, 0, 255] : [0, 0, 0, 0])
)

// Windows / Linux：蓝底圆角 + 白字形（任务栏可见性优先，不用 Template）
writePng(
  path.join(outDir, 'tray-icon.png'),
  32,
  (x, y) => {
    if (!inRoundedRect(x, y, 32, 7)) return [0, 0, 0, 0]
    if (isGlyphM(x, y, 32)) return [255, 255, 255, 255]
    return [59, 130, 246, 255]
  }
)
