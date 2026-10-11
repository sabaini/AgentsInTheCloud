import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LxdRequestError } from "../src/lxd/index.ts";
import { createMachineLeases, machineInstanceName, type MachineLeaseDependencies, type MachineSettings } from "../src/server/leases.ts";
import { machineNetworkAcl, machineNetworkAclRules, workspaceNetworkConfig, workspaceNetworkName } from "../src/server/sandbox.ts";
import { clientProfile as client, FakeLxd, nodeProfile as node } from "./fake-lxd.ts";

let directory: string;
let lxd: FakeLxd;
let connected: boolean;
let settings: MachineSettings;

function dependencies(overrides: Partial<MachineLeaseDependencies> = {}): MachineLeaseDependencies {
  return {
    lxd: async () => connected ? lxd : undefined,
    machineSettings: async () => settings,
    publicKey: async (workspaceId) => `ssh-ed25519 AAAAworkspace agents-in-the-cloud workspace ${workspaceId}`,
    reachesMachines: async () => true,
    directory: (workspaceId) => join(directory, workspaceId),
    bootTimeoutMs: 5_000,
    pollMs: 1,
    changed: async () => undefined,
    ...overrides,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "machines-leases-"));
  lxd = new FakeLxd();
  connected = true;
  settings = { profiles: [node, client], maxMachines: 3 };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("a machine gets its disks in its root disk's pool, the workspace key, and waits out a booting agent", async () => {
  const leases = createMachineLeases(dependencies());
  const machine = await leases.acquire("w1", { profile: "node" }, 5_000);
  expect(machine).toMatchObject({ name: "node-1", profile: "node", type: "virtual-machine", state: "ready", diskSizesGiB: [20, 20, 20], snapshots: [] });

  const instance = lxd.instancesByName.get(machineInstanceName("w1", "node-1"))!;
  expect([...lxd.volumes.keys()]).toEqual([1, 2, 3].map((n) => `fast/${instance.name}-disk${n}`));
  expect(instance.post).toMatchObject({
    type: "virtual-machine",
    source: { alias: "24.04", server: "https://cloud-images.ubuntu.com/releases", protocol: "simplestreams" },
    profiles: ["default", "ceph-node"],
    devices: { disk1: { type: "disk", pool: "fast", source: `${instance.name}-disk1` } },
    config: { "user.aitc.workspace": "w1", "user.aitc.lease": "node-1", "migration.stateful": "false" },
  });
  expect(instance.config["cloud-init.vendor-data"]).toBe('#cloud-config\nhostname: "node-1"\nmanage_etc_hosts: true\nssh_authorized_keys:\n  - "ssh-ed25519 AAAAworkspace agents-in-the-cloud workspace w1"\n');
  const stored = JSON.parse(await readFile(join(directory, "w1", "leases.json"), "utf8"));
  expect(stored.leases[0]).toMatchObject({ status: "ready", hostKeys: ["ssh-ed25519 AAAAhost"] });

  expect((await leases.acquire("w1", { profile: "client", name: "probe" }, 5_000)).name).toBe("probe");
  expect(lxd.instancesByName.get(machineInstanceName("w1", "probe"))!.config).not.toHaveProperty(["migration.stateful"]);
  expect((await leases.acquire("w1", { profile: "node" }, 5_000)).name).toBe("node-2");
  expect((await leases.acquire("w2", { profile: "node" }, 5_000)).name).toBe("node-1");
});

test("each workspace's machines share a network of their own, behind one ACL, until the last of them goes", async () => {
  const leases = createMachineLeases(dependencies());
  const node = await leases.acquire("w1", { profile: "node" }, 5_000);
  await leases.acquire("w1", { profile: "client" }, 5_000);
  await leases.acquire("w2", { profile: "client" }, 5_000);
  const network = workspaceNetworkName("w1");
  for (const name of ["node-1", "client-1"]) expect(lxd.instancesByName.get(machineInstanceName("w1", name))!.devices.eth0).toEqual({ type: "nic", name: "eth0", network });
  expect(lxd.networks).toEqual(new Map([[network, workspaceNetworkConfig("UPLINK")], [workspaceNetworkName("w2"), workspaceNetworkConfig("UPLINK")]]));
  expect(lxd.acls.get(machineNetworkAcl)).toEqual({ egress: machineNetworkAclRules().egress, ingress: machineNetworkAclRules().ingress });
  // The others know it by its instance name, not by its hostname.
  expect(node.dnsName).toBe(`${machineInstanceName("w1", "node-1")}.lxd`);

  await leases.release("w1", "node-1");
  expect(lxd.networks.has(network)).toBe(true);
  await leases.release("w1", "client-1");
  expect(lxd.networks.has(network)).toBe(false);
  await leases.acquire("w1", { profile: "client" }, 5_000);
  expect(lxd.networks.has(network)).toBe(true);

  // A machine AgentsInTheCloud lost track of keeps it.
  await lxd.createInstance({ name: "left-behind", type: "container", source: { type: "image", alias: "24.04" }, devices: { eth0: { type: "nic", network } } });
  await leases.release("w1", "client-1");
  expect(await leases.stored("w1")).toEqual([]);
  expect(lxd.networks.has(network)).toBe(true);
});

test("the ACL, and what keeps the workspace's network sandboxed, are put back before each new machine", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "client" }, 5_000);
  const rules = lxd.acls.get(machineNetworkAcl);
  lxd.log = [];
  await leases.acquire("w2", { profile: "client" }, 5_000);
  await leases.acquire("w1", { profile: "client" }, 5_000);
  expect(lxd.log.filter((entry) => entry.startsWith("update "))).toEqual([]);

  lxd.acls.set(machineNetworkAcl, { egress: [{ action: "allow", destination: "0.0.0.0/0", state: "enabled" }], ingress: [] });
  const network = workspaceNetworkName("w1");
  const { "security.acls": _, ...unfiltered } = lxd.networks.get(network)!;
  lxd.networks.set(network, { ...unfiltered, "security.acls.default.egress.action": "allow", "ipv4.nat": "true" });
  await leases.acquire("w1", { profile: "client" }, 5_000);
  expect(lxd.acls.get(machineNetworkAcl)).toEqual(rules!);
  // Its other settings stay.
  expect(lxd.networks.get(network)).toEqual({ ...workspaceNetworkConfig("UPLINK"), "ipv4.nat": "true" });
});

test("a machine profile whose LXD profiles add a network device is refused, as it would get past the workspace's network", async () => {
  const leases = createMachineLeases(dependencies());
  lxd.profiles.set("bridged", { eth1: { type: "nic", network: workspaceNetworkName("w2") } });
  settings.profiles.push({ ...client, name: "bridged", lxdProfiles: ["default", "bridged"] });
  await expect(leases.acquire("w1", { profile: "bridged" }, 5_000)).rejects.toThrow("The LXD profile bridged gives machines another network device, eth1");
  expect([lxd.instancesByName.size, lxd.networks.size]).toEqual([0, 0]);
  // One a later profile takes away again is fine, as is the default profile's eth0, which the machine's own replaces.
  lxd.profiles.set("unbridged", { eth1: { type: "none" } });
  settings.profiles.push({ ...client, name: "unbridged", lxdProfiles: ["default", "bridged", "unbridged"] });
  expect((await leases.acquire("w1", { profile: "unbridged" }, 5_000)).state).toBe("ready");
});

test("requests that can't be met are refused before anything is created", async () => {
  const leases = createMachineLeases(dependencies());
  const sandboxed = lxd.projectSettings;
  lxd.projectSettings = { ...sandboxed, "restricted.devices.proxy": "allow" };
  await expect(leases.acquire("w1", { profile: "node" }, 5_000)).rejects.toThrow("The LXD project agents-in-the-cloud isn't set up to keep machines apart from the rest of the network");
  expect([lxd.networks.size, lxd.acls.size]).toEqual([0, 0]);
  lxd.projectSettings = sandboxed;
  lxd.version = "6.8";
  await expect(leases.acquire("w1", { profile: "node" }, 5_000)).rejects.toThrow("The LXD server runs LXD 6.8, and machines need LXD 6.9 or later");
  lxd.version = "6.9";
  const cephNode = lxd.profiles.get("ceph-node")!;
  lxd.profiles.delete("ceph-node");
  await expect(leases.acquire("w1", { profile: "node" }, 5_000)).rejects.toThrow("The LXD server has no profile called ceph-node. Create it there, or change the machine profile in the template's settings.");
  lxd.profiles.set("ceph-node", cephNode);
  await expect(leases.acquire("w1", { profile: "osd" }, 5_000)).rejects.toThrow("no machine profile called osd. This workspace can use node, client");
  await expect(leases.acquire("w1", { profile: "node", name: "Node 1" }, 5_000)).rejects.toThrow("lowercase letters");
  await expect(createMachineLeases(dependencies({ reachesMachines: async () => false })).acquire("w1", { profile: "node" }, 5_000)).rejects.toThrow("older than machines");
  connected = false;
  await expect(leases.acquire("w1", { profile: "node" }, 5_000)).rejects.toThrow("No LXD server is connected");
  connected = true;
  settings = { profiles: [], maxMachines: 3 };
  await expect(leases.acquire("w1", { profile: "node" }, 5_000)).rejects.toThrow("no machine profiles yet");
  expect(await leases.list("w1")).toEqual([]);

  settings = { profiles: [client], maxMachines: 1 };
  await leases.acquire("w1", { profile: "client", name: "only" }, 5_000);
  await expect(leases.acquire("w1", { profile: "client" }, 5_000)).rejects.toThrow("already has 1 of its 1 machines");
  settings.maxMachines = 2;
  await expect(leases.acquire("w1", { profile: "client", name: "only" }, 5_000)).rejects.toThrow("already has a machine called only");
  expect(lxd.instancesByName.size).toBe(1);
});

test("a slow boot returns early and can be waited for", async () => {
  lxd.probesUntilBooted = 40;
  const leases = createMachineLeases(dependencies({ pollMs: 5 }));
  expect((await leases.acquire("w1", { profile: "client" }, 20)).state).toBe("starting");
  expect((await leases.waitFor("w1", "client-1", 5_000)).state).toBe("ready");
});

test("failures are kept on the machine, and releasing it cleans up what was made", async () => {
  lxd.failCreate = "Failed getting remote image info: Image not found";
  const leases = createMachineLeases(dependencies());
  const machine = await leases.acquire("w1", { profile: "node" }, 5_000);
  expect(machine).toMatchObject({ state: "failed", error: expect.stringContaining("Image not found") });
  expect(lxd.volumes.size).toBe(3);
  await leases.release("w1", "node-1");
  expect(lxd.volumes.size).toBe(0);
  expect(await leases.list("w1")).toEqual([]);

  lxd.failCreate = undefined;
  lxd.hostKeys = new Map();
  expect((await leases.acquire("w1", { profile: "client" }, 5_000)).error).toContain("needs openssh-server");
  lxd.probesUntilBooted = Number.POSITIVE_INFINITY;
  const timing = createMachineLeases(dependencies({ bootTimeoutMs: 30 }));
  expect((await timing.acquire("w2", { profile: "client" }, 5_000)).error).toContain("didn't finish booting");
});

test("releasing a booting machine stops waiting for it and deletes it with its disks", async () => {
  lxd.probesUntilBooted = Number.POSITIVE_INFINITY;
  const leases = createMachineLeases(dependencies());
  expect((await leases.acquire("w1", { profile: "node" }, 10)).state).toBe("starting");
  await leases.release("w1", "node-1");
  expect(lxd.instancesByName.size).toBe(0);
  expect(lxd.volumes.size).toBe(0);
  expect(await leases.list("w1")).toEqual([]);
  await expect(leases.release("w1", "node-1")).rejects.toThrow("no machine called node-1");
});

test("after a restart, machines that were booting carry on and ones never created are marked failed", async () => {
  const lease = (name: string, status: string) => ({ name, location: lxd.location, instance: machineInstanceName("w1", name), profile: { name: "client", image: "ubuntu:24.04", type: "container", lxdProfiles: ["default"], diskSizesGiB: [] }, volumes: [], createdAt: 0, expiresAt: Date.now() + 3_600_000, status, hostKeys: [] });
  await mkdir(join(directory, "w1"), { recursive: true });
  await writeFile(join(directory, "w1", "leases.json"), JSON.stringify({ leases: [lease("booting", "starting"), lease("lost", "creating")] }));
  await lxd.createInstance({ name: machineInstanceName("w1", "booting"), type: "container", source: { type: "image", alias: "24.04" } });

  const leases = createMachineLeases(dependencies());
  expect((await leases.waitFor("w1", "booting", 5_000)).state).toBe("ready");
  expect(await leases.waitFor("w1", "lost", 5_000)).toMatchObject({ state: "failed", error: expect.stringContaining("restarted before this machine was created") });
});

test("snapshots restore a machine and wait for it to come back", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "node" }, 5_000);
  await expect(leases.snapshot("w1", ["node-1"], "clean slate", 5_000)).rejects.toThrow("Snapshot names");
  expect(await leases.snapshot("w1", ["node-1"], "clean", 5_000)).toMatchObject([{ state: "ready", snapshots: ["clean"] }]);
  const instance = lxd.instancesByName.get(machineInstanceName("w1", "node-1"))!;
  instance.status = "Stopped";
  expect((await leases.list("w1"))[0]!.state).toBe("stopped");
  // Booting again, it still has its snapshots.
  expect(await leases.restore("w1", ["node-1"], "clean", 0)).toMatchObject([{ state: "starting", snapshots: ["clean"] }]);
  expect(await leases.waitFor("w1", "node-1", 5_000)).toMatchObject({ state: "ready", snapshots: ["clean"] });
  expect(instance.status).toBe("Running");
  await expect(leases.restore("w1", ["node-1"], "missing", 5_000)).rejects.toThrow("node-1 has no snapshot called missing");
  expect(instance.status).toBe("Running");
});

test("a snapshot has the machine's extra disks too, saved while it's shut down, and restoring rolls them back with it", async () => {
  const instance = machineInstanceName("w1", "node-1");
  let shown: string[] = [];
  const leases = createMachineLeases(dependencies({ changed: async () => { shown.push(...(await leases.list("w1")).map((machine) => machine.state)); } }));
  await leases.acquire("w1", { profile: "node" }, 5_000);
  const disks = [1, 2, 3].map((n) => `${instance}-disk${n}`);
  shown = [];
  lxd.log = [];
  expect((await leases.snapshot("w1", ["node-1"], "clean", 5_000))[0]!.state).toBe("ready");
  expect(lxd.log).toEqual([`stop ${instance}`, ...disks.map((disk) => `snapshot ${disk} clean while Stopped`), `snapshot ${instance} clean while Stopped`, `start ${instance}`]);
  // The Machines view shows it shut down for the snapshot, then booting and ready again.
  expect(shown).toEqual(["saving", "starting", "ready"]);

  lxd.log = [];
  expect((await leases.restore("w1", ["node-1"], "clean", 5_000))[0]!.state).toBe("ready");
  expect(lxd.log).toEqual([`stop ${instance}`, ...disks.map((disk) => `restore ${disk} clean while Stopped`), `restore ${instance} clean while Stopped`, `start ${instance}`]);
  expect(lxd.instancesByName.get(instance)!.status).toBe("Running");

  // Releasing takes the disks' snapshots along with them.
  await leases.release("w1", "node-1");
  expect(lxd.volumeSnapshots.size).toBe(0);
});

test("machines snapshotted together shut down together, and restored together all stop before any is restored", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "client", name: "a" }, 5_000);
  await leases.acquire("w1", { profile: "client", name: "b" }, 5_000);
  const [a, b] = ["a", "b"].map((name) => machineInstanceName("w1", name));
  lxd.log = [];
  expect((await leases.snapshot("w1", ["a", "b"], "formed", 5_000)).map((machine) => [machine.state, machine.snapshots])).toEqual([["ready", ["formed"]], ["ready", ["formed"]]]);
  expect(lxd.log).toEqual([`stop ${a}`, `stop ${b}`, `snapshot ${a} formed while Stopped`, `snapshot ${b} formed while Stopped`, `start ${a}`, `start ${b}`]);
  await expect(leases.snapshot("w1", ["a", "b"], "formed", 5_000)).rejects.toThrow("a already has a snapshot called formed");
  await expect(leases.snapshot("w1", ["a", "a"], "again", 5_000)).rejects.toThrow("Name each machine once");

  lxd.log = [];
  expect((await leases.restore("w1", ["a", "b"], "formed", 5_000)).map((machine) => machine.state)).toEqual(["ready", "ready"]);
  expect(lxd.log).toEqual([`stop ${a}`, `stop ${b}`, `restore ${a} formed while Stopped`, `restore ${b} formed while Stopped`, `start ${a}`, `start ${b}`]);

  // One that's stopped already, say since its workspace was parked, is saved as it is and stays stopped.
  await leases.stopAll("w1");
  lxd.log = [];
  expect((await leases.snapshot("w1", ["a"], "alone", 5_000))[0]!.state).toBe("stopped");
  expect(lxd.log).toEqual([`snapshot ${a} alone while Stopped`]);
  // All of them need the snapshot before any is touched.
  lxd.log = [];
  await expect(leases.restore("w1", ["a", "b"], "alone", 5_000)).rejects.toThrow("b has no snapshot called alone");
  expect(lxd.log).toEqual([]);
});

test("a machine whose restore doesn't finish stays stopped until one does", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "node" }, 5_000);
  await leases.snapshot("w1", ["node-1"], "clean", 5_000);
  const restoreVolume = lxd.restoreVolumeSnapshot.bind(lxd);
  lxd.restoreVolumeSnapshot = async (pool, volume, snapshot) => {
    if (volume.endsWith("-disk2")) throw new LxdRequestError(500, "No space left on device");
    await restoreVolume(pool, volume, snapshot);
  };
  await expect(leases.restore("w1", ["node-1"], "clean", 5_000)).rejects.toThrow("No space left on device");
  expect(await leases.list("w1")).toMatchObject([{ state: "interrupted", error: "No space left on device" }]);
  // Neither ssh nor list_machines starts it with its first disk restored and the others not.
  await leases.usable("w1", "node-1", 5_000);
  await leases.wake("w1");
  expect(lxd.instancesByName.get(machineInstanceName("w1", "node-1"))!.status).toBe("Stopped");
  await expect(leases.snapshot("w1", ["node-1"], "later", 5_000)).rejects.toThrow("isn't ready");

  // Nor after AgentsInTheCloud restarts in the middle of a restore.
  lxd.restoreVolumeSnapshot = () => new Promise(() => {});
  void leases.restore("w1", ["node-1"], "clean", 5_000);
  // Until the restore is recorded, which clears the last one's error, a restart would find only the last one.
  while (JSON.parse(await readFile(join(directory, "w1", "leases.json"), "utf8")).leases[0].error) await Bun.sleep(1);
  const restarted = createMachineLeases(dependencies());
  expect(await restarted.list("w1")).toMatchObject([{ state: "interrupted", error: "AgentsInTheCloud restarted before it finished" }]);
  lxd.restoreVolumeSnapshot = restoreVolume;
  expect((await restarted.restore("w1", ["node-1"], "clean", 5_000))[0]!.state).toBe("ready");
});

test("a machine shut down for a snapshot starts again when the snapshot fails", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "node" }, 5_000);
  lxd.createSnapshot = async () => { throw new LxdRequestError(500, "No space left on device"); };
  await expect(leases.snapshot("w1", ["node-1"], "clean", 5_000)).rejects.toThrow("No space left on device");
  // It's watched while it boots, so ssh waits for it without anything listing it first.
  await leases.usable("w1", "node-1", 5_000);
  expect(await leases.stored("w1")).toMatchObject([{ status: "ready" }]);
  expect((await leases.list("w1"))[0]).toMatchObject({ state: "ready", snapshots: [] });
});

test("when one machine doesn't shut down for a snapshot, the others start again once they have", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "client", name: "a" }, 5_000);
  await leases.acquire("w1", { profile: "client", name: "b" }, 5_000);
  const [a, b] = ["a", "b"].map((name) => machineInstanceName("w1", name));
  const setState = lxd.setInstanceState.bind(lxd);
  let stopB: (() => void) | undefined;
  lxd.setInstanceState = async (name, action) => {
    if (action === "stop" && name === a) throw new LxdRequestError(500, "Failed to stop");
    if (action === "stop" && name === b) await new Promise<void>((resolve) => { stopB = resolve; });
    await setState(name, action);
  };
  const snapshotting = leases.snapshot("w1", ["a", "b"], "formed", 5_000);
  while (!stopB) await Bun.sleep(1);
  await Bun.sleep(20);
  stopB();
  await expect(snapshotting).rejects.toThrow("Failed to stop");
  expect([a, b].map((name) => lxd.instancesByName.get(name)!.status)).toEqual(["Running", "Running"]);
  await leases.usable("w1", "b", 5_000);
  expect((await leases.list("w1")).map((machine) => [machine.state, machine.snapshots])).toEqual([["ready", []], ["ready", []]]);
});

test("parking stops ready machines, and their next use starts them again", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "node" }, 5_000);
  lxd.probesUntilBooted = Number.POSITIVE_INFINITY;
  await leases.acquire("w1", { profile: "client", name: "booting" }, 10);
  await leases.stopAll("w1");
  expect((await leases.list("w1")).map((machine) => [machine.name, machine.state])).toEqual([["node-1", "stopped"], ["booting", "starting"]]);

  const node = lxd.instancesByName.get(machineInstanceName("w1", "node-1"))!;
  node.probesUntilBooted = 2;
  node.cloudInitReadsLeft = 3;
  await leases.usable("w1", "node-1", 5_000);
  expect(node.status).toBe("Running");
  expect(node.cloudInitReadsLeft).toBe(0);
  expect((await leases.list("w1"))[0]!.state).toBe("ready");

  node.status = "Stopped";
  node.probesUntilBooted = Number.POSITIVE_INFINITY;
  await leases.wake("w1");
  expect((await leases.list("w1"))[0]!.state).toBe("starting");
  await leases.release("w1", "node-1");
  await leases.release("w1", "booting");
});

test("expired machines are released, and deleting a workspace releases all of them", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "node" }, 5_000);
  await leases.acquire("w1", { profile: "client" }, 5_000);
  const clientLifetimeEnds = Date.now() + client.lifetimeHours * 3_600_000;
  expect(await leases.expire("w1", clientLifetimeEnds - 60_000)).toEqual([]);
  expect(await leases.expire("w1", clientLifetimeEnds + 60_000)).toEqual(["node-1", "client-1"]);
  expect(lxd.instancesByName.size).toBe(0);
  expect(lxd.volumes.size).toBe(0);

  await leases.acquire("w2", { profile: "node" }, 5_000);
  await leases.acquire("w2", { profile: "client" }, 5_000);
  expect(await leases.releaseAll("w2")).toEqual([]);
  expect(await leases.stored("w2")).toEqual([]);
  expect(lxd.instancesByName.size).toBe(0);
});

test("expiry releases only machines still expired, not one made again under the same name meanwhile", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "client", name: "old" }, 5_000);
  await leases.acquire("w1", { profile: "client", name: "reused" }, 5_000);
  const deleting = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const deleteInstance = lxd.deleteInstance.bind(lxd);
  lxd.deleteInstance = async (name) => {
    deleting.resolve();
    await proceed.promise;
    await deleteInstance(name);
  };
  const sweep = leases.expire("w1", Date.now() + client.lifetimeHours * 3_600_000 + 60_000);
  await deleting.promise;
  // While the sweep deletes the first, an Agent releases the second and makes a new one with its name.
  const remade = leases.release("w1", "reused").catch(() => undefined).then(() => leases.acquire("w1", { profile: "client", name: "reused" }, 5_000));
  proceed.resolve();
  expect(await sweep).toEqual(["old", "reused"]);
  expect((await remade).state).toBe("ready");
  expect((await leases.list("w1")).map((machine) => [machine.name, machine.state])).toEqual([["reused", "ready"]]);
  lxd.deleteInstance = deleteInstance;

  // One that's booting waits for the next sweep.
  lxd.probesUntilBooted = Number.POSITIVE_INFINITY;
  await leases.acquire("w1", { profile: "client", name: "booting" }, 10);
  expect(await leases.expire("w1", Number.POSITIVE_INFINITY)).toEqual(["reused"]);
  await leases.release("w1", "booting");
});

test("a workspace being deleted gets no new machines, and ones already being acquired are released too", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "client", name: "first" }, 5_000);
  const deleting = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const deleteInstance = lxd.deleteInstance.bind(lxd);
  lxd.deleteInstance = async (name) => {
    deleting.resolve();
    await proceed.promise;
    await deleteInstance(name);
  };
  const releasing = leases.releaseAll("w1");
  await deleting.promise;
  const late = leases.acquire("w1", { profile: "client", name: "late" }, 5_000);
  proceed.resolve();
  expect(await releasing).toEqual([]);
  await expect(late).rejects.toThrow("being deleted");
  expect(lxd.instancesByName.size).toBe(0);
  expect(await leases.stored("w1")).toEqual([]);

  // A deletion that fails leaves the workspace as it was.
  lxd.deleteInstance = deleteInstance;
  await leases.acquire("w2", { profile: "client" }, 5_000);
  lxd.deleteInstance = async () => { throw new Error("LXD is busy"); };
  await expect(leases.releaseAll("w2")).rejects.toThrow("LXD is busy");
  lxd.deleteInstance = deleteInstance;
  expect((await leases.acquire("w2", { profile: "client" }, 5_000)).name).toBe("client-2");
});

test("machines stay with the LXD server they're on: with another connected, they're out of reach and kept", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "node" }, 5_000);
  const original = lxd;
  lxd = new FakeLxd({ address: "other.test:8443", fingerprint: "b2", project: "agents-in-the-cloud" });
  await leases.acquire("w1", { profile: "client" }, 5_000);

  expect((await leases.list("w1")).map((machine) => [machine.name, machine.state])).toEqual([["node-1", "disconnected"], ["client-1", "ready"]]);
  const elsewhere = "node-1 is on the LXD server at lxd.test:8443, in project agents-in-the-cloud, which isn't connected now";
  await expect(leases.release("w1", "node-1")).rejects.toThrow(elsewhere);
  await expect(leases.snapshot("w1", ["node-1"], "clean", 5_000)).rejects.toThrow(elsewhere);
  await expect(leases.usable("w1", "node-1", 5_000)).rejects.toThrow(elsewhere);
  expect(await leases.expire("w1", Number.POSITIVE_INFINITY)).toEqual(["client-1"]);
  expect((await leases.stored("w1")).map((lease) => lease.name)).toEqual(["node-1"]);
  expect(original.instancesByName.size).toBe(1);

  // The same server keeps its certificate at a new address.
  lxd = new FakeLxd({ ...original.location, address: "10.0.0.9:8443" });
  lxd.instancesByName = original.instancesByName;
  lxd.volumes = original.volumes;
  expect((await leases.list("w1"))[0]!.state).toBe("ready");

  // Deleting the workspace releases what's on the connected server and leaves the rest where it is.
  await leases.acquire("w1", { profile: "client" }, 5_000);
  lxd = new FakeLxd({ ...original.location, project: "elsewhere" });
  await leases.acquire("w1", { profile: "client", name: "here" }, 5_000);
  expect(await leases.releaseAll("w1")).toEqual(["node-1", "client-1"]);
  expect(lxd.instancesByName.size).toBe(0);
  expect(original.instancesByName.size).toBe(2);
});
