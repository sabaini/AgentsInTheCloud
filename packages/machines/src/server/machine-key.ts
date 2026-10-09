import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentsInTheCloudCoreError, agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, readTextIfExists } from "@agents-in-the-cloud/core";

/** Machine state for one workspace: its leases and the key its machines trust. Outside every Agent sandbox. */
export function workspaceMachinesDirectory(workspaceId: string): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "machines", "workspaces", workspaceId);
}

const keyPath = (workspaceId: string) => join(workspaceMachinesDirectory(workspaceId), "id_ed25519");

/** For the workspace's SSH agent, which signs with it but never hands it out. */
export async function readWorkspaceMachineKey(workspaceId: string): Promise<string[]> {
  const key = await readTextIfExists(keyPath(workspaceId));
  return key === undefined ? [] : [key];
}

/** Creates the workspace's key the first time one of its machines needs it. Callers serialize per workspace. */
export async function workspaceMachinePublicKey(workspaceId: string): Promise<string> {
  const path = keyPath(workspaceId);
  const existing = await readTextIfExists(`${path}.pub`);
  if (existing !== undefined) return existing.trim();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const child = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `agents-in-the-cloud workspace ${workspaceId}`, "-f", path], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new AgentsInTheCloudCoreError("machine_key_failed", `Couldn't create the machine SSH key: ${stderr.trim() || `ssh-keygen exited with ${code}`}`);
  return (await readFile(`${path}.pub`, "utf8")).trim();
}
