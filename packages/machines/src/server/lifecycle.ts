import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { errorMessage, escapeHtml, type WorkspaceDeletionReview, type WorkspaceServerModuleContext } from "@agents-in-the-cloud/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { lxdLocation, sameLxdLocation, type LxdInstance } from "../lxd/index.ts";
import { readLxdConnection } from "./connection.ts";
import { removeInstance, type MachineLxd } from "./leases.ts";
import { workspaceMachinesDirectory, workspacesWithMachines } from "./machine-key.ts";
import { machineLeases, machineTunnels } from "./runtime.ts";

const sweepIntervalMs = 5 * 60_000;
const evidenceSchema = Type.Object({ deleted: Type.Array(Type.String()), kept: Type.Array(Type.String()) });

function machineList(names: string[]): string {
  const rows = names.map((name) => `<div class="managed-list__item"><span class="managed-list__visual" aria-hidden="true">${Icons.Server}</span><div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">${escapeHtml(name)}</span></div></div></div>`).join("");
  return `<div class="managed-list">${rows}</div>`;
}

/** A workspace's machines go with it, so deleting it asks first. */
export const machinesDeletionReview: WorkspaceDeletionReview = {
  async inspect(workspaceId) {
    const leases = await machineLeases.stored(workspaceId);
    if (!leases.length) return { status: "clear" };
    const connection = await readLxdConnection();
    const here = connection && lxdLocation(connection);
    const deleted = leases.filter((lease) => here && sameLxdLocation(lease.location, here)).map((lease) => lease.name).sort();
    const kept = leases.map((lease) => lease.name).filter((name) => !deleted.includes(name)).sort();
    return { status: "blocked", fingerprint: createHash("sha256").update(JSON.stringify({ deleted, kept })).digest("hex"), details: { deleted, kept } };
  },
  renderEvidence(_workspaceId, details) {
    if (!Value.Check(evidenceSchema, details)) throw new Error("Machine deletion evidence is invalid");
    const sections = [];
    if (details.deleted.length) sections.push(`<p>Deleting this workspace also deletes its machines, with their disks and snapshots:</p>${machineList(details.deleted)}`);
    if (details.kept.length) sections.push(`<p>${details.deleted.length ? "These machines" : "Its machines"} stay on their LXD server, which isn’t connected right now. Connect it again in Settings to delete them there:</p>${machineList(details.kept)}`);
    return `<section class="workspace-deletion-machines">${sections.join("")}</section>`;
  },
};

/** Machines in the LXD project that no workspace's lease accounts for, such as ones a workspace left behind while LXD was disconnected. */
export async function untrackedMachines(lxd: MachineLxd): Promise<LxdInstance[]> {
  const tracked = new Set<string>();
  for (const workspaceId of await workspacesWithMachines()) {
    for (const lease of await machineLeases.stored(workspaceId)) if (sameLxdLocation(lease.location, lxd.location)) tracked.add(lease.instance);
  }
  return (await lxd.instances()).filter((instance) => instance.config["user.aitc.workspace"] !== undefined && !tracked.has(instance.name));
}

/** Deletes an untracked machine, the extra disks AITC made for it, and its workspace's network once that's unused. Never runs on its own. */
export async function deleteUntrackedMachine(lxd: MachineLxd, name: string): Promise<void> {
  const machine = (await untrackedMachines(lxd)).find((instance) => instance.name === name);
  if (!machine) throw new AgentsInTheCloudCoreError("machine_unavailable", `${name} isn't a machine AgentsInTheCloud has lost track of`);
  await removeInstance(lxd, name);
  // With the machine gone, nothing lists its disks anymore, so ones that are left get named here.
  const left: { pool: string; volume: string; error: unknown }[] = [];
  for (const device of Object.values(machine.devices)) {
    if (device.type !== "disk" || !device.pool || !device.source?.startsWith(`${name}-disk`)) continue;
    try {
      await lxd.deleteVolume(device.pool, device.source);
    } catch (error) {
      left.push({ pool: device.pool, volume: device.source, error });
    }
  }
  await machineLeases.removeNetworkIfUnused(lxd, machine.config["user.aitc.workspace"]!);
  if (!left.length) return;
  const commands = left.map(({ pool, volume }) => `lxc storage volume delete ${pool} ${volume} --project ${lxd.location.project}`);
  throw new AgentsInTheCloudCoreError("machine_unavailable", `${name} is deleted, but ${left.length === 1 ? "one of its disks isn’t" : "some of its disks aren’t"} (${errorMessage(left[0]!.error)}). To delete ${left.length === 1 ? "it" : "them"}, run ${commands.join(" and ")} on the LXD server.`);
}

async function sweepExpired(): Promise<void> {
  // Machines can't be released without their server; they're swept once it's connected again.
  if (!await readLxdConnection()) return;
  for (const workspaceId of await workspacesWithMachines()) {
    try {
      const expired = await machineLeases.expire(workspaceId, Date.now());
      if (expired.length) console.log(`[machines] Released expired machines of workspace ${workspaceId}: ${expired.join(", ")}`);
    } catch (error) {
      console.error(`[machines] Couldn't release expired machines of workspace ${workspaceId}:`, error);
    }
  }
}

export function registerMachineLifecycle(context: WorkspaceServerModuleContext): void {
  // A failure here stops the deletion, so machines are never silently left behind.
  context.events.on("workspace_deleting", async ({ workspaceId }) => {
    const kept = await machineLeases.releaseAll(workspaceId);
    if (kept.length) console.warn(`[machines] Workspace ${workspaceId}'s machines ${kept.join(", ")} stay on an LXD server that isn't connected, untracked`);
  });
  // A deletion that stops leaves the workspace as it was; trying again releases whatever it gets meanwhile.
  context.events.on("workspace_delete_failed", ({ workspaceId }) => machineLeases.reopen(workspaceId));
  context.onWorkspaceRemoved(async (workspaceId) => {
    await machineTunnels.close(workspaceId);
    await rm(workspaceMachinesDirectory(workspaceId), { recursive: true, force: true });
  });
  context.events.on("workspace_suspending", ({ workspaceId }) => {
    // Parking doesn't wait for VMs to shut down; their next use waits for that, then starts them again.
    void machineLeases.stopAll(workspaceId).catch((error: Error) => console.error(`[machines] Couldn't stop workspace ${workspaceId}'s machines:`, error));
  });
  // Nothing waits for a sweep, so a failure that isn't one workspace's, like an unreadable connection, is reported here.
  const sweepNow = () => void sweepExpired().catch((error: Error) => console.error("[machines] Couldn't release expired machines:", error));
  const sweep = setInterval(sweepNow, sweepIntervalMs);
  sweep.unref();
  context.events.on("agents_in_the_cloud_host_stopping", () => clearInterval(sweep));
  sweepNow();
}
