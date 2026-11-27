import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256'

describe('sha256Hex', () => {
  it('标准测试向量', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('The quick brown fox jumps over the lazy dog'))
      .toBe('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592')
  })

  it('UTF-8 与 WebCrypto 一致（含跨 64 字节块）', async () => {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return // 极端环境无 WebCrypto 时只保留固定向量
    const samples = [
      '中文.png',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      'a'.repeat(1000),
      'src/b.ts\na.txt\n中文.png',
    ]
    for (const sample of samples) {
      const bytes = new TextEncoder().encode(sample)
      const hash = await subtle.digest('SHA-256', bytes)
      const expected = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
      expect(sha256Hex(sample)).toBe(expected)
    }
  })
})