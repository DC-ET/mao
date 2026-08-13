import type { AppConfig } from '../config/app-config.js';

/** Port of Java OssProperties (`oss.*` configuration). */
export type OssProperties = AppConfig['oss'];

export function ossPropertiesFromApp(cfg: AppConfig): OssProperties {
  return cfg.oss;
}
