// 发送媒体活引用（技术方案 2026-11-20-send-media-live-reference §4.1）：
// delivery 不带 uploads 副本地址，而携带「来源定位信息」，消费端渲染 / 下载时实时取数。
// 后端组装与前端 resolver 共用本类型；token 绝不入消息 JSON，由前端渲染期追加。

/** 工作区活引用（形态 A，仅存量消息）：按会话 + 相对路径经 workspace-download 实时读取。 */
export interface DeliveryWorkspaceRef {
  type: 'workspace';
  /** 发送会话 id：使下载 URL 自包含，且下载端 requireOwnedSession 校验的就是正确会话。 */
  sessionId: number;
  /** 工作区相对路径（发送时归一化；绝对路径入参不落盘）。 */
  path: string;
}

/**
 * 发送快照（形态 D，技术方案 2026-11-24-send-file-snapshot D3）：发送当时把字节另存一份，
 * 消息只记快照 id。工作区之后怎么删、怎么改都不影响这份附件。
 */
export interface DeliverySendFileRef {
  type: 'send-file';
  /** 快照 id（UUID）。下载端用它查表，不接受客户端传入的路径。 */
  id: string;
}

/**
 * 活引用判别联合。`'workspace'` 只服务存量消息（新代码不再写出）；
 * `'send-file'` 是新发送的默认形态。未来新增引用类型在此扩展成员。
 */
export type DeliveryRef = DeliveryWorkspaceRef | DeliverySendFileRef;
