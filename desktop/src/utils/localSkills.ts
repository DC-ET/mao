import type { LocalSkillReport } from '../composables/useStreamWS'

/**
 * LOCAL 模式下，收集桌面端本地未上传的技能（~/.agents/skills），随消息一起上报给服务端。
 * 这些技能无需上传即可在本次本地任务中使用；若要在云端模式任务中使用，仍需先上传。
 *
 * 主聊天（useChat.ts）与边路任务（SideChatPanel.vue）均需要在 LOCAL 模式发送/编辑消息前调用。
 */
export async function collectLocalUnsyncedSkills(
  executionMode: string,
  isElectron: boolean
): Promise<LocalSkillReport[] | undefined> {
  if (executionMode !== 'LOCAL' || !isElectron) return undefined
  try {
    const result = await (window as any).electronAPI.listLocalSkills()
    if (!result || result.error || !Array.isArray(result.skills) || result.skills.length === 0) {
      return undefined
    }
    return result.skills.map((s: any) => ({
      name: s.name,
      description: s.description || '',
      folderName: s.folderName
    }))
  } catch {
    return undefined
  }
}
