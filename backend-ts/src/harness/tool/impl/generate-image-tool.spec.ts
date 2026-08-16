import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenerateImageTool } from './generate-image-tool.js';

describe('GenerateImageTool', () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('PNG').toString('base64') }, { url: 'https://cdn.example/a.png' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));

  it('generates images from local mock api', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'img-'));
    const tool = new GenerateImageTool({
      findFirstActiveImageModel: async () => ({
        modelId: 'gpt-image', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k',
      }),
    }, dir, 'https://mao.example/uploads');
    expect(tool.getName()).toBe('generate_image');
    expect(tool.getToolPrompt()).toContain('prompt');
    const missing = JSON.parse(await tool.execute('{}', 1, null));
    expect(missing.error).toContain('prompt');
    const emptyModel = new GenerateImageTool({ findFirstActiveImageModel: async () => null }, dir);
    expect(JSON.parse(await emptyModel.execute(JSON.stringify({ prompt: 'cat' }), 1, null)).error).toContain('文生图');
    const result = JSON.parse(await tool.execute(JSON.stringify({ prompt: 'a cat', n: 2 }), 1, null));
    expect(result.images.length).toBe(2);
    expect(result.images[0].image_url).toContain('uploads');
  });
});
