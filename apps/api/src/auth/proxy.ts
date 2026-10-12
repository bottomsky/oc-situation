import { isIP } from 'node:net';
/** Trust only explicitly configured reverse proxy addresses/networks in production. */
export function trustedProxies(production: boolean, value?: string): false | string[] {
  if (!production || !value?.trim()) return false;
  const ranges = value.split(',').map((part) => part.trim());
  for (const range of ranges) {
    const [address, prefix] = range.split('/');
    const family = isIP(address ?? '');
    if (!family || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < (family === 4 ? 8 : 32) || Number(prefix) > (family === 4 ? 32 : 128)))) throw new Error('TRUSTED_PROXY_CIDRS must contain explicit trusted proxy IP addresses or bounded CIDRs');
  }
  return ranges;
}
