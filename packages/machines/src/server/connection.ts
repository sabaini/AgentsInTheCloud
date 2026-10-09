import { rm } from "node:fs/promises";
import { AgentsInTheCloudCoreError, agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, readTextIfExists, writeJsonAtomic } from "@agents-in-the-cloud/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { LxdConnection } from "../lxd/index.ts";

const storedConnectionSchema = Type.Object({
  server: Type.Object({ address: Type.String(), certificate: Type.String() }),
  project: Type.String(),
  credentials: Type.Object({ certificate: Type.String(), privateKey: Type.String() }),
});

/** Like the GitHub token, AITC's LXD client key lives in the data directory, outside Agent sandboxes. */
function connectionPath(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "machines", "lxd.json");
}

export async function readLxdConnection(): Promise<LxdConnection | undefined> {
  const path = connectionPath();
  const text = await readTextIfExists(path);
  if (text === undefined) return undefined;
  const stored: unknown = JSON.parse(text);
  if (!Value.Check(storedConnectionSchema, stored)) throw new AgentsInTheCloudCoreError("invalid_lxd_connection", `${path} doesn't describe an LXD connection`);
  return stored;
}

export async function saveLxdConnection(connection: LxdConnection): Promise<void> {
  await writeJsonAtomic(connectionPath(), { server: connection.server, project: connection.project, credentials: connection.credentials }, { mode: 0o600 });
}

export async function forgetLxdConnection(): Promise<void> {
  await rm(connectionPath(), { force: true });
}
