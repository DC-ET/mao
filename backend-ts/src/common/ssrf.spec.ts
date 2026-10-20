import { describe, expect, it } from 'vitest';
import {
  areIpsInCidrAllowlist, cidrOverlapsHardDeniedNet, ipv4InCidr, ipv4ToUint32,
  isCloudMetadataHost, isCloudMetadataIp, isHostInCidrAllowlist, isLoopbackIp,
  isPrivateOrReservedHostname, isPrivateOrReservedIp, isValidCidr,
  parseCidrList, resolveHostIps,
} from './ssrf.js';

describe('isPrivateOrReservedHostname', () => {
  it('rejects localhost variants', () => {
    expect(isPrivateOrReservedHostname('localhost')).toBe(true);
    expect(isPrivateOrReservedHostname('api.localhost')).toBe(true);
  });

  it('rejects RFC1918 private ranges', () => {
    expect(isPrivateOrReservedHostname('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHostname('172.16.0.1')).toBe(true);
    expect(isPrivateOrReservedHostname('172.31.255.255')).toBe(true);
    expect(isPrivateOrReservedHostname('192.168.1.1')).toBe(true);
  });

  it('rejects loopback / link-local / reserved', () => {
    expect(isPrivateOrReservedHostname('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedHostname('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedHostname('0.0.0.0')).toBe(true);
    expect(isPrivateOrReservedHostname('255.255.255.255')).toBe(true);
    expect(isPrivateOrReservedHostname('224.0.0.1')).toBe(true);
  });

  it('rejects IPv6 literals and internal suffixes', () => {
    expect(isPrivateOrReservedHostname('::1')).toBe(true);
    expect(isPrivateOrReservedHostname('fe80::1')).toBe(true);
    expect(isPrivateOrReservedHostname('printer.local')).toBe(true);
    expect(isPrivateOrReservedHostname('db.internal')).toBe(true);
  });

  it('allows public hostnames', () => {
    expect(isPrivateOrReservedHostname('example.com')).toBe(false);
    expect(isPrivateOrReservedHostname('api.github.com')).toBe(false);
    expect(isPrivateOrReservedHostname('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedHostname('172.32.0.1')).toBe(false);
    expect(isPrivateOrReservedHostname('192.169.1.1')).toBe(false);
    expect(isPrivateOrReservedHostname('localhost.example.com')).toBe(false);
  });
});

describe('ipv4ToUint32', () => {
  it('converts dotted quads', () => {
    expect(ipv4ToUint32('0.0.0.0')).toBe(0);
    expect(ipv4ToUint32('10.0.0.1')).toBe(167772161);
    expect(ipv4ToUint32('255.255.255.255')).toBe(4294967295);
  });

  it('returns null for out-of-range or non-IPv4 input', () => {
    expect(ipv4ToUint32('256.1.1.1')).toBeNull();
    expect(ipv4ToUint32('1.2.3')).toBeNull();
    expect(ipv4ToUint32('::1')).toBeNull();
    expect(ipv4ToUint32('a.b.c.d')).toBeNull();
  });
});

describe('isPrivateOrReservedIp', () => {
  it('mirrors the IPv4 matrix', () => {
    expect(isPrivateOrReservedIp('192.168.0.10')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('100.64.0.1')).toBe(false);
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
  });

  it('handles IPv6 loopback / unspecified / mapped / link-local / ULA / multicast', () => {
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('::')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('fd00::1')).toBe(true);
    expect(isPrivateOrReservedIp('ff02::1')).toBe(true);
    expect(isPrivateOrReservedIp('2001:db8::1')).toBe(false);
  });
});

describe('hard-deny predicates', () => {
  it('loopback covers 127.0.0.0/8 and ::1 only', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('127.255.255.254')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp('10.0.0.1')).toBe(false);
    expect(isLoopbackIp('169.254.169.254')).toBe(false);
  });

  it('cloud metadata covers the endpoint IP and known hostnames (case-insensitive)', () => {
    expect(isCloudMetadataIp('169.254.169.254')).toBe(true);
    expect(isCloudMetadataIp('169.254.169.253')).toBe(false);
    expect(isCloudMetadataHost('169.254.169.254')).toBe(true);
    expect(isCloudMetadataHost('metadata.google.internal')).toBe(true);
    expect(isCloudMetadataHost('METADATA.GOOG')).toBe(true);
    expect(isCloudMetadataHost('metadata.example.com')).toBe(false);
  });
});

describe('CIDR helpers', () => {
  it('validates CIDR literals', () => {
    expect(isValidCidr('10.0.0.0/8')).toBe(true);
    expect(isValidCidr('10.0.0.1')).toBe(true);
    expect(isValidCidr('0.0.0.0/0')).toBe(true);
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
    expect(isValidCidr('300.1.1.1')).toBe(false);
    expect(isValidCidr('10.0.0.0/-1')).toBe(false);
    expect(isValidCidr('example.com')).toBe(false);
    expect(isValidCidr('10.0.0.0/8/16')).toBe(false);
  });

  it('parses the settings JSON array, normalizing bare IPs to /32', () => {
    expect(parseCidrList('["10.0.0.0/8","192.168.1.5"]')).toEqual(['10.0.0.0/8', '192.168.1.5/32']);
    expect(parseCidrList('not-json')).toEqual([]);
    expect(parseCidrList('{"a":1}')).toEqual([]);
    expect(parseCidrList(null)).toEqual([]);
    expect(parseCidrList('["10.0.0.0/8","bogus",42]')).toEqual(['10.0.0.0/8']);
  });

  it('matches IPv4 against CIDR prefixes', () => {
    expect(ipv4InCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipv4InCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipv4InCidr('172.16.5.5', '172.16.0.0/12')).toBe(true);
    expect(ipv4InCidr('172.32.5.5', '172.16.0.0/12')).toBe(false);
    expect(ipv4InCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(ipv4InCidr('8.8.8.8', 'bad')).toBe(false);
    expect(ipv4InCidr('::1', '::/0')).toBe(false);
  });

  it('requires every resolved IP to match the allowlist', () => {
    expect(areIpsInCidrAllowlist(['10.1.2.3'], ['10.0.0.0/8'])).toBe(true);
    expect(areIpsInCidrAllowlist(['10.1.2.3', '10.4.5.6'], ['10.0.0.0/8'])).toBe(true);
    expect(areIpsInCidrAllowlist(['10.1.2.3', '192.168.1.5'], ['10.0.0.0/8'])).toBe(false);
    expect(areIpsInCidrAllowlist(['8.8.8.8'], ['10.0.0.0/8'])).toBe(false);
    expect(areIpsInCidrAllowlist([], ['10.0.0.0/8'])).toBe(false);
    expect(areIpsInCidrAllowlist(['10.1.2.3'], [])).toBe(false);
  });

  it('flags allowlist entries that intersect the hard-denied nets', () => {
    expect(cidrOverlapsHardDeniedNet('127.0.0.0/8')).toBe(true);
    expect(cidrOverlapsHardDeniedNet('127.0.0.1')).toBe(true);
    expect(cidrOverlapsHardDeniedNet('169.254.169.254')).toBe(true);
    expect(cidrOverlapsHardDeniedNet('169.254.0.0/16')).toBe(true);
    expect(cidrOverlapsHardDeniedNet('0.0.0.0/0')).toBe(true);
    expect(cidrOverlapsHardDeniedNet('10.0.0.0/8')).toBe(false);
    expect(cidrOverlapsHardDeniedNet('192.168.1.0/24')).toBe(false);
    expect(cidrOverlapsHardDeniedNet('172.16.0.0/12')).toBe(false);
    expect(cidrOverlapsHardDeniedNet('169.253.0.0/16')).toBe(false);
    expect(cidrOverlapsHardDeniedNet('bogus')).toBe(false);
  });
});

describe('resolveHostIps / isHostInCidrAllowlist', () => {
  it('passes IPv4 literals through without DNS', async () => {
    await expect(resolveHostIps('10.1.2.3')).resolves.toEqual(['10.1.2.3']);
  });

  it('returns the IPv6 literal for IP-level rejection', async () => {
    await expect(resolveHostIps('[::1]')).resolves.toEqual(['::1']);
  });

  it('checks allowlist membership by resolving the hostname first', async () => {
    await expect(isHostInCidrAllowlist('10.9.9.9', ['10.0.0.0/8'])).resolves.toBe(true);
    await expect(isHostInCidrAllowlist('8.8.8.8', ['10.0.0.0/8'])).resolves.toBe(false);
    await expect(isHostInCidrAllowlist('10.9.9.9', [])).resolves.toBe(false);
  });
});
