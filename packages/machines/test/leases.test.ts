import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMachineLeases, machineInstanceName, type MachineLeaseDependencies, type MachineSettings } from "../src/server/leases.ts";
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
    config: { "user.aitc.workspace": "w1", "user.aitc.lease": "node-1" },
  });
  expect(instance.config["cloud-init.vendor-data"]).toBe('#cloud-config\nhostname: "node-1"\nmanage_etc_hosts: true\nssh_authorized_keys:\n  - "ssh-ed25519 AAAAworkspace agents-in-the-cloud workspace w1"\n');
  const stored = JSON.parse(await readFile(join(directory, "w1", "leases.json"), "utf8"));
  expect(stored.leases[0]).toMatchObject({ status: "ready", hostKeys: ["ssh-ed25519 AAAAhost"] });

  expect((await leases.acquire("w1", { profile: "client", name: "probe" }, 5_000)).name).toBe("probe");
  expect((await leases.acquire("w1", { profile: "node" }, 5_000)).name).toBe("node-2");
  expect((await leases.acquire("w2", { profile: "node" }, 5_000)).name).toBe("node-1");
});

test("requests that can't be met are refused before anything is created", async () => {
  const leases = createMachineLeases(dependencies());
  await expect(leases.acquire("w1", { profile: "osd" }, 5_000)).rejects.toThrow("no machine profile called osd. This workspace can use node, client");
  await expect(leases.acquire("w1", { profile: "node", name: "Node 1" }, 5_000)).rejects.toThrow("lowercase letters");
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
  lxd.profiles.delete("ceph-node");
  expect((await leases.acquire("w1", { profile: "node", name: "unprofiled" }, 5_000)).error).toBe("The LXD server has no profile called ceph-node. Create it there, or change the machine profile in the template's settings.");
  await leases.release("w1", "unprofiled");
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
  await expect(leases.snapshot("w1", "node-1", "clean slate")).rejects.toThrow("Snapshot names");
  expect((await leases.snapshot("w1", "node-1", "clean")).snapshots).toEqual(["clean"]);
  const instance = lxd.instancesByName.get(machineInstanceName("w1", "node-1"))!;
  instance.status = "Frozen";
  expect((await leases.list("w1"))[0]!.state).toBe("paused");
  instance.status = "Stopped";
  expect((await leases.list("w1"))[0]!.state).toBe("stopped");
  // Booting again, it still has its snapshots.
  expect(await leases.restore("w1", "node-1", "clean", 0)).toMatchObject({ state: "starting", snapshots: ["clean"] });
  expect(await leases.waitFor("w1", "node-1", 5_000)).toMatchObject({ state: "ready", snapshots: ["clean"] });
  expect(instance.status).toBe("Running");
  await expect(leases.restore("w1", "node-1", "missing", 5_000)).rejects.toThrow("node-1 has no snapshot called missing");
  expect(instance.status).toBe("Running");
});

test("a snapshot has what the machine has written and its extra disks too, saved while it's paused, and restoring rolls them back with it", async () => {
  const instance = machineInstanceName("w1", "node-1");
  let shown: string[] = [];
  const leases = createMachineLeases(dependencies({ changed: async () => { shown.push(lxd.instancesByName.get(instance)?.status ?? "none"); } }));
  await leases.acquire("w1", { profile: "node" }, 5_000);
  const disks = [1, 2, 3].map((n) => `${instance}-disk${n}`);
  shown = [];
  await leases.snapshot("w1", "node-1", "clean");
  expect(lxd.log).toEqual([`run sync in ${instance} while Running`, ...disks.map((disk) => `snapshot ${disk} clean while Frozen`), `snapshot ${instance} clean while Frozen`]);
  // The Machines view shows it paused, then running again.
  expect(shown).toEqual(["Frozen", "Running"]);
  expect(lxd.instancesByName.get(instance)!.status).toBe("Running");

  lxd.log = [];
  expect((await leases.restore("w1", "node-1", "clean", 5_000)).state).toBe("ready");
  expect(lxd.log).toEqual([...disks.map((disk) => `restore ${disk} clean while Stopped`), `restore ${instance} clean while Stopped`]);
  expect(lxd.instancesByName.get(instance)!.status).toBe("Running");

  // Releasing takes the disks' snapshots along with them.
  await leases.release("w1", "node-1");
  expect(lxd.volumeSnapshots.size).toBe(0);
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
  await expect(leases.snapshot("w1", "node-1", "clean")).rejects.toThrow(elsewhere);
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
