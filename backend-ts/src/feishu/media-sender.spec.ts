import { describe, expect, it, vi } from 'vitest';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { feishuFileTypeOf, feishuSendTargetOf, sendFeishuFile, sendFeishuImage } from './media-sender.js';

function makeClient(): Lark.Client & {
  im: { v1: { image: { create: ReturnType<typeof vi.fn> }; file: { create: ReturnType<typeof vi.fn> }; message: { create: ReturnType<typeof vi.fn> } } };
} {
  const client = {
    im: {
      v1: {
        image: { create: vi.fn() },
        file: { create: vi.fn() },
        message: { create: vi.fn() },
      },
    },
  };
  return client as never;
}

describe('feishuSendTargetOf', () => {
  it('parses p2p identity prefix and group chat as chat_id', () => {
    expect(feishuSendTargetOf('1', 'p2p:union:on_abc')).toEqual({ appId: '1', receiveId: 'on_abc', receiveIdType: 'union_id' });
    expect(feishuSendTargetOf('1', 'p2p:open:ou_def')).toEqual({ appId: '1', receiveId: 'ou_def', receiveIdType: 'open_id' });
    expect(feishuSendTargetOf('1', 'oc_chat')).toEqual({ appId: '1', receiveId: 'oc_chat', receiveIdType: 'chat_id' });
    expect(() => feishuSendTargetOf('1', 'p2p:on_legacy')).toThrow('缺少身份类型前缀');
  });
});

describe('feishuFileTypeOf', () => {
  it('maps known extensions and falls back to stream', () => {
    expect(feishuFileTypeOf('a.mp4')).toBe('mp4');
    expect(feishuFileTypeOf('报告.PDF')).toBe('pdf');
    expect(feishuFileTypeOf('b.docx')).toBe('doc');
    expect(feishuFileTypeOf('c.xlsx')).toBe('xls');
    expect(feishuFileTypeOf('d.pptx')).toBe('ppt');
    expect(feishuFileTypeOf('e.zip')).toBe('stream');
    expect(feishuFileTypeOf('noext')).toBe('stream');
  });
});

describe('sendFeishuImage', () => {
  it('uploads then sends an image message to the target', async () => {
    const client = makeClient();
    client.im.v1.image.create.mockResolvedValue({ image_key: 'img_v2' });
    client.im.v1.message.create.mockResolvedValue({ code: 0 });

    await sendFeishuImage(client, { appId: '1', receiveId: 'oc_chat', receiveIdType: 'chat_id' }, Buffer.from('png'));

    expect(client.im.v1.image.create).toHaveBeenCalledWith({ data: { image_type: 'message', image: Buffer.from('png') } });
    expect(client.im.v1.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_chat', msg_type: 'image', content: JSON.stringify({ image_key: 'img_v2' }) },
    });
  });

  it('throws when upload returns no image key', async () => {
    const client = makeClient();
    client.im.v1.image.create.mockResolvedValue(null);
    await expect(sendFeishuImage(client, feishuSendTargetOf('1', 'oc_chat'), Buffer.from('png'))).rejects.toThrow('飞书图片上传失败');
  });

  it('sends p2p target once with the identity type encoded in the prefix', async () => {
    const client = makeClient();
    client.im.v1.image.create.mockResolvedValue({ image_key: 'img_v2' });
    client.im.v1.message.create
      .mockResolvedValueOnce({ code: 99992400, msg: 'user not found' });

    await expect(sendFeishuImage(client, feishuSendTargetOf('1', 'p2p:union:on_abc'), Buffer.from('png')))
      .rejects.toThrow('code=99992400, msg=user not found');

    // 不做"猜身份重试"：失败一次即抛出真实错误码。
    expect(client.im.v1.message.create).toHaveBeenCalledTimes(1);
    expect(client.im.v1.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'union_id' },
      data: expect.objectContaining({ receive_id: 'on_abc' }),
    });
  });
});

describe('sendFeishuFile', () => {
  it('uploads with mapped file type and basename, then sends a file message', async () => {
    const client = makeClient();
    client.im.v1.file.create.mockResolvedValue({ file_key: 'file_v3' });
    client.im.v1.message.create.mockResolvedValue({ code: 0 });

    await sendFeishuFile(client, feishuSendTargetOf('1', 'oc_chat'), '/tmp/dir/报告.pdf', Buffer.from('pdf'));

    expect(client.im.v1.file.create).toHaveBeenCalledWith({
      data: { file_type: 'pdf', file_name: '报告.pdf', file: Buffer.from('pdf') },
    });
    expect(client.im.v1.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_chat', msg_type: 'file', content: JSON.stringify({ file_key: 'file_v3' }) },
    });
  });

  it('throws when upload returns no file key', async () => {
    const client = makeClient();
    client.im.v1.file.create.mockResolvedValue(null);
    await expect(sendFeishuFile(client, feishuSendTargetOf('1', 'oc_chat'), 'a.pdf', Buffer.from('pdf'))).rejects.toThrow('飞书文件上传失败');
  });
});
