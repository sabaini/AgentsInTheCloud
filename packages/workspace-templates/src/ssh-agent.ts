import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { agentsInTheCloudDataPath, dockerHostAgentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, readTextIfExists, type AgentsInTheCloudEventBus } from "@agents-in-the-cloud/core";
import { listWorkspaces } from "@agents-in-the-cloud/workspace";
import { workspaceTemplateIdOfInit } from "./workspace-template.ts";
import { revealEffectiveSshKeys } from "./ssh-keys.ts";
import { prepareWorkspaceSshTrust, workspaceGitSshCommand } from "./ssh-host-trust.ts";
import { SharedSshAgent } from "./shared-ssh-agent.ts";

/** Where a workspace's SSH directory appears inside its container, read-only and live. */
export const workspaceSshContainerDirectory = "/run/agents-in-the-cloud-ssh-agent";
const configDirectoryInclude = `Include ${workspaceSshContainerDirectory}/ssh_config.d/*.conf\n`;
let shared: SharedSshAgent | undefined;
const workspaceKeySources = new Set<(workspaceId: string) => Promise<string[]>>();

/** Add private keys that only one workspace's agent may sign with, such as the key its leased machines trust. */
export function registerWorkspaceSshKeySource(source: (workspaceId: string) => Promise<string[]>): () => void {
  workspaceKeySources.add(source);
  return () => { workspaceKeySources.delete(source); };
}

/** The global and template keys every workspace of the template may use, plus the workspace's own. */
async function signingKeys(workspaceTemplateId?: string, workspaceId?: string): Promise<string[]> {
  const workspaceKeys = workspaceId ? await Promise.all([...workspaceKeySources].map(source => source(workspaceId))) : [];
  return [...await revealEffectiveSshKeys(workspaceTemplateId), ...workspaceKeys.flat()];
}

/** The host side of a workspace's SSH directory. Modules may add `ssh_config.d/*.conf` files; the workspace's SSH config includes them. */
export function workspaceSshDirectory(workspaceId: string): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "ssh-agents", workspaceId);
}

/** Whether ssh in the workspace reads `ssh_config.d`. A container gets its SSH config once, so ones made before it did never will. */
export async function workspaceSshReadsConfigDirectory(workspaceId: string): Promise<boolean> {
  return (await readTextIfExists(join(workspaceSshDirectory(workspaceId), "ssh_config")))?.startsWith(configDirectoryInclude) ?? false;
}

function sshEnvironment(directory: string) {
  return {
    SSH_AUTH_SOCK: join(directory, "agent.sock"),
    GIT_SSH_COMMAND: workspaceGitSshCommand(join(directory, "known_hosts")),
  };
}

export async function workspaceSourceSshEnvironment(workspaceId: string, workspaceTemplateId?: string): Promise<Record<string, string>> {
  // One module owns the signing backend for the lifetime of AgentsInTheCloud, not a workspace.
  shared ??= new SharedSshAgent(agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "ssh-signer"), signingKeys);
  const directory = workspaceSshDirectory(workspaceId);
  await shared.listen(join(directory, "agent.sock"), workspaceTemplateId, workspaceId);
  await prepareWorkspaceSshTrust(directory, workspaceTemplateId);
  await writeFile(join(directory, "workspace_known_hosts"), "", { flag: "wx" }).catch(error => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  return sshEnvironment(directory);
}

export async function stopWorkspaceSshAgent(workspaceId: string): Promise<void> {
  await shared?.remove(join(workspaceSshDirectory(workspaceId), "agent.sock"));
}

export async function stopWorkspaceTemplateSshAgents(): Promise<void> {
  const agent = shared;
  shared = undefined;
  await agent?.close();
}

export function registerWorkspaceTemplateSshAgentWorkspaceEvents(events: AgentsInTheCloudEventBus): void {
  events.on("workspace_plan_prepare", async ({ workspaceId, init, plan }) => {
    await workspaceSourceSshEnvironment(workspaceId, workspaceTemplateIdOfInit(init));
    Object.assign(plan.env, sshEnvironment(workspaceSshContainerDirectory));
    const directory = workspaceSshDirectory(workspaceId);
    const command = `#!/bin/sh
set -eu
host="$1"
port="$2"
keys="$(ssh-keyscan -T 5 -p "$port" "$host" 2>/dev/null)"
[ -n "$keys" ] || exit 1
printf '%s\\n' "$keys" | curl --noproxy '*' --fail --silent --show-error --max-time 1810 --unix-socket /run/agents-in-the-cloud-parent/ingress.sock \\
  --data-urlencode "host=$host" --data-urlencode "port=$port" --data-urlencode 'keys@-' http://localhost/ssh/host-keys
`;
    await writeFile(join(directory, "known-hosts-command"), command, { mode: 0o755 });
    // Loopback is the workspace's own container, not a server the user can verify, so keep default OpenSSH behavior there.
    // Included hosts come first, because OpenSSH keeps the first value it finds for each option.
    await writeFile(join(directory, "ssh_config"), `${configDirectoryInclude}Host * !localhost !127.* !::1\n    KnownHostsCommand /run/agents-in-the-cloud-ssh-agent/known-hosts-command %h %p\n    UserKnownHostsFile /run/agents-in-the-cloud-ssh-agent/known_hosts /run/agents-in-the-cloud-ssh-agent/workspace_known_hosts ~/.ssh/known_hosts\n    StrictHostKeyChecking yes\n`);
    plan.containerFiles.push({ source: join(directory, "ssh_config"), target: "/etc/ssh/ssh_config.d/agents-in-the-cloud.conf" });
    plan.initScripts.push("chown root:root /etc/ssh/ssh_config.d/agents-in-the-cloud.conf; chmod 644 /etc/ssh/ssh_config.d/agents-in-the-cloud.conf");
    plan.mounts.push({ type: "bind", source: dockerHostAgentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "ssh-agents", workspaceId), target: workspaceSshContainerDirectory, readonly: true });
    plan.cleanup.push(() => stopWorkspaceSshAgent(workspaceId));
  });
  events.on("workspace_deleted", async ({ workspaceId }) => stopWorkspaceSshAgent(workspaceId));
}

export async function restoreWorkspaceTemplateSshAgents(): Promise<void> {
  for (const workspace of (await listWorkspaces()).workspaces) {
    await workspaceSourceSshEnvironment(workspace.id, workspaceTemplateIdOfInit(workspace.init));
  }
}
