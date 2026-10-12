import { registerWorkspaceAgentTool } from "@agents-in-the-cloud/agent/server/tools";
import { defineWorkspaceTool } from "@agents-in-the-cloud/agent/server/workspace-tool";
import { Type } from "typebox";
import type { MachineLeases, MachineSettings, MachineView } from "./leases.ts";

/** Long enough for a first VM image download and boot; Agents' MCP tool calls allow an hour. */
const waitMs = 10 * 60_000;

function kind(type: MachineView["type"]): string {
  return type === "virtual-machine" ? "virtual machine" : "container";
}

function resources({ cpus, memoryGiB }: { cpus: number; memoryGiB: number }): string {
  return `${cpus} ${cpus === 1 ? "CPU" : "CPUs"} and ${memoryGiB} GiB of memory`;
}

function describeMachine(machine: MachineView): string {
  const disks = machine.diskSizesGiB.length ? ` and ${machine.diskSizesGiB.length === 1 ? "an extra disk" : `${machine.diskSizesGiB.length} extra disks`} (${machine.diskSizesGiB.join(", ")} GiB)` : "";
  const what = `a ${kind(machine.type)} from ${machine.image} with ${resources(machine)}${disks}, made from profile ${machine.profile}, until ${machine.expiresAt}`;
  const snapshots = machine.snapshots.length ? ` Snapshots: ${machine.snapshots.join(", ")}.` : "";
  const addresses = machine.addresses.length ? ` Other machines reach it as ${machine.dnsName} or at ${machine.addresses.join(" or ")}, not as ${machine.name}.` : "";
  switch (machine.state) {
    case "ready": return `${machine.name} is ready: ${what}. Reach it with \`ssh ${machine.name}\`; scp and rsync work too.${addresses}${snapshots}`;
    case "creating": return `${machine.name} is being created: ${what}. Wait for it with wait_for_machine.`;
    case "starting": return `${machine.name} is booting: ${what}. Wait for it with wait_for_machine.${snapshots}`;
    case "saving": return `${machine.name} is shut down while a snapshot of it is saved: ${what}. Wait for it with wait_for_machine.${snapshots}`;
    case "stopped": return `${machine.name} is stopped: ${what}. Connecting with ssh or wait_for_machine starts it again.${snapshots}`;
    case "restoring": return `${machine.name} is being restored to a snapshot: ${what}.${snapshots}`;
    case "interrupted": return `${machine.name} didn't finish restoring to a snapshot (${machine.error}), so its disks may be from different points in time: ${what}. It stays stopped until restore_machines succeeds, or release it with release_machine.${snapshots}`;
    case "failed": return `${machine.name} couldn't be set up: ${machine.error}. Release it with release_machine.`;
    case "missing": return `${machine.name} is gone from the LXD server. Release it with release_machine.`;
    case "disconnected": return `${machine.name} is on an LXD server that isn't connected now: ${what}. It can be used or released once the user connects that server again in Settings, under Machines.`;
  }
}

function describeProfiles({ profiles, maxMachines }: MachineSettings): string {
  if (!profiles.length) return "This workspace's template has no machine profiles yet, so no machines can be created. The user can add profiles in the template's settings, under Machines.";
  const lines = profiles.map((profile) => `- ${profile.name}: a ${kind(profile.type)} from ${profile.image} with ${resources(profile)}${profile.diskSizesGiB.length ? ` and extra disks of ${profile.diskSizesGiB.join(", ")} GiB` : ""}, kept for ${profile.lifetimeHours} hours`);
  return `Profiles you can create machines from (up to ${maxMachines} at once):\n${lines.join("\n")}`;
}

type ToolDetails = MachineView | { machines: MachineView[] } | { name: string };

/** "node-1", "node-1 and node-2", "node-1, node-2 and node-3". */
function listed(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
}

function result(text: string, details: ToolDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

const machineName = Type.String({ description: "The machine's name, as acquire_machine or list_machines reported it." });
const machineNames = Type.Array(Type.String(), { minItems: 1, description: "The machines' names, as acquire_machine or list_machines reported them." });
const snapshotName = Type.String({ description: "Snapshot name: letters, digits, dots, hyphens and underscores." });

/** Gives every workspace's Agents the machine tools; returns a function that takes them away again. */
export function registerMachineTools(leases: MachineLeases): () => void {
  const unregister = [
    registerWorkspaceAgentTool("acquire_machine", (workspaceId) => defineWorkspaceTool({
      name: "acquire_machine",
      label: "Acquire Machine",
      description: "Create a fresh test machine for this workspace from one of its machine profiles: a virtual machine or container on the user's LXD server, with its own kernel and real disks, for work the workspace container can't do, like installing snaps, using block devices or forming clusters. Once it has booted, `ssh <name>` reaches it from this workspace as ubuntu, with passwordless sudo; scp, rsync and tools like juju or ansible can use the name too. Machines reach each other by the names and addresses list_machines reports, not by their short names. Waits until it has booted. Use list_machines to see the profiles. Release machines you no longer need.",
      parameters: Type.Object({
        profile: Type.String({ description: "Name of the machine profile to use." }),
        name: Type.Optional(Type.String({ description: "Name for the machine: lowercase letters, digits and hyphens. Defaults to the profile name and a number, like node-1." })),
      }),
      execute: async (_toolCallId, params: { profile: string; name?: string }, signal) => {
        const machine = await leases.acquire(workspaceId, params, waitMs, signal);
        return result(describeMachine(machine), machine);
      },
    })),
    registerWorkspaceAgentTool("list_machines", (workspaceId) => defineWorkspaceTool({
      name: "list_machines",
      label: "List Machines",
      description: "List this workspace's test machines with their state, the names and addresses other machines reach them at, and expiry, and the machine profiles new ones can be created from. Machines stopped while the workspace was parked start again.",
      parameters: Type.Object({}),
      execute: async () => {
        await leases.wake(workspaceId);
        const [machines, settings] = await Promise.all([leases.list(workspaceId), leases.settings(workspaceId)]);
        const text = `${machines.length ? machines.map(describeMachine).join("\n") : "This workspace has no machines."}\n\n${describeProfiles(settings)}`;
        return result(text, { machines });
      },
    })),
    registerWorkspaceAgentTool("wait_for_machine", (workspaceId) => defineWorkspaceTool({
      name: "wait_for_machine",
      label: "Wait for Machine",
      description: "Wait for a machine that's being created or booting, starting it first if it's stopped, then report its state.",
      parameters: Type.Object({ name: machineName }),
      execute: async (_toolCallId, params: { name: string }, signal) => {
        await leases.wake(workspaceId, [params.name]);
        const machine = await leases.waitFor(workspaceId, params.name, waitMs, signal);
        return result(describeMachine(machine), machine);
      },
    })),
    registerWorkspaceAgentTool("release_machine", (workspaceId) => defineWorkspaceTool({
      name: "release_machine",
      label: "Release Machine",
      description: "Delete one of this workspace's machines, with its disks and snapshots. This can't be undone.",
      parameters: Type.Object({ name: machineName }),
      execute: async (_toolCallId, params: { name: string }) => {
        await leases.release(workspaceId, params.name);
        return result(`Released ${params.name}. It's deleted, with its disks and snapshots.`, { name: params.name });
      },
    })),
    registerWorkspaceAgentTool("snapshot_machines", (workspaceId) => defineWorkspaceTool({
      name: "snapshot_machines",
      label: "Snapshot Machines",
      description: "Save one or more machines' disks, extra disks included, as a named snapshot of each, to return to with restore_machines between experiments. The machines shut down for it and start again afterwards, so what's only in their memory is lost; this waits until they're back. Snapshot machines that work together, like a cluster's nodes, in one call: they shut down together, so the snapshot holds one moment across all of them. Snapshots last until the machine is released.",
      parameters: Type.Object({ machines: machineNames, snapshot: snapshotName }),
      execute: async (_toolCallId, params: { machines: string[]; snapshot: string }, signal) => {
        const machines = await leases.snapshot(workspaceId, params.machines, params.snapshot, waitMs, signal);
        return result(`Saved snapshot ${params.snapshot} of ${listed(params.machines)}.\n${machines.map(describeMachine).join("\n")}`, { machines });
      },
    })),
    registerWorkspaceAgentTool("restore_machines", (workspaceId) => defineWorkspaceTool({
      name: "restore_machines",
      label: "Restore Machines",
      description: "Put one or more machines back to a snapshot they all have, discarding every change since. Restore machines that work together, like a cluster's nodes, in one call: all of them stop before any is restored and start again together, so they come back from the same moment. One at a time, the others would carry on without it. This waits until they're back.",
      parameters: Type.Object({ machines: machineNames, snapshot: snapshotName }),
      execute: async (_toolCallId, params: { machines: string[]; snapshot: string }, signal) => {
        const machines = await leases.restore(workspaceId, params.machines, params.snapshot, waitMs, signal);
        return result(`Restored ${listed(params.machines)} to ${params.snapshot}.\n${machines.map(describeMachine).join("\n")}`, { machines });
      },
    })),
  ];
  return () => { for (const remove of unregister) remove(); };
}
