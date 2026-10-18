import path from 'node:path';

/**
 * 工作区绑定键归一化：null / 空串一律归一为全局工作区根（§5.7 P1-1）。
 *
 * host 侧 `ShellSession.workspaceDir` 恒非 null（getEffectiveWorkspaceRoot 兜底），
 * 而容器 envelope / 云端终端的 workspace 可为 null；两侧必须落到同一个键，
 * 否则「同一用户同一会话」在 host 与 docker 下生效的变量集合不同。
 */
export function normalizeWorkspaceKey(
  workspace: string | null | undefined,
  globalWorkspaceRoot: string,
): string {
  const root = path.resolve(globalWorkspaceRoot);
  const raw = workspace == null ? '' : String(workspace).trim();
  if (raw === '') return root;
  return path.resolve(raw);
}
