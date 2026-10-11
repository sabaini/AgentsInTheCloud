/** Check the sandbox on a real LXD server with OVN, in a fresh project set up as the connect form suggests: two
 * workspaces with two containers each, made by AITC's own code. Each machine reaches its workspace's other machine,
 * the internet and DNS, and nothing else: not the other workspace's machines, not the LXD server at any private
 * address it listens on, and not cloud metadata. A public address is the internet's, which machines reach like anyone.
 * AITC refuses a machine whose LXD profile adds a network device, and puts back a workspace network someone changed.
 * Then AITC's own certificate tries what would hand out the LXD host or get past the ACL, and LXD refuses each for
 * that reason.
 * Needs `lxc` with admin access to the server. `--uplink` is its OVN uplink network.
 * Cleans up on success and keeps everything on failure for diagnosis.
 *
 *   bun run test:machines:sandbox [--remote <lxc-remote>] [--uplink UPLINK] [--image <ubuntu-release>]
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { JsonObject } from "@agents-in-the-cloud/core";
import { isWorkspaceEgressAddress } from "@agents-in-the-cloud/shared/egress-policy";
import type { WorkspaceTemplateMachineProfile } from "@agents-in-the-cloud/workspace-templates";
import { certificateFingerprint, createLxdClientCredentials, joinLxdServer, LxdClient, parseLxdTrustToken } from "../src/lxd/index.ts";
import { connectLxd, lxdFetchTls } from "../src/lxd/tls.ts";
import { createMachineLeases, machineInstanceName, type MachineView } from "../src/server/leases.ts";
import { machineNetworkAcl, workspaceNetworkConfig, workspaceNetworkName } from "../src/server/sandbox.ts";

const project = `aitc-it-${randomUUID().slice(0, 8)}`;
const workspaces = [`${project}-a`, `${project}-b`];
const { values: options } = parseArgs({ options: { remote: { type: "string" }, uplink: { type: "string", default: "UPLINK" }, image: { type: "string", default: "24.04" } } });
const on = (name = "") => options.remote ? `${options.remote}:${name}` : name;
const cleanup: string[][] = [];
const directory = await mkdtemp(join(tmpdir(), "machines-sandbox-it-"));

async function command(program: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn([program, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${program} ${args.join(" ")}: ${stderr || stdout}`);
  return stdout.trim();
}
const lxc = (...args: string[]) => command("lxc", ...args);

async function step<T>(description: string, action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await action();
  console.log(`ok  ${description} (${Date.now() - started} ms)`);
  return result;
}

const profile: WorkspaceTemplateMachineProfile = { id: randomUUID(), workspaceTemplateId: "t", name: "box", image: `ubuntu:${options.image}`, type: "container", lxdProfiles: ["default"], diskSizesGiB: [], lifetimeHours: 1, createdAt: "", updatedAt: "" };
/** Its second LXD profile adds a NIC on the other workspace's network. */
const bridged: WorkspaceTemplateMachineProfile = { ...profile, id: randomUUID(), name: "bridged", lxdProfiles: ["default", "bridged"] };

try {
  const pool = await lxc("profile", "device", "get", on("default"), "root", "pool");
  await lxc("project", "create", on(project), "-c", "features.images=false", "-c", "features.profiles=true", "-c", "features.networks=true", "-c", "restricted=true", "-c", "restricted.snapshots=allow", "-c", `restricted.networks.uplinks=${options.uplink}`);
  cleanup.unshift(["project", "delete", on(project)]);
  await lxc("profile", "device", "add", on("default"), "root", "disk", "path=/", `pool=${pool}`, "--project", project);
  cleanup.unshift(["network", "acl", "delete", on(machineNetworkAcl), "--project", project]);
  const token = (await lxc("config", "trust", "add", ...(options.remote ? [on()] : []), "--name", project, "--restricted", "--projects", project)).split("\n").at(-1)!;
  const listening = parseLxdTrustToken(token).addresses;
  const credentials = await createLxdClientCredentials(project);
  const { server } = await joinLxdServer(token, credentials);
  cleanup.unshift(["config", "trust", "remove", on(certificateFingerprint(credentials.certificate))]);
  const lxd = new LxdClient({ server, credentials, project });
  const keyPath = join(directory, "id_ed25519");
  await command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "aitc sandbox", "-f", keyPath);
  const leases = createMachineLeases({
    lxd: async () => lxd,
    machineSettings: async () => ({ profiles: [profile, bridged], maxMachines: 3 }),
    publicKey: async () => (await readFile(`${keyPath}.pub`, "utf8")).trim(),
    reachesMachines: async () => true,
    directory: (workspaceId) => join(directory, workspaceId),
    bootTimeoutMs: 10 * 60_000,
    pollMs: 2_000,
    changed: async () => undefined,
  });
  const machineCleanup = workspaces.flatMap((workspaceId) => [
    ...["box-1", "box-2", "box-3"].map((name) => ["delete", "--force", "--project", project, on(machineInstanceName(workspaceId, name))]),
    ["network", "delete", on(workspaceNetworkName(workspaceId)), "--project", project],
  ]);
  cleanup.unshift(...machineCleanup);

  const [a, b] = await step("two workspaces with two containers each", () => Promise.all(workspaces.map(async (workspaceId) => {
    const machines: MachineView[] = [];
    for (const name of ["box-1", "box-2"]) machines.push(await leases.acquire(workspaceId, { profile: "box", name }, 10 * 60_000));
    for (const machine of machines) assert.equal(machine.state, "ready", JSON.stringify(machine));
    return machines.map((machine) => ({ ...machine, instance: machineInstanceName(workspaceId, machine.name) }));
  })));

  const reaches = async (from: { instance: string }, host: string, port: number) => (await lxd.run(from.instance, ["timeout", "5", "bash", "-c", `</dev/tcp/${host}/${port}`])).exitCode === 0;

  await step("each reaches its workspace's other machine, by name and address, and the internet and DNS", async () => {
    for (const [self, other] of [[a![0]!, a![1]!], [a![1]!, a![0]!], [b![0]!, b![1]!]] as const) {
      assert(await reaches(self, other.dnsName, 22), `${self.instance} can't reach ${other.dnsName}`);
      assert(await reaches(self, other.addresses[0]!, 22), `${self.instance} can't reach ${other.addresses[0]}`);
    }
    for (const machine of [...a!, ...b!]) {
      assert(await reaches(machine, "1.1.1.1", 443), `${machine.instance} can't reach the internet`);
      assert.equal((await lxd.run(machine.instance, ["getent", "hosts", "ubuntu.com"])).exitCode, 0, `${machine.instance} can't resolve names`);
    }
  });

  await step("none reaches the other workspace's machines", async () => {
    for (const [self, other] of [[a![0]!, b![0]!], [b![1]!, a![1]!]] as const) {
      assert(!await reaches(self, other.addresses[0]!, 22), `${self.instance} reaches ${other.instance}`);
      // Their names aren't in this network's DNS either.
      assert.notEqual((await lxd.run(self.instance, ["getent", "hosts", other.dnsName])).exitCode, 0, `${self.instance} resolves ${other.dnsName}`);
    }
  });

  await step("none reaches the LXD server at any private IPv4 address it listens on, nor cloud metadata", async () => {
    let checked = 0;
    for (const address of listening) {
      const separator = address.lastIndexOf(":");
      const host = address.slice(0, separator);
      if (!isIPv4(host) || isWorkspaceEgressAddress(host)) continue;
      // Only addresses this test reaches tell a refused connection from one that goes nowhere.
      const reachable = await connectLxd(address).then(({ socket }) => { socket.destroy(); return true; }, () => false);
      if (!reachable) continue;
      checked++;
      for (const machine of [a![0]!, b![0]!]) assert(!await reaches(machine, host, Number(address.slice(separator + 1))), `${machine.instance} reaches LXD at ${address}`);
    }
    assert(checked > 0, `none of ${listening.join(", ")} is reachable from here`);
    assert(!await reaches(a![0]!, "169.254.169.254", 80), "a machine reaches 169.254.169.254");
  });

  await step("a machine whose LXD profile adds a network device is refused", async () => {
    await lxc("profile", "create", on("bridged"), "--project", project);
    cleanup.unshift(["profile", "delete", on("bridged"), "--project", project]);
    await lxc("profile", "device", "add", on("bridged"), "eth1", "nic", `network=${workspaceNetworkName(workspaces[1]!)}`, "--project", project);
    await assert.rejects(leases.acquire(workspaces[0]!, { profile: "bridged" }, 60_000), /The LXD profile bridged gives machines another network device, eth1/);
    assert.deepEqual((await leases.list(workspaces[0]!)).map((machine) => machine.name), ["box-1", "box-2"]);
    await lxc("profile", "delete", on("bridged"), "--project", project);
    cleanup.shift();
  });

  await step("a workspace network someone changed is put back before its next machine", async () => {
    const network = workspaceNetworkName(workspaces[0]!);
    await lxc("network", "unset", on(network), "security.acls", "--project", project);
    await lxc("network", "set", on(network), "security.acls.default.egress.action=allow", "--project", project);
    const box = await leases.acquire(workspaces[0]!, { profile: "box", name: "box-3" }, 10 * 60_000);
    assert.equal(box.state, "ready", JSON.stringify(box));
    const { config } = await lxd.network(network);
    for (const [key, value] of Object.entries(workspaceNetworkConfig(options.uplink))) assert.equal(config[key], value, key);
    const self = { instance: machineInstanceName(workspaces[0]!, "box-3") };
    assert(await reaches(self, a![0]!.dnsName, 22), `box-3 can't reach ${a![0]!.dnsName}`);
    assert(!await reaches(self, b![0]!.addresses[0]!, 22), `box-3 reaches ${b![0]!.instance}`);
    await leases.release(workspaces[0]!, "box-3");
  });

  await step("AITC's own certificate can't hand out the host or get past the ACL", async () => {
    const identity = { server, credentials };
    const network = workspaceNetworkName(workspaces[0]!);
    const { config } = await lxd.network(network);
    const uplinkAddress = config["volatile.network.ipv4.address"];
    assert(uplinkAddress, `${network} has no uplink address: ${JSON.stringify(config)}`);
    /** The error LXD answers with, or undefined if it did as asked. */
    const attempt = async (method: string, path: string, body: JsonObject): Promise<string | undefined> => {
      const url = new URL(path, `https://${server.address}`);
      url.searchParams.set("project", project);
      const response = await fetch(url, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" }, tls: lxdFetchTls(identity) });
      // SAFETY: LXD's documented response envelope; the fields read are checked below.
      const answer = await response.json() as { type: string; error?: string; operation?: string };
      if (answer.type === "error") return answer.error;
      if (answer.type !== "async") return undefined;
      const done = await fetch(new URL(`${answer.operation}/wait?timeout=-1`, `https://${server.address}`), { tls: lxdFetchTls(identity) });
      // SAFETY: LXD's documented operation envelope.
      const result = await done.json() as { type: string; error?: string; metadata?: { status_code: number; err: string } };
      return result.type === "error" ? result.error : result.metadata!.status_code === 200 ? undefined : result.metadata!.err;
    };
    let tried = 0;
    const instance = (config: Record<string, string>, devices: Record<string, Record<string, string>> = {}, type = "container") => {
      const name = `escape-${++tried}`;
      cleanup.unshift(["delete", "--force", "--project", project, on(name)]);
      return { name, type, source: { type: "none" }, config, devices };
    };
    // Each with the reason LXD gives for it, so a request refused for anything else, say a mistake in it, doesn't pass.
    const tries: [what: string, method: string, path: string, body: JsonObject, reason: RegExp][] = [
      ["a privileged container", "POST", "/1.0/instances", instance({ "security.privileged": "true" }), /Privileged containers are forbidden/],
      ["a nesting container", "POST", "/1.0/instances", instance({ "security.nesting": "true" }), /Container nesting is forbidden/],
      ["raw.lxc", "POST", "/1.0/instances", instance({ "raw.lxc": "lxc.apparmor.profile=unconfined" }), /Use of low-level config "raw.lxc" .* is forbidden/],
      ["raw.qemu", "POST", "/1.0/instances", instance({ "raw.qemu": "-device virtio-rng-pci" }, {}, "virtual-machine"), /Use of low-level config "raw.qemu" .* is forbidden/],
      ["the host's root as a disk", "POST", "/1.0/instances", instance({}, { host: { type: "disk", source: "/", path: "/host" } }), /Attaching disks not backed by a pool is forbidden/],
      ["a host character device", "POST", "/1.0/instances", instance({}, { kmsg: { type: "unix-char", source: "/dev/kmsg", path: "/dev/kmsg" } }), /Unix character devices are forbidden/],
      ["a proxy to the host", "POST", "/1.0/instances", instance({}, { sshd: { type: "proxy", listen: "tcp:127.0.0.1:2222", connect: "tcp:127.0.0.1:22", bind: "instance" } }), /Proxy devices are forbidden/],
      // The project has networks of its own, so the uplink isn't one it can see.
      ["a NIC on the uplink itself", "POST", "/1.0/instances", instance({}, { eth0: { type: "nic", network: options.uplink, name: "eth0" } }), new RegExp(`Failed loading network "${options.uplink}" for project "${project}": Network not found`)],
      ["a macvlan NIC on a host interface", "POST", "/1.0/instances", instance({}, { eth0: { type: "nic", nictype: "macvlan", parent: "eth0", name: "eth0" } }), /Only managed network devices are allowed/],
      ["a bridge of its own", "POST", "/1.0/networks", { name: "escape-br", type: "bridge", config: {} }, /Network type does not support non-default projects/],
      ["a forward from the uplink", "POST", `/1.0/networks/${network}/forwards`, { listen_address: uplinkAddress, ports: [{ protocol: "tcp", listen_port: "2222", target_address: a![0]!.addresses[0], target_port: "22" }] }, /Uplink network does not contain .* in its routes/],
      ["unrestricting its project", "PATCH", `/1.0/projects/${project}`, { config: { restricted: "false" } }, /Certificate is restricted/],
    ];
    const allowed: string[] = [];
    const otherwise: string[] = [];
    for (const [what, method, path, body, reason] of tries) {
      const error = await attempt(method, path, body);
      if (error === undefined) allowed.push(what);
      else if (!reason.test(error)) otherwise.push(`${what}: ${error}`);
      else console.log(`    refused ${what}: ${error}`);
    }
    assert.deepEqual(allowed, [], `LXD allowed ${allowed.join(", ")}`);
    assert.deepEqual(otherwise, [], `LXD refused these for another reason than expected:\n${otherwise.join("\n")}`);
    cleanup.splice(0, tried);
  });

  await step("release them all, with their networks", async () => {
    for (const workspaceId of workspaces) for (const name of ["box-1", "box-2"]) await leases.release(workspaceId, name);
    cleanup.splice(0, machineCleanup.length);
    assert.equal(await lxc("list", "--project", project, on(), "-c", "n", "-f", "csv"), "");
    assert.equal(await lxc("network", "list", on(), "--project", project, "-f", "csv"), "");
  });

  await lxd.removeOwnCertificate();
  cleanup.shift();
  for (const args of cleanup) await lxc(...args);
  await rm(directory, { recursive: true, force: true });
  console.log("passed");
} catch (error) {
  console.error(error);
  console.error(`\nFAILED. Kept for diagnosis in ${directory}; clean up with:\n${cleanup.map(args => `  lxc ${args.join(" ")}`).join("\n")}`);
  process.exit(1);
}
