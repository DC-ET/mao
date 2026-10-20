import { describe, expect, it, vi } from 'vitest';
import type { Transporter } from 'nodemailer';
import {
  EmailWebhookSender, EMAIL_NOT_CONFIGURED_ERROR, maskEmail, renderEmail,
  type EmailSmtpConfigProvider, type EmailTransportOptions, type TransportFactory,
} from './email-sender.js';
import type { EmailSmtpSettings } from '../../settings/types.js';

function config(overrides: Partial<EmailSmtpSettings> = {}): EmailSmtpSettings {
  return {
    enabled: true,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpUser: 'sender@example.com',
    smtpPassword: 'secret',
    fromAddr: 'noreply@example.com',
    useTls: true,
    ...overrides,
  };
}

function provider(current: EmailSmtpSettings): EmailSmtpConfigProvider {
  return { getEmailSmtpConfig: async () => current };
}

interface CapturedMail {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
}

/** 捕获 sendMail 入参与 transport 工厂选项的 stub（方案 §3.1：测试可注入 transport stub）。 */
function stubFactory(handler: (mail: CapturedMail) => Promise<Record<string, unknown>>) {
  const mails: CapturedMail[] = [];
  const options: EmailTransportOptions[] = [];
  const factory: TransportFactory = (opts) => {
    options.push(opts);
    return {
      sendMail: async (mail: CapturedMail) => {
        mails.push(mail);
        return handler(mail);
      },
      close: () => true,
    } as unknown as Transporter;
  };
  return { factory, mails, options };
}

const TASK_FAILURE_TEXT = 'Mao 任务失败通知\n任务：生成周报\n结果：执行失败\n时间：2026-10-20 10:00:00\n原因：模型超时';

describe('maskEmail', () => {
  it('本地部分保留首字符其余打码', () => {
    expect(maskEmail('z***@example.com'.replace('z***', 'zhangsan'))).toBe('z***@example.com');
    expect(maskEmail('zhangsan@example.com')).toBe('z***@example.com');
  });

  it('本地部分长度为 1 时整体打码', () => {
    expect(maskEmail('a@example.com')).toBe('***@example.com');
  });

  it('无 @ 的脏数据整体打码', () => {
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });

  it('超长域名原样保留', () => {
    const domain = 'very-long-subdomain.example-company.co.uk';
    expect(maskEmail(`user@${domain}`)).toBe(`u***@${domain}`);
  });
});

describe('renderEmail', () => {
  it('subject 取 text 首行，text 原文双 Part 齐备', () => {
    const rendered = renderEmail({ text: TASK_FAILURE_TEXT });
    expect(rendered.subject).toBe('Mao 任务失败通知');
    expect(rendered.text).toBe(TASK_FAILURE_TEXT);
    expect(rendered.html).toContain('Mao 任务失败通知');
    expect(rendered.html).toContain('任务：生成周报');
    expect(rendered.html).toContain('原因：模型超时');
    expect(rendered.html).toContain('本邮件由 Mao 实例自动发送');
    // 换行转 <br />，缩进保留
    expect(rendered.html).toContain('<br />');
  });

  it('HTML 正文转义用户内容', () => {
    const rendered = renderEmail({ text: 'Mao 任务完成通知\n任务：<script>alert(1)</script> & "quoted"' });
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;');
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
  });

  it('首行含换行时只取首行，不把后续行带进 subject', () => {
    // 防御性目标：text 后续行（哪怕未来含用户输入）不得进入 header
    const rendered = renderEmail({ text: 'Mao 测试通知\r\nBcc: evil@x.com\n正文' });
    expect(rendered.subject).toBe('Mao 测试通知');
    expect(rendered.html).toContain('Bcc: evil@x.com');
  });

  it('无换行的 text 整体作为 subject，正文为空', () => {
    const rendered = renderEmail({ text: 'Mao Agent 测试通知' });
    expect(rendered.subject).toBe('Mao Agent 测试通知');
    expect(rendered.html).toContain('Mao Agent 测试通知');
  });

  it('card 被忽略（决策 6）', () => {
    const rendered = renderEmail({ text: 'Mao 提问通知\n任务：问答', card: { schema: '2.0' } });
    expect(rendered.html).not.toContain('schema');
  });
});

describe('EmailWebhookSender', () => {
  it('channel 为 EMAIL', () => {
    const sender = new EmailWebhookSender(provider(config()));
    expect(sender.channel()).toBe('EMAIL');
  });

  it('发送双 Part 邮件：subject=首行、from/to/超时参数齐备', async () => {
    const { factory, mails, options } = stubFactory(async () => ({}));
    const sender = new EmailWebhookSender(provider(config()), factory);
    const result = await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT, card: { schema: '2.0' } });
    expect(result.success).toBe(true);
    expect(result.retryable).toBe(false);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('Mao 任务失败通知');
    expect(mails[0].from).toBe('noreply@example.com');
    expect(mails[0].to).toBe('user@corp.com');
    expect(mails[0].text).toBe(TASK_FAILURE_TEXT);
    expect(mails[0].html).toContain('本邮件由 Mao 实例自动发送');
    // card 不进邮件；transport 超时对齐 webhook 10s
    expect(options[0].connectionTimeout).toBe(10_000);
    expect(options[0].socketTimeout).toBe(10_000);
    expect(options[0].secure).toBe(true);
    expect(options[0]).toMatchObject({ host: 'smtp.example.com', port: 465 });
  });

  it('fromAddr 为空时回落 smtpUser', async () => {
    const { factory, mails } = stubFactory(async () => ({}));
    const sender = new EmailWebhookSender(provider(config({ fromAddr: '' })), factory);
    await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
    expect(mails[0].from).toBe('sender@example.com');
  });

  it('未启用 / 缺 host / 缺发件人 → 不可重试且不发送', async () => {
    for (const bad of [config({ enabled: false }), config({ smtpHost: '' }), config({ fromAddr: '', smtpUser: '' })]) {
      const { factory, mails } = stubFactory(async () => ({}));
      const sender = new EmailWebhookSender(provider(bad), factory);
      const result = await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toBe(EMAIL_NOT_CONFIGURED_ERROR);
      expect(mails).toHaveLength(0);
    }
  });

  it('收件邮箱为空 → 不可重试', async () => {
    const { factory } = stubFactory(async () => ({}));
    const sender = new EmailWebhookSender(provider(config()), factory);
    const result = await sender.send('  ', { text: TASK_FAILURE_TEXT });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('认证失败 535 → 不可重试，带响应摘要', async () => {
    const { factory } = stubFactory(async () => {
      const error = new Error('Invalid login') as Error & { code?: string; responseCode?: number; response?: string };
      error.code = 'EAUTH';
      error.responseCode = 535;
      error.response = '535 5.7.8 Authentication credentials invalid';
      throw error;
    });
    const sender = new EmailWebhookSender(provider(config()), factory);
    const result = await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(535);
    expect(result.providerCode).toBe('EAUTH');
    expect(result.error).toContain('535');
  });

  it('收件人无效 550 → 不可重试', async () => {
    const { factory } = stubFactory(async () => {
      const error = new Error('No such user') as Error & { code?: string; responseCode?: number };
      error.code = 'EENVELOPE';
      error.responseCode = 550;
      throw error;
    });
    const sender = new EmailWebhookSender(provider(config()), factory);
    const result = await sender.send('ghost@corp.com', { text: TASK_FAILURE_TEXT });
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(550);
  });

  it('SMTP 5xx → 可重试', async () => {
    const { factory } = stubFactory(async () => {
      const error = new Error('Try later') as Error & { responseCode?: number };
      error.responseCode = 451;
      throw error;
    });
    const sender = new EmailWebhookSender(provider(config()), factory);
    const result = await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.httpStatus).toBe(451);
  });

  it('网络错 / 超时 → 可重试', async () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET']) {
      const { factory } = stubFactory(async () => {
        const error = new Error('network') as Error & { code?: string };
        error.code = code;
        throw error;
      });
      const sender = new EmailWebhookSender(provider(config()), factory);
      const result = await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('邮件发送网络失败');
    }
  });

  it('未覆盖的错误 code → 保守按可重试', async () => {
    const { factory } = stubFactory(async () => {
      throw new Error('mystery');
    });
    const sender = new EmailWebhookSender(provider(config()), factory);
    const result = await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('邮件发送失败');
  });

  it('rejected 非空（服务端拒收）→ 不可重试', async () => {
    const { factory } = stubFactory(async () => ({ rejected: ['ghost@corp.com'] }));
    const sender = new EmailWebhookSender(provider(config()), factory);
    const result = await sender.send('ghost@corp.com', { text: TASK_FAILURE_TEXT });
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(550);
    expect(result.error).toContain('ghost@corp.com');
  });

  it('transport 按配置复用，配置变更即重建', async () => {
    let current = config();
    const { factory, options } = stubFactory(async () => ({}));
    const sender = new EmailWebhookSender({ getEmailSmtpConfig: async () => current }, factory);
    await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
    await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
    expect(options).toHaveLength(1);
    current = config({ smtpHost: 'smtp2.example.com', smtpPort: 587, useTls: false });
    await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
    expect(options).toHaveLength(2);
    expect(options[1]).toMatchObject({ host: 'smtp2.example.com', port: 587, secure: false });
    // 仅密码变化也重建（auth 变更必须生效）
    current = config({ smtpPassword: 'new-secret' });
    await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
    expect(options).toHaveLength(3);
    expect(options[2].auth).toMatchObject({ user: 'sender@example.com', pass: 'new-secret' });
  });

  it('smtpUser 为空时不带 auth', async () => {
    const { factory, options } = stubFactory(async () => ({}));
    const sender = new EmailWebhookSender(provider(config({ smtpUser: '', smtpPassword: '' })), factory);
    await sender.send('user@corp.com', { text: TASK_FAILURE_TEXT });
    expect(options[0].auth).toBeUndefined();
  });
});
