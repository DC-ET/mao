import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it, afterEach } from 'vitest';
import { DingTalkWebhookSender, FeishuWebhookSender } from './webhook-sender.js';

describe('WebhookSender', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers.length = 0;
  });

  async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      return `http://127.0.0.1:${addr.port}`;
    }
    throw new Error('no port');
  }

  it('dingTalkRequiresHttpAndBusinessSuccess', async () => {
    const bodies = ['{"errcode":0,"errmsg":"ok"}', '{"errcode":310000,"errmsg":"invalid"}'];
    const base = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(bodies.shift());
    });
    const sender = new DingTalkWebhookSender();
    expect((await sender.send(`${base}/robot/send`, 'test')).success).toBe(true);
    expect((await sender.send(`${base}/robot/send`, 'test')).success).toBe(false);
  });

  it('feishuSupportsCurrentAndLegacySuccessCodes', async () => {
    const bodies = ['{"code":0,"msg":"success"}', '{"StatusCode":0,"StatusMessage":"success"}'];
    const base = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(bodies.shift());
    });
    const sender = new FeishuWebhookSender();
    expect((await sender.send(`${base}/hook`, 'test')).success).toBe(true);
    expect((await sender.send(`${base}/hook`, 'test')).success).toBe(true);
  });
});
