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
    expect((await sender.send(`${base}/robot/send`, { text: 'test' })).success).toBe(true);
    expect((await sender.send(`${base}/robot/send`, { text: 'test' })).success).toBe(false);
  });

  it('dingTalkIgnoresCardAndKeepsTextPayload', async () => {
    let body = '';
    const base = await listen((req, res) => {
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end('{"errcode":0,"errmsg":"ok"}');
      });
    });
    const sender = new DingTalkWebhookSender();
    await sender.send(`${base}/robot/send`, { text: '纯文本', card: { header: { title: '卡片' } } });
    expect(JSON.parse(body)).toEqual({ msgtype: 'text', text: { content: '纯文本' } });
  });

  it('feishuSupportsCurrentAndLegacySuccessCodes', async () => {
    const bodies = ['{"code":0,"msg":"success"}', '{"StatusCode":0,"StatusMessage":"success"}'];
    const base = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(bodies.shift());
    });
    const sender = new FeishuWebhookSender();
    expect((await sender.send(`${base}/hook`, { text: 'test' })).success).toBe(true);
    expect((await sender.send(`${base}/hook`, { text: 'test' })).success).toBe(true);
  });

  it('feishuSendsInteractiveCardWhenCardProvided', async () => {
    let body = '';
    const base = await listen((req, res) => {
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end('{"code":0,"msg":"success"}');
      });
    });
    const sender = new FeishuWebhookSender();
    const card = { header: { template: 'green', title: { tag: 'plain_text', content: 'Mao Agent 任务通知' } }, elements: [] };
    expect((await sender.send(`${base}/hook`, { text: '文本回退', card })).success).toBe(true);
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload.msg_type).toBe('interactive');
    expect(payload.card).toEqual(card);
    // 有卡片时不再发文本消息，避免同一次通知重复。
    expect(payload.content).toBeUndefined();
  });

  it('feishuFallsBackToTextMessageWhenCardAbsent', async () => {
    let body = '';
    const base = await listen((req, res) => {
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end('{"code":0,"msg":"success"}');
      });
    });
    const sender = new FeishuWebhookSender();
    await sender.send(`${base}/hook`, { text: '纯文本' });
    expect(JSON.parse(body)).toEqual({ msg_type: 'text', content: { text: '纯文本' } });
  });
});
