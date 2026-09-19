import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { AGENT_AVATAR_MAX_BYTES, normalizeAgentAvatar, registerAgentAvatarRoutes, validateAgentAvatarUrl } from './agent-avatar.js';

const avatarUrl = '/uploads/12345678-1234-1234-1234-123456789abc.png';
const image = () => sharp({ create: { width: 8, height: 8, channels: 4, background: 'red' } });

function multipartBody(bytes: Buffer, mime = 'image/png', field = 'file', repeat = 1): Buffer {
  const parts = Array.from({ length: repeat }, () => Buffer.concat([
    Buffer.from(`--avatar-boundary\r\nContent-Disposition: form-data; name="${field}"; filename="../../evil.svg"\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes, Buffer.from('\r\n'),
  ]));
  return Buffer.concat([...parts, Buffer.from('--avatar-boundary--\r\n')]);
}

describe('Agent avatar validation', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('fully decodes and normalizes %s without metadata or trailing payload', async (format) => {
    const input = await image().toFormat(format).toBuffer();
    const output = await normalizeAgentAvatar(Buffer.concat([input, Buffer.from('<script>evil</script>')]), `image/${format}`);
    expect((await sharp(output).metadata()).format).toBe('png');
    expect(output.includes(Buffer.from('<script>'))).toBe(false);
  });

  it('accepts WeChat editor uploads with missing or generic MIME based on magic bytes', async () => {
    const jpeg = await image().jpeg().toBuffer();
    for (const mime of ['', 'application/octet-stream']) {
      const output = await normalizeAgentAvatar(jpeg, mime);
      expect((await sharp(output).metadata()).format).toBe('png');
    }
    await expect(normalizeAgentAvatar(jpeg, 'image/png')).rejects.toThrow('一致');
  });

  it('rejects empty, oversized, SVG, fake, mismatched and truncated images', async () => {
    const png = await image().png().toBuffer();
    for (const [bytes, mime] of [
      [Buffer.alloc(0), 'image/png'], [Buffer.alloc(AGENT_AVATAR_MAX_BYTES + 1), 'image/png'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
      [Buffer.from('<svg/>'), 'image/png'], [png, 'image/jpeg'], [png.subarray(0, 40), 'image/png'],
    ] as const) {
      await expect(normalizeAgentAvatar(bytes, mime)).rejects.toThrow();
    }
  });

  it('rejects excessive dimensions and animated WebP', async () => {
    const wide = await sharp({ create: { width: 4097, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
    await expect(normalizeAgentAvatar(wide, 'image/png')).rejects.toThrow();
    const animated = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]), {
      raw: { width: 2, height: 2, channels: 3, pageHeight: 1 },
    }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    await expect(normalizeAgentAvatar(animated, 'image/webp')).rejects.toThrow();
  });

  it('rejects APNG animation control chunks and bounds the normalized size', async () => {
    const png = await image().png().toBuffer();
    const animationControl = Buffer.alloc(20);
    animationControl.writeUInt32BE(8, 0);
    animationControl.write('acTL', 4);
    await expect(normalizeAgentAvatar(Buffer.concat([png.subarray(0, 33), animationControl, png.subarray(33)]), 'image/png')).rejects.toThrow('动画');
    const large = await sharp({ create: { width: 1024, height: 768, channels: 3, background: 'red' } }).png().toBuffer();
    const metadata = await sharp(await normalizeAgentAvatar(large, 'image/png')).metadata();
    expect(metadata).toMatchObject({ width: 512, height: 384 });
  });

  it('restricts avatar URLs to local UUID PNG paths', () => {
    for (const value of [undefined, null, avatarUrl]) expect(() => validateAgentAvatarUrl(value)).not.toThrow();
    for (const value of ['', 'https://evil/a.png', '//evil/a.png', 'data:image/svg+xml,test', '/uploads/../a.png', avatarUrl + '?x', avatarUrl.replace('.png', '.svg'), 5, {}]) {
      expect(() => validateAgentAvatarUrl(value)).toThrow();
    }
  });
});

describe('Agent avatar upload route', () => {
  async function setup(userId: number | undefined = 7, allowed = true) {
    const app = Fastify();
    app.setErrorHandler(handleError);
    await app.register(multipart);
    app.addHook('preHandler', async (request) => { request.userId = userId; });
    const uploadFile = vi.fn(async () => ({ storedName: avatarUrl.slice('/uploads/'.length) })) as never;
    const permission = { hasPermission: vi.fn(async () => allowed) };
    registerAgentAvatarRoutes(app, { uploadFile }, permission);
    return { app, uploadFile, permission };
  }

  it('stores normalized PNG using the existing file service and returns a public URL', async () => {
    const { app, uploadFile, permission } = await setup();
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/agents/avatar',
        headers: { 'content-type': 'multipart/form-data; boundary=avatar-boundary' },
        payload: multipartBody(await image().jpeg().toBuffer(), 'image/jpeg'),
      });
      expect(response.json()).toMatchObject({ code: 0, data: { avatarUrl } });
      expect(permission.hasPermission).toHaveBeenCalledWith(7, 'agent:write');
      expect(uploadFile).toHaveBeenCalledWith(expect.any(Buffer), 'agent-avatar.png', 'image/png', 7, null);
    } finally { await app.close(); }
  });

  it.each([401, 403])('requires authentication and permission (%s)', async (status) => {
    const { app, uploadFile } = await setup(7, false);
    if (status === 401) app.addHook('preHandler', async (request) => { request.userId = undefined; });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/agents/avatar', payload: {} });
      expect(response.statusCode).toBe(status);
      expect(uploadFile).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('rejects malformed requests, missing/wrong fields, multiple files and multipart truncation before storage', async () => {
    const { app, uploadFile } = await setup();
    const png = await image().png().toBuffer();
    try {
      for (const payload of [
        Buffer.from('--avatar-boundary--\r\n'), multipartBody(png, 'image/png', 'wrong'),
        multipartBody(png, 'image/png', 'file', 2), multipartBody(Buffer.alloc(AGENT_AVATAR_MAX_BYTES + 1)),
        multipartBody(Buffer.from('<svg/>')), Buffer.from('malformed'),
      ]) {
        const response = await app.inject({ method: 'POST', url: '/v1/agents/avatar',
          headers: { 'content-type': 'multipart/form-data; boundary=avatar-boundary' }, payload });
        expect(response.statusCode).not.toBe(500);
        expect(response.json().code).not.toBe(0);
      }
      const json = await app.inject({ method: 'POST', url: '/v1/agents/avatar', payload: {} });
      expect(json.json().code).not.toBe(0);
      expect(uploadFile).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
