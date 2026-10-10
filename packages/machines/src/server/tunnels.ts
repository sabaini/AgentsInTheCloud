import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { writeFileAtomic } from "@agents-in-the-cloud/core";
import type { LxdClient } from "../lxd/index.ts";
import type { MachineLease } from "./leases.ts";

export type MachineTunnelLxd = Pick<LxdClient, "exec">;

export interface MachineTunnelDependencies {
  /** Waits until the machine can take a connection, starting it if it's stopped, and returns the LXD project it's in. */
  usable(workspaceId: string, name: string): Promise<MachineTunnelLxd>;
  /** The workspace's SSH directory on this host. */
  hostDirectory(workspaceId: string): string;
  /** The same directory inside the workspace container. */
  containerDirectory: string;
}

/** Inside the machine; LXD exec reaches it whether the LXD server is local or remote, without a route to its network. */
const sshCommand = ["nc", "-N", "127.0.0.1", "22"];

/** Unix socket paths are limited to 107 bytes, and a machine name can be 40 characters on its own. */
function socketName(name: string): string {
  return `${createHash("sha256").update(name).digest("hex").slice(0, 12)}.sock`;
}

function write(socket: Socket, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => socket.write(chunk, (error) => error ? reject(error) : resolve()));
}

function sshConfig(leases: MachineLease[], directory: string): string {
  const hosts = leases.map((lease) => `Host ${lease.name}
    User ubuntu
    ProxyCommand socat - UNIX-CONNECT:${directory}/machines/${socketName(lease.name)}
    HostKeyAlias ${lease.name}
    UserKnownHostsFile ${directory}/machines/known_hosts
    KnownHostsCommand none
    StrictHostKeyChecking yes
    CheckHostIP no
`);
  return `# This workspace's machines. AgentsInTheCloud rewrites this file as they come and go.\n${hosts.join("")}`;
}

interface Tunnel { server: Server; clients: Set<Socket> }

/** One Unix socket per machine in its workspace's SSH directory, plus the SSH config and host keys to use them. */
export function createMachineTunnels(deps: MachineTunnelDependencies) {
  const tunnels = new Map<string, Map<string, Tunnel>>();

  async function relay(client: Socket, workspaceId: string, lease: MachineLease): Promise<void> {
    const { instance } = lease;
    // Reads and writes report their own failures, such as ssh exiting mid-reply; without a listener the same error would crash the process.
    client.on("error", () => {});
    try {
      const process = await (await deps.usable(workspaceId, lease.name)).exec(instance, sshCommand);
      const toMachine = async () => {
        try {
          // Iterating would otherwise destroy the socket once the client stops sending, cutting off the reply.
          for await (const chunk of client.iterator({ destroyOnReturn: false })) await process.write(chunk);
        } finally {
          process.closeStdin();
        }
      };
      const toClient = async () => {
        try {
          for await (const chunk of process.stdout) await write(client, chunk);
        } catch (error) {
          // ssh going away mid-reply is fine. Losing the machine's side isn't, and without an end ssh would wait for the rest of the reply.
          if (client.destroyed) return;
          client.destroy();
          throw error;
        }
        client.end();
      };
      const errors = async () => {
        let stderr = "";
        for await (const chunk of process.stderr) stderr += chunk.toString("utf8");
        return stderr.trim();
      };
      const [, forwarded, stderr, exited] = await Promise.allSettled([toMachine(), toClient(), errors(), process.exited]);
      if (forwarded.status === "rejected") throw forwarded.reason;
      if (exited.status === "rejected") throw exited.reason;
      if (exited.value !== 0) console.error(`[machines] SSH relay to ${instance} ended with status ${exited.value}${stderr.status === "fulfilled" && stderr.value ? `: ${stderr.value}` : ""}`);
    } catch (error) {
      console.error(`[machines] SSH relay to ${instance} failed:`, error);
    } finally {
      client.destroy();
    }
  }

  async function listen(path: string, workspaceId: string, lease: MachineLease): Promise<Tunnel> {
    await rm(path, { force: true });
    const clients = new Set<Socket>();
    // Each direction ends on its own: the client finishing sending doesn't end the machine's reply.
    const server = createServer({ allowHalfOpen: true }, (client) => {
      clients.add(client);
      client.once("close", () => clients.delete(client));
      void relay(client, workspaceId, lease);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    return { server, clients };
  }

  /** Cuts open connections too: closing alone would wait for them, and one may be waiting for this very change. */
  async function stop(tunnel: Tunnel, path: string): Promise<void> {
    for (const client of tunnel.clients) client.destroy();
    await new Promise<void>((resolve, reject) => tunnel.server.close((error) => error ? reject(error) : resolve()));
    await rm(path, { force: true });
  }

  /** Match the workspace's sockets and SSH config to its machines. A machine that has booted once keeps its socket while it restarts, so connections can wait for it. */
  async function sync(workspaceId: string, leases: MachineLease[]): Promise<void> {
    const reachable = leases.filter((lease) => lease.hostKeys.length > 0);
    const directory = join(deps.hostDirectory(workspaceId), "machines");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const current = tunnels.get(workspaceId) ?? new Map<string, Tunnel>();
    tunnels.set(workspaceId, current);
    for (const [name, tunnel] of current) {
      if (reachable.some((lease) => lease.name === name)) continue;
      current.delete(name);
      await stop(tunnel, join(directory, socketName(name)));
    }
    for (const lease of reachable) {
      if (!current.has(lease.name)) current.set(lease.name, await listen(join(directory, socketName(lease.name)), workspaceId, lease));
    }
    await writeFileAtomic(join(directory, "known_hosts"), reachable.flatMap((lease) => lease.hostKeys.map((key) => `${lease.name} ${key}\n`)).join(""), { mode: 0o644 });
    await writeFileAtomic(join(deps.hostDirectory(workspaceId), "ssh_config.d", "machines.conf"), sshConfig(reachable, deps.containerDirectory), { mode: 0o644 });
  }

  /** For a workspace that's gone: its sockets, host keys and SSH config entries go too. */
  async function close(workspaceId: string): Promise<void> {
    const current = tunnels.get(workspaceId);
    tunnels.delete(workspaceId);
    for (const [name, tunnel] of current ?? []) await stop(tunnel, join(deps.hostDirectory(workspaceId), "machines", socketName(name)));
    await rm(join(deps.hostDirectory(workspaceId), "machines"), { recursive: true, force: true });
    await rm(join(deps.hostDirectory(workspaceId), "ssh_config.d", "machines.conf"), { force: true });
  }

  return { sync, close };
}

export type MachineTunnels = ReturnType<typeof createMachineTunnels>;
