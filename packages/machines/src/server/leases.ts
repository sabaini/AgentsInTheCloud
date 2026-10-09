import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentsInTheCloudCoreError, createKeyedOperationQueue, readTextIfExists, writeJsonAtomic } from "@agents-in-the-cloud/core";
import { errorMessage } from "@agents-in-the-cloud/shared";
import { machineImageServers, type WorkspaceTemplateMachineProfile } from "@agents-in-the-cloud/workspace-templates";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { LxdRequestError, type LxdClient, type LxdInstance, type LxdInstancesPost } from "../lxd/index.ts";

const leaseSchema = Type.Object({
  name: Type.String(),
  instance: Type.String(),
  /** What the machine was made from; later profile changes don't touch it. */
  profile: Type.Object({
    name: Type.String(),
    image: Type.String(),
    type: Type.Union([Type.Literal("virtual-machine"), Type.Literal("container")]),
    lxdProfiles: Type.Array(Type.String()),
    diskSizesGiB: Type.Array(Type.Number()),
  }),
  pool: Type.Optional(Type.String()),
  volumes: Type.Array(Type.String()),
  createdAt: Type.Number(),
  expiresAt: Type.Number(),
  status: Type.Union([Type.Literal("creating"), Type.Literal("starting"), Type.Literal("ready"), Type.Literal("failed")]),
  error: Type.Optional(Type.String()),
  /** `type base64` lines, for the workspace's known_hosts. */
  hostKeys: Type.Array(Type.String()),
});
const leaseStoreSchema = Type.Object({ leases: Type.Array(leaseSchema) });
export type MachineLease = Static<typeof leaseSchema>;

export type MachineLxd = Pick<LxdClient, "instances" | "instance" | "profileDevices" | "createBlockVolume" | "deleteVolume" | "createInstance" | "setInstanceState" | "deleteInstance" | "readInstanceFile" | "snapshots" | "createSnapshot" | "restoreSnapshot">;

export interface MachineSettings {
  profiles: WorkspaceTemplateMachineProfile[];
  maxMachines: number;
}

export interface MachineLeaseDependencies {
  /** The connected LXD project; throws when there is none. */
  lxd(): Promise<MachineLxd>;
  machineSettings(workspaceId: string): Promise<MachineSettings>;
  publicKey(workspaceId: string): Promise<string>;
  directory(workspaceId: string): string;
  /** How long cloud-init may take before a machine counts as failed. */
  bootTimeoutMs: number;
  pollMs: number;
}

export type MachineState = "creating" | "starting" | "ready" | "stopped" | "failed" | "missing";

export interface MachineView {
  name: string;
  profile: string;
  type: MachineLease["profile"]["type"];
  image: string;
  diskSizesGiB: number[];
  state: MachineState;
  expiresAt: string;
  snapshots: string[];
  error?: string;
}

const machineNamePattern = /^[a-z][a-z0-9-]{0,39}$/;
const snapshotNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const bootFinishedPath = "/var/lib/cloud/instance/boot-finished";
const hostKeyPaths = ["ed25519", "ecdsa", "rsa"].map((type) => `/etc/ssh/ssh_host_${type}_key.pub`);
const probeTimeoutMs = 15_000;

function refused(message: string): AgentsInTheCloudCoreError {
  return new AgentsInTheCloudCoreError("machine_unavailable", message);
}

function isMissing(error: unknown): error is LxdRequestError {
  return error instanceof LxdRequestError && error.status === 404;
}

/** LXD names are per project, so each workspace's machines get a suffix of their own. */
export function machineInstanceName(workspaceId: string, name: string): string {
  return `${name}-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 8)}`;
}

export function machineImageSource(image: string): LxdInstancesPost["source"] {
  const separator = image.indexOf(":");
  if (separator < 0) return { type: "image", alias: image };
  const prefix = image.slice(0, separator);
  const server = Object.entries(machineImageServers).find(([name]) => name === prefix)?.[1];
  if (!server) throw refused(`Image server ${prefix} is unknown`);
  return { type: "image", alias: image.slice(separator + 1), server, protocol: "simplestreams" };
}

function vendorData(name: string, publicKey: string): string {
  // JSON strings are valid YAML, so the name and key need no further quoting.
  return `#cloud-config\nhostname: ${JSON.stringify(name)}\nmanage_etc_hosts: true\nssh_authorized_keys:\n  - ${JSON.stringify(publicKey)}\n`;
}

/** Extra disks go in the storage pool of the machine's root disk, which its LXD profiles define. */
async function rootDiskPool(lxd: MachineLxd, profiles: string[]): Promise<string> {
  let pool: string | undefined;
  // Later profiles override earlier ones, as when LXD applies them.
  for (const profile of profiles) {
    const root = Object.values(await lxd.profileDevices(profile)).find((device) => device.type === "disk" && device.path === "/");
    if (root?.pool) pool = root.pool;
  }
  if (!pool) throw refused(`None of the LXD profiles ${profiles.join(", ")} gives machines a root disk, so there's no storage pool for their extra disks`);
  return pool;
}

async function removeInstance(lxd: MachineLxd, instance: string): Promise<void> {
  let current: LxdInstance;
  try {
    current = await lxd.instance(instance);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (current.status !== "Stopped") await lxd.setInstanceState(instance, "stop", true);
  await lxd.deleteInstance(instance);
}

/** Wait for `done`, but no longer than `ms` or until the caller gives up; the work itself carries on. */
async function within(done: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  const stop = new AbortController();
  const waiting = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  try {
    // Running out of time or being cancelled just ends the wait.
    await Promise.race([done, delay(ms, undefined, { signal: waiting }).catch(() => undefined)]);
  } finally {
    stop.abort();
  }
}

function stateOf(lease: MachineLease, instance: LxdInstance | undefined): MachineState {
  if (lease.status !== "ready") return lease.status;
  if (!instance) return "missing";
  return instance.status === "Running" ? "ready" : "stopped";
}

function viewOf(lease: MachineLease, instance: LxdInstance | undefined, snapshots: string[]): MachineView {
  const view: MachineView = {
    name: lease.name,
    profile: lease.profile.name,
    type: lease.profile.type,
    image: lease.profile.image,
    diskSizesGiB: lease.profile.diskSizesGiB,
    state: stateOf(lease, instance),
    expiresAt: new Date(lease.expiresAt).toISOString(),
    snapshots,
  };
  if (lease.error) view.error = lease.error;
  return view;
}

interface Task { controller: AbortController; done: Promise<void> }

/** The machines each workspace leases. Store changes run one at a time per workspace; creating and booting run alongside. */
export function createMachineLeases(deps: MachineLeaseDependencies) {
  const serialize = createKeyedOperationQueue();
  const tasks = new Map<string, Task>();
  const taskKey = (workspaceId: string, name: string) => `${workspaceId}\0${name}`;
  const storePath = (workspaceId: string) => join(deps.directory(workspaceId), "leases.json");

  async function readLeases(workspaceId: string): Promise<MachineLease[]> {
    const text = await readTextIfExists(storePath(workspaceId));
    return text === undefined ? [] : Value.Parse(leaseStoreSchema, JSON.parse(text)).leases;
  }

  async function writeLeases(workspaceId: string, leases: MachineLease[]): Promise<void> {
    await writeJsonAtomic(storePath(workspaceId), { leases });
  }

  async function find(workspaceId: string, name: string): Promise<MachineLease> {
    const lease = (await readLeases(workspaceId)).find((candidate) => candidate.name === name);
    if (!lease) throw refused(`This workspace has no machine called ${name}`);
    return lease;
  }

  async function update(workspaceId: string, name: string, change: (lease: MachineLease) => void): Promise<void> {
    await serialize(workspaceId, async () => {
      const leases = await readLeases(workspaceId);
      const lease = leases.find((candidate) => candidate.name === name);
      if (!lease) throw refused(`This workspace has no machine called ${name}`);
      change(lease);
      await writeLeases(workspaceId, leases);
    });
  }

  function start(workspaceId: string, name: string, work: (signal: AbortSignal) => Promise<void>): Task {
    const key = taskKey(workspaceId, name);
    const controller = new AbortController();
    const task: Task = {
      controller,
      done: work(controller.signal)
        .catch((error: Error) => {
          // Work records its own failures on the lease; this is for failing to record them, or being released.
          if (!controller.signal.aborted) console.error(`[machines] ${workspaceId}/${name}:`, error);
        })
        .finally(() => { if (tasks.get(key) === task) tasks.delete(key); }),
    };
    tasks.set(key, task);
    return task;
  }

  /** The machine's files come from its LXD agent, which in a VM starts late in boot and restarts once. */
  async function probe(lxd: MachineLxd, instance: string, signal: AbortSignal): Promise<string[] | undefined> {
    try {
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(probeTimeoutMs)]);
      if (!await lxd.readInstanceFile(instance, bootFinishedPath, attempt)) return undefined;
      const keys = await Promise.all(hostKeyPaths.map((path) => lxd.readInstanceFile(instance, path, attempt)));
      return keys.flatMap((key) => key ? [key.toString("utf8").trim().split(/\s+/).slice(0, 2).join(" ")] : []);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof LxdRequestError || (error instanceof DOMException && error.name === "TimeoutError")) return undefined;
      throw error;
    }
  }

  async function becomeReady(workspaceId: string, name: string, lxd: MachineLxd, signal: AbortSignal): Promise<void> {
    const { instance } = await find(workspaceId, name);
    const deadline = Date.now() + deps.bootTimeoutMs;
    let hostKeys = await probe(lxd, instance, signal);
    while (!hostKeys) {
      if (Date.now() > deadline) throw refused(`${name} didn't finish booting within ${Math.round(deps.bootTimeoutMs / 60_000)} minutes. Its image may not have cloud-init.`);
      await delay(deps.pollMs, undefined, { signal });
      hostKeys = await probe(lxd, instance, signal);
    }
    if (!hostKeys.length) throw refused(`${name} has no SSH host keys. Its image needs openssh-server.`);
    const keys = hostKeys;
    await update(workspaceId, name, (lease) => {
      lease.status = "ready";
      lease.hostKeys = keys;
      delete lease.error;
    });
  }

  async function failOnError(workspaceId: string, name: string, signal: AbortSignal, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (signal.aborted) throw error;
      await update(workspaceId, name, (lease) => {
        lease.status = "failed";
        lease.error = errorMessage(error);
      });
    }
  }

  async function provision(workspaceId: string, name: string, signal: AbortSignal): Promise<void> {
    await failOnError(workspaceId, name, signal, async () => {
      const lxd = await deps.lxd();
      const lease = await find(workspaceId, name);
      const sizes = lease.profile.diskSizesGiB;
      let devices: Record<string, Record<string, string>> = {};
      if (sizes.length) {
        const pool = await rootDiskPool(lxd, lease.profile.lxdProfiles);
        const volumes = sizes.map((_, index) => `${lease.instance}-disk${index + 1}`);
        // Recorded before they exist, so releasing a half-made machine still finds its disks.
        await update(workspaceId, name, (stored) => {
          stored.pool = pool;
          stored.volumes = volumes;
        });
        for (const [index, size] of sizes.entries()) await lxd.createBlockVolume(pool, volumes[index]!, `${size}GiB`);
        devices = Object.fromEntries(volumes.map((volume, index) => [`disk${index + 1}`, { type: "disk", pool, source: volume }]));
      }
      await lxd.createInstance({
        name: lease.instance,
        description: `AgentsInTheCloud machine ${name} for workspace ${workspaceId}`,
        type: lease.profile.type,
        source: machineImageSource(lease.profile.image),
        profiles: lease.profile.lxdProfiles,
        config: { "user.aitc.workspace": workspaceId, "user.aitc.lease": name, "cloud-init.vendor-data": vendorData(name, await deps.publicKey(workspaceId)) },
        devices,
        start: true,
      });
      await update(workspaceId, name, (stored) => { stored.status = "starting"; });
      await becomeReady(workspaceId, name, lxd, signal);
    });
  }

  /** Picks up a machine whose creation an AgentsInTheCloud restart interrupted. */
  async function resume(workspaceId: string, name: string, signal: AbortSignal): Promise<void> {
    await failOnError(workspaceId, name, signal, async () => {
      const lxd = await deps.lxd();
      const lease = await find(workspaceId, name);
      if (lease.status === "creating") {
        if (!(await lxd.instances()).some((instance) => instance.name === lease.instance)) throw refused("AgentsInTheCloud restarted before this machine was created. Release it and create a new one.");
        await update(workspaceId, name, (stored) => { stored.status = "starting"; });
      }
      await becomeReady(workspaceId, name, lxd, signal);
    });
  }

  async function list(workspaceId: string): Promise<MachineView[]> {
    const leases = await readLeases(workspaceId);
    if (!leases.length) return [];
    for (const lease of leases) {
      if ((lease.status === "creating" || lease.status === "starting") && !tasks.has(taskKey(workspaceId, lease.name))) start(workspaceId, lease.name, (signal) => resume(workspaceId, lease.name, signal));
    }
    const lxd = await deps.lxd();
    const instances = new Map((await lxd.instances()).map((instance) => [instance.name, instance]));
    return await Promise.all(leases.map(async (lease) => {
      const instance = instances.get(lease.instance);
      return viewOf(lease, instance, lease.status === "ready" && instance ? await lxd.snapshots(lease.instance) : []);
    }));
  }

  async function view(workspaceId: string, name: string): Promise<MachineView> {
    const machine = (await list(workspaceId)).find((candidate) => candidate.name === name);
    if (!machine) throw refused(`This workspace has no machine called ${name}`);
    return machine;
  }

  async function waitFor(workspaceId: string, name: string, waitMs: number, signal?: AbortSignal): Promise<MachineView> {
    await view(workspaceId, name);
    const task = tasks.get(taskKey(workspaceId, name));
    if (task) await within(task.done, waitMs, signal);
    return await view(workspaceId, name);
  }

  async function acquire(workspaceId: string, request: { profile: string; name?: string }, waitMs: number, signal?: AbortSignal): Promise<MachineView> {
    const name = await serialize(workspaceId, async () => {
      const { profiles, maxMachines } = await deps.machineSettings(workspaceId);
      if (!profiles.length) throw refused("This workspace's template has no machine profiles yet. Ask the user to add one in the template's settings, under Machines.");
      const profile = profiles.find((candidate) => candidate.name === request.profile);
      if (!profile) throw refused(`There's no machine profile called ${request.profile}. This workspace can use ${profiles.map((candidate) => candidate.name).join(", ")}.`);
      const leases = await readLeases(workspaceId);
      if (leases.length >= maxMachines) throw refused(`This workspace already has ${leases.length} of its ${maxMachines} machines. Release one first.`);
      let name = request.name?.trim() || "";
      for (let number = 1; !name; number++) if (!leases.some((lease) => lease.name === `${profile.name}-${number}`)) name = `${profile.name}-${number}`;
      if (!machineNamePattern.test(name)) throw new AgentsInTheCloudCoreError("invalid_arguments", "Machine names use lowercase letters, digits and hyphens, start with a letter, and have up to 40 characters");
      if (leases.some((lease) => lease.name === name)) throw refused(`This workspace already has a machine called ${name}`);
      // Refuse before recording anything when no LXD server is connected.
      await deps.lxd();
      await deps.publicKey(workspaceId);
      const now = Date.now();
      await writeLeases(workspaceId, [...leases, {
        name,
        instance: machineInstanceName(workspaceId, name),
        profile: { name: profile.name, image: profile.image, type: profile.type, lxdProfiles: profile.lxdProfiles, diskSizesGiB: profile.diskSizesGiB },
        volumes: [],
        createdAt: now,
        expiresAt: now + profile.lifetimeHours * 3_600_000,
        status: "creating",
        hostKeys: [],
      }]);
      return name;
    });
    await within(start(workspaceId, name, (taskSignal) => provision(workspaceId, name, taskSignal)).done, waitMs, signal);
    return await view(workspaceId, name);
  }

  async function snapshot(workspaceId: string, name: string, snapshotName: string): Promise<MachineView> {
    if (!snapshotNamePattern.test(snapshotName)) throw new AgentsInTheCloudCoreError("invalid_arguments", "Snapshot names use letters, digits, dots, hyphens and underscores");
    await serialize(workspaceId, async () => {
      const lease = await find(workspaceId, name);
      if (lease.status !== "ready") throw refused(`${name} isn't ready yet, so it can't be snapshotted`);
      await (await deps.lxd()).createSnapshot(lease.instance, snapshotName);
    });
    return await view(workspaceId, name);
  }

  async function restore(workspaceId: string, name: string, snapshotName: string, waitMs: number, signal?: AbortSignal): Promise<MachineView> {
    const lxd = await deps.lxd();
    await serialize(workspaceId, async () => {
      const lease = await find(workspaceId, name);
      if (lease.status !== "ready") throw refused(`${name} isn't ready yet, so it can't be restored`);
      await lxd.restoreSnapshot(lease.instance, snapshotName);
      if ((await lxd.instance(lease.instance)).status !== "Running") await lxd.setInstanceState(lease.instance, "start");
      const leases = await readLeases(workspaceId);
      leases.find((candidate) => candidate.name === name)!.status = "starting";
      await writeLeases(workspaceId, leases);
    });
    const task = start(workspaceId, name, (taskSignal) => failOnError(workspaceId, name, taskSignal, () => becomeReady(workspaceId, name, lxd, taskSignal)));
    await within(task.done, waitMs, signal);
    return await view(workspaceId, name);
  }

  /** Deletes the machine, its disks and its snapshots. A machine still being created is finished first. */
  async function release(workspaceId: string, name: string): Promise<void> {
    const task = tasks.get(taskKey(workspaceId, name));
    task?.controller.abort();
    await task?.done;
    await serialize(workspaceId, async () => {
      const leases = await readLeases(workspaceId);
      const lease = leases.find((candidate) => candidate.name === name);
      if (!lease) throw refused(`This workspace has no machine called ${name}`);
      const lxd = await deps.lxd();
      await removeInstance(lxd, lease.instance);
      for (const volume of lease.volumes) {
        try {
          await lxd.deleteVolume(lease.pool!, volume);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await writeLeases(workspaceId, leases.filter((candidate) => candidate !== lease));
    });
  }

  return { acquire, list, waitFor, snapshot, restore, release, settings: deps.machineSettings };
}

export type MachineLeases = ReturnType<typeof createMachineLeases>;
