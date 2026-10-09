import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { getWorkspaceInit } from "@agents-in-the-cloud/workspace";
import { getWorkspaceTemplateConfiguration, isGitWorkspaceTemplateInit, workspaceSshContainerDirectory, workspaceSshDirectory, workspaceTemplateIdFromInit } from "@agents-in-the-cloud/workspace-templates";
import { LxdClient } from "../lxd/index.ts";
import { readLxdConnection } from "./connection.ts";
import { createMachineLeases, type MachineSettings } from "./leases.ts";
import { workspaceMachinePublicKey, workspaceMachinesDirectory } from "./machine-key.ts";
import { createMachineTunnels } from "./tunnels.ts";

/** How long a connection or tool call waits for a machine to boot. A first VM image download fits too. */
export const machineBootWaitMs = 10 * 60_000;

export async function templateMachineSettings(workspaceTemplateId: string | undefined): Promise<MachineSettings> {
  if (!workspaceTemplateId) return { profiles: [], maxMachines: 0 };
  const { machineProfiles, maxMachines } = await getWorkspaceTemplateConfiguration(workspaceTemplateId);
  return { profiles: machineProfiles, maxMachines };
}

async function machineSettings(workspaceId: string): Promise<MachineSettings> {
  const init = await getWorkspaceInit(workspaceId);
  return await templateMachineSettings(isGitWorkspaceTemplateInit(init) ? workspaceTemplateIdFromInit(init) : undefined);
}

export async function connectedLxd(): Promise<LxdClient> {
  const connection = await readLxdConnection();
  if (!connection) throw new AgentsInTheCloudCoreError("machine_unavailable", "No LXD server is connected, so there are no machines. Ask the user to connect one in Settings, under Machines.");
  return new LxdClient(connection);
}

let showChange = (_workspaceId: string) => {};

/** Lets the Machines view refresh whenever a workspace's machines change. */
export function onMachinesChanged(invalidateWorkspace: (workspaceId: string) => void): void {
  showChange = invalidateWorkspace;
}

export const machineTunnels = createMachineTunnels({
  lxd: connectedLxd,
  usable: (workspaceId, name) => machineLeases.usable(workspaceId, name, machineBootWaitMs),
  hostDirectory: workspaceSshDirectory,
  containerDirectory: workspaceSshContainerDirectory,
});

export const machineLeases = createMachineLeases({
  lxd: connectedLxd,
  machineSettings,
  publicKey: workspaceMachinePublicKey,
  directory: workspaceMachinesDirectory,
  bootTimeoutMs: 15 * 60_000,
  pollMs: 3_000,
  async changed(workspaceId, leases) {
    await machineTunnels.sync(workspaceId, leases);
    showChange(workspaceId);
  },
});
