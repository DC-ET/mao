import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * uploads 静态托管：文件名为 UUID/唯一序号，内容不可变，默认长缓存；
 * 自动更新清单（releases/ 下的 yml/json、latest*.yml）内容会变且被客户端轮询
 * （Electron autoUpdater / 安卓 OTA / useVersionCheck），不加缓存头，避免拿到旧版本号。
 */
const UPLOAD_CACHE_EXCLUDED = /(^|\/)(releases\/[^/]*\.(json|ya?ml)|latest[^/]*\.ya?ml)$/i;

function uploadCacheHeaders(path: string): Record<string, string> {
  if (UPLOAD_CACHE_EXCLUDED.test(path)) return { 'Cache-Control': 'no-cache' };
  return { 'Cache-Control': 'public, max-age=604800' };
}

export async function registerUploadStatic(app: FastifyInstance, uploadDir: string, apiPrefix: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: '/uploads/',
    decorateReply: false,
    setHeaders: (reply, path) => {
      for (const [k, v] of Object.entries(uploadCacheHeaders(path))) reply.header(k, v);
    },
  });
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: `${apiPrefix.replace(/\/$/, '')}/uploads/`,
    decorateReply: false,
    setHeaders: (reply, path) => {
      for (const [k, v] of Object.entries(uploadCacheHeaders(path))) reply.header(k, v);
    },
  });
}
