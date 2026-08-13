import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/app-config.js';
import { createMaoApp } from './create-app.js';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  const adapter = new FastifyAdapter({
    logger: true,
    bodyLimit: 52 * 1024 * 1024,
  });
  const nestApp = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bodyParser: false,
  });
  const fastify = nestApp.getHttpAdapter().getInstance();
  const mao = await createMaoApp(cfg, fastify as never);
  const port = cfg.server.port;
  await nestApp.listen(port, '0.0.0.0');
  console.info(`Mao TS backend listening on ${port} (context-path ${cfg.server.servlet.contextPath})`);

  const shutdown = async (): Promise<void> => {
    await mao.close().catch(() => undefined);
    await nestApp.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

void bootstrap().catch((err) => {
  console.error('Failed to start Mao TS backend', err);
  process.exit(1);
});
