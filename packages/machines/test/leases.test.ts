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
    lxds: async () => connected ? [lxd] : [],
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
    config: { "user.aitc.workspace": "w1", "user.aitc.lease": "node-1", "limits.cpu": "2", "limits.memory": "4GiB", "migration.stateful": "false" },
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

test("after a restart, machines that were booting carry on, ones LXD is still making are waited for, and ones never made are marked failed", async () => {
  const lease = (name: string, status: string) => ({ name, location: lxd.location, instance: machineInstanceName("w1", name), profile: { name: "client", image: "ubuntu:24.04", type: "container", lxdProfiles: ["default"], cpus: 1, memoryGiB: 1, diskSizesGiB: [] }, volumes: [], createdAt: 0, expiresAt: Date.now() + 3_600_000, status, hostKeys: [] });
  await mkdir(join(directory, "w1"), { recursive: true });
  await writeFile(join(directory, "w1", "leases.json"), JSON.stringify({ leases: [lease("booting", "starting"), lease("downloading", "creating"), lease("lost", "creating")] }));
  await lxd.createInstance({ name: machineInstanceName("w1", "booting"), type: "container", source: { type: "image", alias: "24.04" } });

  const leases = createMachineLeases(dependencies({ bootTimeoutMs: 300 }));
  expect((await leases.waitFor("w1", "booting", 5_000)).state).toBe("ready");
  // LXD lists an instance only once it has its image.
  expect((await leases.waitFor("w1", "downloading", 20)).state).toBe("creating");
  await lxd.createInstance({ name: machineInstanceName("w1", "downloading"), type: "container", source: { type: "image", alias: "24.04" } });
  expect((await leases.waitFor("w1", "downloading", 5_000)).state).toBe("ready");
  expect(await leases.waitFor("w1", "lost", 5_000)).toMatchObject({ state: "failed", error: expect.stringContaining("restarted before this machine was created") });
});

test("listing machines while one is made or released doesn't take it for one a restart interrupted", async () => {
  lxd.probesUntilBooted = Number.POSITIVE_INFINITY;
  const statuses = new Set<string>();
  // Like the Machines view, which lists them whenever they change.
  const leases = createMachineLeases(dependencies({
    changed: async (workspaceId, stored) => {
      for (const lease of stored) statuses.add(lease.status);
      await leases.list(workspaceId);
    },
  }));
  expect(await leases.acquire("w1", { profile: "client" }, 20)).toMatchObject({ state: "starting" });
  expect(statuses).toEqual(new Set(["creating", "starting"]));

  let probes = 0;
  const readInstanceFile = lxd.readInstanceFile.bind(lxd);
  lxd.readInstanceFile = async (name, path) => {
    probes++;
    return await readInstanceFile(name, path);
  };
  const deleteInstance = lxd.deleteInstance.bind(lxd);
  lxd.deleteInstance = async (name) => {
    await leases.list("w1");
    await deleteInstance(name);
  };
  await leases.release("w1", "client-1");
  const after = probes;
  await Bun.sleep(30);
  expect(probes).toBe(after);
});

test("with no LXD server connected, machines show as out of reach, and listing or parking them leaves them be", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "client" }, 5_000);
  connected = false;
  await leases.wake("w1");
  await leases.stopAll("w1");
  expect((await leases.list("w1")).map((machine) => machine.state)).toEqual(["disconnected"]);
  await expect(leases.release("w1", "client-1")).rejects.toThrow("No LXD server is connected");
  connected = true;
  expect(lxd.instancesByName.get(machineInstanceName("w1", "client-1"))!.status).toBe("Running");
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

test("when one machine doesn't start after a restore, the others are watched while they boot, and it stays stopped until its next use", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "client", name: "a" }, 5_000);
  await leases.acquire("w1", { profile: "client", name: "b" }, 5_000);
  await leases.snapshot("w1", ["a", "b"], "formed", 5_000);
  const [a, b] = ["a", "b"].map((name) => machineInstanceName("w1", name));
  const restoreSnapshot = lxd.restoreSnapshot.bind(lxd);
  lxd.restoreSnapshot = async (name, snapshot) => {
    await restoreSnapshot(name, snapshot);
    lxd.instancesByName.get(name)!.probesUntilBooted = Number.POSITIVE_INFINITY;
  };
  const setState = lxd.setInstanceState.bind(lxd);
  let startA: (() => void) | undefined;
  lxd.setInstanceState = async (name, action) => {
    if (action === "start" && name === b) throw new LxdRequestError(500, "Failed to start");
    if (action === "start" && name === a) await new Promise<void>((resolve) => { startA = resolve; });
    await setState(name, action);
  };
  let settled = false;
  const restoring = leases.restore("w1", ["a", "b"], "formed", 5_000);
  void restoring.catch(() => undefined).finally(() => { settled = true; });
  while (!startA) await Bun.sleep(1);
  await Bun.sleep(20);
  // Nothing else gets to the machines while one of them is still starting.
  expect(settled).toBe(false);
  startA();
  await expect(restoring).rejects.toThrow("Failed to start");
  expect((await leases.list("w1")).map((machine) => [machine.state, machine.error])).toEqual([["starting", undefined], ["stopped", undefined]]);

  lxd.setInstanceState = setState;
  for (const name of [a, b]) lxd.instancesByName.get(name)!.probesUntilBooted = 0;
  await leases.usable("w1", "a", 5_000);
  await leases.usable("w1", "b", 5_000);
  expect((await leases.list("w1")).map((machine) => machine.state)).toEqual(["ready", "ready"]);
});

test("when one machine doesn't wake, the ones that did are watched while they boot", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "client", name: "a" }, 5_000);
  await leases.acquire("w1", { profile: "client", name: "b" }, 5_000);
  await leases.stopAll("w1");
  const [a, b] = ["a", "b"].map((name) => machineInstanceName("w1", name));
  const setState = lxd.setInstanceState.bind(lxd);
  lxd.setInstanceState = async (name, action) => {
    if (action === "start" && name === b) throw new LxdRequestError(500, "Failed to start");
    await setState(name, action);
    lxd.instancesByName.get(name)!.probesUntilBooted = Number.POSITIVE_INFINITY;
  };
  await expect(leases.wake("w1")).rejects.toThrow("Failed to start");
  // Not ready before it has booted.
  expect((await leases.list("w1")).map((machine) => machine.state)).toEqual(["starting", "stopped"]);
  lxd.setInstanceState = setState;
  lxd.instancesByName.get(a)!.probesUntilBooted = 0;
  await leases.usable("w1", "a", 5_000);
  expect((await leases.list("w1")).map((machine) => machine.state)).toEqual(["ready", "stopped"]);
});

test("a machine used right after its workspace is parked waits for it to shut down, then starts again", async () => {
  const leases = createMachineLeases(dependencies());
  await leases.acquire("w1", { profile: "client" }, 5_000);
  const instance = lxd.instancesByName.get(machineInstanceName("w1", "client-1"))!;
  const setState = lxd.setInstanceState.bind(lxd);
  let stop: (() => void) | undefined;
  lxd.setInstanceState = async (name, action) => {
    if (action === "stop") await new Promise<void>((resolve) => { stop = resolve; });
    await setState(name, action);
  };
  const parking = leases.stopAll("w1");
  while (!stop) await Bun.sleep(1);
  // It's still running while it shuts down.
  const using = leases.usable("w1", "client-1", 5_000);
  await Bun.sleep(20);
  lxd.log = [];
  stop();
  await parking;
  await using;
  expect(lxd.log).toEqual([`stop ${instance.name}`, `start ${instance.name}`]);
  expect(instance.status).toBe("Running");
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

  // A deletion that fails, at this step or a later one, leaves the workspace as it was once it's reopened.
  lxd.deleteInstance = deleteInstance;
  await leases.acquire("w2", { profile: "client" }, 5_000);
  lxd.deleteInstance = async () => { throw new Error("LXD is busy"); };
  await expect(leases.releaseAll("w2")).rejects.toThrow("LXD is busy");
  lxd.deleteInstance = deleteInstance;
  await expect(leases.acquire("w2", { profile: "client" }, 5_000)).rejects.toThrow("being deleted");
  leases.reopen("w2");
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

test("a workspace's machines all go on one LXD server: the one with the fewest machines when it gets its first", async () => {
  const other = new FakeLxd({ address: "other.test:8443", fingerprint: "b2", project: "agents-in-the-cloud" });
  const leases = createMachineLeases(dependencies({ lxds: async () => [lxd, other] }));
  const server = async (workspaceId: string) => (await leases.acquire(workspaceId, { profile: "client" }, 5_000)).server;
  // A tie goes to the server connected first.
  expect(await server("w1")).toBe("lxd.test:8443");
  expect(await server("w2")).toBe("other.test:8443");
  // Its other machines need to reach it, so they follow it, though the other server has fewer.
  expect(await server("w1")).toBe("lxd.test:8443");
  expect(await server("w3")).toBe("other.test:8443");
  expect([...lxd.networks.keys()]).toEqual([workspaceNetworkName("w1")]);
  expect([...other.networks.keys()]).toEqual([workspaceNetworkName("w2"), workspaceNetworkName("w3")]);
  for (const server of [lxd, other]) expect(server.acls.has(machineNetworkAcl)).toBe(true);
  expect((await leases.list("w1")).map((machine) => [machine.name, machine.server, machine.state])).toEqual([["client-1", "lxd.test:8443", "ready"], ["client-2", "lxd.test:8443", "ready"]]);
});

test("servers that can't take a machine are passed over, and when none can, each one's reason is given", async () => {
  const other = new FakeLxd({ address: "other.test:8443", fingerprint: "b2", project: "agents-in-the-cloud" });
  const leases = createMachineLeases(dependencies({ lxds: async () => [lxd, other] }));
  lxd.version = "6.8";
  other.profiles.delete("ceph-node");
  await expect(leases.acquire("w1", { profile: "node" }, 5_000)).rejects.toThrow("None of the connected LXD servers can take this machine. At lxd.test:8443: The LXD server runs LXD 6.8, and machines need LXD 6.9 or later. Ask the user to upgrade it, or to connect another one in Settings, under Machines. At other.test:8443: The LXD server has no profile called ceph-node.");
  expect([lxd.networks.size, other.networks.size]).toEqual([0, 0]);
  expect((await leases.acquire("w1", { profile: "client" }, 5_000)).server).toBe("other.test:8443");

  lxd.version = "6.9";
  lxd.instanceTypes = ["container"];
  await expect(leases.acquire("w3", { profile: "node" }, 5_000)).rejects.toThrow("At lxd.test:8443: The LXD server can't run virtual machines, as it has no hardware virtualization (/dev/kvm).");
  lxd.instanceTypes = ["container", "virtual-machine"];

  // One that's out of reach doesn't hold up the others.
  other.server = async () => { throw new Error("Unable to connect"); };
  expect((await leases.acquire("w2", { profile: "client" }, 5_000)).server).toBe("lxd.test:8443");
  // A workspace's own server isn't passed over, though, as its machines couldn't reach one elsewhere.
  await expect(leases.acquire("w1", { profile: "client" }, 5_000)).rejects.toThrow("Unable to connect");
  expect(lxd.instancesByName.size).toBe(1);
});

test("machines on several servers are each parked, woken, snapshotted, expired and released where they are", async () => {
  const other = new FakeLxd({ address: "other.test:8443", fingerprint: "b2", project: "agents-in-the-cloud" });
  let servers = [lxd];
  const leases = createMachineLeases(dependencies({ lxds: async () => servers }));
  await leases.acquire("w1", { profile: "client", name: "a" }, 5_000);
  // With its server disconnected, the workspace's next machine goes elsewhere.
  servers = [other];
  await leases.acquire("w1", { profile: "node", name: "b" }, 5_000);
  servers = [lxd, other];
  const [a, b] = [lxd.instancesByName.get(machineInstanceName("w1", "a"))!, other.instancesByName.get(machineInstanceName("w1", "b"))!];
  expect((await leases.list("w1")).map((machine) => [machine.name, machine.server, machine.state])).toEqual([["a", "lxd.test:8443", "ready"], ["b", "other.test:8443", "ready"]]);

  await leases.stopAll("w1");
  expect([a.status, b.status]).toEqual(["Stopped", "Stopped"]);
  await leases.wake("w1", undefined, 5_000);
  expect((await leases.list("w1")).map((machine) => machine.state)).toEqual(["ready", "ready"]);

  expect((await leases.snapshot("w1", ["a", "b"], "both", 5_000)).map((machine) => [machine.state, machine.snapshots])).toEqual([["ready", ["both"]], ["ready", ["both"]]]);
  expect((await leases.restore("w1", ["a", "b"], "both", 5_000)).map((machine) => machine.state)).toEqual(["ready", "ready"]);

  // Only the servers its machines are on are asked about them.
  const third = new FakeLxd({ address: "third.test:8443", fingerprint: "c3", project: "agents-in-the-cloud" });
  third.instances = async () => { throw new Error("Unable to connect"); };
  servers = [lxd, third, other];
  expect((await leases.list("w1")).map((machine) => machine.state)).toEqual(["ready", "ready"]);

  servers = [other];
  expect(await leases.expire("w1", Number.POSITIVE_INFINITY)).toEqual(["b"]);
  expect([other.instancesByName.size, other.volumes.size, other.networks.size]).toEqual([0, 0, 0]);
  servers = [lxd, other];
  await leases.acquire("w1", { profile: "client", name: "c" }, 5_000);
  expect(await leases.releaseAll("w1")).toEqual([]);
  expect([lxd.instancesByName.size, lxd.networks.size]).toEqual([0, 0]);
});
