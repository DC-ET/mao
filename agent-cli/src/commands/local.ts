import path from 'node:path';
import type { CliConfig } from '../args';
import type { ChatContext } from './chat';
import { WsClient, type WsClientOptions } from '../ws/ws-client';
import { LocalExecutor } from '../local/executor';
import { ensureWorkspaceTrusted } from '../local/trust';
import { resolveDeviceIdentity, type DeviceIdentity } from '../local/device-identity';
import { DEFAULT_REMOTE_APPROVAL_TIMEOUT_MS, type ApprovalPolicy } from '../local/approval';
import { CliError, EXIT } from '../util/exit-codes';

/** 不按 sessionId 过滤、直接交给唯一 LocalExecutor 的事件。 */
export const DAEMON_ROUTED_EVENTS = new Set([
  'tool_execute',
  'skill_sync_required',
  'mcp_sync_required',
  'tool_approval_resolved',
]);

/** `--workspace` 相对路径按 cwd 解析；缺省就是 cwd。 */
export function resolveDaemonWorkspace(workspace: string | undefined, cwd = process.cwd()): string {
  const raw = workspace && workspace.trim() !== '' ? workspace : '.';
  return path.resolve(cwd, raw);
}

/**
 * daemon 没有交互式审批面。TTY 位钉死，避免挂在终端上时 canPrompt 为真、
 * 掉进 readline。
 */
export function buildDaemonApprovalPolicy(
  cfg: Pick<CliConfig, 'yolo' | 'force' | 'onApproval' | 'approveRules' | 'strictDangerCheck' | 'iKnowWhatImDoing' | 'approvalTimeoutMs'>,
): ApprovalPolicy {
  return {
    yolo: cfg.yolo,
    force: cfg.force,
    onApproval: cfg.onApproval,
    approveRules: [...cfg.approveRules],
    strictDangerCheck: cfg.strictDangerCheck,
    iKnowWhatImDoing: cfg.iKnowWhatImDoing,
    stdoutIsTty: false,
    stdinIsTty: false,
    remoteApprovalTimeoutMs: cfg.approvalTimeoutMs,
  };
}

export function approvalModeLabel(policy: ApprovalPolicy): string {
  if (policy.yolo || policy.force) return '--yolo 自动放行（仍不豁免工作区信任与默认拒绝清单）';
  if (policy.onApproval === 'fail') return '需要审批时立即拒绝';
  if (policy.onApproval === 'remote') {
    const ms = policy.remoteApprovalTimeoutMs != null && policy.remoteApprovalTimeoutMs > 0
      ? policy.remoteApprovalTimeoutMs
      : DEFAULT_REMOTE_APPROVAL_TIMEOUT_MS;
    const seconds = ms >= 1000 ? Math.round(ms / 1000) : ms / 1000;
    return `等待桌面 / 安卓 / Web 投票，${seconds} 秒超时后拒绝`;
  }
  return '需要审批时询问';
}

export interface DaemonHooks {
  createWs?: (opts: WsClientOptions) => WsClient;
  getDevice?: () => DeviceIdentity;
  onSignal?: (name: 'SIGINT' | 'SIGTERM', fn: () => void) => void;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/**
 * `mao-agent local --serve`：不创建 SessionRunner、不 subscribe、不过 acceptEvent。
 * 凭设备身份拿执行连接，替本机全部 LOCAL 会话执行工具。
 */
export async function cmdLocal(ctx: ChatContext, hooks: DaemonHooks = {}): Promise<number> {
  const writeOut = hooks.stdout ?? ((line: string) => {
    process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
  });
  const writeErr = hooks.stderr ?? ((line: string) => {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
  });
  const cfg = ctx.cfg;
  if (!cfg.serve) {
    writeErr('常驻本地执行端请使用：mao-agent local --serve');
    return EXIT.GENERAL;
  }

  const trustRoot = resolveDaemonWorkspace(cfg.workspace);
  try {
    await ensureWorkspaceTrusted(trustRoot, false);
  } catch (err) {
    writeErr(err instanceof Error ? err.message : String(err));
    writeErr('重新启动: mao-agent local --serve');
    return err instanceof CliError ? err.exitCode : EXIT.GENERAL;
  }

  let account = '（未能读取账号）';
  try {
    const me = await ctx.rest.me();
    account = me.displayName || me.username || account;
  } catch (err) {
    ctx.logger.debug('读取当前账号失败', err);
  }

  const device = hooks.getDevice?.() ?? resolveDeviceIdentity();
  const policy = buildDaemonApprovalPolicy(cfg);
  const wsOpts: WsClientOptions = {
    baseUrl: ctx.baseUrl,
    getToken: ctx.getToken,
    debug: cfg.debug ? (message, extra) => ctx.logger.debug(message, extra) : undefined,
    onConsecutiveReconnectFailures: (n) => {
      ctx.logger.warn(`连不上服务器（已重试 ${n} 次）。检查网络，或 mao-agent login 后重试。`);
    },
    ...(hooks.getDevice ? { getDevice: hooks.getDevice } : {}),
  };
  const ws = hooks.createWs?.(wsOpts) ?? new WsClient(wsOpts);
  const executor = new LocalExecutor({
    ws,
    getToken: ctx.getToken,
    baseUrl: ctx.baseUrl,
    workspace: trustRoot,
    policy,
    onApprovalDenied: () => {
      writeErr('审批未通过，守护进程继续运行');
    },
  });
  ws.setOnDisconnect(() => executor.onWsClosed());

  const servedSessions = new Set<number>();
  let toolCount = 0;
  ws.on((evt) => {
    if (evt.type === 'connected') {
      executor.setApprovalRelaySupported(evt.data?.approvalRelay === true);
      return;
    }
    if (!DAEMON_ROUTED_EVENTS.has(evt.type)) return;
    if (evt.sessionId != null) servedSessions.add(evt.sessionId);
    if (evt.type !== 'tool_execute') {
      void executor.handleEvent(evt);
      return;
    }
    const toolName = String(evt.data?.toolName ?? '');
    const requested = typeof evt.data?.workspace === 'string' && evt.data.workspace.trim() !== ''
      ? evt.data.workspace
      : trustRoot;
    const started = Date.now();
    toolCount += 1;
    void executor.handleEvent(evt).finally(() => {
      writeOut(`tool session=${evt.sessionId} tool=${toolName} workspace=${requested} ${Date.now() - started}ms`);
    });
  });

  const listen = hooks.onSignal ?? ((name, fn) => {
    process.once(name, fn);
  });
  let stopping = false;
  let release: (code: number) => void = () => {};
  const stopped = new Promise<number>((resolve) => {
    release = resolve;
  });
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      try {
        await executor.shutdown();
      } catch (err) {
        ctx.logger.debug('shutdown', err);
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
      writeOut(`已退出。服务会话 ${servedSessions.size} 个，执行工具 ${toolCount} 次。`);
      release(EXIT.SUCCESS);
    })();
  };
  listen('SIGINT', shutdown);
  listen('SIGTERM', shutdown);

  try {
    await ws.connect();
  } catch (err) {
    if (!stopping) {
      writeErr(`守护进程启动失败: ${err instanceof Error ? err.message : String(err)}`);
      writeErr('重新启动: mao-agent local --serve');
      try {
        ws.close();
      } catch {
        // ignore
      }
      return EXIT.GENERAL;
    }
  }
  if (stopping) return stopped;

  writeOut([
    'mao-agent 常驻本地执行端',
    `账号: ${account}`,
    `设备: ${device.name} (${device.id})`,
    `信任根: ${trustRoot}`,
    `审批: ${approvalModeLabel(policy)}`,
    '已接管本机 LOCAL 执行连接（谁最后连接谁执行；桌面端后启动会夺回，关闭桌面端后本进程自动接回）',
  ].join('\n'));

  return stopped;
}
