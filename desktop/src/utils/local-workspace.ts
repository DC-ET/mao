import type { LocalWorkspaceSummary, Session, SessionEnvironmentInfo } from '../stores/session/types'

/** 浏览器创建 LOCAL 会话的创建参数回显（技术方案 2026-11-17 D6/D7）：
 *  设备绑定沿用所选工作区的代表会话，环境快照（platform/shell/osVersion/isGit）随绑定同源沿用；
 *  platform 是未绑定兜底路径惰性认领 ② 平台一致性校验的输入。 */
export interface BrowserLocalTarget {
  /** null = 工作区无绑定数据（纯历史遗留）：新会话落库为未绑定，首发走惰性认领 ②/③。 */
  deviceId: string | null
  deviceName: string | null
  environmentInfo: SessionEnvironmentInfo
}

type SessionLike = Pick<Session, 'id' | 'workspace' | 'targetDeviceId' | 'targetDeviceName' | 'platform' | 'shell' | 'osVersion' | 'isGit'>

/**
 * 解析浏览器新建 LOCAL 会话的沿用来源：
 * ① 本地工作区聚合条目（权威，绑定与平台同源）→ ② 会话实体回退（端点请求失败但总览预填
 * 带路径：同路径且已绑定的最近会话优先，none 时仅取环境快照）→ ③ 全无数据返回 null
 * （不猜设备，交给服务端惰性认领兜底）。
 */
export function resolveBrowserLocalTarget(
  workspace: string,
  entries: LocalWorkspaceSummary[],
  sessions: SessionLike[],
): BrowserLocalTarget | null {
  const trimmed = workspace.trim()
  if (!trimmed) return null
  const entry = entries.find((item) => item.workspace === trimmed)
  if (entry) {
    return {
      deviceId: entry.targetDeviceId,
      deviceName: entry.targetDeviceName,
      environmentInfo: environmentInfoOf(entry.platform, entry.shell, entry.osVersion, entry.isGit),
    }
  }
  const sameWorkspace = sessions.filter((s) => s.workspace === trimmed)
  if (sameWorkspace.length === 0) return null
  const bound = sameWorkspace.filter((s) => s.targetDeviceId != null && s.targetDeviceId !== '')
  const picked = (bound.length > 0 ? bound : sameWorkspace).slice()
    .sort((a, b) => numericId(b.id) - numericId(a.id))[0]
  return {
    deviceId: picked.targetDeviceId ?? null,
    deviceName: picked.targetDeviceName ?? null,
    environmentInfo: environmentInfoOf(picked.platform, picked.shell, picked.osVersion, picked.isGit),
  }
}

function environmentInfoOf(
  platform: string | null | undefined,
  shell: string | null | undefined,
  osVersion: string | null | undefined,
  isGit: boolean | null | undefined,
): SessionEnvironmentInfo {
  return {
    platform: platform ?? undefined,
    shell: shell ?? undefined,
    osVersion: osVersion ?? undefined,
    isGit: isGit ?? undefined,
  }
}

/** 会话 id 是服务端数字 id 的字符串形态；数值大者更晚创建，作为回退时的「最近」判据。 */
function numericId(id: string): number {
  const n = Number(id)
  return Number.isFinite(n) ? n : 0
}

/** 本地工作区条目的设备标签（下拉副标题共用，技术方案 2026-11-17）：
 *  设备名 + 在线态；未绑定按惰性认领口径提示「首次发送时登记」。 */
export function localWorkspaceDeviceLabel(
  entry: Pick<LocalWorkspaceSummary, 'targetDeviceId' | 'targetDeviceName' | 'targetDeviceOnline'>,
): string {
  const device = entry.targetDeviceName || '未登记执行端'
  if (entry.targetDeviceId == null) return `${device} · 首次发送时登记`
  const online = entry.targetDeviceOnline === true ? '在线' : entry.targetDeviceOnline === false ? '离线' : ''
  return online ? `${device} · ${online}` : device
}
