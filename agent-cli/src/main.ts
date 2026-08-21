import { parseCliConfig, HELP_TEXT, normalizeBaseUrl, DEFAULT_BASE_URL } from './args';
import { CliError, EXIT } from './util/exit-codes';
import { createLogger } from './util/logger';
import { getCliVersion } from './util/version';
import { cleanupRuntimeDir, resolveConfig } from './config/config-store';
import { createTokenResolver } from './auth/token';
import { currentTokenSource } from './auth/token';
import { RestClient } from './rest/rest-client';
import { cmdLogin } from './commands/login';
import { cmdLogout } from './commands/logout';
import { cmdStatus } from './commands/status';
import { cmdLs } from './commands/ls';
import { cmdChat } from './commands/chat';
import { cmdUpdate } from './commands/update';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const done = (s: string) => {
      cleanup();
      resolve(s);
    };
    // 非交互 shell（如 Agent 的持久 shell）会保持 stdin 打开且永不 EOF，无限等待会挂死；
    // 2s 内没有任何字节则视为没有管道输入。
    let timer = setTimeout(() => done(Buffer.concat(chunks).toString('utf8').trim()), 2000);
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      // EOF 后 end/close 会触发；收到数据后仍继续等 EOF，最多再等 2s
      clearTimeout(timer);
      timer = setTimeout(() => done(Buffer.concat(chunks).toString('utf8').trim()), 2000);
    };
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('close', onClose);
      process.stdin.removeListener('error', onError);
    };
    const onEnd = () => done(Buffer.concat(chunks).toString('utf8').trim());
    const onClose = () => done(Buffer.concat(chunks).toString('utf8').trim());
    const onError = () => done(Buffer.concat(chunks).toString('utf8').trim());
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('close', onClose);
    process.stdin.once('error', onError);
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let cfg;
  try {
    cfg = parseCliConfig(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(msg + '\n');
    return err instanceof CliError ? err.exitCode : EXIT.GENERAL;
  }

  if (cfg.command === 'help' || cfg.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (cfg.command === 'version' || cfg.version) {
    process.stdout.write(`mao-agent ${getCliVersion()}\n`);
    return 0;
  }

  cleanupRuntimeDir();

  if (!cfg.stdinIsTty && cfg.consumesPipedPrompt) {
    const piped = await readStdin();
    if (piped) {
      cfg.prompt = cfg.prompt ? `${cfg.prompt}\n${piped}` : piped;
    }
  }

  const resolved = resolveConfig({
    baseUrl: cfg.baseUrl,
    permissionLevel: cfg.permissionLevel,
    outputFormat: cfg.outputFormat,
    verboseTools: cfg.verboseTools,
    asciiOnly: cfg.asciiOnly,
    queuedInput: cfg.queuedInput,
  });
  if (!cfg.baseUrl) cfg.baseUrl = resolved.baseUrl;
  const baseUrl = normalizeBaseUrl(cfg.baseUrl || resolved.baseUrl || DEFAULT_BASE_URL);
  resolved.baseUrl = baseUrl;

  const logger = createLogger(cfg.debug);

  const restPreview = new RestClient({
    baseUrl,
    getToken: () => currentTokenSource(cfg.token).accessToken,
    timeoutMs: cfg.timeoutMs,
    debug: cfg.debug ? (m, extra) => logger.debug(m, extra) : undefined,
  });
  const tokens = createTokenResolver({
    cliToken: cfg.token,
    refresh: (rt) => restPreview.refresh(rt),
  });
  const rest = new RestClient({
    baseUrl,
    getToken: () => tokens.getAccessToken(),
    onUnauthorized: () => tokens.onUnauthorized(),
    timeoutMs: cfg.timeoutMs,
    debug: cfg.debug ? (m, extra) => logger.debug(m, extra) : undefined,
  });

  const ctx = { rest, cfg, resolved, getToken: () => tokens.getAccessToken(), logger };

  try {
    switch (cfg.command) {
      case 'login':
        await cmdLogin(rest, { username: cfg.username, password: cfg.password });
        return 0;
      case 'logout':
        await cmdLogout(rest);
        return 0;
      case 'status':
        cmdStatus({ baseUrl, cliToken: cfg.token });
        return 0;
      case 'update':
        await cmdUpdate({
          ref: cfg.updateRef,
          repo: cfg.updateRepo,
          srcDir: cfg.updateSrcDir,
          check: cfg.updateCheck,
        });
        return 0;
      case 'ls':
        await cmdLs(rest, cfg.outputFormat === 'json' || cfg.outputFormat === 'stream-json', {
          lastSessionId: resolved.lastSessionId,
        });
        return 0;
      case 'resume':
      case 'chat':
        return await cmdChat(ctx);
      default:
        process.stderr.write(HELP_TEXT);
        return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(msg + '\n');
    return err instanceof CliError ? err.exitCode : EXIT.GENERAL;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n');
    process.exit(EXIT.GENERAL);
  });
}
