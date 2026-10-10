import { registerWorkspaceAgentTool } from "@agents-in-the-cloud/agent/server/tools";
import { defineWorkspaceTool } from "@agents-in-the-cloud/agent/server/workspace-tool";
import { Type } from "typebox";
import type { MachineLeases, MachineSettings, MachineView } from "./leases.ts";

/** Long enough for a first VM image download and boot; Agents' MCP tool calls allow an hour. */
const waitMs = 10 * 60_000;

function kind(type: MachineView["type"]): string {
  return type === "virtual-machine" ? "virtual machine" : "container";
}

function describeMachine(machine: MachineView): string {
  const disks = machine.diskSizesGiB.length ? ` with ${machine.diskSizesGiB.length === 1 ? "an extra disk" : `${machine.diskSizesGiB.length} extra disks`} (${machine.diskSizesGiB.join(", ")} GiB)` : "";
  const what = `a ${kind(machine.type)} from ${machine.image}${disks}, made from profile ${machine.profile}, until ${machine.expiresAt}`;
  const snapshots = machine.snapshots.length ? ` Snapshots: ${machine.snapshots.join(", ")}.` : "";
  const addresses = machine.addresses.length ? ` Other machines reach it at ${machine.addresses.join(" or ")}, not by name.` : "";
  switch (machine.state) {
    case "ready": return `${machine.name} is ready: ${what}. Reach it with \`ssh ${machine.name}\`; scp and rsync work too.${addresses}${snapshots}`;
    case "creating": return `${machine.name} is being created: ${what}. Wait for it with wait_for_machine.`;
    case "starting": return `${machine.name} is booting: ${what}. Wait for it with wait_for_machine.${snapshots}`;
    case "paused": return `${machine.name} is paused while a snapshot of it is saved: ${what}. Wait for it with wait_for_machine.${snapshots}`;
    case "stopped": return `${machine.name} is stopped: ${what}. Connecting with ssh or wait_for_machine starts it again.${snapshots}`;
    case "restoring": return `${machine.name} is being restored to a snapshot: ${what}.${snapshots}`;
    case "interrupted": return `${machine.name} didn't finish restoring to a snapshot (${machine.error}), so its disks may be from different points in time: ${what}. It stays stopped until restore_machine succeeds, or release it with release_machine.${snapshots}`;
    case "failed": return `${machine.name} couldn't be set up: ${machine.error}. Release it with release_machine.`;
    case "missing": return `${machine.name} is gone from the LXD server. Release it with release_machine.`;
    case "disconnected": return `${machine.name} is on an LXD server that isn't connected now: ${what}. It can be used or released once the user connects that server again in Settings, under Machines.`;
  }
}

function describeProfiles({ profiles, maxMachines }: MachineSettings): string {
  if (!profiles.length) return "This workspace's template has no machine profiles yet, so no machines can be created. The user can add profiles in the template's settings, under Machines.";
  const lines = profiles.map((profile) => `- ${profile.name}: a ${kind(profile.type)} from ${profile.image}${profile.diskSizesGiB.length ? ` with extra disks of ${profile.diskSizesGiB.join(", ")} GiB` : ""}, kept for ${profile.lifetimeHours} hours`);
  return `Profiles you can create machines from (up to ${maxMachines} at once):\n${lines.join("\n")}`;
}

type ToolDetails = MachineView | { machines: MachineView[] } | { name: string };

function result(text: string, details: ToolDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

const machineName = Type.String({ description: "The machine's name, as acquire_machine or list_machines reported it." });
const snapshotName = Type.String({ description: "Snapshot name: letters, digits, dots, hyphens and underscores." });

/** Gives every workspace's Agents the machine tools; returns a function that takes them away again. */
export function registerMachineTools(leases: MachineLeases): () => void {
  const unregister = [
    registerWorkspaceAgentTool("acquire_machine", (workspaceId) => defineWorkspaceTool({
      name: "acquire_machine",
      label: "Acquire Machine",
      description: "Create a fresh test machine for this workspace from one of its machine profiles: a virtual machine or container on the user's LXD server, with its own kernel and real disks, for work the workspace container can't do, like installing snaps, using block devices or forming clusters. Once it has booted, `ssh <name>` reaches it from this workspace as ubuntu, with passwordless sudo; scp, rsync and tools like juju or ansible can use the name too. Machines reach each other at the addresses list_machines reports, not by name. Waits until it has booted. Use list_machines to see the profiles. Release machines you no longer need.",
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
      description: "List this workspace's test machines with their state, addresses and expiry, and the machine profiles new ones can be created from. Machines stopped while the workspace was parked start again.",
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
    registerWorkspaceAgentTool("snapshot_machine", (workspaceId) => defineWorkspaceTool({
      name: "snapshot_machine",
      label: "Snapshot Machine",
      description: "Save a machine's disks, its extra ones included, as a named snapshot, to return to with restore_machine between experiments. A machine with extra disks pauses while they're saved. Snapshots last until the machine is released.",
      parameters: Type.Object({ name: machineName, snapshot: snapshotName }),
      execute: async (_toolCallId, params: { name: string; snapshot: string }) => {
        const machine = await leases.snapshot(workspaceId, params.name, params.snapshot);
        return result(`Saved snapshot ${params.snapshot} of ${params.name}.`, machine);
      },
    })),
    registerWorkspaceAgentTool("restore_machine", (workspaceId) => defineWorkspaceTool({
      name: "restore_machine",
      label: "Restore Machine",
      description: "Put a machine back to one of its snapshots, discarding every change since. The machine restarts; this waits until it's back.",
      parameters: Type.Object({ name: machineName, snapshot: snapshotName }),
      execute: async (_toolCallId, params: { name: string; snapshot: string }, signal) => {
        const machine = await leases.restore(workspaceId, params.name, params.snapshot, waitMs, signal);
        return result(`Restored ${params.name} to ${params.snapshot}. ${describeMachine(machine)}`, machine);
      },
    })),
  ];
  return () => { for (const remove of unregister) remove(); };
}
