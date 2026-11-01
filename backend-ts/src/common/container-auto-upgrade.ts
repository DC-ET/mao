/**
 * 容器内代码版本漂移「自动升级」总开关（V178，默认开启）。
 *
 * key 放在 common：settings 保存校验（settings.service）与运行时解析
 * （harness/container/container-auto-upgrade.ts）共用同一常量，避免两处漂移。
 */
export const CONTAINER_AUTO_UPGRADE_SETTING_KEY = 'runtime.container.autoUpgrade';

/** 任意来源值 → 开关布尔：缺省 / 非法 / 读库失败一律回落 true（保持既有部署行为）。 */
export function parseContainerAutoUpgrade(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const value = raw.trim().toLowerCase();
  if (value === 'false' || value === '0') return false;
  return true;
}

/** 保存前校验：只接受 true / false（空值 = 清空回落默认，视为合法）。 */
export function isContainerAutoUpgradeValueValid(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const value = raw.trim().toLowerCase();
  return value === '' || value === 'true' || value === 'false';
}
