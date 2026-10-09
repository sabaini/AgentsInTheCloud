import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteUntrackedMachine, machinesDeletionReview, untrackedMachines } from "../src/server/lifecycle.ts";
import { FakeLxd } from "./fake-lxd.ts";

let previousDataDir: string | undefined;
let dataDir: string;
let lxd: FakeLxd;

beforeEach(async () => {
  previousDataDir = process.env.ATELIER_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "machines-lifecycle-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  const lease = { name: "node-1", instance: "node-1-aaaa", profile: { name: "node", image: "ubuntu:24.04", type: "virtual-machine", lxdProfiles: ["default"], diskSizesGiB: [] }, volumes: [], createdAt: 0, expiresAt: Date.now() + 3_600_000, status: "ready", hostKeys: [] };
  await mkdir(join(dataDir, "machines", "workspaces", "w1"), { recursive: true });
  await writeFile(join(dataDir, "machines", "workspaces", "w1", "leases.json"), JSON.stringify({ leases: [lease] }));
  lxd = new FakeLxd();
  const source = { type: "image" as const, alias: "24.04" };
  await lxd.createInstance({ name: "node-1-aaaa", type: "virtual-machine", source, config: { "user.aitc.workspace": "w1" } });
  await lxd.createInstance({ name: "lost-bbbb", type: "virtual-machine", source, config: { "user.aitc.workspace": "gone", "user.aitc.lease": "lost" }, devices: { disk1: { type: "disk", pool: "default", source: "lost-bbbb-disk1" } } });
  await lxd.createBlockVolume("default", "lost-bbbb-disk1", "1GiB");
  await lxd.createInstance({ name: "someone-elses", type: "container", source });
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

test("deleting a workspace with machines asks first, naming them", async () => {
  expect(await machinesDeletionReview.inspect("w1")).toMatchObject({ status: "blocked", details: { machines: ["node-1"], connected: false } });
  expect(await machinesDeletionReview.inspect("w2")).toEqual({ status: "clear" });
});

test("only tagged machines no workspace tracks count as untracked, and deleting one takes its disks", async () => {
  expect((await untrackedMachines(lxd)).map((machine) => machine.name)).toEqual(["lost-bbbb"]);
  await expect(deleteUntrackedMachine(lxd, "node-1-aaaa")).rejects.toThrow("lost track of");
  await expect(deleteUntrackedMachine(lxd, "someone-elses")).rejects.toThrow("lost track of");
  await deleteUntrackedMachine(lxd, "lost-bbbb");
  expect([...lxd.instancesByName.keys()]).toEqual(["node-1-aaaa", "someone-elses"]);
  expect(lxd.volumes.size).toBe(0);
});
