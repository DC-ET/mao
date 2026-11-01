import { describe, expect, it, vi } from 'vitest';
import { ContainerAutoUpgradeResolver } from './container-auto-upgrade.js';
import {
  CONTAINER_AUTO_UPGRADE_SETTING_KEY, isContainerAutoUpgradeValueValid, parseContainerAutoUpgrade,
} from '../../common/container-auto-upgrade.js';

describe('container auto upgrade switch', () => {
  it('parsesValuesWithEnabledDefault', () => {
    expect(parseContainerAutoUpgrade(null)).toBe(true);
    expect(parseContainerAutoUpgrade(undefined)).toBe(true);
    expect(parseContainerAutoUpgrade('weird')).toBe(true);
    expect(parseContainerAutoUpgrade('true')).toBe(true);
    expect(parseContainerAutoUpgrade('1')).toBe(true);
    expect(parseContainerAutoUpgrade('false')).toBe(false);
    expect(parseContainerAutoUpgrade(' FALSE ')).toBe(false);
    expect(parseContainerAutoUpgrade('0')).toBe(false);
    // 保存校验：只接受 true / false（空值 = 清空回落默认，视为合法）
    expect(isContainerAutoUpgradeValueValid('true')).toBe(true);
    expect(isContainerAutoUpgradeValueValid('false')).toBe(true);
    expect(isContainerAutoUpgradeValueValid('')).toBe(true);
    expect(isContainerAutoUpgradeValueValid('yes')).toBe(false);
  });

  it('resolvesWithTtlCacheAndInvalidate', async () => {
    let now = 1_000;
    let value: string | null = 'false';
    const getValue = vi.fn(async () => value);
    const resolver = new ContainerAutoUpgradeResolver({
      systemSettingService: { getValue },
      now: () => now,
    });
    expect(await resolver.resolve()).toBe(false);
    expect(getValue).toHaveBeenCalledWith(CONTAINER_AUTO_UPGRADE_SETTING_KEY);

    value = 'true';
    now += 4_000;
    expect(await resolver.resolve()).toBe(false); // TTL 内不重复查库
    expect(getValue).toHaveBeenCalledTimes(1);

    now += 2_000; // 超过 5s TTL
    expect(await resolver.resolve()).toBe(true);
    expect(getValue).toHaveBeenCalledTimes(2);

    // 后台保存后立即失效，不等 TTL
    value = 'false';
    resolver.invalidate();
    expect(await resolver.resolve()).toBe(false);
  });

  it('fallsBackToEnabledWhenReadFails', async () => {
    const resolver = new ContainerAutoUpgradeResolver({
      systemSettingService: {
        getValue: async () => {
          throw new Error('db down');
        },
      },
    });
    await expect(resolver.resolve()).resolves.toBe(true);
  });
});
