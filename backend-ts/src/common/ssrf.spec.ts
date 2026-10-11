import { describe, expect, it } from 'vitest';
import { isPrivateOrReservedHostname } from './ssrf.js';

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
