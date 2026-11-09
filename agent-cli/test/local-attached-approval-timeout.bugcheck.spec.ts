import { describe, expect, it, vi } from 'vitest';
import { parseCliConfig } from '../src/args';
import { cmdChat, type ChatContext } from '../src/commands/chat';
import type { ApprovalPolicy } from '../src/local/approval';
import { createLogger } from '../src/util/logger';

const captured = vi.hoisted(() => ({
  policy: undefined as ApprovalPolicy | undefined,
}));

vi.mock('../src/local/executor', () => ({
  LocalExecutor: class {
    constructor(opts: { policy: ApprovalPolicy }) {
      captured.policy = opts.policy;
      throw new Error('STOP_AFTER_POLICY');
    }
  },
}));

vi.mock('../src/local/trust', () => ({
  ensureWorkspaceTrusted: async () => {},
}));

vi.mock('../src/local/device-identity', () => ({
  resolveDeviceIdentity: () => ({ id: 'dev-review', name: 'ReviewHost', platform: 'darwin' }),
}));

vi.mock('../src/config/config-store', async () => {
  const actual = await vi.importActual<typeof import('../src/config/config-store')>('../src/config/config-store');
  return { ...actual, rememberLastSession: () => {} };
});

const tty = { stdoutIsTty: true, stdinIsTty: true };

describe('attached local remote approval timeout', () => {
  it('passes approval-timeout-ms into the executor policy', async () => {
    captured.policy = undefined;
    const cfg = parseCliConfig(
      ['--local', '-p', 'hi', '--on-approval', 'remote', '--approval-timeout-ms', '1500'],
      tty,
    );
    expect(cfg.approvalTimeoutMs).toBe(1500);
    expect(cfg.onApproval).toBe('remote');

    const rest = {
      listAgents: async () => [{ id: 1, name: 'Coder', isDefault: true }],
      listActiveModels: async () => [],
      createSession: async () => ({
        id: 1,
        executionMode: 'LOCAL',
        workspace: process.cwd(),
        agentId: 1,
        permissionLevel: 'READ_WRITE',
      }),
    };

    await expect(cmdChat({
      rest: rest as unknown as ChatContext['rest'],
      cfg,
      resolved: {} as ChatContext['resolved'],
      baseUrl: 'http://127.0.0.1:9/api',
      getToken: async () => 'token',
      logger: createLogger(false),
    })).rejects.toThrow('STOP_AFTER_POLICY');

    expect(captured.policy?.onApproval).toBe('remote');
    expect(captured.policy?.remoteApprovalTimeoutMs).toBe(1500);
  });
});
