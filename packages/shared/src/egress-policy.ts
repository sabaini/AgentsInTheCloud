import { BlockList, isIP } from "node:net";

/**
 * The workspace egress invariant: over IP, a workspace may reach global
 * unicast destinations (the public internet) and nothing else.
 *
 * AgentsInTheCloud's own services are never valid destinations. The app, the
 * supervisor and every other control channel are reached through per-workspace
 * Unix sockets with fixed route lists, not through the network. Private
 * networks (LAN, VPN, tailnet, Docker bridges) are not reachable either, except
 * for exact host:port destinations the user lists under Private network access.
 * Those may only resolve to the private network ranges below.
 *
 * This module is the one policy definition for both enforcement layers: the
 * System nftables firewall (images/system/src/firewall.ts) and the egress
 * proxy's destination check (packages/proxy-egress), so they cannot drift.
 * Workspaces' test machines are held to it too, by the network ACL that
 * packages/machines generates from it.
 */

/** Special-purpose IPv4 ranges that are never workspace egress destinations. */
export const blockedEgressIpv4Ranges: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["0.0.0.0", 8], // "this network", broadcast abuse
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // CGNAT / Tailscale tailnet
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC1918 private, Docker bridges
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918 private, most LANs
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
];

/** The only globally routed IPv6 block; it excludes loopback, ULA and everything non-global. */
export const allowedEgressIpv6Range = { address: "2000::", prefix: 3 } as const;

/** Global-range exceptions that are never workspace egress destinations. */
export const blockedEgressIpv6Ranges: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["2001:db8::", 32], // documentation
];

const blockedIpv4 = new BlockList();
for (const [address, prefix] of blockedEgressIpv4Ranges) blockedIpv4.addSubnet(address, prefix, "ipv4");

const allowedIpv6 = new BlockList();
allowedIpv6.addSubnet(allowedEgressIpv6Range.address, allowedEgressIpv6Range.prefix, "ipv6");

const blockedIpv6 = new BlockList();
for (const [address, prefix] of blockedEgressIpv6Ranges) blockedIpv6.addSubnet(address, prefix, "ipv6");

/**
 * Private networks a user may open exact host:port destinations into. Loopback,
 * link-local (cloud metadata) and special-purpose ranges are never allowed, and
 * neither is 172.16.0.0/12: System allocates every Docker network from it, so
 * it would reach other workspaces and System itself.
 */
export const privateNetworkIpv4Ranges: ReadonlyArray<readonly [address: string, prefix: number]> = [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["192.168.0.0", 16],
];

/** Unique local IPv6 addresses, including tailnet addresses. */
export const privateNetworkIpv6Range = { address: "fc00::", prefix: 7 } as const;

const privateIpv4 = new BlockList();
for (const [address, prefix] of privateNetworkIpv4Ranges) privateIpv4.addSubnet(address, prefix, "ipv4");

const privateIpv6 = new BlockList();
privateIpv6.addSubnet(privateNetworkIpv6Range.address, privateNetworkIpv6Range.prefix, "ipv6");

/** True when `ip` may be opened as a Private network access destination; literal addresses only. */
export function isPrivateNetworkAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return privateIpv4.check(ip, "ipv4");
  if (family === 6) return privateIpv6.check(ip, "ipv6");
  return false;
}

/** True when `ip` may be a workspace egress destination; literal addresses only. */
export function isWorkspaceEgressAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blockedIpv4.check(ip, "ipv4");
  if (family === 6) return allowedIpv6.check(ip, "ipv6") && !blockedIpv6.check(ip, "ipv6");
  return false;
}

const ipv4Number = (address: string) => address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
const ipv4Address = (value: number) => [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join(".");

/** Every IPv4 address outside the blocked ranges, as the fewest CIDR blocks, for allow lists that can't subtract ranges. */
export function workspaceEgressIpv4AllowedCidrs(): string[] {
  const blocked = blockedEgressIpv4Ranges.map(([address, prefix]) => [ipv4Number(address), ipv4Number(address) + 2 ** (32 - prefix)] as const).sort((a, b) => a[0] - b[0]);
  const cidrs: string[] = [];
  // Each step takes the largest block that starts on its own boundary and stays inside the gap.
  const cover = (start: number, end: number) => {
    while (start < end) {
      let size = 1;
      while (start % (size * 2) === 0 && start + size * 2 <= end) size *= 2;
      cidrs.push(`${ipv4Address(start)}/${32 - Math.log2(size)}`);
      start += size;
    }
  };
  let next = 0;
  for (const [start, end] of blocked) {
    cover(next, start);
    next = Math.max(next, end);
  }
  cover(next, 2 ** 32);
  return cidrs;
}

/** nftables set elements for the System firewall, generated from the same list the proxy enforces. */
export function workspaceEgressNftIpv4Elements(): string {
  return blockedEgressIpv4Ranges.map(([address, prefix]) => `${address}/${prefix}`).join(",\n      ");
}
