/**
 * token 管理：无状态契约（设计文档 2.3）。
 * SDK 内存持有当前 token，401 / WS 1003 关闭时回调宿主 getToken() 重取。
 */
export class TokenProvider {
  private current: Promise<string> | null = null;

  constructor(private readonly supplier: () => Promise<string>) {}

  /** 供 REST 层调用；同一并发批次复用同一 Promise */
  get(): Promise<string> {
    if (!this.current) {
      this.current = this.supplier().catch((err) => {
        this.current = null;
        throw err;
      });
    }
    return this.current;
  }

  /** WS 重连 / 401 后强制刷新：丢弃缓存，重新向宿主索取 */
  invalidate() {
    this.current = null;
  }
}
