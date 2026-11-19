import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { gunzipBounded, isGzipBytes, isTarFileName, loadTarArchive, parseTarBytes } from './tar-archive'

const ENCODER = new TextEncoder()

function writeAscii(buf: Uint8Array, offset: number, str: string, maxLen: number) {
  const bytes = ENCODER.encode(str)
  buf.set(bytes.subarray(0, maxLen), offset)
}

function writeOctal(buf: Uint8Array, offset: number, value: number, fieldLen: number) {
  const oct = value.toString(8).padStart(fieldLen - 1, '0')
  writeAscii(buf, offset, oct, fieldLen - 1)
  buf[offset + fieldLen - 1] = 0
}

function finalizeHeaderChecksum(header: Uint8Array) {
  // chksum field (148..156) filled with spaces during sum calculation
  for (let i = 148; i < 156; i++) header[i] = 0x20
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  const oct = sum.toString(8).padStart(6, '0')
  writeAscii(header, 148, oct, 6)
  header[154] = 0
  header[155] = 0x20
}

function buildTarBlock(opts: {
  name: string
  typeFlag: string
  payload?: Uint8Array
  prefix?: string
}): Uint8Array {
  const payload = opts.payload ?? new Uint8Array(0)
  const paddedPayload = Math.ceil(payload.byteLength / 512) * 512
  const out = new Uint8Array(512 + paddedPayload)
  writeAscii(out, 0, opts.name, 100)
  writeOctal(out, 100, 0o644, 8)
  writeOctal(out, 108, 0, 8)
  writeOctal(out, 116, 0, 8)
  writeOctal(out, 124, payload.byteLength, 12)
  writeOctal(out, 136, 0, 12)
  out[156] = opts.typeFlag.charCodeAt(0)
  writeAscii(out, 257, 'ustar', 5)
  writeAscii(out, 263, '00', 2)
  if (opts.prefix) {
    writeAscii(out, 345, opts.prefix, 155)
  }
  finalizeHeaderChecksum(out.subarray(0, 512))
  out.set(payload, 512)
  return out
}

function concatBlocks(blocks: Uint8Array[]): Uint8Array {
  const eof = new Uint8Array(1024)
  const total = blocks.reduce((s, b) => s + b.byteLength, 0) + eof.byteLength
  const out = new Uint8Array(total)
  let pos = 0
  for (const b of blocks) {
    out.set(b, pos)
    pos += b.byteLength
  }
  return out
}

describe('tar-archive 解析与解压守卫', () => {
  it('识别 tar / tar.gz / tgz 后缀与 gzip 魔数', () => {
    expect(isTarFileName('ark-cli-skill-20261119.tar.gz')).toBe(true)
    expect(isTarFileName('pkg.tgz')).toBe(true)
    expect(isTarFileName('archive.TAR')).toBe(true)
    expect(isTarFileName('bundle.zip')).toBe(false)

    const gz = new Uint8Array(gzipSync(Buffer.from('hello')))
    expect(isGzipBytes(gz)).toBe(true)
    expect(isGzipBytes(new Uint8Array([0x50, 0x4b]))).toBe(false)
  })

  it('解析 .tar.gz 包中的目录、普通文件、ustar prefix 与 PAX 中文路径', async () => {
    const skillBody = ENCODER.encode('# ark-cli\n技能说明')
    const paxRecord = (() => {
      const kv = 'path=ark-cli/中文说明.md\n'
      // 反复收敛长度前缀字节数
      let len = kv.length + 3
      let line = `${len} ${kv}`
      len = ENCODER.encode(line).byteLength
      line = `${len} ${kv}`
      return ENCODER.encode(line)
    })()

    const tar = concatBlocks([
      buildTarBlock({ name: './ark-cli/', typeFlag: '5' }),
      buildTarBlock({ name: 'SKILL.md', prefix: 'ark-cli', typeFlag: '0', payload: skillBody }),
      // 符号链接应被安全跳过，不混入普通条目
      buildTarBlock({ name: 'ark-cli/latest', typeFlag: '2' }),
      // PAX 扩展头覆盖下一条目的 UTF-8 路径
      buildTarBlock({ name: 'pax-header', typeFlag: 'x', payload: paxRecord }),
      buildTarBlock({ name: 'fallback.md', typeFlag: '0', payload: ENCODER.encode('中文正文') }),
    ])

    const tarGz = new Uint8Array(gzipSync(tar))
    const entries = await loadTarArchive(tarGz)

    expect(entries.map(e => ({ name: e.name, dir: e.isDirectory, size: e.uncompressedSize }))).toEqual([
      { name: 'ark-cli/', dir: true, size: 0 },
      { name: 'ark-cli/SKILL.md', dir: false, size: skillBody.byteLength },
      { name: 'ark-cli/中文说明.md', dir: false, size: ENCODER.encode('中文正文').byteLength },
    ])
    expect(new TextDecoder().decode(entries[1].data)).toBe('# ark-cli\n技能说明')
    expect(new TextDecoder().decode(entries[2].data)).toBe('中文正文')
  })

  it('gzip 炸弹防线：解压字节超过上限时立即中止并报错', async () => {
    const bigZero = Buffer.alloc(4096, 0x41)
    const gz = new Uint8Array(gzipSync(bigZero))
    await expect(gunzipBounded(gz, 1024)).rejects.toThrow(/上限/)
  })

  it('截断损坏的 tar 包抛出明确错误', () => {
    const broken = buildTarBlock({ name: 'a.txt', typeFlag: '0', payload: ENCODER.encode('hello world') })
    expect(() => parseTarBytes(broken.subarray(0, 516))).toThrow(/损坏|截断/)
  })
})
