import { ElMessageBox } from 'element-plus'

/**
 * 系统设置面板的服务端同步守卫，统一三个子面板的刷新语义：
 * - 本地没有未保存编辑 → 静默跟随服务端值覆盖；
 * - 本地有未保存编辑且服务端未变（含自己保存后的回流）→ 保留本地编辑，不打扰；
 * - 本地有未保存编辑且服务端已被更新（他人修改/其他面板触发刷新拿到新值）
 *   → 弹「丢弃并刷新 / 保留本地编辑」确认。
 *
 * 调用方约定：应用服务端值或保存成功后，快照基线随之对齐（resolve 内部维护）。
 * 快照需为确定性序列化（如固定键序的 JSON.stringify），相同语义的值必须产生相同快照。
 */
export function useServerSyncGuard() {
  /** 最近一次与服务端对齐的快照；null 表示尚未初始化（首次到达直接应用） */
  let baseline: string | null = null
  let confirmInFlight = false

  /** 保存成功后调用：把基线对齐到刚写入服务端的值，随后的刷新回流视为「服务端未变」 */
  function markBaseline(savedSnapshot: string): void {
    baseline = savedSnapshot
  }

  /**
   * 服务端数据到达（含刷新回流）时决策：
   * - 'apply'：以服务端值覆盖本地编辑（调用方执行覆盖后无需再动基线，内部已对齐）；
   * - 'keep'：保留本地编辑；基线已推进到新服务端值，服务端不再变化前不会重复打扰。
   */
  async function resolve(incoming: string, localSnapshot: string): Promise<'apply' | 'keep'> {
    if (baseline === null) {
      baseline = incoming
      return 'apply'
    }
    if (incoming === baseline) {
      // 服务端未变：本地干净时幂等 apply，脏则保留
      return localSnapshot === baseline ? 'apply' : 'keep'
    }
    if (localSnapshot === baseline) {
      // 本地干净：直接跟随
      baseline = incoming
      return 'apply'
    }
    // 冲突：本地脏且服务端变了
    if (confirmInFlight) return 'keep'
    confirmInFlight = true
    try {
      await ElMessageBox.confirm(
        '服务端配置已被更新（可能由其他人修改），丢弃当前未保存的编辑并刷新？',
        '配置已变更',
        { confirmButtonText: '丢弃并刷新', cancelButtonText: '保留本地编辑', type: 'warning' }
      )
      baseline = incoming
      return 'apply'
    } catch {
      baseline = incoming
      return 'keep'
    } finally {
      confirmInFlight = false
    }
  }

  return { resolve, markBaseline }
}
