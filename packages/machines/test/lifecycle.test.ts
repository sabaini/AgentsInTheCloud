import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateFingerprint, createLxdClientCredentials } from "../src/lxd/index.ts";
import { saveLxdConnection } from "../src/server/connection.ts";
import { deleteUntrackedMachine, machinesDeletionReview, untrackedMachines } from "../src/server/lifecycle.ts";
import { FakeLxd } from "./fake-lxd.ts";

let previousDataDir: string | undefined;
let dataDir: string;
let lxd: FakeLxd;

beforeEach(async () => {
  previousDataDir = process.env.ATELIER_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "machines-lifecycle-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  lxd = new FakeLxd();
  const lease = { name: "node-1", location: lxd.location, instance: "node-1-aaaa", profile: { name: "node", image: "ubuntu:24.04", type: "virtual-machine", lxdProfiles: ["default"], diskSizesGiB: [] }, volumes: [], createdAt: 0, expiresAt: Date.now() + 3_600_000, status: "ready", hostKeys: [] };
  await mkdir(join(dataDir, "machines", "workspaces", "w1"), { recursive: true });
  await writeFile(join(dataDir, "machines", "workspaces", "w1", "leases.json"), JSON.stringify({ leases: [lease] }));
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

test("deleting a workspace with machines asks first, naming the ones that go with it and the ones that stay", async () => {
  expect(await machinesDeletionReview.inspect("w1")).toMatchObject({ status: "blocked", details: { deleted: [], kept: ["node-1"] } });
  expect(await machinesDeletionReview.inspect("w2")).toEqual({ status: "clear" });

  const server = await createLxdClientCredentials("lxd.test");
  await saveLxdConnection({ server: { address: "lxd.test:8443", certificate: server.certificate }, project: "agents-in-the-cloud", credentials: await createLxdClientCredentials("aitc") });
  const lease = (name: string, fingerprint: string) => ({ name, location: { address: "lxd.test:8443", fingerprint, project: "agents-in-the-cloud" }, instance: `${name}-cccc`, profile: { name: "node", image: "ubuntu:24.04", type: "virtual-machine", lxdProfiles: ["default"], diskSizesGiB: [] }, volumes: [], createdAt: 0, expiresAt: Date.now() + 3_600_000, status: "ready", hostKeys: [] });
  await mkdir(join(dataDir, "machines", "workspaces", "w3"), { recursive: true });
  await writeFile(join(dataDir, "machines", "workspaces", "w3", "leases.json"), JSON.stringify({ leases: [lease("here", certificateFingerprint(server.certificate)), lease("elsewhere", "b2")] }));
  const review = await machinesDeletionReview.inspect("w3");
  expect(review).toMatchObject({ status: "blocked", details: { deleted: ["here"], kept: ["elsewhere"] } });
  const evidence = machinesDeletionReview.renderEvidence("w3", review.status === "blocked" ? review.details : {});
  expect(evidence).toContain("Its machines will be deleted too");
  expect(evidence).toContain("These ones will stay on their LXD server");
});

test("only tagged machines no workspace tracks count as untracked, and deleting one takes its disks", async () => {
  expect((await untrackedMachines(lxd)).map((machine) => machine.name)).toEqual(["lost-bbbb"]);
  await expect(deleteUntrackedMachine(lxd, "node-1-aaaa")).rejects.toThrow("lost track of");
  await expect(deleteUntrackedMachine(lxd, "someone-elses")).rejects.toThrow("lost track of");
  await deleteUntrackedMachine(lxd, "lost-bbbb");
  expect([...lxd.instancesByName.keys()]).toEqual(["node-1-aaaa", "someone-elses"]);
  expect(lxd.volumes.size).toBe(0);
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
