import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SendWechatFileTool, SendWechatImageTool } from './wechat-tools.js';

describe('WechatTools', () => {
  let server: http.Server;
  let port = 0;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(png);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));

  const pathSandbox = { resolveLenient: vi.fn((_p: string, ws: string | null) => _p.startsWith('/') ? _p : join(ws ?? '', _p)) };
  const support = { resolveAccount: vi.fn(async () => ({ accountId: 'acc', wxUserId: 'wx' })) };
  const upload = {
    uploadImage: vi.fn(async () => ({ mediaId: 'mid' })),
    uploadFile: vi.fn(async () => ({ mediaId: 'fid' })),
  };
  const send = { sendImage: vi.fn(async () => true), sendFile: vi.fn(async () => true) };

  it('sends local and remote images and files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-'));
    const imgPath = join(dir, 'a.png');
    writeFileSync(imgPath, png);
    const imageTool = new SendWechatImageTool(pathSandbox as never, support, upload, send);
    expect(imageTool.getName()).toBe('send_wechat_image');
    expect(JSON.parse(await imageTool.execute('{}', 11, 7, dir)).error).toContain('image');
    expect(JSON.parse(await imageTool.execute(JSON.stringify({ image: imgPath }), 11, 7, dir)).success).toBe(true);
    expect(JSON.parse(await imageTool.execute(JSON.stringify({ image: `http://127.0.0.1:${port}/a.png` }), 11, 7, dir)).success).toBe(true);
    support.resolveAccount.mockResolvedValueOnce(null);
    expect(JSON.parse(await imageTool.execute(JSON.stringify({ image: imgPath }), 11, 7, dir)).error).toContain('未绑定');

    const fileTool = new SendWechatFileTool(pathSandbox as never, support, upload, send);
    expect(fileTool.getName()).toBe('send_wechat_file');
    writeFileSync(join(dir, 'note.txt'), 'hello');
    pathSandbox.resolveLenient.mockReturnValue(join(dir, 'note.txt'));
    expect(JSON.parse(await fileTool.execute(JSON.stringify({ file: 'note.txt' }), 11, 7, dir)).success).toBe(true);
  });
});
