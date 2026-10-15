import { createRequire } from 'node:module';
import type { PtyOpenOptions } from './runtime-channel-protocol.js';

/** node-pty 的最小类型面（容器内 import 真实 node-pty；单测注入 fake）。 */
export interface ContainerPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}

export type ContainerPtyFactory = (options: PtyOpenOptions) => ContainerPty;

/** node-pty 的 spawn 签名（仅声明用到的部分）。 */
type NodePtyModule = {
  spawn(file: string, args: string[], options: {
    name?: string; cols: number; rows: number; cwd: string; env: { [key: string]: string };
  }): ContainerPty;
};

/** 生产实现：node-pty spawn。镜像内已安装与 Node ABI 匹配的 node-pty。 */
export const containerNodePtyFactory: ContainerPtyFactory = (options) => {
  const nodePty = requireNodePty();
  return nodePty.spawn(options.shell, options.args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env as { [key: string]: string },
  });
};

function requireNodePty(): NodePtyModule {
  // 容器内 node_modules 位于 /opt/mao/backend-ts/node_modules（镜像内置，ABI 匹配）
  const req = createRequire(import.meta.url);
  return req('node-pty') as NodePtyModule;
}

export interface PtyHubHooks {
  sendData(ptyId: string, data: string): void;
  sendExit(ptyId: string, exitCode: number): void;
}

/** PtyHub.open 的 spawn 结果：成功回 pid 供宿主机 ack，失败回错误文本。 */
export type PtyOpenOutcome = { ok: true; pid: number } | { ok: false; error: string };

/**
 * 容器内 pty 通道集线器（技术方案 §5.7.3 / §8 第 8 条）：
 * 与 tool_call 共用同一条 socket 连接，pty 输出经分帧协议回传宿主机。
 */
export class PtyHub {
  private readonly ptys = new Map<string, ContainerPty>();
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly hooks: PtyHubHooks,
    private readonly factory: ContainerPtyFactory = containerNodePtyFactory,
  ) {}

  get activeCount(): number {
    return this.ptys.size;
  }

  async open(ptyId: string, options: PtyOpenOptions): Promise<PtyOpenOutcome> {
    if (this.ptys.has(ptyId)) return { ok: true, pid: this.ptys.get(ptyId)!.pid };
    try {
      const pty = this.factory(options);
      this.ptys.set(ptyId, pty);
      pty.onData((data) => this.hooks.sendData(ptyId, data));
      pty.onExit(({ exitCode }) => {
        this.ptys.delete(ptyId);
        this.hooks.sendExit(ptyId, exitCode ?? -1);
      });
      return { ok: true, pid: pty.pid };
    } catch (e) {
      console.error(`[pty-hub] open failed: ${(e as Error).message}`);
      this.hooks.sendExit(ptyId, -1);
      return { ok: false, error: (e as Error).message };
    }
  }

  write(ptyId: string, data: string): void {
    this.ptys.get(ptyId)?.write(data);
  }

  resize(ptyId: string, cols: number, rows: number): void {
    try {
      this.ptys.get(ptyId)?.resize(cols, rows);
    } catch { /* 已退出时 resize 抛错，忽略（与宿主机口径一致） */ }
  }

  close(ptyId: string): void {
    const pty = this.ptys.get(ptyId);
    if (!pty) return;
    this.ptys.delete(ptyId);
    try { pty.kill(); } catch { /* ignore */ }
  }

  closeAll(): void {
    for (const id of [...this.ptys.keys()]) this.close(id);
  }
}
