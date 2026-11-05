import { parseCliConfig, formatHelp, normalizeBaseUrl } from './args';
import { CliError, EXIT } from './util/exit-codes';
import { createLogger } from './util/logger';
import { getCliVersion } from './util/version';
import { cleanupRuntimeDir, resolveConfig } from './config/config-store';
import { BASE_URL_SETUP_HINT, setupBaseUrlInteractive, warnIfTransientBaseUrl } from './config/base-url';
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
    const collected = () => Buffer.concat(chunks).toString('utf8').trim();
    // 非交互 shell（如 Agent 的持久 shell）会保持 stdin 打开且永不 EOF，无限等待会挂死；
    // 2s 内没有任何字节则视为没有管道输入。收到 EOF（end/close）立即结算，不再空等。
    const idle = setTimeout(() => done(collected()), 2000);
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      clearTimeout(idle);
    };
    const cleanup = () => {
      clearTimeout(idle);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('close', onEnd);
      process.stdin.removeListener('error', onEnd);
    };
    const onEnd = () => done(collected());
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('close', onEnd);
    process.stdin.once('error', onEnd);
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
    process.stdout.write(formatHelp(cfg.helpAll));
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
  // 未显式下发时 cfg 里这两项为 undefined：回写解析后的值（项目/用户配置或内置默认），
  // 下游读 cfg.outputFormat / cfg.permissionLevel 的行为与修复前一致
  cfg.outputFormat = resolved.outputFormat;
  cfg.permissionLevel = resolved.permissionLevel;
  // 站点地址不再内置默认值：未设置时 login 要求先设置，其余需要连接服务器的命令统一报错。
  let baseUrl = resolved.baseUrl ? normalizeBaseUrl(resolved.baseUrl) : undefined;

  const logger = createLogger(cfg.debug);

  try {
    // status / update 不连服务器：前者展示「未设置」状态，后者只做本地升级。
    if (cfg.command === 'status') {
      cmdStatus({ baseUrl, cliToken: cfg.token });
      return 0;
    }
    if (cfg.command === 'update') {
      await cmdUpdate({
        ref: cfg.updateRef,
        repo: cfg.updateRepo,
        srcDir: cfg.updateSrcDir,
        check: cfg.updateCheck,
      });
      return 0;
    }

    // 首次安装登录且未配置站点地址：TTY 下要求输入并保存到用户配置，非 TTY 走下面的统一报错。
    if (!baseUrl && cfg.command === 'login' && cfg.stdinIsTty && cfg.stdoutIsTty) {
      baseUrl = await setupBaseUrlInteractive();
    }
    // 未配置站点地址时 logout 依然可用：跳过服务端调用，仅本地清理登录态。
    if (!baseUrl && cfg.command === 'logout') {
      await cmdLogout();
      return 0;
    }
    if (!baseUrl) {
      process.stderr.write(BASE_URL_SETUP_HINT + '\n');
      return EXIT.GENERAL;
    }
    resolved.baseUrl = baseUrl;

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

    const ctx = { rest, cfg, resolved, baseUrl, getToken: () => tokens.getAccessToken(), logger };

    switch (cfg.command) {
      case 'login':
        await cmdLogin(rest, { username: cfg.username, password: cfg.password });
        warnIfTransientBaseUrl(Boolean(cfg.baseUrl || process.env.MAO_BASE_URL));
        return 0;
      case 'logout':
        await cmdLogout(rest);
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
        process.stderr.write(formatHelp());
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
