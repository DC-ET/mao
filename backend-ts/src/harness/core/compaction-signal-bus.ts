/**
 * 手动压缩信号总线（技术方案 5.4）：运行中会话无法立即压缩，改为置一个布尔信号，
 * 由 AgentLoop 在下一个工具轮边界消费执行。仅布尔信号，无数据面。
 *
 * 生命周期与 cancelFlags 同款「双向清理」：
 * - signal：置位（幂等，重复点击不叠加）；
 * - consume：读取并清除（命中即一次性消费）；
 * - clear：执行结束 / 启动丢弃陈旧信号时清理，避免残留信号在下次执行意外触发压缩。
 */
export class CompactionSignalBus {
  private readonly signals = new Set<number>();

  signal(sessionId: number): void {
    this.signals.add(sessionId);
  }

  has(sessionId: number): boolean {
    return this.signals.has(sessionId);
  }

  /** 命中并清除；无信号返回 false。 */
  consume(sessionId: number): boolean {
    if (!this.signals.has(sessionId)) return false;
    this.signals.delete(sessionId);
    return true;
  }

  clear(sessionId: number): void {
    this.signals.delete(sessionId);
  }
}
