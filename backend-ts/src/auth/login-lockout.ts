/**
 * 进程内登录失败锁定（滑动窗口）：key（规范化用户名|IP）→ 窗口内最近失败时间戳。
 * 防暴力破解而非精确计量——重启清零可接受；多实例部署下各实例独立计数。
 * 阈值 / 窗口走 env（LOGIN_MAX_FAILURES / LOGIN_LOCK_MINUTES）；阈值 <= 0 整体关闭。
 * 实现为纯类便于单测（时钟可注入），与 openapi/rate-limiter.ts 同风格。
 */
export interface LoginLockoutOptions {
  maxFailures?: number;
  lockMinutes?: number;
  now?: () => number;
}

export class LoginLockout {
  private readonly failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options?: LoginLockoutOptions) {
    this.maxFailures = options?.maxFailures ?? envInt('LOGIN_MAX_FAILURES', 5);
    this.windowMs = Math.max(1, options?.lockMinutes ?? envInt('LOGIN_LOCK_MINUTES', 15)) * 60_000;
    this.now = options?.now ?? (() => Date.now());
  }

  /**
   * 锁定剩余秒数（未锁返回 0）。锁定的是「再试」本身：期间即便密码正确也拒绝，
   * 与「禁用账号」不同——禁用是账号属性，锁定是针对该 用户名+IP 的暴力破解防护。
   */
  lockedSecondsRemaining(key: string): number {
    if (this.maxFailures <= 0) return 0;
    const timestamps = this.prune(this.failures.get(key) ?? []);
    if (timestamps.length === 0) {
      this.failures.delete(key);
      return 0;
    }
    this.failures.set(key, timestamps);
    const oldest = timestamps[0];
    return oldest != null && timestamps.length >= this.maxFailures
      ? Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000))
      : 0;
  }

  /** 记一次失败：验过密码但未通过（本地密码错误、用户不存在、LDAP 兜底失败同口径）。 */
  recordFailure(key: string): void {
    if (this.maxFailures <= 0) return;
    const timestamps = this.prune([...(this.failures.get(key) ?? []), this.now()]);
    this.failures.set(key, timestamps);
    if (this.failures.size > 10_000) this.cleanup();
  }

  /** 正确密码不算暴力尝试：成功登录（含 LDAP 成功）清零该键。 */
  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  /** 丢弃全部已过期的键（防长驻进程 key 无限累积）；测试亦可用来复位。 */
  cleanup(): void {
    for (const [key, timestamps] of this.failures) {
      if (this.prune(timestamps).length === 0) {
        this.failures.delete(key);
      }
    }
  }

  /** 只留窗口内的最近 maxFailures 条——更早的失败对「是否达到阈值」无影响。 */
  private prune(timestamps: number[]): number[] {
    const cutoff = this.now() - this.windowMs;
    const live = timestamps.filter((ts) => ts > cutoff);
    return live.length > this.maxFailures ? live.slice(-this.maxFailures) : live;
  }
}

/**
 * 计数键。用户名归一化只做大小写折叠与去首尾空白——方向是保守的（只会合并计数，
 * 不会把同一尝试拆到多个键）。MySQL8 默认 collation（utf8mb4_0900_ai_ci）的重音
 * 折叠（á=a、ß=ss）未镜像：非 ASCII 用户名换写法可绕开按用户名合并，残余绕过面
 * 评估为可接受——键仍含 IP，每个变体有独立预算；本机制是爆破防护而非访问控制边界。
 */
export function loginLockKey(username: string, ip: string | null | undefined): string {
  return `${username.trim().toLowerCase()}|${ip ?? ''}`;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^-?\d+$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}
