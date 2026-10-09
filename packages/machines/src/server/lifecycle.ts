import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { escapeHtml, type WorkspaceDeletionReview, type WorkspaceServerModuleContext } from "@agents-in-the-cloud/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { LxdInstance } from "../lxd/index.ts";
import { readLxdConnection } from "./connection.ts";
import { removeInstance, type MachineLxd } from "./leases.ts";
import { workspaceMachinesDirectory, workspacesWithMachines } from "./machine-key.ts";
import { machineLeases, machineTunnels } from "./runtime.ts";

const sweepIntervalMs = 5 * 60_000;
const evidenceSchema = Type.Object({ machines: Type.Array(Type.String()), connected: Type.Boolean() });

/** A workspace's machines go with it, so deleting it asks first. */
export const machinesDeletionReview: WorkspaceDeletionReview = {
  async inspect(workspaceId) {
    const machines = (await machineLeases.stored(workspaceId)).map((lease) => lease.name).sort();
    if (!machines.length) return { status: "clear" };
    const connected = (await readLxdConnection()) !== undefined;
    return { status: "blocked", fingerprint: createHash("sha256").update(JSON.stringify({ machines, connected })).digest("hex"), details: { machines, connected } };
  },
  renderEvidence(_workspaceId, details) {
    if (!Value.Check(evidenceSchema, details)) throw new Error("Machine deletion evidence is invalid");
    const note = details.connected
      ? "Its machines will be deleted too, with their disks and snapshots:"
      : "Its machines will stay on their LXD server, which isn’t connected right now. Reconnect it in Settings to delete them there:";
    const rows = details.machines.map((name) => `<div class="managed-list__item"><span class="managed-list__visual" aria-hidden="true">${Icons.Server}</span><div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">${escapeHtml(name)}</span></div></div></div>`).join("");
    return `<section class="workspace-deletion-machines"><p>${note}</p><div class="managed-list">${rows}</div></section>`;
  },
};

/** Machines in the LXD project that no workspace's lease accounts for, such as ones a workspace left behind while LXD was disconnected. */
export async function untrackedMachines(lxd: MachineLxd): Promise<LxdInstance[]> {
  const tracked = new Set<string>();
  for (const workspaceId of await workspacesWithMachines()) for (const lease of await machineLeases.stored(workspaceId)) tracked.add(lease.instance);
  return (await lxd.instances()).filter((instance) => instance.config["user.aitc.workspace"] !== undefined && !tracked.has(instance.name));
}

/** Deletes an untracked machine and the extra disks AITC made for it. Never runs on its own. */
export async function deleteUntrackedMachine(lxd: MachineLxd, name: string): Promise<void> {
  const machine = (await untrackedMachines(lxd)).find((instance) => instance.name === name);
  if (!machine) throw new AgentsInTheCloudCoreError("machine_unavailable", `${name} isn't a machine AgentsInTheCloud has lost track of`);
  await removeInstance(lxd, name);
  for (const device of Object.values(machine.devices)) {
    if (device.type === "disk" && device.pool && device.source?.startsWith(`${name}-disk`)) await lxd.deleteVolume(device.pool, device.source);
  }
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
    if (await readLxdConnection()) await machineLeases.releaseAll(workspaceId);
    else if ((await machineLeases.stored(workspaceId)).length) console.warn(`[machines] No LXD server is connected, so workspace ${workspaceId}'s machines stay on it, untracked`);
  });
  context.onWorkspaceRemoved(async (workspaceId) => {
    await machineTunnels.close(workspaceId);
    await rm(workspaceMachinesDirectory(workspaceId), { recursive: true, force: true });
  });
  context.events.on("workspace_suspending", ({ workspaceId }) => {
    // Parking doesn't wait for VMs to shut down; their next use starts them again.
    void machineLeases.stopAll(workspaceId).catch((error: Error) => console.error(`[machines] Couldn't stop workspace ${workspaceId}'s machines:`, error));
  });
  const sweep = setInterval(() => void sweepExpired(), sweepIntervalMs);
  sweep.unref();
  context.events.on("agents_in_the_cloud_host_stopping", () => clearInterval(sweep));
  void sweepExpired();
}
