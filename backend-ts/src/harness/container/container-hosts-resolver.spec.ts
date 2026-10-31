import { describe, expect, it } from 'vitest';
import {
  CONTAINER_EXTRA_HOSTS_KEY,
  CONTAINER_INHERIT_HOST_HOSTS_KEY,
  containerHostsFingerprint,
  EMPTY_CONTAINER_HOSTS_FINGERPRINT,
  mergeContainerHosts,
  normalizeHostName,
  parseExtraHostsValue,
  parseHostHostsFile,
  validateCustomHostEntry,
} from '../../common/container-hosts.js';
import { ContainerHostsResolver, parseInheritFlag } from './container-hosts-resolver.js';

const HOSTS_FILE = [
  '# 宿主机 hosts 示例',
  '127.0.0.1 localhost',
  '127.0.1.1 my-host',
  '10.70.21.57 prometheus.acg.team prom.example # 内网监控',
  '10.70.21.58 Upper.CASE.com.',
  'fe80::1 ipv6.local',
  '10.70.21.59',
  '169.254.169.254 metadata.local',
  '10.70.21.60 prometheus.acg.team',
].join('\n');

interface ResolverOptions {
  settings?: Record<string, string | null>;
  hostsFile?: string;
  failSettings?: boolean;
  failFile?: boolean;
  now?: () => number;
}

function makeResolver(options: ResolverOptions = {}): ContainerHostsResolver {
  return new ContainerHostsResolver({
    systemSettingService: {
      async getValue(key: string) {
        if (options.failSettings) throw new Error('db down');
        const settings = options.settings ?? {};
        return key in settings ? settings[key]! : null;
      },
    },
    readHostHostsFile: async () => {
      if (options.failFile) throw new Error('EACCES');
      return options.hostsFile ?? HOSTS_FILE;
    },
    now: options.now,
    hostsFilePath: '/etc/hosts',
  });
}

describe('common/container-hosts', () => {
  it('normalizesHostNames', () => {
    expect(normalizeHostName(' Foo.COM. ')).toBe('foo.com');
    expect(normalizeHostName('mysql')).toBe('mysql');
    expect(normalizeHostName('a-b.example.com')).toBe('a-b.example.com');
    expect(normalizeHostName('')).toBeNull();
    expect(normalizeHostName('a..b')).toBeNull();
    expect(normalizeHostName('-a.com')).toBeNull();
    expect(normalizeHostName('a_b.com')).toBeNull();
    expect(normalizeHostName(`${'a'.repeat(64)}.com`)).toBeNull();
  });

  it('rejectsReservedAndReservedRangeIps', () => {
    expect(validateCustomHostEntry('prometheus.acg.team', '10.70.21.57')).toBeNull();
    expect(validateCustomHostEntry('localhost', '10.0.0.1')).toContain('保留域名');
    expect(validateCustomHostEntry('a.com', '127.0.0.1')).toContain('环回');
    expect(validateCustomHostEntry('a.com', '169.254.169.254')).toContain('云元数据');
    expect(validateCustomHostEntry('a.com', '0.0.0.0')).toContain('保留段');
    expect(validateCustomHostEntry('a.com', '224.0.0.1')).toContain('保留段');
    expect(validateCustomHostEntry('a.com', 'fe80::1')).toContain('IPv4');
  });

  it('parsesExtraHostsJson', () => {
    expect(parseExtraHostsValue('[]')).toEqual({ ok: true, entries: [] });
    expect(parseExtraHostsValue('')).toEqual({ ok: true, entries: [] });
    expect(parseExtraHostsValue(null).ok).toBe(true);
    expect(parseExtraHostsValue('not-json').ok).toBe(false);
    expect(parseExtraHostsValue('{}').ok).toBe(false);
    const ok = parseExtraHostsValue('[{"host":"A.com.","ip":"10.0.0.1"}]');
    expect(ok).toEqual({ ok: true, entries: [{ host: 'a.com', ip: '10.0.0.1' }] });
    expect(parseExtraHostsValue('[{"host":"a.com","ip":"127.0.0.1"}]').ok).toBe(false);
    expect(parseExtraHostsValue('[{"host":"a.com","ip":"10.0.0.1"},{"host":"a.com","ip":"10.0.0.2"}]').ok).toBe(false);
    const many = JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ host: `h${i}.com`, ip: '10.0.0.1' })));
    expect(parseExtraHostsValue(many).ok).toBe(false);
    expect(parseExtraHostsValue('[{"host":1,"ip":"10.0.0.1"}]').ok).toBe(false);
  });

  it('parsesHostHostsFileWithFilters', () => {
    const { entries, truncated } = parseHostHostsFile(HOSTS_FILE);
    expect(truncated).toBe(false);
    expect(entries).toEqual([
      { host: 'prometheus.acg.team', ip: '10.70.21.57' },
      { host: 'prom.example', ip: '10.70.21.57' },
      { host: 'upper.case.com', ip: '10.70.21.58' },
    ]);
    // 环回 / IPv6 / 元数据 / 重复 host 均被过滤
    expect(entries.some((entry) => entry.host === 'localhost' || entry.host === 'my-host')).toBe(false);
    expect(entries.some((entry) => entry.host === 'metadata.local')).toBe(false);
    // 截断
    const limited = parseHostHostsFile(HOSTS_FILE, 2);
    expect(limited.entries).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it('reportsTruncatedOnlyWhenEntriesDropped', () => {
    // 恰好达到上限不算截断（否则打误导性 warn）
    const exactly = Array.from({ length: 100 }, (_, i) => `10.0.0.1 h${i}.com`).join('\n');
    const exactResult = parseHostHostsFile(exactly);
    expect(exactResult.entries).toHaveLength(100);
    expect(exactResult.truncated).toBe(false);
    const over = parseHostHostsFile(`${exactly}\n10.0.0.1 h100.com`);
    expect(over.entries).toHaveLength(100);
    expect(over.truncated).toBe(true);
  });

  it('mergesHostsWithCustomOverrideAndSort', () => {
    const merged = mergeContainerHosts(
      [{ host: 'b.com', ip: '10.0.0.2' }, { host: 'a.com', ip: '10.0.0.1' }],
      [{ host: 'b.com', ip: '192.168.1.1' }, { host: 'c.com', ip: '10.0.0.3' }],
      true,
    );
    expect(merged).toEqual([
      { host: 'a.com', ip: '10.0.0.1', source: 'hosts-file' },
      { host: 'b.com', ip: '192.168.1.1', source: 'custom' },
      { host: 'c.com', ip: '10.0.0.3', source: 'custom' },
    ]);
    const onlyCustom = mergeContainerHosts([{ host: 'a.com', ip: '10.0.0.1' }], [], false);
    expect(onlyCustom).toEqual([]);
  });

  it('computesStableFingerprint', () => {
    const entries = [{ host: 'a.com', ip: '10.0.0.1' }, { host: 'b.com', ip: '10.0.0.2' }];
    expect(containerHostsFingerprint(entries)).toBe(containerHostsFingerprint([...entries]));
    expect(containerHostsFingerprint(entries)).not.toBe(containerHostsFingerprint([{ host: 'a.com', ip: '10.0.0.9' }]));
    expect(containerHostsFingerprint([])).toBe(EMPTY_CONTAINER_HOSTS_FINGERPRINT);
  });

  it('parsesInheritFlag', () => {
    expect(parseInheritFlag(null)).toBe(true);
    expect(parseInheritFlag('')).toBe(true);
    expect(parseInheritFlag('true')).toBe(true);
    expect(parseInheritFlag('TRUE')).toBe(true);
    expect(parseInheritFlag('false')).toBe(false);
    expect(parseInheritFlag('0')).toBe(false);
    expect(parseInheritFlag('yes')).toBe(true);
  });
});

describe('ContainerHostsResolver', () => {
  it('mergesHostsFileAndCustomRulesByDefault', async () => {
    const resolver = makeResolver();
    const entries = await resolver.resolve();
    expect(entries).toEqual([
      { host: 'prom.example', ip: '10.70.21.57', source: 'hosts-file' },
      { host: 'prometheus.acg.team', ip: '10.70.21.57', source: 'hosts-file' },
      { host: 'upper.case.com', ip: '10.70.21.58', source: 'hosts-file' },
    ]);
  });

  it('customRulesOverrideHostsFileAndSwitchOffSkipsFile', async () => {
    const override = makeResolver({
      settings: { [CONTAINER_EXTRA_HOSTS_KEY]: '[{"host":"prometheus.acg.team","ip":"192.168.10.10"}]' },
    });
    const entries = await override.resolve();
    expect(entries.find((entry) => entry.host === 'prometheus.acg.team')).toEqual({
      host: 'prometheus.acg.team', ip: '192.168.10.10', source: 'custom',
    });

    const switchedOff = makeResolver({
      settings: { [CONTAINER_INHERIT_HOST_HOSTS_KEY]: 'false' },
    });
    expect(await switchedOff.resolve()).toEqual([]);

    const switchedOffWithCustom = makeResolver({
      settings: {
        [CONTAINER_INHERIT_HOST_HOSTS_KEY]: '0',
        [CONTAINER_EXTRA_HOSTS_KEY]: '[{"host":"a.internal","ip":"10.1.2.3"}]',
      },
    });
    expect(await switchedOffWithCustom.resolve()).toEqual([
      { host: 'a.internal', ip: '10.1.2.3', source: 'custom' },
    ]);
  });

  it('degradesWhenHostsFileUnreadable', async () => {
    const resolver = makeResolver({
      failFile: true,
      settings: { [CONTAINER_EXTRA_HOSTS_KEY]: '[{"host":"a.internal","ip":"10.1.2.3"}]' },
    });
    const preview = await resolver.preview();
    expect(preview.entries).toEqual([{ host: 'a.internal', ip: '10.1.2.3', source: 'custom' }]);
    expect(preview.hostsFileError).toContain('EACCES');
    expect(preview.inheritEnabled).toBe(true);
    expect(preview.hostsFilePath).toBe('/etc/hosts');
    // 降级标记：不得用于漂移判定（否则瞬时故障会误重建存量容器）
    expect(preview.degraded).toBe(true);
  });

  it('degradesWhenSettingsQueryFails', async () => {
    const resolver = makeResolver({ failSettings: true, hostsFile: '10.0.0.1 a.internal' });
    const resolution = await resolver.resolveWithMeta();
    expect(resolution.entries).toEqual([{ host: 'a.internal', ip: '10.0.0.1', source: 'hosts-file' }]);
    expect(resolution.degraded).toBe(true);
  });

  it('marksHealthyResolutionAsNotDegraded', async () => {
    const resolver = makeResolver();
    const resolution = await resolver.resolveWithMeta();
    expect(resolution.degraded).toBe(false);
    expect(resolution.entries.length).toBeGreaterThan(0);
  });

  it('cachesForTtlAndInvalidates', async () => {
    let clock = 1_000;
    let content = '10.0.0.1 a.internal';
    const resolver = new ContainerHostsResolver({
      systemSettingService: { getValue: async () => null },
      readHostHostsFile: async () => content,
      now: () => clock,
      hostsFilePath: '/etc/hosts',
    });
    expect(await resolver.resolve()).toEqual([{ host: 'a.internal', ip: '10.0.0.1', source: 'hosts-file' }]);
    content = '10.0.0.2 a.internal';
    clock += 1_000; // 未超 5s：命中缓存
    expect((await resolver.resolve())[0]!.ip).toBe('10.0.0.1');
    resolver.invalidate();
    expect((await resolver.resolve())[0]!.ip).toBe('10.0.0.2');
    clock += 6_000; // 超过 TTL：自动重新读取
    content = '10.0.0.3 a.internal';
    expect((await resolver.resolve())[0]!.ip).toBe('10.0.0.3');
  });
});
