'use strict'

/**
 * 从应用 logo 生成桌面托盘图标（electron/assets/）。
 * 运行：node scripts/gen-tray-icons.cjs（提交产物，脚本保留以便再生成）。
 * 源图：src/assets/app-icon.png（金色羽毛）。
 * - tray-icon-mac.png / tray-icon-mac@2x.png  22pt 彩色 logo（macOS 菜单栏）
 * - tray-icon.png                             32px 彩色 logo（Windows / Linux）
 * 不用 Template：Template 只保留透明度，会把羽毛压成单色剪影。
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

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 就地反滤波一行。bpp 为每像素字节数。 */
function unfilter(filter, row, prev, bpp) {
  if (filter === 0) return
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0
    const up = prev[i]
    const ul = i >= bpp ? prev[i - bpp] : 0
    if (filter === 1) row[i] = (row[i] + left) & 255
    else if (filter === 2) row[i] = (row[i] + up) & 255
    else if (filter === 3) row[i] = (row[i] + ((left + up) >> 1)) & 255
    else if (filter === 4) row[i] = (row[i] + paeth(left, up, ul)) & 255
    else throw new Error(`不支持的 PNG 滤波: ${filter}`)
  }
}

/** 解码 8-bit RGB / RGBA PNG，返回 { width, height, pixels }，pixels 为 RGBA。 */
function decodePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('PNG 签名错误')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  const idats = []
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || (data[9] !== 2 && data[9] !== 6)) {
        throw new Error(`只支持 8-bit RGB/RGBA，实际 bitDepth=${data[8]} colorType=${data[9]}`)
      }
      colorType = data[9]
    } else if (type === 'IDAT') {
      idats.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + len
  }
  if (!width || !height || colorType < 0 || idats.length === 0) throw new Error('PNG 缺少 IHDR/IDAT')
  const bpp = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idats))
  const stride = width * bpp
  if (raw.length !== (stride + 1) * height) throw new Error('PNG 解压长度错误')
  const pixels = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]
    const row = Buffer.from(raw.subarray(src, src + stride))
    src += stride
    unfilter(filter, row, prev, bpp)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const j = x * bpp
      pixels[i] = row[j]
      pixels[i + 1] = row[j + 1]
      pixels[i + 2] = row[j + 2]
      pixels[i + 3] = bpp === 4 ? row[j + 3] : 255
    }
    row.copy(prev)
  }
  return { width, height, pixels }
}

/** 面积加权缩小，避免 512→22 时最近邻发糊或锯齿。 */
function areaSample(src, sw, sh, size) {
  return (x, y) => {
    const x0 = (x * sw) / size
    const x1 = ((x + 1) * sw) / size
    const y0 = (y * sh) / size
    const y1 = ((y + 1) * sh) / size
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    let wsum = 0
    const ix0 = Math.floor(x0)
    const ix1 = Math.min(sw - 1, Math.ceil(x1) - 1)
    const iy0 = Math.floor(y0)
    const iy1 = Math.min(sh - 1, Math.ceil(y1) - 1)
    for (let iy = iy0; iy <= iy1; iy++) {
      const wy = Math.min(iy + 1, y1) - Math.max(iy, y0)
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = Math.min(ix + 1, x1) - Math.max(ix, x0)
        const w = wx * wy
        const p = (iy * sw + ix) * 4
        r += src[p] * w
        g += src[p + 1] * w
        b += src[p + 2] * w
        a += src[p + 3] * w
        wsum += w
      }
    }
    const scale = wsum || 1
    return [Math.round(r / scale), Math.round(g / scale), Math.round(b / scale), Math.round(a / scale)]
  }
}

function writePng(filePath, size, pixelFn) {
  const png = encodePng(size, pixelFn)
  fs.writeFileSync(filePath, png)
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error(`PNG 签名错误: ${filePath}`)
  }
  const head = png.subarray(0, 33)
  if (head.readUInt32BE(8) !== 13) throw new Error(`IHDR 长度错误: ${filePath}`)
  if (head.readUInt32BE(16) !== size || head.readUInt32BE(20) !== size) {
    throw new Error(`PNG 尺寸错误: ${filePath}`)
  }
  console.log(`ok ${path.relative(process.cwd(), filePath)} ${size}x${size} ${png.length}B`)
}

const srcPath = path.join(__dirname, '..', 'src', 'assets', 'app-icon.png')
const outDir = path.join(__dirname, '..', 'electron', 'assets')
const decoded = decodePng(fs.readFileSync(srcPath))
fs.mkdirSync(outDir, { recursive: true })

for (const [name, size] of [
  ['tray-icon-mac.png', 22],
  ['tray-icon-mac@2x.png', 44],
  ['tray-icon.png', 32],
]) {
  writePng(path.join(outDir, name), size, areaSample(decoded.pixels, decoded.width, decoded.height, size))
}

const legacy = path.join(outDir, 'tray-icon-template.png')
if (fs.existsSync(legacy)) {
  fs.unlinkSync(legacy)
  console.log(`removed ${path.relative(process.cwd(), legacy)}`)
}
