import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentsInTheCloudCoreError, createKeyedOperationQueue, readTextIfExists, writeJsonAtomic } from "@agents-in-the-cloud/core";
import { errorMessage } from "@agents-in-the-cloud/shared";
import { machineImageServers, type WorkspaceTemplateMachineProfile } from "@agents-in-the-cloud/workspace-templates";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { LxdRequestError, sameLxdLocation, type LxdClient, type LxdInstance, type LxdInstancesPost } from "../lxd/index.ts";

const leaseSchema = Type.Object({
  name: Type.String(),
  /** The LXD project the machine is in, which may not be the one connected now. */
  location: Type.Object({ address: Type.String(), fingerprint: Type.String(), project: Type.String() }),
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

export type MachineLxd = Pick<LxdClient, "location" | "instances" | "instance" | "profileDevices" | "createBlockVolume" | "deleteVolume" | "createVolumeSnapshot" | "restoreVolumeSnapshot" | "createInstance" | "setInstanceState" | "deleteInstance" | "readInstanceFile" | "run" | "snapshots" | "createSnapshot" | "restoreSnapshot">;

export interface MachineSettings {
  profiles: WorkspaceTemplateMachineProfile[];
  maxMachines: number;
}

export interface MachineLeaseDependencies<Lxd extends MachineLxd = MachineLxd> {
  /** The connected LXD project, if there is one. */
  lxd(): Promise<Lxd | undefined>;
  machineSettings(workspaceId: string): Promise<MachineSettings>;
  publicKey(workspaceId: string): Promise<string>;
  directory(workspaceId: string): string;
  /** How long cloud-init may take before a machine counts as failed. */
  bootTimeoutMs: number;
  pollMs: number;
  /** Runs after every change to a workspace's leases or how its machines run, before the change counts as made. */
  changed(workspaceId: string, leases: MachineLease[]): Promise<void>;
}

export type MachineState = "creating" | "starting" | "ready" | "paused" | "stopped" | "failed" | "missing" | "disconnected";

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
/**
 * cloud-init writes this on tmpfs once it has finished the current boot. Its boot-finished file can't
 * tell: it stays on disk from the previous boot until a few seconds into this one, when LXD's agent
 * already answers and sshd isn't listening yet.
 */
const cloudInitResultPath = "/run/cloud-init/result.json";
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
    const devices = await lxd.profileDevices(profile).catch((error: Error) => {
      throw isMissing(error) ? refused(`The LXD server has no profile called ${profile}. Create it there, or change the machine profile in the template's settings.`) : error;
    });
    const root = Object.values(devices).find((device) => device.type === "disk" && device.path === "/");
    if (root?.pool) pool = root.pool;
  }
  if (!pool) throw refused(`None of the LXD profiles ${profiles.join(", ")} gives machines a root disk, so there's no storage pool for their extra disks`);
  return pool;
}

/** Stops the instance if it's running and deletes it with its snapshots; one that's already gone is fine. */
export async function removeInstance(lxd: MachineLxd, instance: string): Promise<void> {
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
  if (instance.status === "Running") return "ready";
  // A snapshot pauses a machine while its disks are saved.
  return instance.status === "Frozen" ? "paused" : "stopped";
}

function viewOf(lease: MachineLease, state: MachineState, snapshots: string[]): MachineView {
  const view: MachineView = {
    name: lease.name,
    profile: lease.profile.name,
    type: lease.profile.type,
    image: lease.profile.image,
    diskSizesGiB: lease.profile.diskSizesGiB,
    state,
    expiresAt: new Date(lease.expiresAt).toISOString(),
    snapshots,
  };
  if (lease.error) view.error = lease.error;
  return view;
}

interface Task { controller: AbortController; done: Promise<void> }

/** The machines each workspace leases. Store changes run one at a time per workspace; creating and booting run alongside. */
export function createMachineLeases<Lxd extends MachineLxd>(deps: MachineLeaseDependencies<Lxd>) {
  const serialize = createKeyedOperationQueue();
  const tasks = new Map<string, Task>();
  /** Workspaces being deleted, which can't have new machines. */
  const closing = new Set<string>();
  const taskKey = (workspaceId: string, name: string) => `${workspaceId}\0${name}`;
  const storePath = (workspaceId: string) => join(deps.directory(workspaceId), "leases.json");

  async function readLeases(workspaceId: string): Promise<MachineLease[]> {
    const text = await readTextIfExists(storePath(workspaceId));
    return text === undefined ? [] : Value.Parse(leaseStoreSchema, JSON.parse(text)).leases;
  }

  async function writeLeases(workspaceId: string, leases: MachineLease[]): Promise<void> {
    await writeJsonAtomic(storePath(workspaceId), { leases });
    await deps.changed(workspaceId, leases);
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

  async function connected(): Promise<Lxd> {
    const lxd = await deps.lxd();
    if (!lxd) throw refused("No LXD server is connected, so there are no machines. Ask the user to connect one in Settings, under Machines.");
    return lxd;
  }

  /** A machine stays in the LXD project it was made in. With another one connected, it's out of reach as with none. */
  async function lxdFor(lease: MachineLease): Promise<Lxd> {
    const lxd = await connected();
    if (!sameLxdLocation(lease.location, lxd.location)) throw refused(`${lease.name} is on the LXD server at ${lease.location.address}, in project ${lease.location.project}, which isn't connected now. It can be used or released once that's connected again in Settings, under Machines.`);
    return lxd;
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
      if (!await lxd.readInstanceFile(instance, cloudInitResultPath, attempt)) return undefined;
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
      const lease = await find(workspaceId, name);
      const lxd = await lxdFor(lease);
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
      const lease = await find(workspaceId, name);
      const lxd = await lxdFor(lease);
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
    const lxd = await connected();
    const here = (lease: MachineLease) => sameLxdLocation(lease.location, lxd.location);
    for (const lease of leases) {
      if ((lease.status === "creating" || lease.status === "starting") && here(lease) && !tasks.has(taskKey(workspaceId, lease.name))) start(workspaceId, lease.name, (signal) => resume(workspaceId, lease.name, signal));
    }
    const instances = new Map((await lxd.instances()).map((instance) => [instance.name, instance]));
    return await Promise.all(leases.map(async (lease) => {
      if (!here(lease)) return viewOf(lease, "disconnected", []);
      const instance = instances.get(lease.instance);
      return viewOf(lease, stateOf(lease, instance), instance ? await lxd.snapshots(lease.instance) : []);
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
      if (closing.has(workspaceId)) throw refused("This workspace is being deleted, so it can't have new machines");
      const { profiles, maxMachines } = await deps.machineSettings(workspaceId);
      if (!profiles.length) throw refused("This workspace's template has no machine profiles yet. Ask the user to add one in the template's settings, under Machines.");
      const profile = profiles.find((candidate) => candidate.name === request.profile);
      if (!profile) throw refused(`There's no machine profile called ${request.profile}. This workspace can use ${profiles.map((candidate) => candidate.name).join(", ")}.`);
      const leases = await readLeases(workspaceId);
      if (leases.length >= maxMachines) throw refused(`This workspace already has ${leases.length} of its ${maxMachines} machines. Release one first.`);
      let name = request.name?.trim() || "";
      for (let number = 1; !name; number++) if (!leases.some((lease) => lease.name === `${profile.name}-${number}`)) name = `${profile.name}-${number}`;
      if (!machineNamePattern.test(name)) throw new AgentsInTheCloudCoreError("invalid_arguments", "Machine names use lowercase letters, digits and hyphens, start with a letter, and have up to 40 characters");
      // `ssh <name>` reaches the machine, so it mustn't shadow the workspace itself.
      if (name === "localhost") throw new AgentsInTheCloudCoreError("invalid_arguments", "A machine can't be called localhost");
      if (leases.some((lease) => lease.name === name)) throw refused(`This workspace already has a machine called ${name}`);
      // Refuse before recording anything when no LXD server is connected.
      const { location } = await connected();
      await deps.publicKey(workspaceId);
      const now = Date.now();
      await writeLeases(workspaceId, [...leases, {
        name,
        location,
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
      const lxd = await lxdFor(lease);
      const running = (await lxd.instance(lease.instance)).status === "Running";
      if (running) {
        // A snapshot holds what's on the machine's disks, so what it has only written to memory so far goes there first.
        const flushed = await lxd.run(lease.instance, ["sync"]);
        if (flushed.exitCode !== 0) throw refused(`Couldn't save what ${name} has written before the snapshot: ${flushed.stderr.trim()}`);
      }
      // Paused, its disks are saved as they were at one moment.
      const pause = running && lease.volumes.length > 0;
      if (pause) await lxd.setInstanceState(lease.instance, "freeze");
      try {
        if (pause) await deps.changed(workspaceId, await readLeases(workspaceId));
        // Its extra disks aren't part of its own snapshot. That comes last, so a listed snapshot has every disk.
        for (const volume of lease.volumes) await lxd.createVolumeSnapshot(lease.pool!, volume, snapshotName);
        await lxd.createSnapshot(lease.instance, snapshotName);
      } finally {
        if (pause) {
          await lxd.setInstanceState(lease.instance, "unfreeze");
          await deps.changed(workspaceId, await readLeases(workspaceId));
        }
      }
    });
    return await view(workspaceId, name);
  }

  async function restore(workspaceId: string, name: string, snapshotName: string, waitMs: number, signal?: AbortSignal): Promise<MachineView> {
    const lxd = await serialize(workspaceId, async () => {
      const lease = await find(workspaceId, name);
      if (lease.status !== "ready") throw refused(`${name} isn't ready yet, so it can't be restored`);
      const lxd = await lxdFor(lease);
      if (!(await lxd.snapshots(lease.instance)).includes(snapshotName)) throw refused(`${name} has no snapshot called ${snapshotName}`);
      // Its disks can't be restored while it runs, and what it's running is about to be discarded.
      if ((await lxd.instance(lease.instance)).status !== "Stopped") await lxd.setInstanceState(lease.instance, "stop", true);
      for (const volume of lease.volumes) await lxd.restoreVolumeSnapshot(lease.pool!, volume, snapshotName);
      await lxd.restoreSnapshot(lease.instance, snapshotName);
      await lxd.setInstanceState(lease.instance, "start");
      const leases = await readLeases(workspaceId);
      leases.find((candidate) => candidate.name === name)!.status = "starting";
      await writeLeases(workspaceId, leases);
      return lxd;
    });
    const task = start(workspaceId, name, (taskSignal) => failOnError(workspaceId, name, taskSignal, () => becomeReady(workspaceId, name, lxd, taskSignal)));
    await within(task.done, waitMs, signal);
    return await view(workspaceId, name);
  }

  /**
   * Starts machines that are stopped, for example since their workspace was parked, and waits up to
   * `waitMs` for them to boot. Without `names`, wakes all of the workspace's machines.
   */
  async function wake(workspaceId: string, names?: string[], waitMs = 0, signal?: AbortSignal): Promise<void> {
    if (!(await readLeases(workspaceId)).length) return;
    const lxd = await connected();
    const woken = await serialize(workspaceId, async () => {
      const leases = await readLeases(workspaceId);
      const statuses = new Map((await lxd.instances()).map((instance) => [instance.name, instance.status]));
      const stopped = leases.filter((lease) => lease.status === "ready" && sameLxdLocation(lease.location, lxd.location) && statuses.get(lease.instance) === "Stopped" && (!names || names.includes(lease.name)));
      for (const lease of stopped) {
        await lxd.setInstanceState(lease.instance, "start");
        lease.status = "starting";
      }
      if (stopped.length) await writeLeases(workspaceId, leases);
      return stopped.map((lease) => lease.name);
    });
    const booting = woken.map((name) => start(workspaceId, name, (taskSignal) => failOnError(workspaceId, name, taskSignal, () => becomeReady(workspaceId, name, lxd, taskSignal))));
    if (booting.length) await within(Promise.all(booting.map((task) => task.done)).then(() => undefined), waitMs, signal);
  }

  /** For a new connection: starts the machine if it's stopped, waits while it boots, and returns the LXD project it's in. */
  async function usable(workspaceId: string, name: string, waitMs: number): Promise<Lxd> {
    const lxd = await lxdFor(await find(workspaceId, name));
    await wake(workspaceId, [name], waitMs);
    const task = tasks.get(taskKey(workspaceId, name));
    if (task) await within(task.done, waitMs);
    return lxd;
  }

  /** Shuts down a workspace's running machines, as when it's parked. Their next use starts them again. */
  async function stopAll(workspaceId: string): Promise<void> {
    const leases = await readLeases(workspaceId);
    if (!leases.length) return;
    const lxd = await connected();
    const statuses = new Map((await lxd.instances()).map((instance) => [instance.name, instance.status]));
    await Promise.all(leases.filter((lease) => lease.status === "ready" && sameLxdLocation(lease.location, lxd.location) && statuses.get(lease.instance) === "Running").map((lease) => lxd.setInstanceState(lease.instance, "stop")));
  }

  /** Releases the machines in the connected LXD project whose lifetime is over, returning their names. */
  async function expire(workspaceId: string, now: number): Promise<string[]> {
    const { location } = await connected();
    const expired = (await readLeases(workspaceId)).filter((lease) => lease.expiresAt <= now && sameLxdLocation(lease.location, location));
    for (const lease of expired) await release(workspaceId, lease.name);
    return expired.map((lease) => lease.name);
  }

  /**
   * For a workspace being deleted: it can't have new machines anymore, and the ones in the connected LXD
   * project are released. Returns the names of the others, which stay where they are.
   */
  async function releaseAll(workspaceId: string): Promise<string[]> {
    closing.add(workspaceId);
    try {
      // Machines already being acquired are recorded first, so they're released too.
      await serialize(workspaceId, async () => undefined);
      const lxd = await deps.lxd();
      const kept: string[] = [];
      for (const lease of await readLeases(workspaceId)) {
        if (lxd && sameLxdLocation(lease.location, lxd.location)) await release(workspaceId, lease.name);
        else kept.push(lease.name);
      }
      return kept;
    } catch (error) {
      // The deletion stops, and the workspace carries on as before.
      closing.delete(workspaceId);
      throw error;
    }
  }

  /** Deletes the machine, its disks and its snapshots. A machine still being created is finished first. */
  async function release(workspaceId: string, name: string): Promise<void> {
    await lxdFor(await find(workspaceId, name));
    const task = tasks.get(taskKey(workspaceId, name));
    task?.controller.abort();
    await task?.done;
    await serialize(workspaceId, async () => {
      const leases = await readLeases(workspaceId);
      const lease = leases.find((candidate) => candidate.name === name);
      if (!lease) throw refused(`This workspace has no machine called ${name}`);
      const lxd = await lxdFor(lease);
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

  return { acquire, list, waitFor, snapshot, restore, release, wake, usable, stopAll, expire, releaseAll, settings: deps.machineSettings, stored: readLeases };
}

export type MachineLeases = ReturnType<typeof createMachineLeases<MachineLxd>>;
