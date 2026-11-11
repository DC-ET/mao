/**
 * 管理后台统计域 VO（@mao/contracts 的 statistics.ts 模块）。
 *
 * 消费方：backend-ts/src/statistics/、admin/src/views/statistics/OnlineDevicesView.vue。
 * 本模块零运行时，仅类型。
 */
import type { WsClientType } from './ws';

/** 连接自报设备信息（仅 electron / cli 携带；android / browser / embed 为 null）。 */
export interface OnlineDeviceDeviceInfo {
  id: string;
  name: string;
  platform: string;
}

/** 单条在线 WS 连接快照（GET /v1/statistics/online-devices）。 */
export interface OnlineDeviceConnection {
  wsSessionId: string;
  clientType: WsClientType;
  /** 连接建立时间，epoch ms；前端据此计算连接时长 */
  connectedAt: number;
  /** 认证到期时间（JWT exp），epoch ms；连接无认证元数据时为 null */
  authExpiresAt: number | null;
  /** 认证来源；company_sso 有值，本地登录为 null */
  authSource: string | null;
  device: OnlineDeviceDeviceInfo | null;
}

/** GET /v1/statistics/online-devices 响应 data。 */
export interface OnlineDevicesVo {
  /** connections=全量 WS 连接数；users=去重在线用户数；devices=去重设备数（electron/cli 按 (userId, deviceId) 去重 + android 逐条计数，browser/embed 不计入） */
  total: { connections: number; users: number; devices: number };
  /** 按客户端类型分组的连接数（键类型吃 WsClientType 联合扩张，漏类编译期即失败） */
  byClientType: Record<WsClientType, number>;
  users: Array<{
    userId: number;
    username: string;
    displayName: string | null;
    connections: OnlineDeviceConnection[];
  }>;
}
