import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractZip, syncSkills } from '../src/local/skills';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

interface Spec {
  name: string;
  data?: string;
  method?: 0 | 8;
  /** 高 16 位 = unix mode，用来构造 symlink 条目。 */
  unixMode?: number;
}

/** 手工拼最小 zip：覆盖 stored(0) / deflate(8)、目录条目、非法路径与 symlink 条目。 */
function buildZip(specs: Spec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const spec of specs) {
    const nameBuf = Buffer.from(spec.name, 'utf8');
    const raw = Buffer.from(spec.data ?? '', 'utf8');
    const method = spec.method ?? 8;
    const payload = method === 0 ? raw : zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((spec.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-zip-')));
}

describe('extractZip', () => {
  it('extracts deflate and stored entries, creating directories', () => {
    const dest = tempDir();
    const zip = buildZip([
      { name: 'demo/', unixMode: 0o040755 },
      { name: 'demo/SKILL.md', data: '---\nname: demo\n---\n' },
      { name: '.sync-manifest.json', data: '{"skills":["demo"]}', method: 0 },
    ]);
    const written = extractZip(zip, dest);
    expect(written.sort()).toEqual(['.sync-manifest.json', path.join('demo', 'SKILL.md')].sort());
    expect(fs.readFileSync(path.join(dest, 'demo/SKILL.md'), 'utf8')).toBe('---\nname: demo\n---\n');
    expect(fs.readFileSync(path.join(dest, '.sync-manifest.json'), 'utf8')).toBe('{"skills":["demo"]}');
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('rejects zip-slip entries with ../', () => {
    const dest = tempDir();
    const zip = buildZip([{ name: '../evil.txt', data: 'pwned' }]);
    expect(() => extractZip(zip, dest)).toThrow(/非法路径条目/);
    expect(fs.existsSync(path.join(path.dirname(dest), 'evil.txt'))).toBe(false);
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('rejects absolute entry paths', () => {
    const dest = tempDir();
    expect(() => extractZip(buildZip([{ name: '/etc/evil', data: 'x' }]), dest)).toThrow(/非法路径条目/);
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('rejects symlink entries', () => {
    const dest = tempDir();
    const zip = buildZip([{ name: 'demo/link', data: '/etc/passwd', unixMode: 0o120777 }]);
    expect(() => extractZip(zip, dest)).toThrow(/符号链接条目/);
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('rejects unsupported compression methods', () => {
    const dest = tempDir();
    const zip = buildZip([{ name: 'demo/a.txt', data: 'x', method: 0 }]);
    zip.writeUInt16LE(9, 8);
    const cdOffset = zip.readUInt32LE(zip.length - 6);
    zip.writeUInt16LE(9, cdOffset + 10);
    expect(() => extractZip(zip, dest)).toThrow(/不支持的压缩方法/);
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('rejects buffers that are not zip archives', () => {
    const dest = tempDir();
    expect(() => extractZip(Buffer.from('not a zip at all'), dest)).toThrow(/不是合法的 zip/);
    fs.rmSync(dest, { recursive: true, force: true });
  });
});

describe('syncSkills origin check', () => {
  it('refuses absolute syncUrl pointing at another origin', async () => {
    await expect(syncSkills({
      sessionId: 1,
      syncUrl: 'https://evil.example.com/steal',
      baseUrl: 'https://mao.etarch.cn/api/v1',
      token: 'jwt-token',
    })).rejects.toThrow(/拒绝跨源技能同步/);
  });

  it('accepts same-origin absolute syncUrl (fails later at the network layer)', async () => {
    await expect(syncSkills({
      sessionId: 1,
      syncUrl: 'http://127.0.0.1:1/api/v1/skills/sync',
      baseUrl: 'http://127.0.0.1:1/api/v1',
      token: null,
    })).rejects.not.toThrow(/拒绝跨源技能同步/);
  });
});
