import { rm } from "node:fs/promises";
import { AgentsInTheCloudCoreError, agentsInTheCloudDataPath, getAgentsInTheCloudRuntimeContext, readTextIfExists, writeJsonAtomic } from "@agents-in-the-cloud/core";
import { errorMessage } from "@agents-in-the-cloud/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { certificateFingerprint, LxdServerClient, type LxdConnection } from "../lxd/index.ts";

const storedConnectionSchema = Type.Object({
  server: Type.Object({ address: Type.String(), certificate: Type.String() }),
  project: Type.String(),
  credentials: Type.Object({ certificate: Type.String(), privateKey: Type.String() }),
});

/** How long Settings and the Machines view wait for the LXD server, which may be off or out of reach. */
const answerTimeoutMs = 5_000;

/** A server behind a dropped route would otherwise keep a page loading for minutes. */
export async function answeredInTime<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${answerTimeoutMs / 1000} seconds`)), answerTimeoutMs); });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

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

/** Forgets the LXD server and removes AITC's certificate there. If that fails, says how to remove it by hand. */
export async function disconnectLxd(): Promise<string | undefined> {
  const connection = await readLxdConnection();
  if (!connection) return undefined;
  let leftover: string | undefined;
  try {
    await new LxdServerClient(connection).removeOwnCertificate(AbortSignal.timeout(answerTimeoutMs));
  } catch (error) {
    leftover = `AgentsInTheCloud forgot the LXD server at ${connection.server.address} but couldn't remove its certificate there (${errorMessage(error)}). To remove it yourself, run lxc config trust remove ${certificateFingerprint(connection.credentials.certificate)} on the server.`;
  }
  await rm(connectionPath(), { force: true });
  return leftover;
}
