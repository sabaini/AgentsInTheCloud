import { rm } from "node:fs/promises";
import { AgentsInTheCloudCoreError, agentsInTheCloudDataPath, createKeyedOperationQueue, getAgentsInTheCloudRuntimeContext, readTextIfExists, writeJsonAtomic } from "@agents-in-the-cloud/core";
import { errorMessage } from "@agents-in-the-cloud/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { certificateFingerprint, lxdLocation, LxdServerClient, sameLxdLocation, type LxdConnection, type LxdLocation } from "../lxd/index.ts";

const storedConnectionSchema = Type.Object({
  server: Type.Object({ address: Type.String(), certificate: Type.String() }),
  project: Type.String(),
  credentials: Type.Object({ certificate: Type.String(), privateKey: Type.String() }),
});
const storedConnectionsSchema = Type.Object({ servers: Type.Array(storedConnectionSchema) });

/** How long Settings and the Machines view wait for an LXD server, which may be off or out of reach. */
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

/** Like the GitHub token, AITC's LXD client keys live in the data directory, outside Agent sandboxes. */
function connectionsPath(): string {
  return agentsInTheCloudDataPath(getAgentsInTheCloudRuntimeContext(), "machines", "lxd.json");
}

/** Changes to the list of servers, one at a time. */
const serialize = createKeyedOperationQueue();

/** The connected LXD servers, in the order they were connected. */
export async function readLxdConnections(): Promise<LxdConnection[]> {
  const path = connectionsPath();
  const text = await readTextIfExists(path);
  if (text === undefined) return [];
  const stored: unknown = JSON.parse(text);
  if (Value.Check(storedConnectionsSchema, stored)) return stored.servers;
  // Before there could be more than one server, the file held just the one.
  if (Value.Check(storedConnectionSchema, stored)) return [stored];
  throw new AgentsInTheCloudCoreError("invalid_lxd_connection", `${path} doesn't describe LXD connections`);
}

async function saveLxdConnections(connections: LxdConnection[]): Promise<void> {
  const servers = connections.map(({ server, project, credentials }) => ({ server, project, credentials }));
  await writeJsonAtomic(connectionsPath(), { servers }, { mode: 0o600 });
}

/** Adds a server, unless its project is connected already. */
export async function addLxdConnection(connection: LxdConnection): Promise<void> {
  await serialize("connections", async () => {
    const connections = await readLxdConnections();
    if (connections.some((existing) => sameLxdLocation(lxdLocation(existing), lxdLocation(connection)))) throw new AgentsInTheCloudCoreError("lxd_already_connected", `The ${connection.project} project on that LXD server is connected already.`);
    await saveLxdConnections([...connections, connection]);
  });
}

/** Removes AITC's certificate on the server. If that fails, says how to remove it by hand. */
async function removeCertificate(connection: LxdConnection): Promise<string | undefined> {
  try {
    await new LxdServerClient(connection).removeOwnCertificate(AbortSignal.timeout(answerTimeoutMs));
    return undefined;
  } catch (error) {
    return `AgentsInTheCloud forgot the LXD server at ${connection.server.address} but couldn't remove its certificate there (${errorMessage(error)}). To remove it yourself, run lxc config trust remove ${certificateFingerprint(connection.credentials.certificate)} on the server.`;
  }
}

/** Forgets the LXD server and removes AITC's certificate there. If that fails, says how to remove it by hand. */
export async function disconnectLxd(location: LxdLocation): Promise<string | undefined> {
  return await serialize("connections", async () => {
    const connections = await readLxdConnections();
    const connection = connections.find((candidate) => sameLxdLocation(lxdLocation(candidate), location));
    if (!connection) return undefined;
    const leftover = await removeCertificate(connection);
    await saveLxdConnections(connections.filter((candidate) => candidate !== connection));
    return leftover;
  });
}

/** Forgets every LXD server, as when deleting all settings. Says how to remove certificates it couldn't. */
export async function disconnectAllLxd(): Promise<string | undefined> {
  return await serialize("connections", async () => {
    const leftovers: string[] = [];
    for (const connection of await readLxdConnections()) {
      const leftover = await removeCertificate(connection);
      if (leftover) leftovers.push(leftover);
    }
    await rm(connectionsPath(), { force: true });
    return leftovers.length ? leftovers.join(" ") : undefined;
  });
}
