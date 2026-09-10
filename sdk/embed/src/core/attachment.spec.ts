import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_ATTACHMENT_MB,
  collectPastedFiles,
  createPendingAttachment,
  fetchMaxAttachmentMb,
  formatAttachmentSize,
  isImageAttachment,
  uploadAttachments,
  type AttachmentRestClient,
  type PendingAttachment,
} from './attachment';

function clipboardOf(files: File[], text = '') {
  return {
    items: files.map((file) => ({
      kind: 'file',
      getAsFile: () => file,
    })),
    files,
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  } as unknown as DataTransfer;
}

function attachment(file: File): PendingAttachment {
  return { id: file.name, file, previewUrl: null };
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('collectPastedFiles', () => {
  it('取出剪切板里的图片与文件，忽略文本项', () => {
    const image = new File(['x'], 'shot.png', { type: 'image/png' });
    const doc = new File(['y'], 'a.pdf', { type: 'application/pdf' });
    const data = clipboardOf([image, doc], '纯文本');
    expect(collectPastedFiles(data)).toEqual([image, doc]);
  });

  it('无文件时返回空数组（纯文本粘贴交给浏览器）', () => {
    expect(collectPastedFiles(clipboardOf([], 'hello'))).toEqual([]);
    expect(collectPastedFiles(null)).toEqual([]);
  });

  it('items 缺失时回退到 data.files', () => {
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    const data = { files: [file] } as unknown as DataTransfer;
    expect(collectPastedFiles(data)).toEqual([file]);
  });
});

describe('createPendingAttachment', () => {
  it('图片生成预览 object URL，其他文件不生成', () => {
    const create = vi.fn(() => 'blob:preview');
    URL.createObjectURL = create as unknown as typeof URL.createObjectURL;
    const image = createPendingAttachment(new File(['x'], 'shot.png', { type: 'image/png' }));
    const doc = createPendingAttachment(new File(['y'], 'a.pdf', { type: 'application/pdf' }));
    expect(image.previewUrl).toBe('blob:preview');
    expect(doc.previewUrl).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(isImageAttachment(image.file)).toBe(true);
  });
});

describe('formatAttachmentSize', () => {
  it('按量级显示大小', () => {
    expect(formatAttachmentSize(12)).toBe('12 B');
    expect(formatAttachmentSize(2048)).toBe('2 KB');
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('fetchMaxAttachmentMb', () => {
  it('返回后台配置的上限', async () => {
    const client = { request: vi.fn(async () => ({ maxSizeMb: 50 })), upload: vi.fn() } as unknown as AttachmentRestClient;
    expect(await fetchMaxAttachmentMb(client)).toBe(50);
    expect(client.request).toHaveBeenCalledWith('GET', '/upload/config');
  });

  it('配置缺失或请求失败时回退默认值', async () => {
    const empty = { request: vi.fn(async () => ({})), upload: vi.fn() } as unknown as AttachmentRestClient;
    expect(await fetchMaxAttachmentMb(empty)).toBe(DEFAULT_MAX_ATTACHMENT_MB);
    const failing = {
      request: vi.fn(async () => { throw new Error('offline'); }),
      upload: vi.fn(),
    } as unknown as AttachmentRestClient;
    expect(await fetchMaxAttachmentMb(failing)).toBe(DEFAULT_MAX_ATTACHMENT_MB);
  });
});

describe('uploadAttachments', () => {
  it('图片走 /files/upload 并补全相对地址，其他文件走 upload-incoming 生成引用', async () => {
    const calls: Array<{ path: string; sessionId: FormDataEntryValue | null }> = [];
    const client = {
      request: vi.fn(),
      upload: vi.fn(async (path: string, form: FormData) => {
        calls.push({ path, sessionId: form.get('sessionId') });
        if (path === '/files/upload') return { url: '/uploads/pic.png' };
        return { absolutePath: '/opt/mao/data/runtime/2/1/incoming/a.pdf' };
      }),
    } as unknown as AttachmentRestClient;
    const result = await uploadAttachments({
      attachments: [
        attachment(new File(['x'], 'shot.png', { type: 'image/png' })),
        attachment(new File(['y'], 'a.pdf', { type: 'application/pdf' })),
      ],
      client,
      sessionId: 42,
      resolveAssetUrl: (url) => `https://mao.example.com${url}`,
    });
    expect(calls.map((c) => c.path)).toEqual(['/files/upload', '/files/upload-incoming']);
    // 图片不绑会话（通用 uploads），文件必须带 sessionId 落到 runtime incoming
    expect(calls[0].sessionId).toBeNull();
    expect(calls[1].sessionId).toBe('42');
    expect(result.images).toEqual(['https://mao.example.com/uploads/pic.png']);
    expect(result.refs).toEqual(['@{/opt/mao/data/runtime/2/1/incoming/a.pdf}@']);
    expect(result.failed).toEqual([]);
  });

  it('单个附件失败只记录文件名，其他附件继续上传', async () => {
    const client = {
      request: vi.fn(),
      upload: vi.fn(async (path: string) => {
        if (path === '/files/upload') throw new Error('boom');
        return { absolutePath: '/tmp/a.pdf' };
      }),
    } as unknown as AttachmentRestClient;
    const result = await uploadAttachments({
      attachments: [
        attachment(new File(['x'], 'shot.png', { type: 'image/png' })),
        attachment(new File(['y'], 'a.pdf', { type: 'application/pdf' })),
      ],
      client,
      sessionId: 1,
      resolveAssetUrl: (url) => url,
    });
    expect(result.images).toEqual([]);
    expect(result.refs).toEqual(['@{/tmp/a.pdf}@']);
    expect(result.failed).toEqual(['shot.png']);
  });

  it('响应缺少必要字段按失败处理，避免发出无法访问的图片', async () => {
    const client = {
      request: vi.fn(),
      upload: vi.fn(async () => ({})),
    } as unknown as AttachmentRestClient;
    const result = await uploadAttachments({
      attachments: [attachment(new File(['x'], 'shot.png', { type: 'image/png' }))],
      client,
      sessionId: 1,
      resolveAssetUrl: (url) => url,
    });
    expect(result).toEqual({ images: [], refs: [], failed: ['shot.png'] });
  });
});
