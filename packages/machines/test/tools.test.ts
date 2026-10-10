import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentsInTheCloudControlTools } from "@agents-in-the-cloud/agent/server/tools";
import { createMachineLeases, type MachineSettings } from "../src/server/leases.ts";
import { registerMachineTools } from "../src/server/tools.ts";
import { clientProfile, FakeLxd, nodeProfile } from "./fake-lxd.ts";

let directory: string;
let unregister: () => void;
const settings: MachineSettings = { profiles: [nodeProfile, clientProfile], maxMachines: 2 };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "machines-tools-"));
  const lxd = new FakeLxd();
  unregister = registerMachineTools(createMachineLeases({
    lxd: async () => lxd,
    machineSettings: async () => settings,
    publicKey: async () => "ssh-ed25519 AAAAworkspace",
    reachesMachines: async () => true,
    directory: (workspaceId) => join(directory, workspaceId),
    bootTimeoutMs: 5_000,
    pollMs: 1,
    changed: async () => undefined,
  }));
});

afterAll(async () => {
  unregister();
  await rm(directory, { recursive: true, force: true });
});

async function call(name: string, params: Record<string, string> = {}): Promise<string> {
  const tool = createAgentsInTheCloudControlTools("w1").find((candidate) => candidate.name === name)!;
  const result = await tool.execute("call", params);
  return result.content.map((part) => part.type === "text" ? part.text : "").join("");
}

test("Agents create, inspect, snapshot and release machines through their tools", async () => {
  expect(createAgentsInTheCloudControlTools("w1").map((tool) => tool.name)).toEqual(expect.arrayContaining(["acquire_machine", "list_machines", "wait_for_machine", "release_machine", "snapshot_machine", "restore_machine"]));
  expect(await call("list_machines")).toBe("This workspace has no machines.\n\nProfiles you can create machines from (up to 2 at once):\n- node: a virtual machine from ubuntu:24.04 with extra disks of 20, 20, 20 GiB, kept for 24 hours\n- client: a container from ubuntu:24.04, kept for 24 hours");
  expect(await call("acquire_machine", { profile: "node" })).toMatch(/^node-1 is ready: a virtual machine from ubuntu:24\.04 with 3 extra disks \(20, 20, 20 GiB\), made from profile node, until \d{4}-\d\d-\d\dT[\d:.]+Z\. Reach it with `ssh node-1`; scp and rsync work too\. Other machines reach it at 10\.0\.0\.2, not by name\.$/);
  expect(await call("acquire_machine", { profile: "client" })).toEndWith("Other machines reach it at 10.0.0.3, not by name.");
  expect(await call("release_machine", { name: "client-1" })).toBe("Released client-1. It's deleted, with its disks and snapshots.");
  expect(await call("snapshot_machine", { name: "node-1", snapshot: "clean" })).toBe("Saved snapshot clean of node-1.");
  expect(await call("restore_machine", { name: "node-1", snapshot: "clean" })).toStartWith("Restored node-1 to clean. node-1 is ready:");
  expect(await call("list_machines")).toContain("Snapshots: clean.");
  expect(await call("release_machine", { name: "node-1" })).toBe("Released node-1. It's deleted, with its disks and snapshots.");
  await expect(call("wait_for_machine", { name: "node-1" })).rejects.toThrow("no machine called node-1");
});
