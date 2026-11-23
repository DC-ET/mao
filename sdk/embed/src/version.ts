import pkg from '../package.json'

/** 页面嵌入 SDK 版本，随 WS auth 帧上报，供管理后台在线设备展示。 */
export const EMBED_CLIENT_VERSION = typeof pkg.version === 'string' ? pkg.version : ''
