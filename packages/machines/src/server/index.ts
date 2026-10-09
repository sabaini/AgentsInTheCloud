import type { WorkspaceModule } from "@agents-in-the-cloud/shared";
import { machinesSettingsContribution } from "./settings.ts";

export const agentsInTheCloudServerModule: WorkspaceModule = {
  id: "machines",
  staticFiles: { "/machines.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  settingsContributions: [machinesSettingsContribution],
};
