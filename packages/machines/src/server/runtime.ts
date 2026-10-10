import { getWorkspaceInit } from "@agents-in-the-cloud/workspace";
import { getWorkspaceTemplateConfiguration, isGitWorkspaceTemplateInit, workspaceSshContainerDirectory, workspaceSshDirectory, workspaceSshReadsConfigDirectory, workspaceTemplateIdFromInit } from "@agents-in-the-cloud/workspace-templates";
import { LxdClient } from "../lxd/index.ts";
import { readLxdConnection } from "./connection.ts";
import { createMachineLeases, type MachineSettings } from "./leases.ts";
import { workspaceMachinePublicKey, workspaceMachinesDirectory } from "./machine-key.ts";
import { createMachineTunnels } from "./tunnels.ts";

/** How long an ssh connection waits for its machine to boot. A first VM image download fits too. */
const machineBootWaitMs = 10 * 60_000;

export async function templateMachineSettings(workspaceTemplateId: string | undefined): Promise<MachineSettings> {
  if (!workspaceTemplateId) return { profiles: [], maxMachines: 0 };
  const { machineProfiles, maxMachines } = await getWorkspaceTemplateConfiguration(workspaceTemplateId);
  return { profiles: machineProfiles, maxMachines };
}

async function machineSettings(workspaceId: string): Promise<MachineSettings> {
  const init = await getWorkspaceInit(workspaceId);
  return await templateMachineSettings(isGitWorkspaceTemplateInit(init) ? workspaceTemplateIdFromInit(init) : undefined);
}

async function connectedLxd(): Promise<LxdClient | undefined> {
  const connection = await readLxdConnection();
  return connection && new LxdClient(connection);
}

let showChange = (_workspaceId: string) => {};

/** Lets the Machines view refresh whenever a workspace's machines change. */
export function onMachinesChanged(invalidateWorkspace: (workspaceId: string) => void): void {
  showChange = invalidateWorkspace;
}

export const machineTunnels = createMachineTunnels({
  usable: (workspaceId, name) => machineLeases.usable(workspaceId, name, machineBootWaitMs),
  hostDirectory: workspaceSshDirectory,
  containerDirectory: workspaceSshContainerDirectory,
});

export const machineLeases = createMachineLeases({
  lxd: connectedLxd,
  machineSettings,
  publicKey: workspaceMachinePublicKey,
  // Machines' ssh config is a file in ssh_config.d.
  reachesMachines: workspaceSshReadsConfigDirectory,
  directory: workspaceMachinesDirectory,
  bootTimeoutMs: 15 * 60_000,
  pollMs: 3_000,
  async changed(workspaceId, leases) {
    await machineTunnels.sync(workspaceId, leases);
    showChange(workspaceId);
  },
});
