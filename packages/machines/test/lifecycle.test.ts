import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { certificateFingerprint, createLxdClientCredentials } from "../src/lxd/index.ts";
import { saveLxdConnection } from "../src/server/connection.ts";
import { deleteUntrackedMachine, machinesDeletionReview, registerMachineLifecycle, untrackedMachines } from "../src/server/lifecycle.ts";
import { machineLeases } from "../src/server/runtime.ts";
import { workspaceNetworkName } from "../src/server/sandbox.ts";
import { FakeLxd } from "./fake-lxd.ts";

let previousDataDir: string | undefined;
let dataDir: string;
let lxd: FakeLxd;

beforeEach(async () => {
  previousDataDir = process.env.ATELIER_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "machines-lifecycle-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  lxd = new FakeLxd();
  const lease = { name: "node-1", location: lxd.location, instance: "node-1-aaaa", profile: { name: "node", image: "ubuntu:24.04", type: "virtual-machine", lxdProfiles: ["default"], cpus: 2, memoryGiB: 2, diskSizesGiB: [] }, volumes: [], createdAt: 0, expiresAt: Date.now() + 3_600_000, status: "ready", hostKeys: [] };
  await mkdir(join(dataDir, "machines", "workspaces", "w1"), { recursive: true });
  await writeFile(join(dataDir, "machines", "workspaces", "w1", "leases.json"), JSON.stringify({ leases: [lease] }));
  const source = { type: "image" as const, alias: "24.04" };
  for (const workspace of ["w1", "gone"]) await lxd.createNetwork({ name: workspaceNetworkName(workspace), description: "", type: "ovn", config: {} });
  await lxd.createInstance({ name: "node-1-aaaa", type: "virtual-machine", source, config: { "user.aitc.workspace": "w1" }, devices: { eth0: { type: "nic", network: workspaceNetworkName("w1") } } });
  await lxd.createInstance({ name: "lost-bbbb", type: "virtual-machine", source, config: { "user.aitc.workspace": "gone", "user.aitc.lease": "lost" }, devices: { eth0: { type: "nic", network: workspaceNetworkName("gone") }, disk1: { type: "disk", pool: "default", source: "lost-bbbb-disk1" } } });
  await lxd.createBlockVolume("default", "lost-bbbb-disk1", "1GiB");
  await lxd.createInstance({ name: "someone-elses", type: "container", source });
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

test("deleting a workspace with machines asks first, naming the ones that go with it and the ones that stay", async () => {
  expect(await machinesDeletionReview.inspect("w1")).toMatchObject({ status: "blocked", details: { deleted: [], kept: ["node-1"] } });
  expect(await machinesDeletionReview.inspect("w2")).toEqual({ status: "clear" });

  const server = await createLxdClientCredentials("lxd.test");
  await saveLxdConnection({ server: { address: "lxd.test:8443", certificate: server.certificate }, project: "agents-in-the-cloud", credentials: await createLxdClientCredentials("aitc") });
  const lease = (name: string, fingerprint: string) => ({ name, location: { address: "lxd.test:8443", fingerprint, project: "agents-in-the-cloud" }, instance: `${name}-cccc`, profile: { name: "node", image: "ubuntu:24.04", type: "virtual-machine", lxdProfiles: ["default"], cpus: 2, memoryGiB: 2, diskSizesGiB: [] }, volumes: [], createdAt: 0, expiresAt: Date.now() + 3_600_000, status: "ready", hostKeys: [] });
  await mkdir(join(dataDir, "machines", "workspaces", "w3"), { recursive: true });
  await writeFile(join(dataDir, "machines", "workspaces", "w3", "leases.json"), JSON.stringify({ leases: [lease("here", certificateFingerprint(server.certificate)), lease("elsewhere", "b2")] }));
  const review = await machinesDeletionReview.inspect("w3");
  expect(review).toMatchObject({ status: "blocked", details: { deleted: ["here"], kept: ["elsewhere"] } });
});

test("only tagged machines no workspace tracks count as untracked, and deleting one takes its disks and network", async () => {
  expect((await untrackedMachines(lxd)).map((machine) => machine.name)).toEqual(["lost-bbbb"]);
  await expect(deleteUntrackedMachine(lxd, "node-1-aaaa")).rejects.toThrow("lost track of");
  await expect(deleteUntrackedMachine(lxd, "someone-elses")).rejects.toThrow("lost track of");
  await deleteUntrackedMachine(lxd, "lost-bbbb");
  expect([...lxd.instancesByName.keys()]).toEqual(["node-1-aaaa", "someone-elses"]);
  expect(lxd.volumes.size).toBe(0);
  expect([...lxd.networks.keys()]).toEqual([workspaceNetworkName("w1")]);

  // One whose workspace still has a machine here leaves the network to it, even while that one isn't created yet.
  lxd.instancesByName.delete("node-1-aaaa");
  await lxd.createInstance({ name: "stray-aaaa", type: "container", source: { type: "image", alias: "24.04" }, config: { "user.aitc.workspace": "w1" }, devices: { eth0: { type: "nic", network: workspaceNetworkName("w1") } } });
  await deleteUntrackedMachine(lxd, "stray-aaaa");
  expect([...lxd.networks.keys()]).toEqual([workspaceNetworkName("w1")]);
});

test("a machine tracked on another LXD server doesn't hide one of the same name here", async () => {
  const elsewhere = new FakeLxd({ ...lxd.location, fingerprint: "b2" });
  await elsewhere.createInstance({ name: "node-1-aaaa", type: "virtual-machine", source: { type: "image", alias: "24.04" }, config: { "user.aitc.workspace": "w1" } });
  expect((await untrackedMachines(elsewhere)).map((machine) => machine.name)).toEqual(["node-1-aaaa"]);
});

test("a disk that can't be deleted with its untracked machine is named, with how to delete it", async () => {
  lxd.deleteVolume = async () => { throw new Error("storage pool is busy"); };
  await expect(deleteUntrackedMachine(lxd, "lost-bbbb")).rejects.toThrow("lost-bbbb is deleted, but one of its disks isn’t (storage pool is busy). To delete it, run lxc storage volume delete default lost-bbbb-disk1 --project agents-in-the-cloud on the LXD server.");
  expect(lxd.instancesByName.has("lost-bbbb")).toBe(false);
});

test("a workspace whose deletion doesn't go through can have machines again, also when its machines had gone already", async () => {
  const events = createAgentsInTheCloudEventBus();
  // SAFETY: Machine lifecycle registration uses only the context's events and onWorkspaceRemoved.
  registerMachineLifecycle({ events, onWorkspaceRemoved: () => {} } as never);
  const warned = spyOn(console, "warn").mockImplementation(() => undefined);
  await events.emit("workspace_deleting", { workspaceId: "w1" });
  await expect(machineLeases.acquire("w1", { profile: "node" }, 0)).rejects.toThrow("being deleted");
  // As when its container can't be removed.
  await events.emit("workspace_delete_failed", { workspaceId: "w1" });
  await expect(machineLeases.acquire("w1", { profile: "node" }, 0)).rejects.not.toThrow("being deleted");
  warned.mockRestore();
  await events.emit("agents_in_the_cloud_host_stopping", {});
});
