/** Lease real machines on a real LXD server with OVN through a fresh sandboxed project and restricted certificate:
 * a VM with extra disks reached with `ssh node-1` through its tunnel and the workspace key, snapshotted
 * and restored with its disks, and a container that the VM reaches by name on their workspace's network, and that is
 * snapshotted and restored too, alone and together with the VM.
 * Needs `lxc` with admin access to the server. `--uplink` is its OVN uplink network.
 * Cleans up on success and keeps everything on failure for diagnosis.
 *
 *   bun run test:machines [--remote <lxc-remote>] [--uplink UPLINK] [--image <ubuntu-release>]
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { WorkspaceTemplateMachineProfile } from "@agents-in-the-cloud/workspace-templates";
import { certificateFingerprint, createLxdClientCredentials, joinLxdServer, LxdClient, LxdRequestError } from "../src/lxd/index.ts";
import { createMachineLeases, machineInstanceName } from "../src/server/leases.ts";
import { machineNetworkAcl, workspaceNetworkName } from "../src/server/sandbox.ts";
import { createMachineTunnels } from "../src/server/tunnels.ts";

const project = `aitc-it-${randomUUID().slice(0, 8)}`;
// Instance names come from it, and LXD wants their DNS names unique on the network across projects, kept failed runs included.
const workspaceId = project;
const { values: options } = parseArgs({ options: { remote: { type: "string" }, uplink: { type: "string", default: "UPLINK" }, image: { type: "string", default: "24.04" } } });
const on = (name = "") => options.remote ? `${options.remote}:${name}` : name;
const cleanup: string[][] = [];
const directory = await mkdtemp(join(tmpdir(), "machines-leases-it-"));

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

const profile = (values: Partial<WorkspaceTemplateMachineProfile>): WorkspaceTemplateMachineProfile => ({ id: randomUUID(), workspaceTemplateId: "t", name: "node", image: `ubuntu:${options.image}`, type: "virtual-machine", lxdProfiles: ["default"], cpus: 1, memoryGiB: 1, diskSizesGiB: [], lifetimeHours: 1, createdAt: "", updatedAt: "", ...values });

try {
  // The extra disks go where the root disk does: "default" on a plain LXD, "local" on MicroCloud.
  const pool = await lxc("profile", "device", "get", on("default"), "root", "pool");
  // As the connect form suggests.
  await lxc("project", "create", on(project), "-c", "features.profiles=true", "-c", "features.networks=true", "-c", "restricted=true", "-c", "restricted.snapshots=allow", "-c", `restricted.networks.uplinks=${options.uplink}`);
  cleanup.unshift(["project", "delete", on(project)]);
  await lxc("profile", "device", "add", on("default"), "root", "disk", "path=/", `pool=${pool}`, "--project", project);
  // AgentsInTheCloud keeps the ACL for the next machine.
  cleanup.unshift(["network", "acl", "delete", on(machineNetworkAcl), "--project", project]);
  const token = (await lxc("config", "trust", "add", ...(options.remote ? [on()] : []), "--name", project, "--restricted", "--projects", project)).split("\n").at(-1)!;
  const credentials = await createLxdClientCredentials(project);
  const { server } = await joinLxdServer(token, credentials);
  cleanup.unshift(["config", "trust", "remove", on(certificateFingerprint(credentials.certificate))]);
  const lxd = new LxdClient({ server, credentials, project });
  const keyPath = join(directory, "id_ed25519");
  await command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "aitc integration", "-f", keyPath);

  // On this host, the workspace's SSH directory and the one its container would see are the same.
  const sshDirectory = join(directory, "ssh");
  const tunnels = createMachineTunnels({ usable: (workspace, name) => leases.usable(workspace, name, 10 * 60_000), hostDirectory: () => sshDirectory, containerDirectory: sshDirectory });
  const leases = createMachineLeases({
    lxd: async () => lxd,
    machineSettings: async () => ({ profiles: [profile({ name: "node", cpus: 2, memoryGiB: 2, diskSizesGiB: [2, 3] }), profile({ name: "probe", type: "container" })], maxMachines: 2 }),
    publicKey: async () => (await readFile(`${keyPath}.pub`, "utf8")).trim(),
    reachesMachines: async () => true,
    directory: () => directory,
    bootTimeoutMs: 10 * 60_000,
    pollMs: 2_000,
    changed: tunnels.sync,
  });
  const ssh = async (input: Buffer<ArrayBuffer> | undefined, ...args: string[]) => {
    // A connection that never gets anywhere fails the test instead of stalling it.
    const child = Bun.spawn(["timeout", "600", "ssh", "-F", join(sshDirectory, "ssh_config.d", "machines.conf"), "-i", keyPath, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "node-1", ...args], { stdin: input ? new Blob([input]) : "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, stderr);
    return stdout.trim();
  };
  const nodeInstance = machineInstanceName(workspaceId, "node-1");
  const probeInstance = machineInstanceName(workspaceId, "probe-1");
  const network = workspaceNetworkName(workspaceId);
  cleanup.unshift(
    ["delete", "--force", "--project", project, on(nodeInstance)],
    ["delete", "--force", "--project", project, on(probeInstance)],
    ...[1, 2].map((disk) => ["storage", "volume", "delete", on(pool), `${nodeInstance}-disk${disk}`, "--project", project]),
    ["network", "delete", on(network), "--project", project],
  );

  const run = async (shell: string) => {
    const result = await lxd.run(nodeInstance, ["sh", "-c", shell]);
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.toString().trim();
  };
  const node = await step(`acquire a VM from ubuntu:${options.image} with 2 CPUs, 2 GiB of memory and 2 and 3 GiB disks, on its workspace's own network`, () => leases.acquire(workspaceId, { profile: "node" }, 10 * 60_000));
  assert.equal(node.state, "ready", JSON.stringify(node));
  assert.equal((await lxd.network(network)).config["security.acls"], machineNetworkAcl);
  await step("its CPUs, memory, disks, hostname and authorized key are in place", async () => {
    assert.equal(await run("nproc"), "2");
    // The kernel keeps some of it for itself.
    const memoryKiB = Number(await run("awk '/MemTotal/{print $2}' /proc/meminfo"));
    assert(memoryKiB > 1.5 * 1024 ** 2 && memoryKiB <= 2 * 1024 ** 2, `MemTotal is ${memoryKiB} kB`);
    assert.deepEqual((await run("lsblk -dn -b -o SIZE,TYPE -e7 | awk '$2==\"disk\"{print $1}' | sort -n")).split("\n").map(Number).slice(0, 2), [2 * 1024 ** 3, 3 * 1024 ** 3]);
    assert.equal(await run("hostname"), "node-1");
    assert((await run("cat /home/ubuntu/.ssh/authorized_keys")).includes("aitc integration"));
  });
  await step("ssh node-1 goes through its tunnel as ubuntu, with passwordless sudo and the recorded host key", async () => {
    assert.equal(await ssh(undefined, "sudo", "-n", "whoami"), "root");
    const payload = Buffer.alloc(8 * 1024 * 1024, "machines tunnel\n");
    assert.equal((await ssh(payload, "sha256sum")).split(" ")[0], new Bun.CryptoHasher("sha256").update(payload).digest("hex"));
  });

  await step("parking stops the VM, and the next ssh starts it again", async () => {
    await leases.stopAll(workspaceId);
    assert.equal((await lxd.instance(nodeInstance)).status, "Stopped");
    assert.equal((await leases.list(workspaceId))[0]!.state, "stopped");
    assert.equal(await ssh(undefined, "hostname"), "node-1");
    assert.equal((await leases.list(workspaceId))[0]!.state, "ready");
  });

  await step("snapshot, change and restore the VM, its extra disks included", async () => {
    const mark = (text: string) => run(`echo ${text} > /root/mark && printf ${text} | dd of=/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_lxd_disk1 conv=fsync status=none`);
    await mark("before");
    assert.deepEqual((await leases.snapshot(workspaceId, ["node-1"], "clean", 10 * 60_000))[0]!.snapshots, ["clean"]);
    assert.equal((await lxd.instance(nodeInstance)).status, "Running");
    await mark("after-");
    const [restored] = await leases.restore(workspaceId, ["node-1"], "clean", 10 * 60_000);
    assert.equal(restored!.state, "ready", JSON.stringify(restored));
    assert.equal(await run("cat /root/mark; head -c 6 /dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_lxd_disk1"), "before\nbefore");
    assert.equal(await ssh(undefined, "hostname"), "node-1");
  });

  const probe = await step("acquire a container, which the VM reaches by name", () => leases.acquire(workspaceId, { profile: "probe" }, 10 * 60_000));
  assert.equal(probe.state, "ready", JSON.stringify(probe));
  await run(`timeout 10 bash -c '</dev/tcp/${probe.dnsName}/22'`);
  await assert.rejects(leases.acquire(workspaceId, { profile: "probe" }, 1_000), /already has 2 of its 2 machines/);
  await step("snapshot, change, restore the container", async () => {
    await leases.snapshot(workspaceId, ["probe-1"], "clean", 5 * 60_000);
    assert.equal((await lxd.run(probeInstance, ["touch", "/root/experiment"])).exitCode, 0);
    const [restored] = await leases.restore(workspaceId, ["probe-1"], "clean", 5 * 60_000);
    assert.equal(restored!.state, "ready", JSON.stringify(restored));
    assert.deepEqual(restored!.snapshots, ["clean"]);
    assert.equal((await lxd.run(probeInstance, ["test", "-e", "/root/experiment"])).exitCode, 1);
  });

  await step("snapshot the VM and the container together, change both, and restore them together", async () => {
    await leases.snapshot(workspaceId, ["node-1", "probe-1"], "pair", 10 * 60_000);
    assert.deepEqual(await Promise.all([nodeInstance, probeInstance].map(async (instance) => (await lxd.instance(instance)).status)), ["Running", "Running"]);
    for (const instance of [nodeInstance, probeInstance]) assert.equal((await lxd.run(instance, ["touch", "/root/experiment"])).exitCode, 0);
    const restored = await leases.restore(workspaceId, ["node-1", "probe-1"], "pair", 10 * 60_000);
    assert.deepEqual(restored.map((machine) => machine.state), ["ready", "ready"], JSON.stringify(restored));
    for (const instance of [nodeInstance, probeInstance]) assert.equal((await lxd.run(instance, ["test", "-e", "/root/experiment"])).exitCode, 1);
  });

  await step("release both, with their disks and network", async () => {
    await leases.release(workspaceId, "node-1");
    await leases.release(workspaceId, "probe-1");
    cleanup.splice(0, 5);
    const gone = await lxd.network(network).then(() => undefined, (caught: Error) => caught);
    assert(gone instanceof LxdRequestError && gone.status === 404, `expected the network gone, got ${gone}`);
    assert.deepEqual(await leases.list(workspaceId), []);
    assert.equal(await lxc("list", "--project", project, on(), "-c", "n", "-f", "csv"), "");
    assert.equal(await lxc("storage", "volume", "list", on(pool), "--project", project, "type=custom", "-c", "n", "-f", "csv"), "");
    assert(!(await readFile(join(sshDirectory, "ssh_config.d", "machines.conf"), "utf8")).includes("Host node-1"));
    assert.deepEqual((await readdir(join(sshDirectory, "machines"))).filter((file) => file.endsWith(".sock")), []);
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
