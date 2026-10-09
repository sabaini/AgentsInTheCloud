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
    lxd: async () => {
      if (!connected) throw new Error("No LXD server is connected");
      return lxd;
    },
    machineSettings: async () => settings,
    publicKey: async (workspaceId) => `ssh-ed25519 AAAAworkspace agents-in-the-cloud workspace ${workspaceId}`,
    directory: (workspaceId) => join(directory, workspaceId),
    bootTimeoutMs: 5_000,
    pollMs: 1,
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
  const lease = (name: string, status: string) => ({ name, instance: machineInstanceName("w1", name), profile: { name: "client", image: "ubuntu:24.04", type: "container", lxdProfiles: ["default"], diskSizesGiB: [] }, volumes: [], createdAt: 0, expiresAt: Date.now() + 3_600_000, status, hostKeys: [] });
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
  instance.status = "Stopped";
  expect((await leases.list("w1"))[0]!.state).toBe("stopped");
  expect(await leases.restore("w1", "node-1", "clean", 5_000)).toMatchObject({ state: "ready", snapshots: ["clean"] });
  expect(instance.status).toBe("Running");
  await expect(leases.restore("w1", "node-1", "missing", 5_000)).rejects.toThrow("Snapshot not found");
});
