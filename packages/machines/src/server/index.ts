import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import type { WorkspaceModule } from "@agents-in-the-cloud/shared";
import { getWorkspaceInit } from "@agents-in-the-cloud/workspace";
import { getWorkspaceTemplateConfiguration, isGitWorkspaceTemplateInit, registerWorkspaceSshKeySource, workspaceTemplateIdFromInit } from "@agents-in-the-cloud/workspace-templates";
import { LxdClient } from "../lxd/index.ts";
import { readLxdConnection } from "./connection.ts";
import { createMachineLeases, type MachineSettings } from "./leases.ts";
import { readWorkspaceMachineKey, workspaceMachinePublicKey, workspaceMachinesDirectory } from "./machine-key.ts";
import { machinesSettingsContribution } from "./settings.ts";
import { registerMachineTools } from "./tools.ts";

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

const machineLeases = createMachineLeases({
  lxd: connectedLxd,
  machineSettings,
  publicKey: workspaceMachinePublicKey,
  directory: workspaceMachinesDirectory,
  bootTimeoutMs: 15 * 60_000,
  pollMs: 3_000,
});

export const agentsInTheCloudServerModule: WorkspaceModule = {
  id: "machines",
  staticFiles: { "/machines.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  settingsContributions: [machinesSettingsContribution],
  initialize() {
    registerWorkspaceSshKeySource(readWorkspaceMachineKey);
    registerMachineTools(machineLeases);
  },
};
