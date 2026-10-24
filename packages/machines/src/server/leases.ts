import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { AgentsInTheCloudCoreError, createKeyedOperationQueue, readTextIfExists, writeJsonAtomic } from "@agents-in-the-cloud/core";
import { errorMessage } from "@agents-in-the-cloud/shared";
import { machineImageServers, type WorkspaceTemplateMachineProfile } from "@agents-in-the-cloud/workspace-templates";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { LxdRequestError, sameLxdLocation, type LxdClient, type LxdInstance, type LxdInstanceDetails, type LxdInstancesPost } from "../lxd/index.ts";
import { answeredInTime } from "./connection.ts";
import { lxdVersionKeepsSnapshots, machineDnsDomain, machineNetworkAcl, machineNetworkAclRules, projectSandbox, workspaceNetworkConfig, workspaceNetworkName, workspaceNetworkSecurity } from "./sandbox.ts";

const leaseSchema = Type.Object({
  name: Type.String(),
  /** The LXD project the machine is in, which may not be connected now. */
  location: Type.Object({ address: Type.String(), fingerprint: Type.String(), project: Type.String() }),
  instance: Type.String(),
  /** What the machine was made from; later profile changes don't touch it. */
  profile: Type.Object({
    name: Type.String(),
    image: Type.String(),
    type: Type.Union([Type.Literal("virtual-machine"), Type.Literal("container")]),
    lxdProfiles: Type.Array(Type.String()),
    cpus: Type.Number(),
    memoryGiB: Type.Number(),
    diskSizesGiB: Type.Array(Type.Number()),
  }),
  pool: Type.Optional(Type.String()),
  volumes: Type.Array(Type.String()),
  createdAt: Type.Number(),
  expiresAt: Type.Number(),
  status: Type.Union([Type.Literal("creating"), Type.Literal("starting"), Type.Literal("ready"), Type.Literal("restoring"), Type.Literal("failed")]),
  error: Type.Optional(Type.String()),
  /** `type base64` lines, for the workspace's known_hosts. */
  hostKeys: Type.Array(Type.String()),
});
const leaseStoreSchema = Type.Object({ leases: Type.Array(leaseSchema) });
export type MachineLease = Static<typeof leaseSchema>;

export type MachineLxd = Pick<LxdClient, "location" | "server" | "projectConfig" | "network" | "createNetwork" | "updateNetwork" | "deleteNetwork" | "networkAcl" | "createNetworkAcl" | "updateNetworkAcl" | "instances" | "instance" | "profileDevices" | "createBlockVolume" | "deleteVolume" | "createVolumeSnapshot" | "restoreVolumeSnapshot" | "createInstance" | "setInstanceState" | "deleteInstance" | "readInstanceFile" | "details" | "snapshots" | "createSnapshot" | "restoreSnapshot">;

export interface MachineSettings {
  profiles: WorkspaceTemplateMachineProfile[];
  maxMachines: number;
}

export interface MachineLeaseDependencies<Lxd extends MachineLxd = MachineLxd> {
  /** The connected LXD projects, in the order they were connected. */
  lxds(): Promise<Lxd[]>;
  machineSettings(workspaceId: string): Promise<MachineSettings>;
  publicKey(workspaceId: string): Promise<string>;
  /** Whether ssh in the workspace can reach its machines; workspaces made before there were machines can't. */
  reachesMachines(workspaceId: string): Promise<boolean>;
  directory(workspaceId: string): string;
  /** How long cloud-init may take before a machine counts as failed. */
  bootTimeoutMs: number;
  pollMs: number;
  /** Runs after every change to a workspace's leases or how its machines run, before the change counts as made. */
  changed(workspaceId: string, leases: MachineLease[]): Promise<void>;
}

/** An interrupted machine didn't finish restoring, so its disks may be from different points in time; it stays stopped until a restore does. */
export type MachineState = "creating" | "starting" | "ready" | "saving" | "stopped" | "restoring" | "interrupted" | "failed" | "missing" | "disconnected";

export interface MachineView {
  name: string;
  profile: string;
  type: MachineLease["profile"]["type"];
  image: string;
  cpus: number;
  memoryGiB: number;
  diskSizesGiB: number[];
  state: MachineState;
  /** The address of the LXD server it's on. */
  server: string;
  /** The name the workspace's other machines know it by; its own hostname is `name`, which they don't. */
  dnsName: string;
  /** Where the workspace's other machines reach it, while it runs. */
  addresses: string[];
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

interface ProfileDevice { profile: string; device: Awaited<ReturnType<MachineLxd["profileDevices"]>>[string] }

/** The devices a machine's LXD profiles give it, by name: a later profile's device replaces an earlier one's, as when LXD applies them. */
async function profileDevices(lxd: MachineLxd, profiles: string[]): Promise<Map<string, ProfileDevice>> {
  const devices = new Map<string, ProfileDevice>();
  for (const profile of profiles) {
    const own = await lxd.profileDevices(profile).catch((error: Error) => {
      throw isMissing(error) ? refused(`The LXD server has no profile called ${profile}. Create it there, or change the machine profile in the template's settings.`) : error;
    });
    for (const [name, device] of Object.entries(own)) devices.set(name, { profile, device });
  }
  return devices;
}

/** Extra disks go in the storage pool of the machine's root disk, which its LXD profiles define. */
async function rootDiskPool(lxd: MachineLxd, profiles: string[]): Promise<string> {
  const pool = [...(await profileDevices(lxd, profiles)).values()].find(({ device }) => device.type === "disk" && device.path === "/")?.device.pool;
  if (!pool) throw refused(`None of the LXD profiles ${profiles.join(", ")} gives machines a root disk, so there's no storage pool for their extra disks`);
  return pool;
}

/** Keeps the ACL of machine networks as `egress-policy.ts` says, also when that has changed or someone edited it. */
async function applyNetworkAcl(lxd: MachineLxd): Promise<void> {
  const rules = machineNetworkAclRules();
  try {
    const current = await lxd.networkAcl(machineNetworkAcl);
    if (!isDeepStrictEqual(current, { egress: rules.egress, ingress: rules.ingress })) await lxd.updateNetworkAcl(machineNetworkAcl, rules);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await lxd.createNetworkAcl(machineNetworkAcl, rules);
  }
}

/**
 * Deletes the workspace's network once none of its machines are left in the project, so idle workspaces hold no uplink
 * address. `leases` are the ones it has now, which may still be creating their instances.
 */
async function removeUnusedNetwork(lxd: MachineLxd, workspaceId: string, leases: MachineLease[]): Promise<void> {
  if (leases.some((lease) => sameLxdLocation(lease.location, lxd.location))) return;
  const network = workspaceNetworkName(workspaceId);
  try {
    // Machines AITC lost track of may still use it.
    if ((await lxd.network(network)).usedBy.length) return;
    await lxd.deleteNetwork(network);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
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

/** Throws the first failure among `results`, which are all settled by then. */
function throwFirstFailure(results: PromiseSettledResult<unknown>[]): void {
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
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

function stateOf(lease: MachineLease, instance: LxdInstance | undefined, restoring: boolean, saving: boolean): MachineState {
  if (lease.status === "restoring") return restoring ? "restoring" : "interrupted";
  if (lease.status !== "ready") return lease.status;
  if (saving) return "saving";
  if (!instance) return "missing";
  return instance.status === "Running" ? "ready" : "stopped";
}

const unknownDetails: LxdInstanceDetails = { snapshots: [], addresses: [] };

/** `server` is where the machine's LXD server is now, which it may have moved from since. */
function viewOf(lease: MachineLease, state: MachineState, { snapshots, addresses }: LxdInstanceDetails, server = lease.location.address): MachineView {
  const view: MachineView = {
    name: lease.name,
    profile: lease.profile.name,
    type: lease.profile.type,
    image: lease.profile.image,
    cpus: lease.profile.cpus,
    memoryGiB: lease.profile.memoryGiB,
    diskSizesGiB: lease.profile.diskSizesGiB,
    state,
    server,
    dnsName: `${lease.instance}.${machineDnsDomain}`,
    addresses,
    expiresAt: new Date(lease.expiresAt).toISOString(),
    snapshots,
  };
  if (lease.error) view.error = lease.error;
  else if (state === "interrupted") view.error = "AgentsInTheCloud restarted before it finished";
  return view;
}

interface Task { controller: AbortController; done: Promise<void> }

/** Wait up to `ms` for the machines to boot, or until the caller gives up. */
async function untilBooted(booting: Task[], ms: number, signal?: AbortSignal): Promise<void> {
  if (booting.length) await within(Promise.all(booting.map((task) => task.done)).then(() => undefined), ms, signal);
}

/** The connected LXD project the machine is in, if it's connected. */
function at<Lxd extends MachineLxd>(lxds: Lxd[], lease: MachineLease): Lxd | undefined {
  return lxds.find((lxd) => sameLxdLocation(lease.location, lxd.location));
}

/** A machine stays in the LXD project it was made in. While that isn't connected, it's out of reach. */
function lxdOf<Lxd extends MachineLxd>(lxds: Lxd[], lease: MachineLease): Lxd {
  const lxd = at(lxds, lease);
  if (!lxd) throw refused(`${lease.name} is on the LXD server at ${lease.location.address}, in project ${lease.location.project}, which isn't connected now. It can be used or released once that's connected again in Settings, under Machines.`);
  return lxd;
}

/** Refuses an LXD project that can't take a machine from `profile`, or keep it sandboxed, saying why. Returns the uplink for the workspace's network. */
async function uplinkFor(lxd: MachineLxd, profile: WorkspaceTemplateMachineProfile): Promise<string> {
  const { version, instanceTypes } = await lxd.server();
  if (!lxdVersionKeepsSnapshots(version)) throw refused(`The LXD server runs LXD ${version}, and machines need LXD 6.9 or later. Ask the user to upgrade it, or to connect another one in Settings, under Machines.`);
  if (!instanceTypes.includes(profile.type)) throw refused(`The LXD server can't run ${profile.type === "virtual-machine" ? "virtual machines, as it has no hardware virtualization (/dev/kvm)" : "containers"}. Ask the user to connect one that can in Settings, under Machines, or to change the machine profile in the template's settings.`);
  const { uplink, missing, unsafe } = projectSandbox(await lxd.projectConfig(lxd.location.project));
  if (!uplink || missing.length || unsafe.length) throw refused(`The LXD project ${lxd.location.project} isn't set up to keep machines apart from the rest of the network, so AgentsInTheCloud won't create them there. Ask the user to look at Settings, under Machines.`);
  // The machine's own eth0 replaces any its LXD profiles have, but another network device would get past its workspace's network.
  const nic = [...await profileDevices(lxd, profile.lxdProfiles)].find(([key, { device }]) => key !== "eth0" && device.type === "nic");
  if (nic) throw refused(`The LXD profile ${nic[1].profile} gives machines another network device, ${nic[0]}, which could connect them to more than their workspace's other machines. Ask the user to remove it from that profile on the LXD server, or to change the machine profile in the template's settings.`);
  return uplink;
}

/**
 * Where a workspace's next machine goes. Its machines reach each other on its network, which is on one LXD server, so
 * they all go where its first one did. That one goes to the server with the fewest machines among those that can take it.
 */
async function placement<Lxd extends MachineLxd>(lxds: Lxd[], leases: MachineLease[], profile: WorkspaceTemplateMachineProfile): Promise<{ lxd: Lxd; uplink: string }> {
  const home = lxds.find((lxd) => leases.some((lease) => sameLxdLocation(lease.location, lxd.location)));
  const only = home ?? (lxds.length === 1 ? lxds[0] : undefined);
  if (only) return { lxd: only, uplink: await uplinkFor(only, profile) };
  // One that's out of reach doesn't hold up the others.
  const checked = await Promise.allSettled(lxds.map(async (lxd) => ({
    lxd,
    uplink: await answeredInTime(uplinkFor(lxd, profile)),
    machines: (await answeredInTime(lxd.instances())).length,
  })));
  const usable = checked.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const reasons = checked.flatMap((result, index) => result.status === "rejected" ? [`At ${lxds[index]!.location.address}: ${errorMessage(result.reason)}`] : []);
  if (!usable.length) throw refused(`None of the connected LXD servers can take this machine. ${reasons.join(" ")}`);
  return usable.reduce((fewest, candidate) => candidate.machines < fewest.machines ? candidate : fewest);
}

/** The machines each workspace leases. Store changes run one at a time per workspace; creating and booting run alongside. */
export function createMachineLeases<Lxd extends MachineLxd>(deps: MachineLeaseDependencies<Lxd>) {
  const serialize = createKeyedOperationQueue();
  /** Not a workspace ID, so changes to a project's ACL run one at a time, alongside workspaces' changes. */
  const networkAclKey = (lxd: MachineLxd) => `\0network-acl\0${lxd.location.fingerprint}\0${lxd.location.project}`;
  const tasks = new Map<string, Task>();
  /** Machines this process has worked on. Any other lease left creating or starting was interrupted by a restart. */
  const known = new Set<string>();
  /** Machines being restored right now; a lease left restoring otherwise was interrupted. */
  const restoring = new Set<string>();
  /** Machines shut down while a snapshot of them is saved. */
  const saving = new Set<string>();
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

  async function connected(): Promise<Lxd[]> {
    const lxds = await deps.lxds();
    if (!lxds.length) throw refused("No LXD server is connected, so there are no machines. Ask the user to connect one in Settings, under Machines.");
    return lxds;
  }

  async function lxdFor(lease: MachineLease): Promise<Lxd> {
    return lxdOf(await connected(), lease);
  }

  /** The workspace's ready machines, on connected servers, whose instances have `status`. */
  async function readyWithStatus(lxds: Lxd[], leases: MachineLease[], status: string): Promise<MachineLease[]> {
    const matching: MachineLease[] = [];
    for (const lxd of lxds) {
      const here = leases.filter((lease) => lease.status === "ready" && sameLxdLocation(lease.location, lxd.location));
      if (!here.length) continue;
      const statuses = new Map((await lxd.instances()).map((instance) => [instance.name, instance.status]));
      matching.push(...here.filter((lease) => statuses.get(lease.instance) === status));
    }
    return matching;
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
    known.add(key);
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

  /** Watches machines that were just started until they've booted, and records on each whether it did. */
  function boot(workspaceId: string, machines: MachineLease[], lxds: Lxd[]): Task[] {
    return machines.map((lease) => {
      const lxd = lxdOf(lxds, lease);
      return start(workspaceId, lease.name, (signal) => failOnError(workspaceId, lease.name, signal, () => becomeReady(workspaceId, lease.name, lxd, signal)));
    });
  }

  /**
   * Starts `machines`, all together, and watches them boot. Ones that start count as starting, also when another one
   * doesn't; the first failure is thrown once every start has finished. Runs in the workspace's queue, with all its `leases`.
   */
  async function startMachines(workspaceId: string, leases: MachineLease[], machines: MachineLease[], lxds: Lxd[]): Promise<Task[]> {
    const starts = await Promise.allSettled(machines.map((lease) => lxdOf(lxds, lease).setInstanceState(lease.instance, "start")));
    const started = machines.filter((_, index) => starts[index]!.status === "fulfilled");
    for (const lease of started) lease.status = "starting";
    await writeLeases(workspaceId, leases);
    const booting = boot(workspaceId, started, lxds);
    throwFirstFailure(starts);
    return booting;
  }

  async function provision(workspaceId: string, name: string, signal: AbortSignal): Promise<void> {
    await failOnError(workspaceId, name, signal, async () => {
      const lease = await find(workspaceId, name);
      const lxd = await lxdFor(lease);
      const sizes = lease.profile.diskSizesGiB;
      // This replaces any eth0 the machine's LXD profiles have.
      const devices: NonNullable<LxdInstancesPost["devices"]> = { eth0: { type: "nic", name: "eth0", network: workspaceNetworkName(workspaceId) } };
      if (sizes.length) {
        const pool = await rootDiskPool(lxd, lease.profile.lxdProfiles);
        signal.throwIfAborted();
        const volumes = sizes.map((_, index) => `${lease.instance}-disk${index + 1}`);
        // Recorded before they exist, so releasing a half-made machine still finds its disks.
        await update(workspaceId, name, (stored) => {
          stored.pool = pool;
          stored.volumes = volumes;
        });
        for (const [index, size] of sizes.entries()) await lxd.createBlockVolume(pool, volumes[index]!, `${size}GiB`);
        for (const [index, volume] of volumes.entries()) devices[`disk${index + 1}`] = { type: "disk", pool, source: volume };
      }
      const config: NonNullable<LxdInstancesPost["config"]> = {
        "user.aitc.workspace": workspaceId,
        "user.aitc.lease": name,
        "cloud-init.vendor-data": vendorData(name, await deps.publicKey(workspaceId)),
        "limits.cpu": String(lease.profile.cpus),
        "limits.memory": `${lease.profile.memoryGiB}GiB`,
      };
      // MicroCloud turns stateful migration on for every VM, and then refuses extra disks from local pools. Machines never move.
      if (lease.profile.type === "virtual-machine") config["migration.stateful"] = "false";
      signal.throwIfAborted();
      await lxd.createInstance({
        name: lease.instance,
        description: `AgentsInTheCloud machine ${name} for workspace ${workspaceId}`,
        type: lease.profile.type,
        source: machineImageSource(lease.profile.image),
        profiles: lease.profile.lxdProfiles,
        config,
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
        // LXD lists the instance only once it has its image, which for a first VM can take minutes.
        const deadline = Date.now() + deps.bootTimeoutMs;
        while (!(await lxd.instances()).some((instance) => instance.name === lease.instance)) {
          if (Date.now() > deadline) throw refused("AgentsInTheCloud restarted before this machine was created. Release it and create a new one.");
          await delay(deps.pollMs, undefined, { signal });
        }
        await update(workspaceId, name, (stored) => { stored.status = "starting"; });
      }
      await becomeReady(workspaceId, name, lxd, signal);
    });
  }

  async function list(workspaceId: string): Promise<MachineView[]> {
    const leases = await readLeases(workspaceId);
    if (!leases.length) return [];
    // Only the servers its machines are on.
    const lxds = (await deps.lxds()).filter((lxd) => leases.some((lease) => sameLxdLocation(lease.location, lxd.location)));
    for (const lease of leases) {
      if ((lease.status === "creating" || lease.status === "starting") && at(lxds, lease) && !known.has(taskKey(workspaceId, lease.name))) start(workspaceId, lease.name, (signal) => resume(workspaceId, lease.name, signal));
    }
    const instances = new Map(await Promise.all(lxds.map(async (lxd) => [lxd, new Map((await lxd.instances()).map((instance) => [instance.name, instance]))] as const)));
    return await Promise.all(leases.map(async (lease) => {
      const lxd = at(lxds, lease);
      if (!lxd) return viewOf(lease, "disconnected", unknownDetails);
      const instance = instances.get(lxd)!.get(lease.instance);
      const key = taskKey(workspaceId, lease.name);
      return viewOf(lease, stateOf(lease, instance, restoring.has(key), saving.has(key)), instance ? await lxd.details(lease.instance) : unknownDetails, lxd.location.address);
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
      if (!await deps.reachesMachines(workspaceId)) throw refused("This workspace is older than machines in AgentsInTheCloud, so ssh in it can't reach them. Ask the user to create a new workspace from its template to use machines.");
      // Refuse before recording anything when no LXD server is connected, or none can keep machines sandboxed.
      const { lxd, uplink } = await placement(await connected(), leases, profile);
      await deps.publicKey(workspaceId);
      // Shared by every workspace's network in the project.
      await serialize(networkAclKey(lxd), () => applyNetworkAcl(lxd));
      const network = workspaceNetworkName(workspaceId);
      const existing = await lxd.network(network).catch((error: Error) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (!existing) await lxd.createNetwork({ name: network, description: `AgentsInTheCloud machines of workspace ${workspaceId}`, type: "ovn", config: workspaceNetworkConfig(uplink) });
      // Also when someone changed what keeps it sandboxed.
      else if (Object.entries(workspaceNetworkSecurity).some(([key, value]) => existing.config[key] !== value)) await lxd.updateNetwork(network, workspaceNetworkSecurity);
      const now = Date.now();
      // Listing the machines while this records it mustn't take it for one a restart interrupted.
      known.add(taskKey(workspaceId, name));
      await writeLeases(workspaceId, [...leases, {
        name,
        location: lxd.location,
        instance: machineInstanceName(workspaceId, name),
        profile: { name: profile.name, image: profile.image, type: profile.type, lxdProfiles: profile.lxdProfiles, cpus: profile.cpus, memoryGiB: profile.memoryGiB, diskSizesGiB: profile.diskSizesGiB },
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

  async function views(workspaceId: string, names: string[]): Promise<MachineView[]> {
    const machines = await list(workspaceId);
    return names.map((name) => machines.find((machine) => machine.name === name)!);
  }

  /** The named machines' leases, each named once, in the order given. */
  function named(leases: MachineLease[], names: string[]): MachineLease[] {
    if (!names.length) throw new AgentsInTheCloudCoreError("invalid_arguments", "Name at least one machine");
    if (new Set(names).size !== names.length) throw new AgentsInTheCloudCoreError("invalid_arguments", "Name each machine once");
    return names.map((name) => {
      const lease = leases.find((candidate) => candidate.name === name);
      if (!lease) throw refused(`This workspace has no machine called ${name}`);
      return lease;
    });
  }

  /**
   * Saves each machine's disks as a snapshot. The machines shut down for it, all together, so it holds one moment across
   * all of them, which machines working together need to come back to, with their disks clean. Ones that were running
   * start again afterwards, and this waits up to `waitMs` for them to boot.
   *
   * A snapshot of a running machine can't be restored once the machine has stopped, which restoring needs: it holds the
   * name its network device had on the LXD host, and a restricted project refuses to set that (LXD 5.21 and 6.9).
   */
  async function snapshot(workspaceId: string, names: string[], snapshotName: string, waitMs: number, signal?: AbortSignal): Promise<MachineView[]> {
    if (!snapshotNamePattern.test(snapshotName)) throw new AgentsInTheCloudCoreError("invalid_arguments", "Snapshot names use letters, digits, dots, hyphens and underscores");
    const booting = await serialize(workspaceId, async () => {
      const leases = await readLeases(workspaceId);
      const machines = named(leases, names);
      const lxds = await connected();
      for (const lease of machines) {
        if (lease.status !== "ready") throw refused(`${lease.name} isn't ready yet, so it can't be snapshotted`);
        if ((await lxdOf(lxds, lease).snapshots(lease.instance)).includes(snapshotName)) throw refused(`${lease.name} already has a snapshot called ${snapshotName}`);
      }
      const running: MachineLease[] = [];
      for (const lease of machines) if ((await lxdOf(lxds, lease).instance(lease.instance)).status !== "Stopped") running.push(lease);
      for (const lease of machines) saving.add(taskKey(workspaceId, lease.name));
      let restarted: Task[] = [];
      try {
        await deps.changed(workspaceId, leases);
        // When one doesn't stop, the others still do, and need starting again below.
        throwFirstFailure(await Promise.allSettled(running.map((lease) => lxdOf(lxds, lease).setInstanceState(lease.instance, "stop"))));
        for (const lease of machines) {
          const lxd = lxdOf(lxds, lease);
          // A machine's extra disks aren't part of its own snapshot. That comes last, so a listed snapshot has every disk.
          for (const volume of lease.volumes) await lxd.createVolumeSnapshot(lease.pool!, volume, snapshotName);
          await lxd.createSnapshot(lease.instance, snapshotName);
        }
      } finally {
        for (const lease of machines) saving.delete(taskKey(workspaceId, lease.name));
        // Also when the snapshot failed, the machines that were running carry on, watched while they boot.
        const stopped: MachineLease[] = [];
        for (const lease of running) if ((await lxdOf(lxds, lease).instance(lease.instance)).status === "Stopped") stopped.push(lease);
        restarted = await startMachines(workspaceId, leases, stopped, lxds);
      }
      return restarted;
    });
    await untilBooted(booting, waitMs, signal);
    return await views(workspaceId, names);
  }

  /**
   * Puts the machines back to a snapshot they all have. All of them stop before any is restored, and they start again
   * once all are, so machines working together come back from the same moment.
   */
  async function restore(workspaceId: string, names: string[], snapshotName: string, waitMs: number, signal?: AbortSignal): Promise<MachineView[]> {
    const booting = await serialize(workspaceId, async () => {
      const leases = await readLeases(workspaceId);
      const machines = named(leases, names);
      const lxds = await connected();
      for (const lease of machines) {
        // One whose last restore didn't finish can be restored again.
        if (lease.status !== "ready" && lease.status !== "restoring") throw refused(`${lease.name} isn't ready yet, so it can't be restored`);
        if (!(await lxdOf(lxds, lease).snapshots(lease.instance)).includes(snapshotName)) throw refused(`${lease.name} has no snapshot called ${snapshotName}`);
      }
      // Until every disk is back, they're from different points in time, so nothing may start the machines meanwhile.
      for (const lease of machines) {
        lease.status = "restoring";
        delete lease.error;
        restoring.add(taskKey(workspaceId, lease.name));
      }
      try {
        await writeLeases(workspaceId, leases);
        // Their disks can't be restored while they run, and what they're running is about to be discarded.
        throwFirstFailure(await Promise.allSettled(machines.map(async (lease) => {
          const lxd = lxdOf(lxds, lease);
          if ((await lxd.instance(lease.instance)).status !== "Stopped") await lxd.setInstanceState(lease.instance, "stop", true);
        })));
        for (const lease of machines) {
          const lxd = lxdOf(lxds, lease);
          for (const volume of lease.volumes) await lxd.restoreVolumeSnapshot(lease.pool!, volume, snapshotName);
          await lxd.restoreSnapshot(lease.instance, snapshotName);
        }
        for (const lease of machines) lease.status = "ready";
      } catch (error) {
        for (const lease of machines) lease.error = errorMessage(error);
        throw error;
      } finally {
        for (const lease of machines) restoring.delete(taskKey(workspaceId, lease.name));
        await writeLeases(workspaceId, leases);
      }
      // Every disk is back, so they start from the same moment. One that doesn't start stays stopped until its next use.
      return await startMachines(workspaceId, leases, machines, lxds);
    });
    await untilBooted(booting, waitMs, signal);
    return await views(workspaceId, names);
  }

  /**
   * Starts machines that are stopped, for example since their workspace was parked, and waits up to
   * `waitMs` for them to boot. Without `names`, wakes all of the workspace's machines.
   */
  async function wake(workspaceId: string, names?: string[], waitMs = 0, signal?: AbortSignal): Promise<void> {
    if (!(await readLeases(workspaceId)).length) return;
    // Ones whose LXD server isn't connected show as out of reach instead.
    const lxds = await deps.lxds();
    const booting = await serialize(workspaceId, async () => {
      const leases = await readLeases(workspaceId);
      const stopped = await readyWithStatus(lxds, leases.filter((lease) => !names || names.includes(lease.name)), "Stopped");
      return stopped.length ? await startMachines(workspaceId, leases, stopped, lxds) : [];
    });
    await untilBooted(booting, waitMs, signal);
  }

  /** For a new connection: starts the machine if it's stopped, waits while it boots, and returns the LXD project it's in. */
  async function usable(workspaceId: string, name: string, waitMs: number): Promise<Lxd> {
    const lxd = await lxdFor(await find(workspaceId, name));
    await wake(workspaceId, [name]);
    // Whether it was just started or was booting already.
    const task = tasks.get(taskKey(workspaceId, name));
    if (task) await within(task.done, waitMs);
    return lxd;
  }

  /** Shuts down a workspace's running machines, as when it's parked. Their next use waits for that, then starts them again. */
  async function stopAll(workspaceId: string): Promise<void> {
    if (!(await readLeases(workspaceId)).length) return;
    const lxds = await deps.lxds();
    await serialize(workspaceId, async () => {
      const running = await readyWithStatus(lxds, await readLeases(workspaceId), "Running");
      throwFirstFailure(await Promise.allSettled(running.map((lease) => lxdOf(lxds, lease).setInstanceState(lease.instance, "stop"))));
    });
  }

  /**
   * Releases the machines on connected LXD servers whose lifetime is over, returning their names. They're chosen
   * and deleted in one go, so one released and made again under the same name meanwhile isn't taken for the old one.
   * A machine that's booting waits for the next sweep.
   */
  async function expire(workspaceId: string, now: number): Promise<string[]> {
    const lxds = await connected();
    return await serialize(workspaceId, async () => {
      let leases = await readLeases(workspaceId);
      const expired = leases.filter((lease) => lease.expiresAt <= now && at(lxds, lease) && !tasks.has(taskKey(workspaceId, lease.name)));
      for (const lease of expired) {
        const lxd = lxdOf(lxds, lease);
        await destroy(lxd, lease);
        leases = leases.filter((candidate) => candidate !== lease);
        await removeUnusedNetwork(lxd, workspaceId, leases);
        await writeLeases(workspaceId, leases);
      }
      return expired.map((lease) => lease.name);
    });
  }

  /**
   * For a workspace being deleted: it can't have new machines anymore, until `reopen`, and the ones on connected LXD
   * servers are released. Returns the names of the others, which stay where they are.
   */
  async function releaseAll(workspaceId: string): Promise<string[]> {
    closing.add(workspaceId);
    // Machines already being acquired are recorded first, so they're released too.
    await serialize(workspaceId, async () => undefined);
    const lxds = await deps.lxds();
    const kept: string[] = [];
    for (const lease of await readLeases(workspaceId)) {
      if (at(lxds, lease)) await release(workspaceId, lease.name);
      else kept.push(lease.name);
    }
    return kept;
  }

  /** For a workspace whose deletion didn't go through, at any step: it carries on, and can have new machines again. */
  function reopen(workspaceId: string): void {
    closing.delete(workspaceId);
  }

  /** Deletes the machine, its disks and its snapshots. Work still going on for it, like creating it, stops first. */
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
      await destroy(lxd, lease);
      const remaining = leases.filter((candidate) => candidate !== lease);
      await removeUnusedNetwork(lxd, workspaceId, remaining);
      await writeLeases(workspaceId, remaining);
    });
  }

  /** Deletes the machine's instance, with its snapshots, and its disks. */
  async function destroy(lxd: Lxd, lease: MachineLease): Promise<void> {
    await removeInstance(lxd, lease.instance);
    for (const volume of lease.volumes) {
      try {
        await lxd.deleteVolume(lease.pool!, volume);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  /** For a machine of the workspace's that AITC lost track of and deleted: its network goes too, once nothing uses it. */
  async function removeNetworkIfUnused(lxd: MachineLxd, workspaceId: string): Promise<void> {
    await serialize(workspaceId, async () => await removeUnusedNetwork(lxd, workspaceId, await readLeases(workspaceId)));
  }

  return { acquire, list, waitFor, snapshot, restore, release, wake, usable, stopAll, expire, releaseAll, reopen, removeNetworkIfUnused, settings: deps.machineSettings, stored: readLeases };
}

export type MachineLeases = ReturnType<typeof createMachineLeases<MachineLxd>>;
