import { createHash } from "node:crypto";
import { workspaceEgressIpv4AllowedCidrs } from "@agents-in-the-cloud/shared/egress-policy";
import type { LxdNetworkAclPut, LxdNetworksPost } from "../lxd/index.ts";

/**
 * Machines run whatever Agents put on them, so they're held to the workspace egress invariant: each workspace's
 * machines get an OVN network of their own, where they reach each other and the public internet, and nothing else.
 * That needs an LXD project whose certificate can make such networks but can't hand out the LXD host.
 */

/** The ACL every workspace's network uses. Its `@internal` means the machines on that network. */
export const machineNetworkAcl = "aitc-machines";
/** LXD's default `dns.domain`: machines reach each other as `<instance>.lxd`. */
export const machineDnsDomain = "lxd";

/** Like machines' instance names, so a workspace's network and its machines carry the same suffix. */
export function workspaceNetworkName(workspaceId: string): string {
  return `aitc-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 8)}`;
}

export function machineNetworkAclRules(): LxdNetworkAclPut {
  return {
    description: "AgentsInTheCloud machines reach each other and the public internet",
    egress: [
      { action: "allow", destination: "@internal", state: "enabled" },
      { action: "allow", destination: workspaceEgressIpv4AllowedCidrs().join(","), state: "enabled" },
    ],
    ingress: [{ action: "allow", source: "@internal", state: "enabled" }],
  };
}

/** What keeps a workspace's network sandboxed. */
export const workspaceNetworkSecurity: LxdNetworksPost["config"] = {
  // There's no IPv6 to filter.
  "ipv6.address": "none",
  "security.acls": machineNetworkAcl,
  // OVN applies reject rules before allow rules, so rejecting private ranges would also cut machines off from each
  // other. The ACL lists what's allowed instead, and the rest is refused here. LXD still allows DHCP, and DNS to the
  // uplink's resolvers.
  "security.acls.default.egress.action": "reject",
  "security.acls.default.ingress.action": "reject",
};

export function workspaceNetworkConfig(uplink: string): LxdNetworksPost["config"] {
  return { network: uplink, ...workspaceNetworkSecurity };
}

/**
 * In a restricted project, LXD before 6.9 restores a VM's snapshot only once: restoring gives the VM a new
 * `volatile.uuid.generation`, which those refuse to change back with the next restore.
 */
export function lxdVersionKeepsSnapshots(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 6 || (major === 6 && minor >= 9);
}

/** `restricted.*` settings that may be `allow` without handing out the LXD host. Interception's dangerous level is `full`. */
const harmlessAllows = new Set(["restricted.snapshots", "restricted.backups", "restricted.cluster.target", "restricted.containers.interception"]);

export interface ProjectSandbox {
  /** The one OVN uplink the project may use, which its machine networks use. */
  uplink?: string;
  /** Settings the project needs, as `key=value`. */
  missing: string[];
  /** Settings that hand out the LXD host or its devices, and need to go. */
  unsafe: string[];
}

/** Checks an LXD project's config: machines are only created in a project that keeps them sandboxed. */
export function projectSandbox(config: Record<string, string>): ProjectSandbox {
  const missing: string[] = [];
  if (config.restricted !== "true") missing.push("restricted=true");
  if (config["restricted.snapshots"] !== "allow") missing.push("restricted.snapshots=allow");
  // LXD restricts only projects with profiles of their own.
  if (config["features.profiles"] !== "true") missing.push("features.profiles=true");
  if (config["features.networks"] !== "true") missing.push("features.networks=true");
  const uplinks = (config["restricted.networks.uplinks"] ?? "").split(",").map((uplink) => uplink.trim()).filter(Boolean);
  if (uplinks.length !== 1) missing.push("restricted.networks.uplinks=UPLINK");
  const unsafe = Object.entries(config).filter(([key, value]) => key.startsWith("restricted.") && (
    (value === "allow" && !harmlessAllows.has(key)) ||
    (key === "restricted.containers.interception" && value === "full") ||
    // Host user and group IDs a container may map.
    (key.startsWith("restricted.idmap.") && value !== "")
  )).map(([key]) => key).sort();
  const sandbox: ProjectSandbox = { missing, unsafe };
  if (uplinks.length === 1) sandbox.uplink = uplinks[0];
  return sandbox;
}
