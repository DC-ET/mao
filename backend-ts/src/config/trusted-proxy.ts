import { isIP } from 'node:net';

/** Only exact configured reverse-proxy IPs are trusted; never trust arbitrary X-Forwarded-* input. */
export function loadTrustedProxyAddresses(value = process.env.TRUSTED_PROXY_ADDRESSES ?? ''): false | string[] {
  if (!value.trim()) return false;
  const addresses = value.split(',').map((part) => part.trim());
  if (addresses.some((address) => !isIP(address))) {
    throw new Error('TRUSTED_PROXY_ADDRESSES must contain comma-separated exact proxy IP addresses');
  }
  return [...new Set(addresses)];
}
