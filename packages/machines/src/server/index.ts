import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import type { WorkspaceModule } from "@agents-in-the-cloud/shared";
import { getWorkspaceInit, listWorkspaces } from "@agents-in-the-cloud/workspace";
import { getWorkspaceTemplateConfiguration, isGitWorkspaceTemplateInit, registerWorkspaceSshKeySource, workspaceSshContainerDirectory, workspaceSshDirectory, workspaceTemplateIdFromInit } from "@agents-in-the-cloud/workspace-templates";
import { LxdClient } from "../lxd/index.ts";
import { readLxdConnection } from "./connection.ts";
import { createMachineLeases, type MachineSettings } from "./leases.ts";
import { readWorkspaceMachineKey, workspaceMachinePublicKey, workspaceMachinesDirectory } from "./machine-key.ts";
import { machinesSettingsContribution } from "./settings.ts";
import { registerMachineTools } from "./tools.ts";
import { createMachineTunnels } from "./tunnels.ts";

async function machineSettings(workspaceId: string): Promise<MachineSettings> {
  const init = await getWorkspaceInit(workspaceId);
  if (!isGitWorkspaceTemplateInit(init)) return { profiles: [], maxMachines: 0 };
  const { machineProfiles, maxMachines } = await getWorkspaceTemplateConfiguration(workspaceTemplateIdFromInit(init));
  return { profiles: machineProfiles, maxMachines };
}

async function connectedLxd(): Promise<LxdClient> {
  const connection = await readLxdConnection();
  if (!connection) throw new AgentsInTheCloudCoreError("machine_unavailable", "No LXD server is connected, so there are no machines. Ask the user to connect one in Settings, under Machines.");
  return new LxdClient(connection);
}

const tunnels = createMachineTunnels({ lxd: connectedLxd, hostDirectory: workspaceSshDirectory, containerDirectory: workspaceSshContainerDirectory });

const machineLeases = createMachineLeases({
  lxd: connectedLxd,
  machineSettings,
  publicKey: workspaceMachinePublicKey,
  directory: workspaceMachinesDirectory,
  bootTimeoutMs: 15 * 60_000,
  pollMs: 3_000,
  changed: tunnels.sync,
});

export const agentsInTheCloudServerModule: WorkspaceModule = {
  id: "machines",
  staticFiles: { "/machines.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  settingsContributions: [machinesSettingsContribution],
  async initialize(context) {
    registerWorkspaceSshKeySource(readWorkspaceMachineKey);
    registerMachineTools(machineLeases);
    context.onWorkspaceRemoved((workspaceId) => tunnels.close(workspaceId));
    // Sockets end with the AgentsInTheCloud process; machines outlive it.
    for (const { id } of (await listWorkspaces()).workspaces) await tunnels.sync(id, await machineLeases.stored(id));
  },
};
