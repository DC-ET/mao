import { randomUUID } from 'node:crypto';
import type { ClientImpersonation } from '@mao/contracts';

/** 按客户端标识向请求头注入对应的 CLI 伪装头；profile 为 none/空时不做任何事。 */
export function applyClientImpersonationHeaders(
  headers: Record<string, string>,
  profile: ClientImpersonation | null | undefined,
): void {
  if (profile === 'codex') {
    headers['User-Agent'] = 'codex_cli_rs/0.146.0 (Linux 6.1.0; x86_64) xterm-256color';
    headers.originator = 'codex_cli_rs';
    headers['x-codex-window-id'] = '019e9e6a-e81e-7442-bac0-d3bc42cc1b45';
  } else if (profile === 'claude_code') {
    headers['User-Agent'] = 'claude-cli/999.0.0-restored (external, cli)';
    headers['x-app'] = 'cli';
    headers['X-Claude-Code-Session-Id'] = randomUUID();
    headers['x-client-request-id'] = randomUUID();
  }
}
