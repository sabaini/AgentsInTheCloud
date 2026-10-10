import type { WorkspaceModule } from "@agents-in-the-cloud/shared";
import { isGitWorkspaceTemplateInit, registerWorkspaceSshKeySource, workspaceTemplateIdFromInit } from "@agents-in-the-cloud/workspace-templates";
import { machinesDeletionReview, registerMachineLifecycle } from "./lifecycle.ts";
import { readWorkspaceMachineKey, workspacesWithMachines } from "./machine-key.ts";
import { machineLeases, machineTunnels, onMachinesChanged } from "./runtime.ts";
import { machinesSettingsContribution } from "./settings.ts";
import { registerMachineTools } from "./tools.ts";
import { attachMachines, machineRoutes, machinesOpenApiPaths, machinesOpenCommand, machinesWorkView } from "./work-view.ts";

export const agentsInTheCloudServerModule: WorkspaceModule = {
  id: "machines",
  staticFiles: { "/machines.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  settingsContributions: [machinesSettingsContribution],
  deletionReview: machinesDeletionReview,
  workViews: [machinesWorkView],
  commands: [machinesOpenCommand],
  routes: [machineRoutes],
  openApiPaths: machinesOpenApiPaths,
  async initialize(context) {
    onMachinesChanged(context.invalidateWorkspace);
    registerWorkspaceSshKeySource(readWorkspaceMachineKey);
    registerMachineTools(machineLeases);
    registerMachineLifecycle(context);
    // Sockets end with the AgentsInTheCloud process; machines outlive it.
    for (const workspaceId of await workspacesWithMachines()) await machineTunnels.sync(workspaceId, await machineLeases.stored(workspaceId));
  },
  attachToWorkspace: ({ workspaceId, init }) => attachMachines(workspaceId, isGitWorkspaceTemplateInit(init) ? workspaceTemplateIdFromInit(init) : undefined),
};
