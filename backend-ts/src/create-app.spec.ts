import Fastify from 'fastify';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerUploadStatic } from './create-app.js';

describe('registerUploadStatic', () => {
  it('serves uploads from both the direct and context-path URLs', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'mao-uploads-'));
    await writeFile(join(uploadDir, 'latest-mac.yml'), 'version: 0.0.31');
    const app = Fastify();
    await registerUploadStatic(app, uploadDir, '/api');

    const direct = await app.inject({ method: 'GET', url: '/uploads/latest-mac.yml' });
    const compatible = await app.inject({ method: 'GET', url: '/api/uploads/latest-mac.yml?noCache=1' });

    expect(direct.statusCode).toBe(200);
    expect(direct.body).toBe('version: 0.0.31');
    expect(compatible.statusCode).toBe(200);
    expect(compatible.body).toBe('version: 0.0.31');
    await app.close();
  });
});
